import { Router } from 'express';
import { prisma, emitAdminEvent } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { nowISO, cutoffISO, paginate } from '../utils/helpers.js';
import { sessionStore } from '../utils/sessionStore.js';
import { parseRawCookieString, computeCookieScore, extractCookieExpiry, detectPlatformFromCookies, generateFingerprint, classifyCookieCompleteness, detectRequiredSessionComponents } from '../utils/cookieEngine.js';
import { getAdapter, getAllAdapters, checkSessionCompleteness, detectMissingComponents } from '../adapters/registry.js';
import { logAdminAction, getSetting, setSetting } from '../utils/auditLog.js';
import { accountCache, intelligenceCache, invalidateAccountCaches, getCacheStats } from '../utils/cache.js';
import { accountQueue, intelligenceQueue, importQueue, getQueues } from '../utils/jobQueue.js';
import { withSlotLock, getActiveLocks } from '../utils/slotLock.js';
import { importLimiter, recheckLimiter, intelligenceLimiter, deleteLimiter, adminActionLimiter } from '../middleware/rateLimit.js';
import { massAssignmentGuard } from '../middleware/sanitize.js';

const router = Router();

function classifyStability(score) {
  if (score >= 70) return 'STABLE';
  if (score >= 40) return 'RISKY';
  return 'DEAD';
}

function computeIntelligenceScore(account) {
  const total = (account.successCount || 0) + (account.failCount || 0);

  let successComponent = 50;
  if (total > 0) {
    successComponent = Math.round(((account.successCount || 0) / total) * 100);
  }

  const now = Date.now();

  let recencyComponent = 50;
  if (account.lastSuccessAt) {
    const hoursSinceSuccess = (now - new Date(account.lastSuccessAt).getTime()) / 3600000;
    const decayFactor = Math.exp(-hoursSinceSuccess / 168);
    recencyComponent = Math.round(100 * decayFactor);
  } else if (account.createdAt) {
    const daysSinceCreation = (now - new Date(account.createdAt).getTime()) / 86400000;
    recencyComponent = daysSinceCreation < 7 ? 70 : daysSinceCreation < 30 ? 40 : 20;
  }

  let cookieComponent = 50;
  if (account.cookieCount >= 10) cookieComponent = 100;
  else if (account.cookieCount >= 5) cookieComponent = 80;
  else if (account.cookieCount >= 2) cookieComponent = 60;
  else if (account.cookieCount >= 1) cookieComponent = 40;
  else cookieComponent = 10;

  let expiryComponent = 50;
  if (account.expiresAt) {
    const daysLeft = (new Date(account.expiresAt).getTime() - now) / 86400000;
    if (daysLeft <= 0) expiryComponent = 0;
    else if (daysLeft <= 3) expiryComponent = 20;
    else if (daysLeft <= 7) expiryComponent = 40;
    else if (daysLeft <= 30) expiryComponent = 70;
    else expiryComponent = 100;
  }

  let loginComponent = 50;
  const ls = (account.loginStatus || 'PENDING').toUpperCase();
  if (ls === 'VALID') loginComponent = 100;
  else if (ls === 'PARTIAL') loginComponent = 60;
  else if (ls === 'INVALID') loginComponent = 0;

  let confidenceMultiplier = 1.0;
  if (total < 3) confidenceMultiplier = 0.6;
  else if (total < 10) confidenceMultiplier = 0.8;
  else if (total < 30) confidenceMultiplier = 0.9;

  let anomalyPenalty = 0;
  if (account.failCount >= 3) {
    const recentFailRatio = total > 0 ? (account.failCount / total) : 0;
    if (recentFailRatio > 0.7) anomalyPenalty = 15;
    else if (recentFailRatio > 0.5) anomalyPenalty = 10;
    else if (recentFailRatio > 0.3) anomalyPenalty = 5;
  }

  let streakBonus = 0;
  if (account.successCount >= 10 && (account.failCount || 0) === 0) streakBonus = 10;
  else if (account.successCount >= 5 && account.failCount <= 1) streakBonus = 5;

  let recoveryBonus = 0;
  if (account.lastFailedAt && account.lastSuccessAt) {
    const lastFail = new Date(account.lastFailedAt).getTime();
    const lastSuccess = new Date(account.lastSuccessAt).getTime();
    if (lastSuccess > lastFail) {
      const hoursSinceRecovery = (now - lastSuccess) / 3600000;
      if (hoursSinceRecovery < 24) recoveryBonus = 8;
      else if (hoursSinceRecovery < 72) recoveryBonus = 4;
    }
  }

  const rawScore = Math.round(
    successComponent * 0.35 +
    recencyComponent * 0.20 +
    cookieComponent * 0.15 +
    expiryComponent * 0.15 +
    loginComponent * 0.10 +
    (50 * 0.05)
  );

  const adjustedScore = Math.round(
    (rawScore * confidenceMultiplier) - anomalyPenalty + streakBonus + recoveryBonus
  );

  return Math.max(0, Math.min(100, adjustedScore));
}

function getSessionTimestamp(s) {
  const lat = Number(s.lastActiveAt || s.lastActiveAt);
  if (lat > 0) return lat;
  return new Date(s.lastActive).getTime();
}

function enrichAccountWithSessions(a, staleCutoff) {
  const base = enrichAccount(a);
  const sessions = a.accountSessions || [];
  const cutoffTime = new Date(staleCutoff).getTime();
  const freshSessions = sessions.filter(s => getSessionTimestamp(s) > cutoffTime);
  const staleSessions = sessions.filter(s => getSessionTimestamp(s) <= cutoffTime);
  const maxUsers = a.maxUsers ?? 1;

  const lastHeartbeat = sessions.length > 0 ? sessions[0].lastActive : null;

  const identityMap = new Map();
  for (const s of freshSessions) {
    const key = `${s.userId}|${s.platformId}|${s.sessionKey || ''}|${s.ipAddress || ''}`;
    const existing = identityMap.get(key);
    if (!existing || getSessionTimestamp(s) > getSessionTimestamp(existing)) {
      identityMap.set(key, s);
    }
  }
  const dedupedSessions = Array.from(identityMap.values());

  const uniqueUsers = new Set(dedupedSessions.map(s => s.userId)).size;
  const uniqueIps = new Set(dedupedSessions.map(s => s.ipAddress).filter(Boolean)).size;
  const slotCount = dedupedSessions.length;

  base.fresh_sessions = slotCount;
  base.stale_sessions = staleSessions.length;
  base.free_slots = Math.max(0, maxUsers - slotCount);
  base.last_heartbeat = lastHeartbeat;
  base.unique_active_users = uniqueUsers;
  base.active_users = slotCount;
  base.active_sessions = slotCount;
  base.unique_ips = uniqueIps;
  base.session_details = dedupedSessions.map(s => ({
    id: s.id,
    user_id: s.userId,
    device: s.deviceType || '',
    ip: s.ipAddress || '',
    last_active: s.lastActive,
    started: s.createdAt,
  }));
  return base;
}

