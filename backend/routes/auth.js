import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma, emitUserEvent, emitAdminEvent } from '../server.js';
import { generateToken, authenticate } from '../middleware/auth.js';
import { generateCsrfToken } from '../middleware/csrf.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { nowISO, randomToken, getClientIP, parseUserAgent } from '../utils/helpers.js';
import { sessionStore } from '../utils/sessionStore.js';
import { lookupIP } from '../utils/geoip.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.get('/csrf_token', (req, res) => {
  const token = generateCsrfToken(null);
  res.json({ success: true, csrf_token: token });
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, device_id } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || '';
    const { deviceType, browser, os } = parseUserAgent(ua);

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) {
      await prisma.loginAttemptLog.create({
        data: { username, ipAddress: ip, userAgent: ua, deviceType, browser, os, status: 'failed', reason: 'User not found', createdAt: nowISO() },
      });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      await prisma.loginAttemptLog.create({
        data: { username, ipAddress: ip, userAgent: ua, deviceType, browser, os, status: 'disabled', reason: 'Account disabled', createdAt: nowISO() },
      });
      return res.status(403).json({ success: false, message: 'Account is disabled' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await prisma.loginAttemptLog.create({
        data: { username, ipAddress: ip, userAgent: ua, deviceType, browser, os, status: 'failed', reason: 'Wrong password', createdAt: nowISO() },
      });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const sessionToken = randomToken(32);
    const devId = device_id || `web_${Date.now()}`;

    const nowMs = Date.now();
    const fp = sessionStore.generateFingerprint(ip, ua);
    const sess = await prisma.userSession.create({
      data: {
        userId: user.id, sessionToken, deviceId: devId,
        ipAddress: ip, userAgent: ua, deviceType, browser, os,
        status: 'active', lastActivity: nowISO(), lastActivityAt: BigInt(nowMs),
        createdAt: nowISO(), createdAtMs: BigInt(nowMs), fingerprint: fp,
      },
    });
    sessionStore.registerUserSession(sess);
    console.log(`[session] Created userSession id=${sess.id} user=${user.id} ip=${ip} browser=${browser} fp=${fp.substring(0,8)}`);

    await prisma.loginHistory.create({
      data: { userId: user.id, ipAddress: ip, userAgent: ua, deviceType, browser, os, action: 'login', createdAt: nowISO() },
    });

    await prisma.loginAttemptLog.create({
      data: { username, ipAddress: ip, userAgent: ua, deviceType, browser, os, status: 'success', reason: null, createdAt: nowISO() },
    });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginIp: ip, deviceId: devId, lastLoginAt: new Date().toISOString() } });

    lookupIP(ip).then(async (geo) => {
      if (geo.status === 'success') {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              ipCountry: geo.country, ipRegion: geo.region, ipCity: geo.city,
              ipIsp: geo.isp, ipTimezone: geo.timezone,
              ipLat: geo.lat, ipLon: geo.lon, ipLookupStatus: 'success',
            },
          });
        } catch (e) { console.warn('[login] IP geo save error:', e.message); }
      }
    }).catch(() => {});

    const jwtToken = generateToken({ userId: user.id, sessionToken, role: user.role });
    const csrfToken = generateCsrfToken(user.id);

    const isReplit = !!process.env.REPLIT_DEV_DOMAIN;
    res.cookie('auth_token', jwtToken, {
      httpOnly: true,
      secure: isReplit || process.env.NODE_ENV === 'production',
      sameSite: isReplit ? 'None' : 'Lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({
      success: true,
      message: 'Login successful',
      csrf_token: csrfToken,
      user_id: user.id,
      username: user.username,
      role: user.role,
      admin_level: user.adminLevel,
      name: user.name,
      redirect: user.role === 'admin' ? 'admin.html' : (user.role === 'reseller' ? 'reseller.html' : 'dashboard.html'),
    });
  } catch (err) {
    logger.error('auth', { action: 'login', error: err.message, username: req.body?.username });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_geo', authenticate, async (req, res) => {
  try {
    const { lat, lon } = req.body;
    if (typeof lat !== 'number' || typeof lon !== 'number') return res.json({ success: false, message: 'Invalid coordinates' });
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return res.json({ success: false, message: 'Coordinates out of range' });

    let city = null, country = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`, {
        signal: ctrl.signal, headers: { 'User-Agent': 'ClearOrbit/1.0', 'Accept': 'application/json' }
      });
      clearTimeout(t);
      const data = await r.json();
      if (data.address) {
        city = data.address.city || data.address.town || data.address.village || data.address.county || null;
        country = data.address.country || null;
      }
    } catch {}

    await prisma.user.update({
      where: { id: req.user.id },
      data: { geoLat: lat, geoLon: lon, geoCity: city, geoCountry: country, geoUpdatedAt: new Date().toISOString() }
    });

    res.json({ success: true, city, country });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const logoutResult = await prisma.userSession.updateMany({
      where: { userId, sessionToken: req.sessionToken },
      data: { status: 'inactive', logoutReason: 'user_logout' },
    });
    if (req.sessionId) sessionStore.releaseUserSession(req.sessionId);
    console.log(`[session] Logout userSession user=${userId} released=${logoutResult.count} reason=user_logout`);

    const activeSlots = await prisma.accountSession.findMany({
      where: { userId, status: 'active' },
      select: { id: true, platformId: true, accountId: true },
    });

    let platforms = [];
    if (activeSlots.length > 0) {
      const slotIds = activeSlots.map(s => s.id);
      await prisma.accountSession.updateMany({
        where: { id: { in: slotIds } },
        data: { status: 'inactive', reason: 'user_logout' },
      });
      for (const s of activeSlots) {
        sessionStore.releaseAccountSession(s.id);
        console.log(`[slot-release] logout_revoke sessionId=${s.id} user=${userId} platform=${s.platformId} account=${s.accountId}`);
      }
      console.log(`[logout-revoke] Released ${slotIds.length} platform slot(s) on logout user=${userId}`);

      const platformIds = [...new Set(activeSlots.map(s => s.platformId))];
      const platformRecords = await prisma.platform.findMany({
        where: { id: { in: platformIds } },
        select: { id: true, cookieDomain: true, name: true },
      });
      platforms = platformRecords.map(p => p.cookieDomain).filter(Boolean);

      emitUserEvent(userId, 'platform_access_revoked', {
        reason: 'user_logout',
        platform_ids: platformIds,
        platforms: platforms,
        session_ids: slotIds,
      });
      emitAdminEvent('sessions_cleaned', { released: slotIds.length, reason: 'user_logout', userId });
    }

    await prisma.loginHistory.create({
      data: {
        userId, ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'] || '', action: 'logout',
        ...parseUserAgent(req.headers['user-agent']),
        createdAt: nowISO(),
      },
    });

    res.clearCookie('auth_token', { path: '/' });
    res.json({ success: true, message: 'Logged out', platforms });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/check_session', authenticate, (req, res) => {
  const csrfToken = generateCsrfToken(req.user.id);
  res.json({
    success: true,
    user_id: req.user.id,
    role: req.user.role,
    admin_level: req.user.adminLevel,
    csrf_token: csrfToken,
  });
});

router.post('/heartbeat', authenticate, async (req, res) => {
  res.json({ success: true, timestamp: nowISO() });
});

router.get('/session/validate', authenticate, (req, res) => {
  res.json({ success: true, valid: true, userId: req.user.id, timestamp: Date.now() });
});

router.get('/keep_alive', authenticate, (req, res) => {
  res.json({ success: true });
});

router.post('/forgot_password', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required' });

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.json({ success: true, message: 'If the account exists, a reset link has been sent' });

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').substring(0, 19);

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'If the account exists, a reset link has been sent', token });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reset_password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ success: false, message: 'Token and new password required' });

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: { token, used: 0 },
    });

    if (!resetToken || new Date(resetToken.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash: hash } });
    await prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used: 1 } });

    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/change_password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }

    const valid = await bcrypt.compare(current_password, req.user.passwordHash);
    if (!valid) return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: hash } });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
