import { logger } from './logger.js';
import crypto from 'crypto';

class SessionStore {
  constructor() {
    this.accountSessions = new Map();
    this.userSessions = new Map();
    this.initialized = false;
  }

  generateFingerprint(ip, userAgent) {
    return crypto.createHash('sha256').update(`${ip || ''}|${userAgent || ''}`).digest('hex').substring(0, 32);
  }

  registerAccountSession(session) {
    this.accountSessions.set(session.id, {
      id: session.id,
      accountId: session.accountId,
      userId: session.userId,
      platformId: session.platformId,
      sessionKey: session.sessionKey || '',
      ipAddress: session.ipAddress || '',
      deviceType: session.deviceType || '',
      lastActiveAt: Number(session.lastActiveAt) || Date.now(),
      createdAtMs: Number(session.createdAtMs) || Date.now(),
      status: 'active',
    });
  }

  registerUserSession(session) {
    this.userSessions.set(session.id, {
      id: session.id,
      userId: session.userId,
      sessionToken: session.sessionToken,
      ipAddress: session.ipAddress || '',
      browser: session.browser || 'Unknown',
      os: session.os || 'Unknown',
      deviceType: session.deviceType || 'desktop',
      fingerprint: session.fingerprint || '',
      lastActivityAt: Number(session.lastActivityAt) || Date.now(),
      createdAtMs: Number(session.createdAtMs) || Date.now(),
      status: 'active',
    });
  }

  heartbeatAccountSession(id, now) {
    const s = this.accountSessions.get(id);
    if (s && s.status === 'active') {
      s.lastActiveAt = now || Date.now();
      return true;
    }
    return false;
  }

  heartbeatAccountSessionByIdentity(userId, platformId, ipAddress, now) {
    const ts = now || Date.now();
    let count = 0;
    for (const s of this.accountSessions.values()) {
      if (s.userId === userId && s.platformId === platformId && s.ipAddress === ipAddress && s.status === 'active') {
        s.lastActiveAt = ts;
        count++;
      }
    }
    return count;
  }

  heartbeatUserSession(id, now) {
    const s = this.userSessions.get(id);
    if (s && s.status === 'active') {
      s.lastActivityAt = now || Date.now();
      return true;
    }
    return false;
  }

  releaseAccountSession(id) {
    const s = this.accountSessions.get(id);
    if (s) {
      s.status = 'inactive';
      this.accountSessions.delete(id);
      return true;
    }
    return false;
  }

  releaseAccountSessionsByIdentity(userId, platformId, ipAddress) {
    let count = 0;
    for (const [id, s] of this.accountSessions) {
      if (s.userId === userId && s.platformId === platformId && s.ipAddress === ipAddress && s.status === 'active') {
        s.status = 'inactive';
        this.accountSessions.delete(id);
        count++;
      }
    }
    return count;
  }

  releaseUserSession(id) {
    const s = this.userSessions.get(id);
    if (s) {
      s.status = 'inactive';
      this.userSessions.delete(id);
      return true;
    }
    return false;
  }

  releaseAllUserSessionsExcept(userId, keepToken) {
    let count = 0;
    for (const [id, s] of this.userSessions) {
      if (s.userId === userId && s.sessionToken !== keepToken && s.status === 'active') {
        s.status = 'inactive';
        this.userSessions.delete(id);
        count++;
      }
    }
    return count;
  }

  releaseAllAccountSessionsForUser(userId) {
    let count = 0;
    for (const [id, s] of this.accountSessions) {
      if (s.userId === userId && s.status === 'active') {
        s.status = 'inactive';
        this.accountSessions.delete(id);
        count++;
      }
    }
    return count;
  }

  releaseAccountSessionsByUserAndIp(userId, ipAddress) {
    let count = 0;
    for (const [id, s] of this.accountSessions) {
      if (s.userId === userId && s.ipAddress === ipAddress && s.status === 'active') {
        s.status = 'inactive';
        this.accountSessions.delete(id);
        count++;
      }
    }
    return count;
  }

  getActiveAccountSessions(platformId, accountId) {
    const results = [];
    for (const s of this.accountSessions.values()) {
      if (s.status !== 'active') continue;
      if (platformId !== undefined && s.platformId !== platformId) continue;
      if (accountId !== undefined && s.accountId !== accountId) continue;
      results.push(s);
    }
    return results;
  }