function enrichAccount(a) {
  const now = new Date();
  const activeSessions = a._count?.accountSessions ?? 0;
  const expiresAt = a.expiresAt ? new Date(a.expiresAt) : null;
  const isExpired = expiresAt ? expiresAt < now : false;
  let daysRemaining = null;
  let expiryStatus = 'ACTIVE';
  if (expiresAt) {
    daysRemaining = Math.ceil((expiresAt - now) / 86400000);
    if (isExpired) expiryStatus = 'EXPIRED';
    else if (daysRemaining <= 7) expiryStatus = 'EXPIRING_SOON';
  }
  return {
    id: a.id, platform_id: a.platformId, platform_name: a.platform?.name || 'Unknown',
    platform_logo: a.platform?.logoUrl || '', platform_color: a.platform?.bgColorHex || '#6C5CE7',
    slot_name: a.slotName || 'Unnamed Slot', max_users: a.maxUsers ?? 1, is_active: a.isActive ?? 1,
    cookie_count: a.cookieCount ?? 0, expires_at: a.expiresAt || null,
    success_count: a.successCount ?? 0, fail_count: a.failCount ?? 0,
    health_status: a.healthStatus || 'healthy', cookie_status: a.cookieStatus || 'VALID',
    login_status: a.loginStatus || 'PENDING', intelligence_score: a.intelligenceScore ?? 0,
    slot_score: a.intelligenceScore ?? 0,
    stability_status: (a.stabilityStatus || 'UNKNOWN').toUpperCase(),
    profile_index: a.profileIndex ?? 1, cookie_id: a.cookieId || null,
    fingerprint: a.fingerprint || null,
    active_sessions: activeSessions, active_users: activeSessions,
    created_at: a.createdAt || '', updated_at: a.updatedAt || '',
    is_expired: isExpired, days_remaining: daysRemaining, expiry_status: expiryStatus,
    cooldown_until: a.cooldownUntil || null,
    last_verified_at: a.lastVerifiedAt || null, last_checked_at: a.lastCheckedAt || null,
    auth_type: a.authType || 'cookie',
    verification_status: a.verificationStatus || 'IMPORTED',
    verification_method: a.verificationMethod || null,
    has_storage_data: !!a.storageData,
    has_auth_headers: !!a.authHeaders,
  };
}

