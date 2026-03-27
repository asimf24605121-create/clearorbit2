import jwt from 'jsonwebtoken';
import { prisma } from '../server.js';
import { nowISO } from '../utils/helpers.js';
import { sessionStore } from '../utils/sessionStore.js';

const JWT_SECRET = process.env.JWT_SECRET || 'clearorbit_jwt_secret_change_in_production';
const SESSION_TIMEOUT_MINUTES = 30;

export function generateToken(payload, expiresIn = '24h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export async function tryAuthenticate(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return next();
  const decoded = verifyToken(token);
  if (!decoded) return next();
  try {
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (user) req.user = user;
  } catch {}
  next();
}

export async function authenticate(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  try {
    const session = await prisma.userSession.findFirst({
      where: {
        userId: decoded.userId,
        sessionToken: decoded.sessionToken,
        status: 'active',
      },
    });

    if (!session) {
      return res.status(401).json({ success: false, message: 'Session expired or invalid' });
    }

    const nowMs = Date.now();
    const lastActivityMs = Number(session.lastActivityAt) || new Date(session.lastActivity).getTime();
    const diffMinutes = (nowMs - lastActivityMs) / 60000;
    if (diffMinutes > SESSION_TIMEOUT_MINUTES) {
      await prisma.userSession.update({
        where: { id: session.id },
        data: { status: 'inactive', logoutReason: 'inactivity_timeout' },
      });
      sessionStore.releaseUserSession(session.id);
      console.log(`[session] Expired userSession id=${session.id} user=${decoded.userId} reason=inactivity_timeout idle=${Math.round(diffMinutes)}min`);
      return res.status(401).json({ success: false, message: 'Session timed out' });
    }

    const currentFingerprint = sessionStore.generateFingerprint(req.ip, req.headers['user-agent']);
    if (session.fingerprint && session.fingerprint !== currentFingerprint) {
      console.log(`[security] Fingerprint mismatch for userSession id=${session.id} user=${decoded.userId} expected=${session.fingerprint.substring(0,8)}... got=${currentFingerprint.substring(0,8)}...`);
    }

    await prisma.userSession.update({
      where: { id: session.id },
      data: { lastActivity: nowISO(), lastActivityAt: BigInt(nowMs) },
    });
    sessionStore.heartbeatUserSession(session.id, nowMs);

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Account disabled' });
    }

    req.user = user;
    req.sessionId = session.id;
    req.sessionToken = decoded.sessionToken;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
}

export function requireAdmin(requiredLevel = null) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    if (requiredLevel === 'super_admin' && req.user.adminLevel !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Super admin access required' });
    }
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
}
