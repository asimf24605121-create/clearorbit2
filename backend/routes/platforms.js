import { Router } from 'express';
import { prisma, emitAdminEvent } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { nowISO } from '../utils/helpers.js';
import {
  parseRawCookieString, detectPlatformFromCookies, generateNetscape,
  extractCookieExpiry, computeCookieScore,
  classifyCookieCompleteness, detectRequiredSessionComponents,
} from '../utils/cookieEngine.js';
import { invalidateAccountCaches, platformCache } from '../utils/cache.js';
import { platformHealthQueue } from '../utils/jobQueue.js';
import { recheckLimiter } from '../middleware/rateLimit.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const hash = crypto.randomBytes(8).toString('hex');
    cb(null, `logo_${hash}${ext}`);
  },
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WebP, and SVG images are allowed'));
  },
});

const BATCH_SIZE = 20;

function classifyPlatformStatus(p, activeAccounts, healthScore) {
  if (!p.isActive) return 'inactive';
  if (activeAccounts === 0) return 'unused';
  if (healthScore >= 75) return 'healthy';
  if (healthScore >= 40) return 'degraded';
  return 'dead';
}

function computePlatformHealth(accounts) {
  const active = accounts.filter(a => a.isActive);
  if (active.length === 0) return { score: 0, activeCount: 0, healthyCount: 0 };
  const totalSuccess = active.reduce((s, a) => s + (a.successCount || 0), 0);
  const totalFail = active.reduce((s, a) => s + (a.failCount || 0), 0);
  const totalAttempts = totalSuccess + totalFail;
  const successRate = totalAttempts > 0 ? (totalSuccess / totalAttempts) * 100 : 50;
  const healthyAccounts = active.filter(a => (a.intelligenceScore || 0) >= 70).length;
  const accountHealthRatio = active.length > 0 ? (healthyAccounts / active.length) * 100 : 0;
  const avgIntelScore = active.length > 0
    ? active.reduce((s, a) => s + (a.intelligenceScore || 0), 0) / active.length : 0;
  const score = Math.round(successRate * 0.35 + accountHealthRatio * 0.35 + avgIntelScore * 0.30);
  return { score: Math.max(0, Math.min(100, score)), activeCount: active.length, healthyCount: healthyAccounts };
}

function statusReason(status, score, activeCount, totalAccounts, lastCheck) {
  if (status === 'inactive') return 'Manually disabled by admin';
  if (status === 'unused') return totalAccounts > 0 ? 'All accounts are deactivated' : 'No accounts linked';
  if (status === 'healthy') return `${activeCount} active account(s), ${score}% health`;
  if (status === 'degraded') return `Performance below threshold (${score}%)`;
  if (status === 'dead') return `Critical failures across accounts (${score}%)`;
  return '';
}

const router = Router();