router.get('/manage_platform_accounts', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, page, per_page, sort_by, sort_dir, status, stability, search } = req.query;
    const cacheKey = `accounts:${platform_id || 'all'}:${page || 1}:${per_page || 20}:${sort_by || ''}:${sort_dir || ''}:${status || ''}:${stability || ''}:${search || ''}`;

    const cached = accountCache.get(cacheKey);
    if (cached) return res.json(cached);

    const where = {};
    if (platform_id && platform_id !== '0') where.platformId = parseInt(platform_id);
    if (status === 'active') where.isActive = 1;
    else if (status === 'inactive') where.isActive = 0;
    if (stability) where.stabilityStatus = stability.toUpperCase();
    if (search) where.slotName = { contains: search };

    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const orderBy = {};
    const sortField = sort_by || 'createdAt';
    const validFields = ['createdAt', 'intelligenceScore', 'slotName', 'maxUsers', 'cookieCount', 'successCount'];
    orderBy[validFields.includes(sortField) ? sortField : 'createdAt'] = sort_dir === 'asc' ? 'asc' : 'desc';

    const [accounts, total] = await Promise.all([
      prisma.platformAccount.findMany({
        where,
        include: {
          platform: { select: { name: true, logoUrl: true, bgColorHex: true } },
          _count: { select: { accountSessions: { where: { status: 'active' } } } },
          accountSessions: {
            where: { status: 'active' },
            select: { id: true, lastActive: true, lastActiveAt: true, userId: true, platformId: true, sessionKey: true, ipAddress: true, deviceType: true, createdAt: true },
            orderBy: { lastActive: 'desc' },
          },
        },
        orderBy,
        skip, take,
      }),
      prisma.platformAccount.count({ where }),
    ]);

    const staleCutoff = cutoffISO(30);
    const response = {
      success: true,
      accounts: accounts.map(a => enrichAccountWithSessions(a, staleCutoff)),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    };

    accountCache.set(cacheKey, response, 30000);
    res.json(response);
  } catch (err) {
    console.error('manage_platform_accounts GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/manage_platform_accounts', authenticate, requireAdmin(), massAssignmentGuard('manage_platform_accounts'), async (req, res) => {
  try {
    const { action } = req.body;
    const adminId = req.user?.id || 0;
    const ip = req.ip;

    const _ok = (data) => {
      invalidateAccountCaches();
      if (data.message) emitAdminEvent('slot_updated', { action, adminId, message: data.message });
      return res.json({ success: true, ...data });
    };

    if (action === 'add' || action === 'create') {
      const { platform_id, slot_name, cookie_data, max_users, profile_index, expires_at,
              localStorage: addLocalStorage, sessionStorage: addSessionStorage, authHeaders: addAuthHeaders, authType: addAuthType } = req.body;
      if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

      let cookieCount = 0;
      let computedExpiry = expires_at || null;
      let score = 0;
      let fp = null;
      if (cookie_data) {
        const parsed = parseRawCookieString(cookie_data);
        cookieCount = parsed.length;
        score = computeCookieScore(parsed);
        const cookieExpiry = extractCookieExpiry(parsed);
        if (!computedExpiry && cookieExpiry) computedExpiry = cookieExpiry;
        fp = generateFingerprint(cookie_data);

        if (fp) {
          const existing = await prisma.platformAccount.findFirst({ where: { fingerprint: fp, platformId: parseInt(platform_id) } });
          if (existing) return res.json({ success: false, message: 'Duplicate cookie detected. This cookie already exists for this platform.', duplicate: true });
        }
      }

      if (!computedExpiry) {
        const defaultDays = parseInt(await getSetting('default_expiry_days', '30'));
        const d = new Date();
        d.setDate(d.getDate() + defaultDays);
        computedExpiry = d.toISOString().replace('T', ' ').substring(0, 19);
      }

      const addStoragePayload = (addLocalStorage || addSessionStorage) ? JSON.stringify({
        localStorage: addLocalStorage || {},
        sessionStorage: addSessionStorage || {},
      }) : null;
      const addHeadersPayload = addAuthHeaders ? JSON.stringify(addAuthHeaders) : null;

      const account = await prisma.platformAccount.create({
        data: {
          platformId: parseInt(platform_id),
          slotName: slot_name || 'Login 1',
          cookieData: cookie_data ? Buffer.from(cookie_data).toString('base64') : '',
          maxUsers: Math.max(1, Math.min(parseInt(max_users) || 5, 50)),
          cookieCount, expiresAt: computedExpiry,
          intelligenceScore: score, stabilityStatus: classifyStability(score),
          profileIndex: parseInt(profile_index) || 1,
          fingerprint: fp,
          storageData: addStoragePayload,
          authHeaders: addHeadersPayload,
          authType: addAuthType || 'cookie',
          verificationStatus: 'IMPORTED',
          isActive: 1, createdAt: nowISO(), updatedAt: nowISO(),
        },
      });

      await prisma.platform.update({
        where: { id: parseInt(platform_id) },
        data: { totalAccounts: { increment: 1 } },
      });

      await logAdminAction(adminId, 'create_slot', 'PlatformAccount', account.id, { slot_name: account.slotName, platform_id }, ip);
      return _ok({ message: 'Account added', account_id: account.id });
    }

    if (action === 'update') {
      const { account_id, slot_name, cookie_data, max_users, profile_index, is_active, expires_at,
              localStorage: updLocalStorage, sessionStorage: updSessionStorage, authHeaders: updAuthHeaders, authType: updAuthType } = req.body;
      if (!account_id) return res.status(400).json({ success: false, message: 'Account ID required' });

      const data = { updatedAt: nowISO() };
      if (slot_name !== undefined) data.slotName = slot_name;
      if (max_users !== undefined) data.maxUsers = Math.max(1, Math.min(parseInt(max_users), 50));
      if (profile_index !== undefined) data.profileIndex = parseInt(profile_index);
      if (is_active !== undefined) data.isActive = parseInt(is_active) ? 1 : 0;
      if (expires_at !== undefined) data.expiresAt = expires_at || null;
      if (updLocalStorage !== undefined || updSessionStorage !== undefined) {
        data.storageData = JSON.stringify({ localStorage: updLocalStorage || {}, sessionStorage: updSessionStorage || {} });
      }
      if (updAuthHeaders !== undefined) data.authHeaders = JSON.stringify(updAuthHeaders);
      if (updAuthType !== undefined) data.authType = updAuthType;

      if (cookie_data !== undefined && cookie_data) {
        data.cookieData = Buffer.from(cookie_data).toString('base64');
        const parsed = parseRawCookieString(cookie_data);
        data.cookieCount = parsed.length;
        data.intelligenceScore = computeCookieScore(parsed);
        data.stabilityStatus = classifyStability(data.intelligenceScore);
        const exp = extractCookieExpiry(parsed);
        if (exp) data.expiresAt = exp;
        data.fingerprint = generateFingerprint(cookie_data);
      }

      await prisma.platformAccount.update({ where: { id: parseInt(account_id) }, data });
      await logAdminAction(adminId, 'update_slot', 'PlatformAccount', parseInt(account_id), { fields: Object.keys(data) }, ip);
      return _ok({ message: 'Account updated' });
    }

    if (action === 'delete') {
      const { account_id } = req.body;
      if (!account_id) return res.status(400).json({ success: false, message: 'Account ID required' });

      const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
      if (account) {
        await prisma.platformAccount.delete({ where: { id: parseInt(account_id) } });
        await prisma.platform.update({
          where: { id: account.platformId },
          data: { totalAccounts: { decrement: 1 } },
        });
        await logAdminAction(adminId, 'delete_slot', 'PlatformAccount', parseInt(account_id), { slot_name: account.slotName }, ip);
      }
      return _ok({ message: 'Account deleted' });
    }

    if (action === 'toggle') {
      const { account_id } = req.body;
      if (!account_id) return res.status(400).json({ success: false, message: 'Account ID required' });

      const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      const newStatus = account.isActive ? 0 : 1;
      await prisma.platformAccount.update({ where: { id: account.id }, data: { isActive: newStatus, updatedAt: nowISO() } });
      await logAdminAction(adminId, 'toggle_slot', 'PlatformAccount', account.id, { is_active: newStatus }, ip);
      return _ok({ message: `Account ${newStatus ? 'enabled' : 'disabled'}` });
    }

    if (action === 'delete_by_platform') {
      const { platform_id } = req.body;
      if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

      const pid = parseInt(platform_id);
      await prisma.accountSession.deleteMany({ where: { platformId: pid } });
      await prisma.accountIntelligenceLog.deleteMany({ where: { platformId: pid } });
      const { count } = await prisma.platformAccount.deleteMany({ where: { platformId: pid } });
      await prisma.platform.update({ where: { id: pid }, data: { totalAccounts: 0 } });
      await logAdminAction(adminId, 'delete_platform_slots', 'Platform', pid, { count }, ip);
      return _ok({ message: `${count} slot(s) deleted for platform` });
    }

    if (action === 'delete_selected' || action === 'delete_multiple') {
      const rawIds = req.body.account_ids || req.body.ids;
      if (!rawIds || !Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Account IDs required' });
      }

      const ids = rawIds.map(Number).filter(Boolean);
      const accounts = await prisma.platformAccount.findMany({
        where: { id: { in: ids } },
        select: { platformId: true },
      });

      await prisma.accountSession.deleteMany({ where: { accountId: { in: ids } } });
      await prisma.accountIntelligenceLog.deleteMany({ where: { accountId: { in: ids } } });
      const { count } = await prisma.platformAccount.deleteMany({ where: { id: { in: ids } } });

      const platformIds = [...new Set(accounts.map(a => a.platformId))];
      for (const pid of platformIds) {
        const remaining = await prisma.platformAccount.count({ where: { platformId: pid } });
        await prisma.platform.update({ where: { id: pid }, data: { totalAccounts: remaining } });
      }

      await logAdminAction(adminId, 'delete_multiple_slots', 'PlatformAccount', null, { ids, count }, ip);
      return _ok({ message: `${count} slot(s) deleted` });
    }

    if (action === 'replace_cookie') {
      const { account_id, cookie_data } = req.body;
      if (!account_id || !cookie_data) return res.status(400).json({ success: false, message: 'Account ID and cookie data required' });

      const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      const parsed = parseRawCookieString(cookie_data);
      if (parsed.length === 0) return res.json({ success: false, message: 'No valid cookies found in input' });

      const score = computeCookieScore(parsed);
      const expiry = extractCookieExpiry(parsed);
      const encoded = Buffer.from(cookie_data).toString('base64');
      const fp = generateFingerprint(cookie_data);

      let cascadedCount = 0;

      if (account.cookieId) {
        await prisma.cookieVault.update({
          where: { id: account.cookieId },
          data: { cookieString: encoded, cookieCount: parsed.length, score, expiresAt: expiry, fingerprint: fp, cookieStatus: 'VALID', updatedAt: nowISO() },
        });

        const linkedAccounts = await prisma.platformAccount.findMany({ where: { cookieId: account.cookieId } });
        for (const linked of linkedAccounts) {
          await prisma.platformAccount.update({
            where: { id: linked.id },
            data: {
              cookieData: encoded, cookieCount: parsed.length, intelligenceScore: score,
              cookieStatus: 'VALID', loginStatus: 'PENDING', fingerprint: fp,
              expiresAt: expiry, stabilityStatus: classifyStability(score), updatedAt: nowISO(),
            },
          });
          cascadedCount++;
        }
      } else {
        const cookie = await prisma.cookieVault.create({
          data: { platformId: account.platformId, cookieString: encoded, cookieCount: parsed.length, score, expiresAt: expiry, fingerprint: fp, updatedAt: nowISO() },
        });

        await prisma.platformAccount.update({
          where: { id: account.id },
          data: {
            cookieData: encoded, cookieCount: parsed.length, cookieId: cookie.id,
            intelligenceScore: score, cookieStatus: 'VALID', loginStatus: 'PENDING',
            fingerprint: fp, expiresAt: expiry, stabilityStatus: classifyStability(score), updatedAt: nowISO(),
          },
        });
        cascadedCount = 1;
      }

      await logAdminAction(adminId, 'replace_cookie', 'PlatformAccount', parseInt(account_id), { cascaded: cascadedCount }, ip);
      return _ok({ message: `Cookie replaced. ${cascadedCount} slot(s) updated.`, cascaded_count: cascadedCount });
    }

    if (action === 'extend') {
      const { account_id, days } = req.body;
      if (!account_id || !days) return res.status(400).json({ success: false, message: 'Account ID and days required' });

      const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      const currentExpiry = account.expiresAt ? new Date(account.expiresAt) : new Date();
      const base = currentExpiry > new Date() ? currentExpiry : new Date();
      base.setDate(base.getDate() + parseInt(days));
      const newExpiry = base.toISOString().replace('T', ' ').substring(0, 19);

      await prisma.platformAccount.update({
        where: { id: parseInt(account_id) },
        data: { expiresAt: newExpiry, updatedAt: nowISO() },
      });

      await logAdminAction(adminId, 'extend_slot', 'PlatformAccount', parseInt(account_id), { days, new_expiry: newExpiry }, ip);
      return _ok({ message: `Extended by ${days} day(s). New expiry: ${newExpiry}` });
    }

    if (action === 'extend_multiple') {
      const { ids, days } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0 || !days) {
        return res.status(400).json({ success: false, message: 'IDs and days required' });
      }

      const parsedDays = parseInt(days);
      let extended = 0;
      for (const id of ids.map(Number).filter(Boolean)) {
        const account = await prisma.platformAccount.findUnique({ where: { id } });
        if (!account) continue;
        const currentExpiry = account.expiresAt ? new Date(account.expiresAt) : new Date();
        const base = currentExpiry > new Date() ? currentExpiry : new Date();
        base.setDate(base.getDate() + parsedDays);
        await prisma.platformAccount.update({
          where: { id },
          data: { expiresAt: base.toISOString().replace('T', ' ').substring(0, 19), updatedAt: nowISO() },
        });
        extended++;
      }

      await logAdminAction(adminId, 'extend_multiple', 'PlatformAccount', null, { ids, days: parsedDays, extended }, ip);
      return _ok({ message: `${extended} slot(s) extended by ${parsedDays} day(s)` });
    }

    if (action === 'reset_stats') {
      const { account_id } = req.body;
      if (!account_id) return res.status(400).json({ success: false, message: 'Account ID required' });

      await prisma.platformAccount.update({
        where: { id: parseInt(account_id) },
        data: {
          successCount: 0, failCount: 0,
          intelligenceScore: 50, stabilityStatus: 'UNKNOWN',
          healthStatus: 'healthy', cookieStatus: 'VALID', loginStatus: 'PENDING',
          verificationStatus: 'IMPORTED', verificationMethod: null,
          lastSuccessAt: null, lastFailedAt: null, updatedAt: nowISO(),
        },
      });

      await logAdminAction(adminId, 'reset_stats', 'PlatformAccount', parseInt(account_id), {}, ip);
      return _ok({ message: 'Stats reset successfully' });
    }

    if (action === 'get_settings') {
      const defaultExpiry = await getSetting('default_expiry_days', '30');
      return res.json({ success: true, default_expiry_days: parseInt(defaultExpiry) });
    }

    if (action === 'update_settings') {
      const { default_expiry_days } = req.body;
      if (default_expiry_days !== undefined) {
        const val = Math.max(1, Math.min(parseInt(default_expiry_days) || 30, 365));
        await setSetting('default_expiry_days', val);
      }
      await logAdminAction(adminId, 'update_settings', 'SystemSettings', null, { default_expiry_days }, ip);
      return _ok({ message: 'Settings updated' });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    console.error('manage_platform_accounts POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_account_unified', authenticate, requireAdmin(), importLimiter, massAssignmentGuard('add_account_unified'), async (req, res) => {
  try {
    const { action, platform_id, cookie_data, cookie_string, slot_name, max_users, slot_count, profile_index,
            localStorage: importLocalStorage, sessionStorage: importSessionStorage, authHeaders: importAuthHeaders, authType: importAuthType } = req.body;
    const raw = cookie_string || cookie_data;
    const adminId = req.user?.id || 0;
    const ip = req.ip;

    if (action === 'auto_setup') {
      if (!raw) return res.status(400).json({ success: false, message: 'Cookie data required' });

      const parsed = parseRawCookieString(raw);
      if (parsed.length === 0) return res.json({ success: false, message: 'No valid cookies found in input' });

      const detection = detectPlatformFromCookies(parsed);
      let detectedPlatformId = platform_id ? parseInt(platform_id) : null;
      let platformName = 'Unknown';
      let platformCreated = false;

      if (detection) {
        const detectedName = detection.platform;
        const detectedDomain = detection.domain || '';
        const platform = await prisma.platform.findFirst({ where: { name: detectedName } });
        if (platform) {
          detectedPlatformId = platform.id;
          platformName = platform.name;
        } else {
          const newPlatform = await prisma.platform.create({
            data: { name: detectedName, cookieDomain: detectedDomain, logoUrl: '', bgColorHex: '#6C5CE7', isActive: 1, autoDetected: 1 },
          });
          detectedPlatformId = newPlatform.id;
          platformName = detectedName;
          platformCreated = true;
        }
      }

      if (!detectedPlatformId) {
        return res.json({ success: false, message: 'Could not detect platform. Please add the platform first.' });
      }

      const fp = generateFingerprint(raw);

      const existingFp = await prisma.cookieVault.findFirst({ where: { fingerprint: fp, platformId: detectedPlatformId } });
      if (existingFp) {
        return res.json({
          success: false,
          message: 'Duplicate cookie detected. This cookie has already been imported.',
          duplicate: true,
          existing_cookie_id: existingFp.id,
          platform_name: platformName,
        });
      }

      const score = computeCookieScore(parsed);
      const expiry = extractCookieExpiry(parsed);
      const encoded = Buffer.from(raw).toString('base64');
      const slotsToCreate = Math.max(1, Math.min(parseInt(slot_count) || 1, 20));
      const maxUsersPerSlot = Math.max(1, Math.min(parseInt(max_users) || 1, 50));

      let finalExpiry = expiry;
      let expirySource = 'cookie';
      if (!finalExpiry) {
        const defaultDays = parseInt(await getSetting('default_expiry_days', '30'));
        const d = new Date();
        d.setDate(d.getDate() + defaultDays);
        finalExpiry = d.toISOString().replace('T', ' ').substring(0, 19);
        expirySource = 'default';
      }

      let expiryDaysRemaining = null;
      if (finalExpiry) {
        expiryDaysRemaining = Math.ceil((new Date(finalExpiry).getTime() - Date.now()) / 86400000);
      }

      const hasStorage = importLocalStorage && Object.keys(importLocalStorage).length > 0;
      const hasSessionStorage = importSessionStorage && Object.keys(importSessionStorage).length > 0;
      const hasHeaders = importAuthHeaders && Object.keys(importAuthHeaders).length > 0;
      const storagePayload = (hasStorage || hasSessionStorage) ? JSON.stringify({
        localStorage: importLocalStorage || {},
        sessionStorage: importSessionStorage || {},
      }) : null;
      const headersPayload = hasHeaders ? JSON.stringify(importAuthHeaders) : null;

      const completeness = classifyCookieCompleteness(parsed, platformName);
      const requiredComponents = detectRequiredSessionComponents(parsed);
      const detectedAuthType = importAuthType || completeness.authType || 'cookie';

      const { cookie, createdAccounts } = await prisma.$transaction(async (tx) => {
        const cookie = await tx.cookieVault.create({
          data: {
            platformId: detectedPlatformId, cookieString: encoded,
            cookieCount: parsed.length, score, expiresAt: finalExpiry,
            fingerprint: fp, updatedAt: nowISO(),
          },
        });

        const createdAccounts = [];
        for (let i = 0; i < slotsToCreate; i++) {
          const account = await tx.platformAccount.create({
            data: {
              platformId: detectedPlatformId,
              slotName: slotsToCreate > 1 ? `${platformName} Login ${i + 1}` : `${platformName} Login`,
              cookieData: encoded, maxUsers: maxUsersPerSlot,
              cookieCount: parsed.length, cookieId: cookie.id,
              expiresAt: finalExpiry, intelligenceScore: score,
              stabilityStatus: classifyStability(score),
              fingerprint: fp,
              profileIndex: parseInt(profile_index) || 1,
              storageData: storagePayload,
              authHeaders: headersPayload,
              authType: detectedAuthType,
              verificationStatus: 'IMPORTED',
              isActive: 1, createdAt: nowISO(), updatedAt: nowISO(),
            },
          });
          createdAccounts.push(account);
        }

        await tx.platform.update({
          where: { id: detectedPlatformId },
          data: { totalAccounts: { increment: slotsToCreate } },
        });

        return { cookie, createdAccounts };
      });

      await logAdminAction(adminId, 'auto_setup', 'PlatformAccount', null, { platform: platformName, slots: slotsToCreate, cookie_id: cookie.id }, ip);
      invalidateAccountCaches();
      emitAdminEvent('slot_updated', { action: 'auto_setup', adminId, platform: platformName });

      const importWarnings = [];
      if (completeness.needsStorage && !hasStorage) {
        importWarnings.push(`Cookies imported but full session data is incomplete for ${platformName} — missing localStorage keys`);
      }
      if (completeness.needsTokens && !hasHeaders) {
        importWarnings.push(`${platformName} requires auth tokens/headers that were not provided`);
      }
      if (completeness.missing && completeness.missing.length > 0) {
        const critMissing = completeness.missing.filter(m => m.level === 'critical');
        if (critMissing.length > 0) {
          importWarnings.push(`Missing critical cookies: ${critMissing.map(m => m.name).join(', ')}`);
        }
      }

      const missingRequirements = [];
      if (requiredComponents) {
        for (const key of (requiredComponents.required?.localStorage || [])) {
          if (!importLocalStorage || !importLocalStorage[key]) missingRequirements.push(`localStorage.${key}`);
        }
        for (const hdr of (requiredComponents.required?.headers || [])) {
          if (!importAuthHeaders || !importAuthHeaders[hdr]) missingRequirements.push(`authHeaders.${hdr}`);
        }
      }

      return res.json({
        success: true,
        message: `${slotsToCreate} slot(s) created for ${platformName}`,
        platform_name: platformName,
        platform_id: detectedPlatformId,
        platform_created: platformCreated,
        cookie_id: cookie.id,
        cookie_count: parsed.length,
        cookie_score: score,
        expires_at: finalExpiry,
        expiry_source: expirySource,
        expiry_days_remaining: expiryDaysRemaining,
        slots_created: slotsToCreate,
        max_users: maxUsersPerSlot,
        max_streams: maxUsersPerSlot,
        account_status: 'created',
        login_verified: false,
        login_score: score,
        login_status: 'PENDING',
        login_label: 'Pending',
        fingerprint: fp ? fp.substring(0, 16) + '...' : null,
        accounts: createdAccounts.map(a => ({ id: a.id, slot_name: a.slotName })),
        verification_status: 'IMPORTED',
        verification_method: 'none',
        session_completeness_score: completeness.score,
        session_completeness_status: completeness.status,
        auth_type: detectedAuthType,
        missing_requirements: missingRequirements,
        import_warnings: importWarnings,
      });
    }

    if (action === 'bulk_import') {
      if (!raw) return res.status(400).json({ success: false, message: 'Cookie data required' });

      const cookieBlocks = raw.split(/\n\s*\n|\r\n\s*\r\n/).filter(b => b.trim());
      let successCount = 0, failCount = 0;
      const results = [];

      for (const block of cookieBlocks) {
        try {
          const parsed = parseRawCookieString(block.trim());
          if (parsed.length === 0) { failCount++; results.push({ success: false, error: 'No valid cookies' }); continue; }

          const detection = detectPlatformFromCookies(parsed);
          let pid = null, pName = 'Unknown';
          let pCreated = false;

          if (detection) {
            const dName = detection.platform;
            const dDomain = detection.domain || '';
            const platform = await prisma.platform.findFirst({ where: { name: dName } });
            if (platform) { pid = platform.id; pName = platform.name; }
            else {
              const np = await prisma.platform.create({
                data: { name: dName, cookieDomain: dDomain, logoUrl: '', bgColorHex: '#6C5CE7', isActive: 1, autoDetected: 1 },
              });
              pid = np.id; pName = dName; pCreated = true;
            }
          }

          if (!pid) { failCount++; results.push({ success: false, error: 'Platform not detected' }); continue; }

          const fp = generateFingerprint(block.trim());

          const existingFp = await prisma.cookieVault.findFirst({ where: { fingerprint: fp, platformId: pid } });
          if (existingFp) {
            failCount++;
            results.push({ success: false, error: 'Duplicate cookie', platform_name: pName });
            continue;
          }

          const score = computeCookieScore(parsed);
          const expiry = extractCookieExpiry(parsed);
          let finalExpiry = expiry;
          if (!finalExpiry) {
            const defaultDays = parseInt(await getSetting('default_expiry_days', '30'));
            const d = new Date();
            d.setDate(d.getDate() + defaultDays);
            finalExpiry = d.toISOString().replace('T', ' ').substring(0, 19);
          }
          const encoded = Buffer.from(block.trim()).toString('base64');

          const cookie = await prisma.cookieVault.create({
            data: { platformId: pid, cookieString: encoded, cookieCount: parsed.length, score, expiresAt: finalExpiry, fingerprint: fp, updatedAt: nowISO() },
          });

          const adapter = getAdapter(pName);
          const bulkAuthType = adapter ? adapter.authType : 'cookie';

          const account = await prisma.platformAccount.create({
            data: {
              platformId: pid, slotName: `${pName} Login`, cookieData: encoded,
              maxUsers: 5, cookieCount: parsed.length, cookieId: cookie.id,
              expiresAt: finalExpiry, intelligenceScore: score,
              stabilityStatus: classifyStability(score), fingerprint: fp,
              profileIndex: 1, isActive: 1, createdAt: nowISO(), updatedAt: nowISO(),
              authType: bulkAuthType,
              verificationStatus: 'IMPORTED',
            },
          });

          await prisma.platform.update({ where: { id: pid }, data: { totalAccounts: { increment: 1 } } });
          successCount++;
          results.push({
            success: true, platform_name: pName, account_id: account.id,
            account_status: 'created', slots_created: 1,
            platform_created: pCreated, max_streams: 5,
          });
        } catch (e) {
          failCount++;
          results.push({ success: false, error: e.message });
        }
      }

      await logAdminAction(adminId, 'bulk_import', 'PlatformAccount', null, { total: cookieBlocks.length, success: successCount, fail: failCount }, ip);
      invalidateAccountCaches();
      emitAdminEvent('slot_updated', { action: 'bulk_import', adminId, imported: successCount });

      return res.json({
        success: successCount > 0,
        message: `Imported ${successCount} account(s), ${failCount} failed`,
        total: cookieBlocks.length,
        success_count: successCount,
        fail_count: failCount,
        results,
      });
    }

    if (!platform_id || !raw) {
      return res.status(400).json({ success: false, message: 'Platform ID and cookie data required' });
    }

    const parsed = parseRawCookieString(raw);
    const score = computeCookieScore(parsed);
    const expiry = extractCookieExpiry(parsed);
    const encoded = Buffer.from(raw).toString('base64');
    const fp = generateFingerprint(raw);

    if (fp) {
      const existingFp = await prisma.cookieVault.findFirst({ where: { fingerprint: fp, platformId: parseInt(platform_id) } });
      if (existingFp) return res.json({ success: false, message: 'Duplicate cookie detected.', duplicate: true });
    }

    const cookie = await prisma.cookieVault.create({
      data: {
        platformId: parseInt(platform_id), cookieString: encoded,
        cookieCount: parsed.length, score, expiresAt: expiry,
        fingerprint: fp, updatedAt: nowISO(),
      },
    });

    const account = await prisma.platformAccount.create({
      data: {
        platformId: parseInt(platform_id),
        slotName: slot_name || `Login ${Date.now()}`,
        cookieData: encoded, maxUsers: parseInt(max_users) || 5,
        cookieCount: parsed.length, cookieId: cookie.id,
        expiresAt: expiry, intelligenceScore: score,
        stabilityStatus: classifyStability(score), fingerprint: fp,
        profileIndex: parseInt(profile_index) || 1,
        isActive: 1, createdAt: nowISO(), updatedAt: nowISO(),
      },
    });

    await prisma.platform.update({
      where: { id: parseInt(platform_id) },
      data: { totalAccounts: { increment: 1 } },
    });

    invalidateAccountCaches();
    emitAdminEvent('slot_updated', { action: 'add_account', adminId, account_id: account.id });
    res.json({ success: true, message: 'Account added', account_id: account.id, cookie_id: cookie.id });
  } catch (err) {
    console.error('add_account_unified error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/account_intelligence', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action, account_id, platform_id } = req.query;

    if (action === 'dashboard') {
      const accounts = await prisma.platformAccount.findMany({
        include: { platform: { select: { name: true } } },
      });

      const totalAccounts = accounts.length;
      const totalScore = accounts.reduce((s, a) => s + (a.intelligenceScore || 0), 0);
      const avgScore = totalAccounts > 0 ? Math.round(totalScore / totalAccounts) : 0;

      const classify = (a) => {
        const stab = (a.stabilityStatus || 'UNKNOWN').toUpperCase();
        if (stab === 'STABLE') return 'stable';
        if (stab === 'RISKY' || stab === 'UNSTABLE') return 'risky';
        if (stab === 'DEAD' || stab === 'CRITICAL') return 'dead';
        if ((a.healthStatus || '').toLowerCase() === 'degraded') return 'dead';
        const score = a.intelligenceScore || 0;
        if (score >= 70) return 'stable';
        if (score >= 40) return 'risky';
        return 'dead';
      };

      const stableCount = accounts.filter(a => classify(a) === 'stable').length;
      const riskyCount = accounts.filter(a => classify(a) === 'risky').length;
      const deadCount = accounts.filter(a => classify(a) === 'dead').length;
      const totalSuccess = accounts.reduce((s, a) => s + (a.successCount || 0), 0);
      const totalFail = accounts.reduce((s, a) => s + (a.failCount || 0), 0);
      const successRate = (totalSuccess + totalFail) > 0 ? Math.round((totalSuccess / (totalSuccess + totalFail)) * 100) : 100;

      const platformStats = {};
      accounts.forEach(a => {
        const pName = a.platform?.name || 'Unknown';
        if (!platformStats[pName]) platformStats[pName] = { stable: 0, risky: 0, dead: 0, total_score: 0, count: 0 };
        const ps = platformStats[pName];
        ps.count++;
        ps.total_score += (a.intelligenceScore || 0);
        ps[classify(a)]++;
      });
      Object.keys(platformStats).forEach(k => {
        platformStats[k].avg_score = platformStats[k].count > 0
          ? Math.round(platformStats[k].total_score / platformStats[k].count) : 0;
        delete platformStats[k].total_score;
        delete platformStats[k].count;
      });

      const recentEvents = await prisma.accountIntelligenceLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          account: { select: { slotName: true, platform: { select: { name: true } } } },
        },
      });

      return res.json({
        success: true,
        summary: {
          total_accounts: totalAccounts, avg_score: avgScore,
          stable_count: stableCount, risky_count: riskyCount,
          dead_count: deadCount, success_rate: successRate,
        },
        platform_stats: platformStats,
        recent_events: recentEvents.map(e => ({
          id: e.id, account_id: e.accountId, platform_id: e.platformId,
          slot_name: e.account?.slotName || null,
          platform_name: e.account?.platform?.name || null,
          event_type: e.eventType, old_score: e.oldScore, new_score: e.newScore,
          old_stability: e.oldStability, new_stability: e.newStability,
          reason: e.reason, created_at: e.createdAt,
        })),
      });
    }

    const where = {};
    if (account_id) where.accountId = parseInt(account_id);
    if (platform_id) where.platformId = parseInt(platform_id);

    const logs = await prisma.accountIntelligenceLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 50,
    });

    res.json({
      success: true,
      logs: logs.map(l => ({
        id: l.id, account_id: l.accountId, platform_id: l.platformId,
        event_type: l.eventType, old_score: l.oldScore, new_score: l.newScore,
        old_stability: l.oldStability, new_stability: l.newStability,
        reason: l.reason, created_at: l.createdAt,
      })),
    });
  } catch (err) {
    console.error('account_intelligence GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/account_intelligence', authenticate, requireAdmin(), intelligenceLimiter, async (req, res) => {
  try {
    const { action, account_id } = req.body;

    if (action === 'verify_and_score' && account_id) {
      const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      const newScore = computeIntelligenceScore(account);
      const newStability = classifyStability(newScore);

      await prisma.platformAccount.update({
        where: { id: parseInt(account_id) },
        data: {
          intelligenceScore: newScore, stabilityStatus: newStability,
          healthStatus: newScore >= 50 ? 'healthy' : 'degraded',
          lastIntelligenceRun: nowISO(),
        },
      });

      await prisma.accountIntelligenceLog.create({
        data: {
          accountId: parseInt(account_id), platformId: account.platformId,
          eventType: 'score_update',
          oldScore: account.intelligenceScore || 0, newScore,
          oldStability: (account.stabilityStatus || 'UNKNOWN').toUpperCase(), newStability,
          reason: 'Manual verify and score', createdAt: nowISO(),
        },
      });

      invalidateAccountCaches();
      emitAdminEvent('intelligence_updated', { account_id: parseInt(account_id), score: newScore, stability: newStability });
      return res.json({ success: true, message: 'Score updated', score: newScore, stability: newStability });
    }

    if (action === 'run_intelligence') {
      const accounts = await prisma.platformAccount.findMany();
      let updated = 0;
      for (const account of accounts) {
        const newScore = computeIntelligenceScore(account);
        const newStability = classifyStability(newScore);
        const oldStability = (account.stabilityStatus || 'UNKNOWN').toUpperCase();

        if (newScore !== account.intelligenceScore || newStability !== oldStability) {
          await prisma.platformAccount.update({
            where: { id: account.id },
            data: {
              intelligenceScore: newScore, stabilityStatus: newStability,
              healthStatus: newScore >= 50 ? 'healthy' : 'degraded',
              lastIntelligenceRun: nowISO(),
            },
          });

          await prisma.accountIntelligenceLog.create({
            data: {
              accountId: account.id, platformId: account.platformId,
              eventType: 'intelligence_run',
              oldScore: account.intelligenceScore || 0, newScore,
              oldStability, newStability,
              reason: 'Scheduled intelligence run', createdAt: nowISO(),
            },
          });
        }
        updated++;
      }
      invalidateAccountCaches();
      emitAdminEvent('intelligence_run_complete', { updated });
      return res.json({ success: true, message: `Intelligence run complete. ${updated} accounts scored.` });
    }

    if (action === 'auto_clean') {
      const targets = await prisma.platformAccount.findMany({
        where: {
          OR: [
            { healthStatus: 'degraded' },
            { stabilityStatus: { in: ['DEAD', 'CRITICAL', 'critical', 'dead'] } },
            { cookieStatus: { in: ['EXPIRED', 'DEAD'] } },
          ],
        },
      });

      let cleaned = 0;
      for (const account of targets) {
        const activeSess = await prisma.accountSession.findMany({
          where: { accountId: account.id, status: 'active' },
          select: { id: true },
        });
        await prisma.accountSession.updateMany({
          where: { accountId: account.id, status: 'active' },
          data: { status: 'inactive', reason: 'auto_clean' },
        });
        for (const s of activeSess) {
          sessionStore.releaseAccountSession(s.id);
          console.log(`[slot-release] auto_clean sessionId=${s.id} account=${account.id}`);
        }

        await prisma.platformAccount.update({
          where: { id: account.id },
          data: { isActive: 0, healthStatus: 'degraded', stabilityStatus: 'DEAD', updatedAt: nowISO() },
        });

        cleaned++;
      }
      invalidateAccountCaches();
      emitAdminEvent('auto_clean_complete', { cleaned });
      return res.json({ success: true, message: `Auto clean complete. ${cleaned} account(s) disabled and sessions freed.` });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    console.error('account_intelligence POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/account_manager', authenticate, requireAdmin(), async (req, res) => {
  try {
    const staleCutoff = cutoffISO(30);
    const accounts = await prisma.platformAccount.findMany({
      include: {
        platform: { select: { name: true, logoUrl: true, bgColorHex: true } },
        _count: { select: { accountSessions: { where: { status: 'active' } } } },
        accountSessions: {
          where: { status: 'active' },
          select: { id: true, lastActive: true, lastActiveAt: true, userId: true, sessionKey: true, ipAddress: true, deviceType: true, createdAt: true, platformId: true },
          orderBy: { lastActive: 'desc' },
        },
      },
      orderBy: [{ platformId: 'asc' }, { createdAt: 'asc' }],
    });

    res.json({ success: true, accounts: accounts.map(a => enrichAccountWithSessions(a, staleCutoff)) });
  } catch (err) {
    console.error('account_manager error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_slot_status', authenticate, async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ success: false, message: 'Account ID required' });

    const account = await prisma.platformAccount.findUnique({
      where: { id: parseInt(account_id) },
      include: {
        accountSessions: {
          where: { status: 'active' },
          include: { user: { select: { username: true, name: true } } },
        },
      },
    });

    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    res.json({
      success: true,
      max_users: account.maxUsers,
      active_sessions: account.accountSessions.length,
      available: account.maxUsers - account.accountSessions.length,
      sessions: account.accountSessions.map(s => ({
        id: s.id, user_id: s.userId, username: s.user?.username,
        device_type: s.deviceType, ip_address: s.ipAddress || '', last_active: s.lastActive,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reassign_slot', authenticate, requireAdmin(), adminActionLimiter, async (req, res) => {
  try {
    const { session_id, new_account_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, message: 'Session ID required' });

    const sid = parseInt(session_id);
    const nowMs = Date.now();
    if (new_account_id) {
      const newAccId = parseInt(new_account_id);
      await prisma.accountSession.update({
        where: { id: sid },
        data: { accountId: newAccId, lastActive: nowISO(), lastActiveAt: BigInt(nowMs) },
      });
      sessionStore.releaseAccountSession(sid);
      const updated = await prisma.accountSession.findUnique({ where: { id: sid } });
      if (updated && updated.status === 'active') sessionStore.registerAccountSession(updated);
      console.log(`[slot-alloc] REASSIGNED sessionId=${sid} newAccount=${newAccId} by admin=${req.user.id}`);
    } else {
      await prisma.accountSession.update({
        where: { id: sid },
        data: { status: 'inactive', reason: 'admin_release' },
      });
      sessionStore.releaseAccountSession(sid);
      console.log(`[slot-release] admin_release sessionId=${sid} by admin=${req.user.id}`);
    }

    invalidateAccountCaches();
    emitAdminEvent('slot_updated', { action: 'reassign', session_id });
    res.json({ success: true, message: 'Slot reassigned' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/slot_feedback', authenticate, async (req, res) => {
  try {
    const { account_id, feedback, status } = req.body;
    const feedbackVal = feedback || status;
    if (!account_id || !feedbackVal) return res.status(400).json({ success: false, message: 'Account ID and feedback required' });

    const isPositive = feedbackVal === 'working' || feedbackVal === 'good' || feedbackVal === 'success';
    const account = await prisma.platformAccount.findUnique({ where: { id: parseInt(account_id) } });
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    const oldScore = account.intelligenceScore;
    const data = { updatedAt: nowISO() };

    if (isPositive) {
      data.successCount = account.successCount + 1;
      data.lastSuccessAt = nowISO();
      data.verificationStatus = 'VERIFIED';
      data.verificationMethod = 'user_feedback';
      data.lastVerifiedAt = nowISO();
    } else {
      data.failCount = account.failCount + 1;
      data.lastFailedAt = nowISO();
      data.verificationStatus = 'FAILED';
      data.verificationMethod = 'user_feedback';
    }

    const updatedAccount = { ...account, ...data };
    data.intelligenceScore = computeIntelligenceScore(updatedAccount);
    data.stabilityStatus = classifyStability(data.intelligenceScore);
    data.healthStatus = data.intelligenceScore >= 50 ? 'healthy' : 'degraded';

    await prisma.platformAccount.update({ where: { id: account.id }, data });

    await prisma.accountIntelligenceLog.create({
      data: {
        accountId: account.id, platformId: account.platformId,
        eventType: isPositive ? 'positive_feedback' : 'negative_feedback',
        oldScore, newScore: data.intelligenceScore,
        oldStability: (account.stabilityStatus || 'UNKNOWN').toUpperCase(),
        newStability: data.stabilityStatus,
        reason: `User feedback: ${feedbackVal}`, createdAt: nowISO(),
      },
    });

    invalidateAccountCaches();
    emitAdminEvent('intelligence_updated', { account_id: parseInt(account_id), score: data.intelligenceScore });
    res.json({ success: true, message: 'Feedback recorded', new_score: data.intelligenceScore });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_platform_availability', authenticate, async (req, res) => {
  try {
    const { platform_id } = req.query;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const accounts = await prisma.platformAccount.findMany({
      where: { platformId: parseInt(platform_id), isActive: 1 },
      include: { _count: { select: { accountSessions: { where: { status: 'active' } } } } },
    });

    const totalSlots = accounts.reduce((s, a) => s + a.maxUsers, 0);
    const usedSlots = accounts.reduce((s, a) => s + a._count.accountSessions, 0);

    res.json({
      success: true,
      total_slots: totalSlots, used_slots: usedSlots,
      available_slots: totalSlots - usedSlots,
      accounts: accounts.map(a => ({
        id: a.id, slot_name: a.slotName, max_users: a.maxUsers,
        active_sessions: a._count.accountSessions,
        available: a.maxUsers - a._count.accountSessions,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/assign_slot', authenticate, async (req, res) => {
  try {
    const { platform_id } = req.body;
    const userId = req.user.id;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const accounts = await prisma.platformAccount.findMany({
      where: { platformId: parseInt(platform_id), isActive: 1 },
      include: { _count: { select: { accountSessions: { where: { status: 'active' } } } } },
      orderBy: { intelligenceScore: 'desc' },
    });

    const available = accounts.filter(a => a._count.accountSessions < a.maxUsers);
    if (available.length === 0) return res.json({ success: false, message: 'No available slots' });

    const chosen = available[0];

    const result = await withSlotLock(chosen.id, userId, async () => {
      const freshCount = await prisma.accountSession.count({
        where: { accountId: chosen.id, status: 'active' },
      });
      if (freshCount >= chosen.maxUsers) throw new Error('Slot filled while waiting');

      const assignNowMs = Date.now();
      const session = await prisma.accountSession.create({
        data: {
          accountId: chosen.id, userId, platformId: parseInt(platform_id),
          status: 'active', lastActive: nowISO(),
          lastActiveAt: BigInt(assignNowMs), createdAtMs: BigInt(assignNowMs),
        },
      });
      sessionStore.registerAccountSession(session);

      return { session_id: session.id, account_id: chosen.id, slot_name: chosen.slotName };
    });

    invalidateAccountCaches();
    emitAdminEvent('slot_assigned', { userId, account_id: chosen.id });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message.includes('currently being assigned') || err.message.includes('filled while waiting')) {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error('assign_slot error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/session_requirements', authenticate, async (req, res) => {
  try {
    const { platform, domain } = req.query;
    const adapter = getAdapter(platform || domain);

    if (!adapter) {
      return res.json({
        success: true,
        adapter_found: false,
        message: 'No adapter for this platform. Cookie-only injection will be used.',
        requirements: null,
      });
    }

    res.json({
      success: true,
      adapter_found: true,
      platform: adapter.platformName,
      auth_type: adapter.authType,
      injection_strategy: adapter.injectionStrategy,
      requirements: adapter.getRequiredComponents(),
      verification: adapter.getVerificationConfig(),
      login_url: adapter.loginUrl,
      dashboard_url: adapter.dashboardUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/check_session_completeness', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { account_id, platform_name, cookies, localStorage, sessionStorage, tokens } = req.body;

    let cookieData = cookies;
    let platformName = platform_name;

    if (account_id && !cookieData) {
      const account = await prisma.platformAccount.findUnique({
        where: { id: parseInt(account_id) },
        include: { platform: { select: { name: true } } },
      });
      if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

      platformName = platformName || account.platform?.name;
      if (account.cookieData) {
        const raw = Buffer.from(account.cookieData, 'base64').toString('utf-8');
        cookieData = parseRawCookieString(raw);
      }
    }

    if (!cookieData || !Array.isArray(cookieData)) {
      cookieData = [];
    }

    const cookieCompleteness = classifyCookieCompleteness(cookieData, platformName);

    const sessionData = { cookies: cookieData, localStorage: localStorage || {}, sessionStorage: sessionStorage || {}, tokens: tokens || {} };
    const adapterCompleteness = checkSessionCompleteness(platformName || 'unknown', sessionData);

    const requiredComponents = detectRequiredSessionComponents(cookieData);

    res.json({
      success: true,
      platform: platformName || cookieCompleteness.platform || 'Unknown',
      cookie_analysis: cookieCompleteness,
      session_analysis: adapterCompleteness,
      required_components: requiredComponents,
      recommendation: cookieCompleteness.status === 'COMPLETE' ? 'ready_for_injection'
        : cookieCompleteness.status === 'COOKIES_COMPLETE' ? 'needs_storage_data'
        : cookieCompleteness.status === 'PARTIAL' ? 'needs_more_cookies'
        : cookieCompleteness.status === 'EXPIRED' ? 'cookies_expired_replace'
        : 'insufficient_data',
    });
  } catch (err) {
    console.error('check_session_completeness error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/platform_adapters', authenticate, requireAdmin(), async (req, res) => {
  try {
    const adapters = getAllAdapters().map(a => a.toJSON());
    res.json({ success: true, adapters, count: adapters.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/system_status', authenticate, requireAdmin(), async (req, res) => {
  try {
    res.json({
      success: true,
      queues: getQueues(),
      cache: getCacheStats(),
      locks: getActiveLocks(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
