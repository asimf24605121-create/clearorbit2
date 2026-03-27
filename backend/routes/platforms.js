import { Router } from 'express';
import { prisma, emitAdminEvent } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { nowISO } from '../utils/helpers.js';
import {
  parseRawCookieString, detectPlatformFromCookies, generateNetscape,
  extractCookieExpiry, computeCookieScore,
  classifyCookieCompleteness, detectRequiredSessionComponents,
} from '../utils/cookieEngine.js';
import { invalidateAccountCaches } from '../utils/cache.js';
import { recheckLimiter } from '../middleware/rateLimit.js';

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

    await prisma.platform.delete({ where: { id: parseInt(platform_id) } });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Deleted platform ID: ${platform_id}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Platform deleted' });
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
    await prisma.platform.update({ where: { id: platform.id }, data: { isActive: newStatus } });

    res.json({ success: true, message: `Platform ${newStatus ? 'enabled' : 'disabled'}`, is_active: newStatus });
  } catch (err) {
    console.error('toggle_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/upload_logo', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, logo_url } = req.body;
    if (!platform_id || !logo_url) return res.status(400).json({ success: false, message: 'Platform ID and logo URL required' });

    await prisma.platform.update({
      where: { id: parseInt(platform_id) },
      data: { logoUrl: logo_url },
    });

    res.json({ success: true, message: 'Logo updated' });
  } catch (err) {
    console.error('upload_logo error:', err);
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
      return res.json({
        success: true, account_id: parseInt(account_id),
        cookie_count: parsed.length, score, cookie_status: cookieStatus,
        expires_at: expiry, is_expired: isExpired,
        platform_name: account.platform?.name || 'Unknown',
      });
    }

    if (action === 'recheck_all') {
      const accounts = await prisma.platformAccount.findMany({ where: { isActive: 1 } });
      let checked = 0, healthy = 0, degraded = 0;

      for (const account of accounts) {
        let raw = account.cookieData ? Buffer.from(account.cookieData, 'base64').toString('utf-8') : '';
        const parsed = raw ? parseRawCookieString(raw) : [];
        const score = parsed.length > 0 ? computeCookieScore(parsed) : 0;
        const expiry = parsed.length > 0 ? extractCookieExpiry(parsed) : null;
        const isExpired = expiry ? new Date(expiry) < new Date() : false;
        const cookieStatus = parsed.length === 0 ? 'MISSING' : isExpired ? 'EXPIRED' : score >= 50 ? 'VALID' : 'WEAK';
        const h = score >= 50 ? 'healthy' : 'degraded';

        await prisma.platformAccount.update({
          where: { id: account.id },
          data: {
            cookieStatus, intelligenceScore: score,
            stabilityStatus: score >= 70 ? 'STABLE' : score >= 40 ? 'RISKY' : 'DEAD',
            healthStatus: h, lastCheckedAt: nowISO(), updatedAt: nowISO(),
          },
        });

        if (h === 'healthy') healthy++; else degraded++;
        checked++;
      }

      invalidateAccountCaches();
      emitAdminEvent('accounts_rechecked', { checked, healthy, degraded });
      return res.json({ success: true, message: `Rechecked ${checked} accounts`, total: checked, healthy, degraded });
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
    const platforms = await prisma.platform.findMany({
      include: {
        platformAccounts: {
          select: { isActive: true, healthStatus: true, successCount: true, failCount: true },
        },
        _count: { select: { subscriptions: { where: { isActive: 1 } } } },
      },
    });

    const health = platforms.map(p => {
      const accounts = p.platformAccounts;
      const active = accounts.filter(a => a.isActive).length;
      const healthy = accounts.filter(a => a.healthStatus === 'healthy').length;
      const totalSuccess = accounts.reduce((s, a) => s + a.successCount, 0);
      const totalFail = accounts.reduce((s, a) => s + a.failCount, 0);
      const score = totalSuccess + totalFail > 0 ? Math.round((totalSuccess / (totalSuccess + totalFail)) * 100) : 100;
      const status = active === 0 ? 'dead' : score >= 80 ? 'active' : score >= 50 ? 'warning' : 'dead';

      return {
        id: p.id, name: p.name, health_score: score,
        health_status: status,
        logo_url: p.logoUrl || '', bg_color_hex: p.bgColorHex || '#4F46E5',
        cookie_domain: p.cookieDomain || '',
        is_active: p.isActive, auto_detected: p.autoDetected,
        active_accounts: active, healthy_accounts: healthy,
        total_accounts: p.totalAccounts,
        total_success: totalSuccess, total_fail: totalFail,
        active_subscribers: p._count.subscriptions,
        last_health_check: p.lastHealthCheck,
      };
    });

    const summary = {
      total: health.length,
      active: health.filter(h => h.health_status === 'active').length,
      warning: health.filter(h => h.health_status === 'warning').length,
      dead: health.filter(h => h.health_status === 'dead').length,
    };

    res.json({ success: true, platforms: health, summary });
  } catch (err) {
    console.error('platform_health error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/platform_health', authenticate, requireAdmin(), async (req, res) => {
  try {
    const platforms = await prisma.platform.findMany({
      include: {
        platformAccounts: {
          select: { id: true, isActive: true, successCount: true, failCount: true, cookieStatus: true },
        },
      },
    });

    const now = nowISO();
    let healthyCount = 0, warningCount = 0, deadCount = 0;

    for (const p of platforms) {
      const accounts = p.platformAccounts;
      const active = accounts.filter(a => a.isActive).length;
      const totalSuccess = accounts.reduce((s, a) => s + a.successCount, 0);
      const totalFail = accounts.reduce((s, a) => s + a.failCount, 0);
      const score = totalSuccess + totalFail > 0 ? Math.round((totalSuccess / (totalSuccess + totalFail)) * 100) : (active > 0 ? 100 : 0);
      const status = active === 0 ? 'dead' : score >= 80 ? 'active' : score >= 50 ? 'warning' : 'dead';

      if (status === 'active') healthyCount++;
      else if (status === 'warning') warningCount++;
      else deadCount++;

      await prisma.platform.update({
        where: { id: p.id },
        data: { healthScore: score, healthStatus: status, lastHealthCheck: now },
      });

      for (const acc of accounts) {
        const accScore = acc.successCount + acc.failCount > 0
          ? Math.round((acc.successCount / (acc.successCount + acc.failCount)) * 100) : 100;
        const accHealth = accScore >= 80 ? 'healthy' : accScore >= 50 ? 'degraded' : 'unhealthy';
        await prisma.platformAccount.update({
          where: { id: acc.id },
          data: { healthStatus: accHealth },
        });
      }
    }

    res.json({
      success: true,
      message: `Health check complete: ${healthyCount} healthy, ${warningCount} warning, ${deadCount} dead`,
    });
  } catch (err) {
    console.error('platform_health POST error:', err);
    res.status(500).json({ success: false, message: 'Health check failed' });
  }
});

export default router;
