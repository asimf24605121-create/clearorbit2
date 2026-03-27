import { Router } from 'express';
import { prisma, emitUserEvent, emitAdminEvent } from '../server.js';
import { authenticate, tryAuthenticate } from '../middleware/auth.js';
import { nowISO, cutoffISO, todayISO, getClientIP, parseUserAgent } from '../utils/helpers.js';
import { parseRawCookieString, classifyCookieCompleteness, detectRequiredSessionComponents } from '../utils/cookieEngine.js';
import { sessionStore } from '../utils/sessionStore.js';

const router = Router();

router.get('/get_dashboard', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = todayISO();
    const now = new Date();

    const [allPlatforms, subscriptions, profile, notifications] = await Promise.all([
      prisma.platform.findMany({
        where: { isActive: 1 },
        select: { id: true, name: true, logoUrl: true, bgColorHex: true, loginUrl: true },
        orderBy: { name: 'asc' },
      }),
      prisma.userSubscription.findMany({
        where: { userId },
        include: {
          platform: { select: { id: true, name: true, logoUrl: true, bgColorHex: true, loginUrl: true } },
        },
        orderBy: { endDate: 'desc' },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, username: true, name: true, email: true, phone: true,
          profileImage: true, profileCompleted: true, country: true, city: true,
        },
      }),
      prisma.userNotification.findMany({
        where: { userId, isRead: 0 },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const subsByPlatform = {};
    for (const s of subscriptions) {
      const pid = s.platformId;
      const existing = subsByPlatform[pid];
      if (!existing) { subsByPlatform[pid] = s; continue; }
      if (s.isActive && !existing.isActive) { subsByPlatform[pid] = s; continue; }
      if (s.isActive === existing.isActive && new Date(s.endDate) > new Date(existing.endDate)) {
        subsByPlatform[pid] = s;
      }
    }

    const cards = allPlatforms.map(p => {
      const sub = subsByPlatform[p.id];
      if (!sub || !sub.isActive) {
        return {
          platform_id: p.id, platform_name: p.name, name: p.name,
          logo_url: p.logoUrl, bg_color_hex: p.bgColorHex, login_url: p.loginUrl,
          subscribed: false,
        };
      }
      const endDate = new Date(sub.endDate + 'T23:59:59');
      const startDate = sub.startDate ? new Date(sub.startDate) : now;
      const remainMs = endDate - now;
      const totalDays = Math.max(1, Math.ceil((endDate - startDate) / 86400000));
      const daysLeft = Math.max(0, Math.ceil(remainMs / 86400000));
      const hours = Math.max(0, Math.floor((remainMs % 86400000) / 3600000));
      const mins = Math.max(0, Math.floor((remainMs % 3600000) / 60000));

      return {
        id: sub.id, platform_id: p.id, platform_name: p.name, name: p.name,
        logo_url: p.logoUrl, bg_color_hex: p.bgColorHex, login_url: p.loginUrl,
        subscribed: true, start_date: sub.startDate, end_date: sub.endDate,
        is_active: sub.isActive,
        remaining: {
          days: daysLeft, hours, minutes: mins,
          expired: remainMs <= 0, total_days: totalDays,
        },
      };
    });

    const activeCount = cards.filter(c => c.subscribed && c.remaining && !c.remaining.expired).length;

    const sessionStaleCutoffMs = Date.now() - 30 * 60 * 1000;
    const allUserSessions = await prisma.userSession.findMany({
      where: { userId, status: 'active' },
      orderBy: { lastActivity: 'desc' },
    });

    const currentSession = allUserSessions.find(s => s.sessionToken === req.sessionToken) || null;
    const freshSessions = allUserSessions.filter(s => {
      const lat = Number(s.lastActivityAt);
      if (lat > 0) return lat > sessionStaleCutoffMs;
      if (!s.lastActivity || s.lastActivity === '') return false;
      return new Date(s.lastActivity).getTime() > sessionStaleCutoffMs;
    });
    const identityMap = new Map();
    for (const s of freshSessions) {
      const key = `${s.ipAddress || ''}|${s.browser || ''}|${s.os || ''}`;
      const existing = identityMap.get(key);
      const sTs = Number(s.lastActivityAt) || new Date(s.lastActivity).getTime();
      const eTs = existing ? (Number(existing.lastActivityAt) || new Date(existing.lastActivity).getTime()) : 0;
      if (!existing || sTs > eTs) {
        identityMap.set(key, s);
      }
    }
    const uniqueSessions = Array.from(identityMap.values());

    res.json({
      success: true,
      username: profile.username,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      profile_image: profile.profileImage,
      profile_completed: profile.profileCompleted,
      cards,
      active_count: activeCount,
      total_count: allPlatforms.length,
      unread_notifications: notifications.length,
      notifications: notifications.map(n => ({
        id: n.id, title: n.title, message: n.message,
        type: n.type, created_at: n.createdAt,
      })),
      current_session: currentSession ? {
        id: currentSession.id,
        ip_address: currentSession.ipAddress || '-',
        browser: currentSession.browser || 'Unknown',
        os: currentSession.os || 'Unknown',
        device_type: currentSession.deviceType || 'desktop',
        created_at: currentSession.createdAt,
        last_activity: currentSession.lastActivity,
      } : null,
      all_sessions: uniqueSessions.map(s => ({
        id: s.id,
        ip_address: s.ipAddress || '-',
        browser: s.browser || 'Unknown',
        os: s.os || 'Unknown',
        device_type: s.deviceType || 'desktop',
        created_at: s.createdAt,
        last_activity: s.lastActivity,
        is_current: s.sessionToken === req.sessionToken,
      })),
      active_devices: uniqueSessions.length,
      device_limit: 2,
    });
  } catch (err) {
    console.error('get_dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/access_platform', authenticate, async (req, res) => {
  try {
    const { platform_id, browser_session_id, device_type } = req.body;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });
    const pid = parseInt(platform_id);
    const userId = req.user.id;
    const clientIp = req.ip;
    const browserSessionId = browser_session_id || '';
    const now = nowISO();
    const nowMs = Date.now();

    const sub = await prisma.userSubscription.findFirst({
      where: { userId, platformId: pid, isActive: 1 },
    });

    if (!sub || new Date(sub.endDate) < new Date()) {
      return res.status(403).json({ success: false, message: 'No active subscription for this platform' });
    }

    const result = await attemptSlotAllocation(req, pid, userId, clientIp, browserSessionId, device_type, now, nowMs, false);

    if (result.all_full) {
      console.log(`[slot-alloc] All slots full on first attempt — running platform-wide cleanup and retrying user=${userId} platform=${pid}`);
      const retryNowMs = Date.now();
      const retryResult = await attemptSlotAllocation(req, pid, userId, clientIp, browserSessionId, device_type, nowISO(), retryNowMs, true);
      if (retryResult.error) {
        console.log(`[slot-alloc] RETRY FAILED — still no slots user=${userId} platform=${pid}`);
        return res.status(retryResult.error).json({ success: false, message: retryResult.message, all_full: retryResult.all_full });
      }
      console.log(`[slot-alloc] RETRY SUCCESS — slot allocated on retry user=${userId} platform=${pid} session=${retryResult.session.id}`);
      return res.json(buildAccessResponse(retryResult.account, pid, retryResult.session.id, retryResult.session.sessionKey));
    }

    if (result.error) {
      return res.status(result.error).json({ success: false, message: result.message, all_full: result.all_full });
    }

    res.json(buildAccessResponse(result.account, pid, result.session.id, result.session.sessionKey));
  } catch (err) {
    console.error('access_platform error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function attemptSlotAllocation(req, pid, userId, clientIp, browserSessionId, device_type, now, nowMs, isRetry) {
  return prisma.$transaction(async (tx) => {
    const staleCutoffMs = nowMs - 30 * 1000;
    const staleCutoff = cutoffISO(30);

    const stalePlatformWide = await tx.accountSession.findMany({
      where: {
        platformId: pid, status: 'active',
        OR: [
          { lastActiveAt: { gt: 0, lt: BigInt(staleCutoffMs) } },
          { lastActiveAt: 0, lastActive: { lt: staleCutoff, not: '' } },
        ],
      },
      select: { id: true, userId: true, accountId: true, lastActiveAt: true },
    });

    if (stalePlatformWide.length > 0) {
      const staleIds = stalePlatformWide.map(s => s.id);
      await tx.accountSession.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'inactive', reason: isRetry ? 'stale_retry_cleanup' : 'stale_on_reaccess' },
      });
      for (const s of stalePlatformWide) {
        sessionStore.releaseAccountSession(s.id);
        const ageMs = nowMs - Number(s.lastActiveAt || 0);
        console.log(`[slot-release] pre_access_cleanup sessionId=${s.id} user=${s.userId} platform=${pid} account=${s.accountId} age=${Math.round(ageMs/1000)}s retry=${isRetry}`);
      }
      console.log(`[slot-alloc] Pre-access cleanup released ${staleIds.length} stale session(s) platform=${pid} retry=${isRetry}`);
    }

    const existing = await tx.accountSession.findFirst({
      where: {
        userId,
        platformId: pid,
        sessionKey: browserSessionId,
        ipAddress: clientIp,
        status: 'active',
      },
    });

    if (existing) {
      await tx.accountSession.update({
        where: { id: existing.id },
        data: { lastActive: now, lastActiveAt: BigInt(nowMs) },
      });
      sessionStore.heartbeatAccountSession(existing.id, nowMs);
      console.log(`[session] Reused accountSession id=${existing.id} user=${userId} platform=${pid} ip=${clientIp} lastActiveAt=${nowMs}`);

      const account = await tx.platformAccount.findUnique({
        where: { id: existing.accountId },
        include: { platform: { select: { name: true, cookieDomain: true, loginUrl: true } } },
      });

      if (account) {
        return { account, session: existing, reused: true };
      }
    }

    const accounts = await tx.platformAccount.findMany({
      where: {
        platformId: pid,
        isActive: 1,
        verificationStatus: { in: ['IMPORTED', 'VERIFIED', 'VERIFYING'] },
      },
      include: {
        platform: { select: { name: true, cookieDomain: true, loginUrl: true } },
        accountSessions: { where: { status: 'active' }, select: { id: true, lastActive: true, lastActiveAt: true } },
      },
      orderBy: { intelligenceScore: 'desc' },
    });

    if (accounts.length === 0) {
      return { error: 404, message: 'No available account' };
    }

    let bestAccount = null;
    for (const acct of accounts) {
      const dbCount = acct.accountSessions.length;
      const maxSlots = acct.maxUsers ?? 1;
      console.log(`[slot-alloc] account=${acct.id} dbActive=${dbCount} maxSlots=${maxSlots} platform=${pid}`);
      if (dbCount < maxSlots) {
        bestAccount = acct;
        break;
      }
    }

    if (!bestAccount) {
      return { error: 429, message: 'All slots are full, try again later', all_full: true };
    }

    const { deviceType, browser, os } = parseUserAgent(req.headers['user-agent']);
    const session = await tx.accountSession.create({
      data: {
        accountId: bestAccount.id, userId,
        platformId: pid, status: 'active',
        deviceType: device_type || `${browser} / ${os} / ${deviceType}`,
        lastActive: now, lastActiveAt: BigInt(nowMs),
        createdAt: now, createdAtMs: BigInt(nowMs),
        sessionKey: browserSessionId,
        ipAddress: clientIp,
      },
    });
    sessionStore.registerAccountSession(session);
    console.log(`[slot-alloc] ALLOCATED sessionId=${session.id} user=${userId} platform=${pid} account=${bestAccount.id} ip=${clientIp} lastActiveAt=${nowMs} retry=${isRetry}`);

    return { account: bestAccount, session };
  });
}

function buildAccessResponse(account, platformId, sessionId, sessionKey) {
  let rawCookieData = '';
  if (account.cookieData) {
    try {
      rawCookieData = Buffer.from(account.cookieData, 'base64').toString('utf-8');
    } catch { rawCookieData = account.cookieData; }
  }

  let parsedCookies = [];
  let isJson = false;
  if (rawCookieData) {
    parsedCookies = parseRawCookieString(rawCookieData);
    try { JSON.parse(rawCookieData); isJson = true; } catch {}
  }

  const platformName = account.platform?.name || 'Unknown';
  const cookieDomain = account.platform?.cookieDomain || '';
  const loginUrl = account.platform?.loginUrl || '';

  let storageData = {};
  if (account.storageData) {
    try { storageData = JSON.parse(account.storageData); } catch {}
  }
  let authHeaders = {};
  if (account.authHeaders) {
    try { authHeaders = JSON.parse(account.authHeaders); } catch {}
  }

  return {
    success: true,
    platform_id: platformId,
    platform_name: platformName,
    domain: cookieDomain,
    redirect_url: loginUrl || (cookieDomain ? 'https://' + cookieDomain.replace(/^\./, '') + '/' : ''),
    cookie_string: rawCookieData,
    cookies: parsedCookies,
    count: parsedCookies.length,
    account_id: account.id,
    session_id: sessionId,
    session_key: sessionKey || '',
    slot_name: account.slotName,
    profile_index: account.profileIndex,
    format: isJson ? 'json' : 'plain',
    localStorage: storageData.localStorage || {},
    sessionStorage: storageData.sessionStorage || {},
    authHeaders: authHeaders,
    authType: account.authType || 'cookie',
    verification_status: account.verificationStatus || 'IMPORTED',
  };
}

router.post('/release_session', tryAuthenticate, async (req, res) => {
  try {
    const { platform_id, session_id } = req.body || {};
    const userId = req.user?.id;

    if (!userId) {
      console.log(`[session] release_session called without auth — ignored`);
      return res.json({ success: false, message: 'Not authenticated' });
    }

    let released = 0;
    const releasedSessionIds = [];

    if (session_id) {
      const sid = parseInt(session_id);
      const target = await prisma.accountSession.findFirst({
        where: { id: sid, userId, status: 'active' },
        select: { id: true, platformId: true, accountId: true },
      });
      if (target) {
        await prisma.accountSession.update({
          where: { id: sid },
          data: { status: 'inactive', reason: 'user_release' },
        });
        sessionStore.releaseAccountSession(sid);
        released = 1;
        releasedSessionIds.push(sid);
        console.log(`[slot-release] sessionId=${sid} user=${userId} platform=${target.platformId} account=${target.accountId} reason=user_release`);
      } else {
        console.log(`[slot-release] sessionId=${sid} user=${userId} NOT FOUND or already inactive`);
      }
    } else if (platform_id) {
      const pid = parseInt(platform_id);
      const activeSessions = await prisma.accountSession.findMany({
        where: { userId, platformId: pid, status: 'active' },
        select: { id: true, accountId: true, ipAddress: true },
      });

      if (activeSessions.length > 0) {
        const ids = activeSessions.map(s => s.id);
        await prisma.accountSession.updateMany({
          where: { id: { in: ids } },
          data: { status: 'inactive', reason: 'user_release' },
        });
        for (const s of activeSessions) {
          sessionStore.releaseAccountSession(s.id);
          releasedSessionIds.push(s.id);
        }
        released = activeSessions.length;
        console.log(`[slot-release] user=${userId} platform=${pid} released=${released} ids=[${ids.join(',')}] reason=user_release`);
      } else {
        console.log(`[slot-release] user=${userId} platform=${pid} NO active sessions to release`);
      }
    }

    if (released > 0) {
      emitUserEvent(userId, 'slot_released', { platform_id: platform_id ? parseInt(platform_id) : null, session_ids: releasedSessionIds, released, reason: 'user_release' });
      emitAdminEvent('slot_released', { userId, released, session_ids: releasedSessionIds, reason: 'user_release' });
    }

    res.json({ success: true, message: 'Session released', released });
  } catch (err) {
    console.error('[slot-release] error:', err.message);
    res.status(500).json({ success: false, message: 'Release failed' });
  }
});

router.get('/session_status', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const staleCutoff = cutoffISO(30 * 60);

    const [platformSessions, allUserSessions] = await Promise.all([
      prisma.accountSession.findMany({
        where: { userId, status: 'active' },
        include: {
          platform: { select: { name: true } },
          account: { select: { slotName: true } },
        },
      }),
      prisma.userSession.findMany({
        where: { userId, status: 'active' },
        orderBy: { lastActivity: 'desc' },
      }),
    ]);

    const currentSessionToken = req.sessionToken;
    const currentSession = allUserSessions.find(s => s.sessionToken === currentSessionToken) || null;
    const staleCutoffMs = Date.now() - 30 * 60 * 1000;

    const freshSessions = allUserSessions.filter(s => {
      const lat = Number(s.lastActivityAt);
      if (lat > 0) return lat > staleCutoffMs;
      if (!s.lastActivity || s.lastActivity === '') return false;
      return new Date(s.lastActivity).getTime() > staleCutoffMs;
    });

    const identityMap = new Map();
    for (const s of freshSessions) {
      const key = `${s.ipAddress || ''}|${s.browser || ''}|${s.os || ''}`;
      const existing = identityMap.get(key);
      const sTs = Number(s.lastActivityAt) || new Date(s.lastActivity).getTime();
      const eTs = existing ? (Number(existing.lastActivityAt) || new Date(existing.lastActivity).getTime()) : 0;
      if (!existing || sTs > eTs) {
        identityMap.set(key, s);
      }
    }
    const uniqueSessions = Array.from(identityMap.values());

    res.json({
      success: true,
      sessions: platformSessions.map(s => ({
        id: s.id, platform_id: s.platformId, platform_name: s.platform?.name,
        slot_name: s.account?.slotName, last_active: s.lastActive,
      })),
      current_session: currentSession ? {
        id: currentSession.id,
        ip_address: currentSession.ipAddress || '-',
        browser: currentSession.browser || 'Unknown',
        os: currentSession.os || 'Unknown',
        device_type: currentSession.deviceType || 'desktop',
        created_at: currentSession.createdAt,
        last_activity: currentSession.lastActivity,
      } : null,
      all_sessions: uniqueSessions.map(s => ({
        id: s.id,
        ip_address: s.ipAddress || '-',
        browser: s.browser || 'Unknown',
        os: s.os || 'Unknown',
        device_type: s.deviceType || 'desktop',
        created_at: s.createdAt,
        last_activity: s.lastActivity,
        is_current: s.sessionToken === currentSessionToken,
      })),
      active_devices: uniqueSessions.length,
      device_limit: 2,
    });
  } catch (err) {
    console.error('session_status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/session_heartbeat', authenticate, async (req, res) => {
  try {
    const { session_id, platform_id } = req.body;
    const userId = req.user.id;
    const now = nowISO();

    const nowMs = Date.now();
    let updated = 0;
    if (session_id) {
      const sid = parseInt(session_id);
      const r = await prisma.accountSession.updateMany({
        where: { id: sid, userId, status: 'active' },
        data: { lastActive: now, lastActiveAt: BigInt(nowMs), ipAddress: req.ip },
      });
      updated = r.count;
      if (updated > 0) sessionStore.heartbeatAccountSession(sid, nowMs);
    } else if (platform_id) {
      const clientIp = req.ip;
      const r = await prisma.accountSession.updateMany({
        where: { userId, platformId: parseInt(platform_id), ipAddress: clientIp, status: 'active' },
        data: { lastActive: now, lastActiveAt: BigInt(nowMs) },
      });
      updated = r.count;
      if (updated > 0) sessionStore.heartbeatAccountSessionByIdentity(userId, parseInt(platform_id), clientIp, nowMs);
    }
    if (updated > 0) {
      console.log(`[heartbeat] user=${userId} session=${session_id || 'n/a'} platform=${platform_id || 'n/a'} updated=${updated} at=${nowMs}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/force_logout', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentToken = req.sessionToken;

    const result = await prisma.userSession.updateMany({
      where: { userId, status: 'active', sessionToken: { not: currentToken } },
      data: { status: 'inactive', logoutReason: 'force_logout_others' },
    });
    sessionStore.releaseAllUserSessionsExcept(userId, currentToken);

    const slotResult = await prisma.accountSession.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'inactive', reason: 'force_logout_others' },
    });
    sessionStore.releaseAllAccountSessionsForUser(userId);
    console.log(`[slot-release] Force logout others user=${userId} userSessions=${result.count} accountSessions=${slotResult.count}`);
    emitUserEvent(userId, 'session_ended', { reason: 'force_logout_others', slots_released: slotResult.count });

    await prisma.loginHistory.create({
      data: { userId, action: 'force_logout', ipAddress: req.ip || '', createdAt: nowISO() },
    });

    res.json({ success: true, message: `Logged out ${result.count} other session(s)`, released: result.count });
  } catch (err) {
    console.error('force_logout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/force_logout_session', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, message: 'Session ID required' });

    const currentToken = req.sessionToken;
    const target = await prisma.userSession.findFirst({
      where: { id: parseInt(session_id), userId, status: 'active' },
    });

    if (!target) return res.status(404).json({ success: false, message: 'Session not found' });
    if (target.sessionToken === currentToken) {
      return res.status(400).json({ success: false, message: 'Cannot force logout your current session' });
    }

    await prisma.userSession.update({
      where: { id: target.id },
      data: { status: 'inactive', logoutReason: 'force_logout_single' },
    });
    sessionStore.releaseUserSession(target.id);
    console.log(`[session] Force logout single userSession id=${target.id} user=${userId} ip=${target.ipAddress}`);

    if (target.ipAddress) {
      const releasedSlots = await prisma.accountSession.updateMany({
        where: { userId, ipAddress: target.ipAddress, status: 'active' },
        data: { status: 'inactive', reason: 'force_logout_single' },
      });
      sessionStore.releaseAccountSessionsByUserAndIp(userId, target.ipAddress);
      if (releasedSlots.count > 0) {
        console.log(`[slot-release] Force logout single: also released ${releasedSlots.count} platform slot(s) for IP ${target.ipAddress}`);
      }
    }
    emitUserEvent(userId, 'session_ended', { reason: 'force_logout_single', session_id: parseInt(session_id) });

    res.json({ success: true, message: 'Session terminated' });
  } catch (err) {
    console.error('force_logout_session error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/active_session_count', authenticate, async (req, res) => {
  try {
    const { platform_id } = req.query;
    const nowMs = Date.now();
    const freshCutoffMs = nowMs - 30 * 1000;
    const freshCutoff = cutoffISO(30);

    const where = {
      status: 'active',
      OR: [
        { lastActiveAt: { gt: BigInt(freshCutoffMs) } },
        { lastActiveAt: 0, lastActive: { gt: freshCutoff } },
      ],
    };
    if (platform_id) where.platformId = parseInt(platform_id);

    const count = await prisma.accountSession.count({ where });

    res.json({ success: true, active_count: count });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/session_health', authenticate, async (req, res) => {
  try {
    const sessions = await prisma.accountSession.findMany({
      where: { userId: req.user.id, status: 'active' },
      include: {
        account: { select: { healthStatus: true, intelligenceScore: true, cookieStatus: true } },
        platform: { select: { name: true } },
      },
    });

    res.json({
      success: true,
      sessions: sessions.map(s => ({
        id: s.id, platform_name: s.platform?.name,
        health_status: s.account?.healthStatus,
        intelligence_score: s.account?.intelligenceScore,
        cookie_status: s.account?.cookieStatus,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_user_profile', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, username: true, name: true, email: true, phone: true,
        country: true, city: true, gender: true, profileImage: true,
        profileCompleted: true, isActive: true, expiryDate: true,
        lastLoginIp: true, createdAt: true,
        subscriptions: {
          where: { isActive: 1 },
          select: {
            id: true, startDate: true, endDate: true, isActive: true,
            platform: { select: { name: true, logoUrl: true, bgColorHex: true } },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let accountStatus = 'active';
    if (!user.isActive) accountStatus = 'inactive';
    else if (user.expiryDate) {
      const exp = new Date(user.expiryDate);
      const now = new Date();
      if (exp < now) accountStatus = 'expired';
      else if ((exp - now) / 86400000 <= 7) accountStatus = 'expiring_soon';
    }

    res.json({
      success: true,
      profile: {
        id: user.id, username: user.username, name: user.name,
        email: user.email, phone: user.phone, country: user.country,
        city: user.city, gender: user.gender, profile_image: user.profileImage,
        profile_completed: user.profileCompleted, expiry_date: user.expiryDate,
        last_login_ip: user.lastLoginIp, account_status: accountStatus,
        created_at: user.createdAt,
      },
      subscriptions: user.subscriptions.map(s => ({
        id: s.id, platform_name: s.platform.name,
        logo_url: s.platform.logoUrl, bg_color_hex: s.platform.bgColorHex,
        start_date: s.startDate, end_date: s.endDate, is_active: s.isActive,
      })),
    });
  } catch (err) {
    console.error('get_user_profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_profile', authenticate, async (req, res) => {
  try {
    const { name, email, phone, country, city, gender } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (email !== undefined) data.email = email;
    if (phone !== undefined) data.phone = phone;
    if (country !== undefined) data.country = country;
    if (city !== undefined) data.city = city;
    if (gender !== undefined) data.gender = gender;

    const hasProfile = name && email && phone;
    if (hasProfile) data.profileCompleted = 1;

    await prisma.user.update({ where: { id: req.user.id }, data });
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/login_history', authenticate, async (req, res) => {
  try {
    const { page, per_page } = req.query;
    const take = Math.min(100, parseInt(per_page) || 25);
    const skip = (Math.max(1, parseInt(page) || 1) - 1) * take;

    const [history, total] = await Promise.all([
      prisma.loginHistory.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.loginHistory.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      success: true,
      history: history.map(h => ({
        id: h.id, ip_address: h.ipAddress, device_type: h.deviceType,
        browser: h.browser, os: h.os, action: h.action, created_at: h.createdAt,
      })),
      total,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_login_history', authenticate, async (req, res) => {
  try {
    await prisma.loginHistory.deleteMany({ where: { userId: req.user.id } });
    res.json({ success: true, message: 'Login history cleared' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