router.get('/get_platforms', authenticate, async (req, res) => {
  try {
    const platforms = await prisma.platform.findMany({
      where: { isActive: 1 },
      select: {
        id: true, name: true, logoUrl: true, bgColorHex: true,
        isActive: true, maxSlotsPerCookie: true, cookieDomain: true,
        loginUrl: true, healthScore: true, healthStatus: true, totalAccounts: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json({
      success: true,
      platforms: platforms.map(p => ({
        id: p.id, name: p.name, logo_url: p.logoUrl, bg_color_hex: p.bgColorHex,
        is_active: p.isActive, max_slots_per_cookie: p.maxSlotsPerCookie,
        cookie_domain: p.cookieDomain, login_url: p.loginUrl,
        health_score: p.healthScore, health_status: p.healthStatus,
        total_accounts: p.totalAccounts,
      })),
    });
  } catch (err) {
    console.error('get_platforms error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_public_platforms', async (req, res) => {
  try {
    const platforms = await prisma.platform.findMany({
      where: { isActive: 1 },
      select: { id: true, name: true, logoUrl: true, bgColorHex: true },
      orderBy: { name: 'asc' },
    });

    res.json({
      success: true,
      platforms: platforms.map(p => ({
        id: p.id, name: p.name, logo_url: p.logoUrl, bg_color_hex: p.bgColorHex,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_platform', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { name, logo_url, bg_color_hex, cookie_domain, login_url, max_slots_per_cookie } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Platform name required' });

    const platform = await prisma.platform.create({
      data: {
        name, logoUrl: logo_url || null, bgColorHex: bg_color_hex || '#1e293b',
        cookieDomain: cookie_domain || null, loginUrl: login_url || null,
        maxSlotsPerCookie: parseInt(max_slots_per_cookie) || 5, isActive: 1,
      },
    });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Added platform: ${name}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Platform added', platform_id: platform.id });
  } catch (err) {
    console.error('add_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_platform', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, name, logo_url, bg_color_hex, cookie_domain, login_url, max_slots_per_cookie } = req.body;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const data = {};
    if (name !== undefined) data.name = name;
    if (logo_url !== undefined) data.logoUrl = logo_url;
    if (bg_color_hex !== undefined) data.bgColorHex = bg_color_hex;
    if (cookie_domain !== undefined) data.cookieDomain = cookie_domain;
    if (login_url !== undefined) data.loginUrl = login_url;
    if (max_slots_per_cookie !== undefined) data.maxSlotsPerCookie = parseInt(max_slots_per_cookie);

    await prisma.platform.update({ where: { id: parseInt(platform_id) }, data });
    res.json({ success: true, message: 'Platform updated' });
  } catch (err) {
    console.error('update_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_platform', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { platform_id } = req.body;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const pid = parseInt(platform_id);
    const platform = await prisma.platform.findUnique({ where: { id: pid } });
    if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });

    if (!req.body.force) {
      const activeSessions = await prisma.accountSession.count({ where: { platformId: pid, status: 'active' } });
      const activeSubs = await prisma.userSubscription.count({ where: { platformId: pid, isActive: 1 } });
      if (activeSessions > 0 || activeSubs > 0) {
        return res.status(409).json({
          success: false,
          message: `Platform "${platform.name}" has ${activeSessions} active session(s) and ${activeSubs} active subscription(s). Disable it first or pass force=true.`,
          requires_force: true,
        });
      }
    }

    await prisma.platform.delete({ where: { id: pid } });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Deleted platform "${platform.name}" (ID: ${platform_id})`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    platformCache.invalidate('platform:dashboard');
    invalidateAccountCaches();
    res.json({ success: true, message: `Platform "${platform.name}" deleted` });
  } catch (err) {
    console.error('delete_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_platforms_bulk', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { platform_ids } = req.body;
    if (!Array.isArray(platform_ids) || !platform_ids.length) {
      return res.status(400).json({ success: false, message: 'Platform IDs required' });
    }
    const ids = platform_ids.map(Number).filter(n => n > 0);
    const deleted = await prisma.platform.deleteMany({ where: { id: { in: ids } } });
    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Bulk deleted ${deleted.count} platform(s)`, ipAddress: req.ip || null, createdAt: nowISO() },
    });
    platformCache.invalidate('platform:dashboard');
    invalidateAccountCaches();
    res.json({ success: true, message: `${deleted.count} platform(s) deleted`, count: deleted.count });
  } catch (err) {
    console.error('delete_platforms_bulk error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_platform', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id } = req.body;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const platform = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) } });
    if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });

    const newStatus = platform.isActive ? 0 : 1;

    const txOps = [];
    let terminatedSessions = 0;
    if (!newStatus) {
      const activeCount = await prisma.accountSession.count({ where: { platformId: platform.id, status: 'active' } });
      terminatedSessions = activeCount;
      txOps.push(prisma.accountSession.updateMany({
        where: { platformId: platform.id, status: 'active' },
        data: { status: 'terminated' },
      }));
      txOps.push(prisma.platform.update({ where: { id: platform.id }, data: { isActive: 0, healthStatus: 'inactive' } }));
      txOps.push(prisma.activityLog.create({
        data: { userId: req.user.id, action: `Disabled platform "${platform.name}" (ID: ${platform.id}), terminated ${terminatedSessions} session(s)`, ipAddress: req.ip || null, createdAt: nowISO() },
      }));
    } else {
      txOps.push(prisma.platform.update({ where: { id: platform.id }, data: { isActive: 1 } }));
      txOps.push(prisma.activityLog.create({
        data: { userId: req.user.id, action: `Enabled platform "${platform.name}" (ID: ${platform.id})`, ipAddress: req.ip || null, createdAt: nowISO() },
      }));
    }

    await prisma.$transaction(txOps);
    platformCache.invalidate('platform:dashboard');
    invalidateAccountCaches();

    const msg = newStatus
      ? `Platform "${platform.name}" enabled`
      : `Platform "${platform.name}" disabled. ${terminatedSessions} active session(s) terminated.`;
    res.json({ success: true, message: msg, is_active: newStatus, terminated_sessions: terminatedSessions });
  } catch (err) {
    console.error('toggle_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/upload_logo', authenticate, requireAdmin(), (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'File too large (max 2MB)' });
      return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
    }
    try {
      const platformId = parseInt(req.body.platform_id);
      if (!platformId) return res.status(400).json({ success: false, message: 'Platform ID required' });

      if (req.body.logo_url && !req.file) {
        await prisma.platform.update({ where: { id: platformId }, data: { logoUrl: req.body.logo_url } });
        platformCache.invalidate('platform:dashboard');
        return res.json({ success: true, message: 'Logo URL updated', logo_url: req.body.logo_url });
      }

      if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });

      const platform = await prisma.platform.findUnique({ where: { id: platformId }, select: { logoUrl: true, name: true } });
      if (!platform) { fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, message: 'Platform not found' }); }

      if (platform.logoUrl && platform.logoUrl.startsWith('/uploads/')) {
        const oldPath = path.join(process.cwd(), platform.logoUrl);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const logoUrl = `/uploads/${req.file.filename}`;
      await prisma.platform.update({ where: { id: platformId }, data: { logoUrl } });

      await prisma.activityLog.create({
        data: { userId: req.user.id, action: `Updated logo for platform "${platform.name}" (ID: ${platformId})`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      platformCache.invalidate('platform:dashboard');
      res.json({ success: true, message: 'Logo uploaded', logo_url: logoUrl });
    } catch (e) {
      console.error('upload_logo error:', e);
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });
});