  getFreshAccountSlotCount(accountId, staleCutoffMs) {
    let count = 0;
    const identities = new Set();
    for (const s of this.accountSessions.values()) {
      if (s.accountId !== accountId || s.status !== 'active') continue;
      if (s.lastActiveAt < staleCutoffMs) continue;
      const key = `${s.userId}|${s.platformId}|${s.sessionKey}|${s.ipAddress}`;
      if (!identities.has(key)) {
        identities.add(key);
        count++;
      }
    }
    return count;
  }

  getStaleAccountSessions(cutoffMs) {
    const stale = [];
    for (const s of this.accountSessions.values()) {
      if (s.status === 'active' && s.lastActiveAt > 0 && s.lastActiveAt < cutoffMs) {
        stale.push(s);
      }
    }
    return stale;
  }

  getStaleUserSessions(cutoffMs) {
    const stale = [];
    for (const s of this.userSessions.values()) {
      if (s.status === 'active' && s.lastActivityAt > 0 && s.lastActivityAt < cutoffMs) {
        stale.push(s);
      }
    }
    return stale;
  }

  findExistingAccountSession(userId, platformId, sessionKey, ipAddress) {
    for (const s of this.accountSessions.values()) {
      if (s.userId === userId && s.platformId === platformId && s.sessionKey === sessionKey && s.ipAddress === ipAddress && s.status === 'active') {
        return s;
      }
    }
    return null;
  }

  findUserSessionByToken(userId, sessionToken) {
    for (const s of this.userSessions.values()) {
      if (s.userId === userId && s.sessionToken === sessionToken && s.status === 'active') {
        return s;
      }
    }
    return null;
  }

  validateFingerprint(sessionId, expectedFingerprint) {
    const s = this.userSessions.get(sessionId);
    if (!s || !s.fingerprint) return true;
    return s.fingerprint === expectedFingerprint;
  }

  purgeStaleForPlatform(platformId, cutoffMs) {
    const purged = [];
    for (const [id, s] of this.accountSessions) {
      if (s.platformId === platformId && s.status === 'active' && s.lastActiveAt > 0 && s.lastActiveAt < cutoffMs) {
        purged.push({ id, userId: s.userId, accountId: s.accountId });
        this.accountSessions.delete(id);
      }
    }
    return purged;
  }

  getActiveCountForAccount(accountId) {
    let count = 0;
    for (const s of this.accountSessions.values()) {
      if (s.accountId === accountId && s.status === 'active') count++;
    }
    return count;
  }

  getStats() {
    return {
      activeAccountSessions: this.accountSessions.size,
      activeUserSessions: this.userSessions.size,
      initialized: this.initialized,
    };
  }

  async syncFromDb(prisma) {
    const [accountSessions, userSessions] = await Promise.all([
      prisma.accountSession.findMany({ where: { status: 'active' } }),
      prisma.userSession.findMany({ where: { status: 'active' } }),
    ]);

    this.accountSessions.clear();
    this.userSessions.clear();

    for (const s of accountSessions) {
      this.registerAccountSession(s);
    }
    for (const s of userSessions) {
      this.registerUserSession(s);
    }

    this.initialized = true;
    logger.info("store", { action: "sync", accountSessions: accountSessions.length, userSessions: userSessions.length });
  }

  runSlotSyncCheck(prisma) {
    return async () => {
      try {
        const [dbAccountSessions, dbUserSessions] = await Promise.all([
          prisma.accountSession.findMany({ where: { status: 'active' }, select: { id: true } }),
          prisma.userSession.findMany({ where: { status: 'active' }, select: { id: true } }),
        ]);

        const dbAccountIds = new Set(dbAccountSessions.map(s => s.id));
        const dbUserIds = new Set(dbUserSessions.map(s => s.id));
        const storeAccountIds = new Set(this.accountSessions.keys());
        const storeUserIds = new Set(this.userSessions.keys());

        let drifted = false;
        if (dbAccountIds.size !== storeAccountIds.size || dbUserIds.size !== storeUserIds.size) {
          drifted = true;
        } else {
          for (const id of dbAccountIds) { if (!storeAccountIds.has(id)) { drifted = true; break; } }
          if (!drifted) for (const id of storeAccountIds) { if (!dbAccountIds.has(id)) { drifted = true; break; } }
          if (!drifted) for (const id of dbUserIds) { if (!storeUserIds.has(id)) { drifted = true; break; } }
          if (!drifted) for (const id of storeUserIds) { if (!dbUserIds.has(id)) { drifted = true; break; } }
        }

        if (drifted) {
          logger.warn("store", { action: "sync_mismatch" });
          await this.syncFromDb(prisma);
        }
      } catch (err) {
        logger.error("store", { action: "sync_error", error: err.message });
      }
    };
  }
}

export const sessionStore = new SessionStore();
export default sessionStore;