router.post('/remove_logo', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id } = req.body;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const platform = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) }, select: { logoUrl: true, name: true } });
    if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });

    if (platform.logoUrl && platform.logoUrl.startsWith('/uploads/')) {
      const filePath = path.join(process.cwd(), platform.logoUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await prisma.platform.update({ where: { id: parseInt(platform_id) }, data: { logoUrl: null } });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Removed logo for platform "${platform.name}" (ID: ${platform_id})`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    platformCache.invalidate('platform:dashboard');
    res.json({ success: true, message: 'Logo removed' });
  } catch (err) {
    console.error('remove_logo error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_cookie', authenticate, async (req, res) => {
  try {
    const { platform_id, cookie_id } = req.query;
    let cookie;

    if (cookie_id) {
      cookie = await prisma.cookieVault.findUnique({ where: { id: parseInt(cookie_id) } });
    } else if (platform_id) {
      cookie = await prisma.cookieVault.findFirst({
        where: { platformId: parseInt(platform_id), cookieStatus: 'VALID' },
        orderBy: { score: 'desc' },
      });
    }

    if (!cookie) return res.status(404).json({ success: false, message: 'No cookie found' });

    res.json({
      success: true,
      cookie: {
        id: cookie.id, platform_id: cookie.platformId,
        cookie_string: cookie.cookieString, expires_at: cookie.expiresAt,
        cookie_status: cookie.cookieStatus, score: cookie.score,
      },
    });
  } catch (err) {
    console.error('get_cookie error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_cookie', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { cookie_id, cookie_string, platform_id } = req.body;
    if (!cookie_id && !platform_id) {
      return res.status(400).json({ success: false, message: 'Cookie ID or Platform ID required' });
    }

    const data = { updatedAt: nowISO() };
    if (cookie_string) {
      data.cookieString = Buffer.from(cookie_string).toString('base64');
      const parsed = parseRawCookieString(cookie_string);
      data.cookieCount = parsed.length;
      data.score = computeCookieScore(parsed);
      const expiry = extractCookieExpiry(parsed);
      if (expiry) data.expiresAt = expiry;
    }

    if (cookie_id) {
      await prisma.cookieVault.update({ where: { id: parseInt(cookie_id) }, data });
    } else {
      await prisma.cookieVault.updateMany({
        where: { platformId: parseInt(platform_id) }, data,
      });
    }

    res.json({ success: true, message: 'Cookie updated' });
  } catch (err) {
    console.error('update_cookie error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_cookie', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { cookie_id } = req.body;
    if (!cookie_id) return res.status(400).json({ success: false, message: 'Cookie ID required' });

    await prisma.cookieVault.delete({ where: { id: parseInt(cookie_id) } });
    res.json({ success: true, message: 'Cookie deleted' });
  } catch (err) {
    console.error('delete_cookie error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/validate_cookie', authenticate, recheckLimiter, async (req, res) => {
  try {
    const { cookie_string, cookie_id, action, account_id } = req.body;

    if ((action === 'recheck' || action === 'recheck_all') && (!req.user || req.user.role !== 'admin')) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    if (action === 'recheck' && account_id) {
      const account = await prisma.platformAccount.findUnique({
        where: { id: parseInt(account_id) },
        include: { platform: { select: { name: true } } },
      });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      let raw = account.cookieData ? Buffer.from(account.cookieData, 'base64').toString('utf-8') : '';
      const parsed = raw ? parseRawCookieString(raw) : [];
      const score = parsed.length > 0 ? computeCookieScore(parsed) : 0;
      const expiry = parsed.length > 0 ? extractCookieExpiry(parsed) : null;
      const isExpired = expiry ? new Date(expiry) < new Date() : false;
      const cookieStatus = parsed.length === 0 ? 'MISSING' : isExpired ? 'EXPIRED' : score >= 50 ? 'VALID' : 'WEAK';

      await prisma.platformAccount.update({
        where: { id: parseInt(account_id) },
        data: {
          cookieStatus, intelligenceScore: score,
          stabilityStatus: score >= 70 ? 'STABLE' : score >= 40 ? 'RISKY' : 'DEAD',
          healthStatus: score >= 50 ? 'healthy' : 'degraded',
          lastCheckedAt: nowISO(), updatedAt: nowISO(),
        },
      });

      invalidateAccountCaches();
      emitAdminEvent('slot_updated', { action: 'recheck', account_id: parseInt(account_id) });

      const reason = parsed.length === 0 ? 'No cookie data present'
        : isExpired ? 'Cookies have expired'
        : score >= 70 ? 'All cookies healthy'
        : score >= 50 ? 'Cookies valid but some may be weak'
        : score >= 20 ? 'Low quality cookies detected'
        : 'Critical — cookies are degraded or missing key auth tokens';

      return res.json({
        success: true, account_id: parseInt(account_id),
        cookie_count: parsed.length, score, cookie_status: cookieStatus,
        expires_at: expiry, is_expired: isExpired,
        platform_name: account.platform?.name || 'Unknown',
        reason,
      });
    }

    if (action === 'recheck_all') {
      const { platform_id } = req.body;
      const where = { isActive: 1 };
      if (platform_id) where.platformId = parseInt(platform_id);

      const accounts = await prisma.platformAccount.findMany({ where });
      let checked = 0, updated = 0;
      const statuses = { VALID: 0, WEAK: 0, EXPIRED: 0, DEAD: 0, MISSING: 0 };

      for (const account of accounts) {
        let raw = account.cookieData ? Buffer.from(account.cookieData, 'base64').toString('utf-8') : '';
        const parsed = raw ? parseRawCookieString(raw) : [];
        const score = parsed.length > 0 ? computeCookieScore(parsed) : 0;
        const expiry = parsed.length > 0 ? extractCookieExpiry(parsed) : null;
        const isExpired = expiry ? new Date(expiry) < new Date() : false;
        const cookieStatus = parsed.length === 0 ? 'MISSING' : isExpired ? 'EXPIRED' : score < 20 ? 'DEAD' : score >= 50 ? 'VALID' : 'WEAK';
        const newStability = score >= 70 ? 'STABLE' : score >= 40 ? 'RISKY' : 'DEAD';
        const h = score >= 50 ? 'healthy' : 'degraded';

        statuses[cookieStatus] = (statuses[cookieStatus] || 0) + 1;

        const changed = account.cookieStatus !== cookieStatus || account.intelligenceScore !== score || account.stabilityStatus !== newStability;
        await prisma.platformAccount.update({
          where: { id: account.id },
          data: {
            cookieStatus, intelligenceScore: score,
            stabilityStatus: newStability,
            healthStatus: h, lastCheckedAt: nowISO(), updatedAt: nowISO(),
          },
        });

        if (changed) updated++;
        checked++;
      }

      invalidateAccountCaches();
      emitAdminEvent('accounts_rechecked', { checked, updated, statuses });
      return res.json({
        success: true,
        message: `Rechecked ${checked} accounts`,
        results: { total: checked, updated, statuses },
      });
    }

    let raw = cookie_string;

    if (cookie_id && !raw) {
      const cookie = await prisma.cookieVault.findUnique({ where: { id: parseInt(cookie_id) } });
      if (cookie) raw = Buffer.from(cookie.cookieString, 'base64').toString('utf-8');
    }

    if (!raw) return res.status(400).json({ success: false, message: 'Cookie string required' });

    const parsed = parseRawCookieString(raw);
    const detection = detectPlatformFromCookies(parsed);
    const score = computeCookieScore(parsed);
    const expiry = extractCookieExpiry(parsed);

    const now = new Date();
    let isExpired = false;
    if (expiry) isExpired = new Date(expiry) < now;

    const completeness = classifyCookieCompleteness(parsed, detection?.platform);
    const requirements = detectRequiredSessionComponents(parsed);

    res.json({
      success: true,
      valid: parsed.length > 0 && !isExpired,
      cookie_count: parsed.length,
      score,
      expires_at: expiry,
      is_expired: isExpired,
      detected_platform: detection?.platform || null,
      detected_domain: detection?.domain || null,
      session_analysis: {
        completeness_status: completeness.status,
        completeness_score: completeness.score,
        auth_type: completeness.authType,
        missing_components: completeness.missing,
        present_components: completeness.present,
        needs_storage: completeness.needsStorage,
        needs_tokens: completeness.needsTokens,
        details: completeness.details,
      },
      required_components: requirements,
    });
  } catch (err) {
    console.error('validate_cookie error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/cookie_detect_platform', authenticate, async (req, res) => {
  try {
    const { cookie_string } = req.body;
    if (!cookie_string) return res.status(400).json({ success: false, message: 'Cookie string required' });

    const parsed = parseRawCookieString(cookie_string);
    const detection = detectPlatformFromCookies(parsed);

    if (!detection) return res.json({ success: true, detected: false });

    let platform = await prisma.platform.findFirst({ where: { name: detection.platform } });

    if (!platform && detection.domain) {
      platform = await prisma.platform.create({
        data: {
          name: detection.platform,
          cookieDomain: detection.domain,
          autoDetected: 1, isActive: 1,
        },
      });
    }

    res.json({
      success: true,
      detected: true,
      platform: detection.platform,
      platform_id: platform?.id || null,
      domain: detection.domain,
      auto_created: platform?.autoDetected === 1,
    });
  } catch (err) {
    console.error('cookie_detect_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/cookie_score', authenticate, async (req, res) => {
  try {
    const { cookie_string } = req.body;
    if (!cookie_string) return res.status(400).json({ success: false, message: 'Cookie string required' });

    const parsed = parseRawCookieString(cookie_string);
    const score = computeCookieScore(parsed);
    const expiry = extractCookieExpiry(parsed);

    res.json({ success: true, score, cookie_count: parsed.length, expires_at: expiry });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/generate_netscape_cookie', authenticate, async (req, res) => {
  try {
    const { cookie_string } = req.body;
    if (!cookie_string) return res.status(400).json({ success: false, message: 'Cookie string required' });

    const parsed = parseRawCookieString(cookie_string);
    const netscape = generateNetscape(parsed);

    res.json({ success: true, netscape_format: netscape, cookie_count: parsed.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/cookie_cleanup', authenticate, requireAdmin(), async (req, res) => {
  try {
    const result = await prisma.cookieVault.deleteMany({
      where: {
        OR: [
          { cookieStatus: 'DEAD' },
          { expiresAt: { lt: nowISO() } },
        ],
      },
    });

    res.json({ success: true, message: `Cleaned up ${result.count} cookies` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/platform_health', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action } = req.query;

    if (action === 'detail') {
      const platformId = parseInt(req.query.platform_id);
      if (!platformId) return res.status(400).json({ success: false, message: 'platform_id required' });
      const platform = await prisma.platform.findUnique({
        where: { id: platformId },
        include: {
          platformAccounts: {
            select: {
              id: true, slotName: true, isActive: true, healthStatus: true,
              intelligenceScore: true, stabilityStatus: true,
              successCount: true, failCount: true, cookieStatus: true,
              lastSuccessAt: true, lastFailedAt: true, expiresAt: true, createdAt: true,
              lastVerifiedAt: true,
            },
            orderBy: { intelligenceScore: 'desc' },
            take: 50,
          },
          _count: {
            select: {
              accountSessions: { where: { status: 'active' } },
              subscriptions: { where: { isActive: 1 } },
              platformAccounts: true,
            },
          },
        },
      });
      if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });
      const { score, activeCount, healthyCount } = computePlatformHealth(platform.platformAccounts);
      const status = classifyPlatformStatus(platform, activeCount, score);
      return res.json({
        success: true,
        platform: {
          id: platform.id, name: platform.name,
          logo_url: platform.logoUrl || '', bg_color_hex: platform.bgColorHex || '#4F46E5',
          cookie_domain: platform.cookieDomain || '', login_url: platform.loginUrl || '',
          is_active: platform.isActive, auto_detected: platform.autoDetected,
          health_score: score, health_status: status,
          status_reason: statusReason(status, score, activeCount, platform._count.platformAccounts, platform.lastHealthCheck),
          last_health_check: platform.lastHealthCheck,
          total_accounts: platform._count.platformAccounts,
          active_accounts: activeCount, healthy_accounts: healthyCount,
          active_sessions: platform._count.accountSessions,
          active_subscribers: platform._count.subscriptions,
          accounts: platform.platformAccounts.map(a => ({
            id: a.id, slot_name: a.slotName, is_active: a.isActive,
            health_status: a.healthStatus, intelligence_score: a.intelligenceScore || 0,
            stability: a.stabilityStatus, cookie_status: a.cookieStatus,
            success_count: a.successCount, fail_count: a.failCount,
            last_success: a.lastSuccessAt, last_failed: a.lastFailedAt,
            last_verified: a.lastVerifiedAt, expires_at: a.expiresAt,
            created_at: a.createdAt,
          })),
        },
      });
    }

    if (action === 'delete_impact') {
      const platformId = parseInt(req.query.platform_id);
      if (!platformId) return res.status(400).json({ success: false, message: 'platform_id required' });
      const [accounts, sessions, subs] = await Promise.all([
        prisma.platformAccount.count({ where: { platformId } }),
        prisma.accountSession.count({ where: { platformId, status: 'active' } }),
        prisma.userSubscription.count({ where: { platformId, isActive: 1 } }),
      ]);
      return res.json({
        success: true,
        impact: { accounts, active_sessions: sessions, active_subscriptions: subs, has_active_usage: sessions > 0 || subs > 0 },
      });
    }

    if (action === 'job_status') {
      const jobId = req.query.job_id;
      if (!jobId) return res.json({ success: true, ...platformHealthQueue.getAll() });
      const status = platformHealthQueue.getStatus(jobId);
      return res.json({ success: true, job: status });
    }

    const cached = platformCache.get('platform:dashboard');
    if (cached) return res.json(cached);

    const platforms = await prisma.platform.findMany({
      include: {
        platformAccounts: {
          select: { isActive: true, healthStatus: true, successCount: true, failCount: true, intelligenceScore: true },
        },
        _count: {
          select: {
            accountSessions: { where: { status: 'active' } },
            subscriptions: { where: { isActive: 1 } },
            platformAccounts: true,
          },
        },
      },
    });

    const health = platforms.map(p => {
      const { score, activeCount, healthyCount } = computePlatformHealth(p.platformAccounts);
      const status = classifyPlatformStatus(p, activeCount, score);
      return {
        id: p.id, name: p.name, health_score: score,
        health_status: status,
        status_reason: statusReason(status, score, activeCount, p._count.platformAccounts, p.lastHealthCheck),
        logo_url: p.logoUrl || '', bg_color_hex: p.bgColorHex || '#4F46E5',
        cookie_domain: p.cookieDomain || '',
        is_active: p.isActive, auto_detected: p.autoDetected,
        slot_count: p._count.platformAccounts,
        active_accounts: activeCount, healthy_accounts: healthyCount,
        active_users: p._count.subscriptions,
        active_sessions: p._count.accountSessions,
        last_health_check: p.lastHealthCheck,
      };
    });

    const summary = {
      total: health.length,
      healthy: health.filter(h => h.health_status === 'healthy').length,
      degraded: health.filter(h => h.health_status === 'degraded').length,
      unused: health.filter(h => h.health_status === 'unused').length,
      inactive: health.filter(h => h.health_status === 'inactive').length,
      dead: health.filter(h => h.health_status === 'dead').length,
    };

    const queueStatus = platformHealthQueue.getAll();

    const result = { success: true, platforms: health, summary, queue_status: queueStatus };
    platformCache.set('platform:dashboard', result, 15000);
    return res.json(result);
  } catch (err) {
    console.error('platform_health error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/platform_health', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action } = req.body;

    if (action === 'run_health_check') {
      const queueState = platformHealthQueue.getAll();
      if (queueState.stats.running > 0 || queueState.stats.pending > 0) {
        return res.json({ success: false, message: 'Health check already running' });
      }

      const jobId = platformHealthQueue.add('platform_health_check', async (data, updateProgress) => {
        const platforms = await prisma.platform.findMany({
          include: {
            platformAccounts: {
              select: { id: true, isActive: true, successCount: true, failCount: true, intelligenceScore: true, cookieStatus: true },
            },
          },
        });

        const now = nowISO();
        let processed = 0;
        const total = platforms.length;
        const updates = [];

        for (const p of platforms) {
          const { score, activeCount } = computePlatformHealth(p.platformAccounts);
          const status = classifyPlatformStatus(p, activeCount, score);
          updates.push({ id: p.id, score, status });

          if (updates.length >= BATCH_SIZE || processed + 1 === total) {
            await prisma.$transaction(
              updates.map(u => prisma.platform.update({
                where: { id: u.id },
                data: { healthScore: u.score, healthStatus: u.status, lastHealthCheck: now },
              }))
            );
            updates.length = 0;
          }

          processed++;
          updateProgress(Math.round((processed / total) * 100));
        }

        platformCache.invalidate('platform:dashboard');
        emitAdminEvent('platform_health_complete', { total: platforms.length });

        return { total: platforms.length };
      });

      await prisma.activityLog.create({
        data: { userId: req.user.id, action: 'Started platform health check', ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return res.json({ success: true, message: 'Health check started', job_id: jobId });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error('platform_health POST error:', err);
    res.status(500).json({ success: false, message: 'Health check failed' });
  }
});

export default router;
