import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import { fileURLToPath } from 'url';

import { apiLimiter } from './middleware/rateLimit.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { verifyToken } from './middleware/auth.js';
import { cutoffISO } from './utils/helpers.js';
import { sessionStore } from './utils/sessionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const prisma = new PrismaClient();

const app = express();
const httpServer = createServer(app);

const isReplit = !!process.env.REPLIT_DEV_DOMAIN;
const allowedOrigins = [];
if (isReplit) {
  allowedOrigins.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
}
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
}

app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, true);
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(apiLimiter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

  }
  next();
});

import { sanitizeMiddleware } from './middleware/sanitize.js';
app.use('/api', sanitizeMiddleware);
app.use('/api', csrfMiddleware);

const staticRoot = path.join(__dirname, '..');
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
}
app.use(express.static(staticRoot, {
  extensions: ['html'],
  index: 'index.html',
}));

app.use('/uploads', express.static(path.join(staticRoot, 'uploads')));
app.use('/assets', express.static(path.join(staticRoot, 'assets')));

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import platformRoutes from './routes/platforms.js';
import accountRoutes from './routes/accounts.js';
import subscriptionRoutes from './routes/subscriptions.js';
import dashboardRoutes from './routes/dashboard.js';
import supportRoutes from './routes/support.js';
import resellerRoutes from './routes/reseller.js';

app.use('/api', authRoutes);
app.use('/api', adminRoutes);
app.use('/api', platformRoutes);
app.use('/api', accountRoutes);
app.use('/api', subscriptionRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', supportRoutes);
app.use('/api', resellerRoutes);

app.get('/api/parse', (req, res) => {
  res.json({ success: true, message: 'Parse endpoint - use POST with cookie data' });
});

app.get('/api/verify_login', (req, res) => {
  res.json({ success: true, message: 'Use POST /api/login for authentication' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

app.get('/:page.html', (req, res) => {
  const filePath = path.join(staticRoot, `${req.params.page}.html`);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send('Page not found');
  });
});

const io = new SocketServer(httpServer, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    credentials: true,
  },
  path: '/socket.io',
});

const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie?.match(/auth_token=([^;]+)/)?.[1];
  if (!token) return next(new Error('Authentication required'));

  const decoded = verifyToken(token);
  if (!decoded) return next(new Error('Invalid token'));

  socket.userId = decoded.userId;
  socket.userRole = decoded.role;
  next();
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, {
    socketId: socket.id,
    connectedAt: new Date().toISOString(),
  });

  io.emit('online_count', onlineUsers.size);

  socket.join(`user_${socket.userId}`);

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.userId);
    io.emit('online_count', onlineUsers.size);
  });

  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });

  if (socket.userRole === 'admin') {
    socket.join('admin_room');
  }
});

export function emitAdminEvent(event, data) {
  io.to('admin_room').emit(event, { ...data, timestamp: Date.now() });
}

export function emitUserEvent(userId, event, data) {
  io.to(`user_${userId}`).emit(event, { ...data, timestamp: Date.now() });
}

export { io, onlineUsers };

import { accountQueue } from './utils/jobQueue.js';

const AUTO_RECHECK_INTERVAL = 30 * 60 * 1000;

async function autoRecheckJob(data, updateProgress) {
  const { parseRawCookieString, computeCookieScore, extractCookieExpiry } = await import('./utils/cookieEngine.js');
  const staleThreshold = cutoffISO(60 * 60);

  const accounts = await prisma.platformAccount.findMany({
    where: {
      isActive: 1,
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: staleThreshold } },
      ],
    },
    include: { platform: { select: { name: true } } },
    take: 50,
  });

  if (accounts.length === 0) return { updated: 0 };

  let updated = 0;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const today = new Date().toISOString().substring(0, 10);
  const deadTransitionPlatforms = new Map();

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const raw = account.cookieData ? Buffer.from(account.cookieData, 'base64').toString('utf-8') : '';
      const parsed = raw ? parseRawCookieString(raw) : [];
      const score = parsed.length > 0 ? computeCookieScore(parsed) : 0;
      const expiry = parsed.length > 0 ? extractCookieExpiry(parsed) : null;
      const isExpired = expiry ? new Date(expiry) < new Date() : false;
      const cookieStatus = parsed.length === 0 ? 'MISSING' : isExpired ? 'EXPIRED' : score >= 50 ? 'VALID' : 'WEAK';
      const newStability = score >= 70 ? 'STABLE' : score >= 40 ? 'RISKY' : 'DEAD';

      if (newStability === 'DEAD' && account.stabilityStatus !== 'DEAD') {
        if (!deadTransitionPlatforms.has(account.platformId)) {
          deadTransitionPlatforms.set(account.platformId, account.platform?.name || `Platform ${account.platformId}`);
        }
      }

      await prisma.platformAccount.update({
        where: { id: account.id },
        data: {
          cookieStatus, intelligenceScore: score,
          stabilityStatus: newStability,
          healthStatus: score >= 50 ? 'healthy' : 'degraded',
          lastCheckedAt: now, updatedAt: now,
        },
      });
      updated++;
    } catch (e) {
      console.error(`Auto-recheck error for account ${account.id}:`, e.message);
    }
    updateProgress(Math.round(((i + 1) / accounts.length) * 100));
  }

  for (const [platformId, platformName] of deadTransitionPlatforms) {
    try {
      const dedupeKey = `platform_dead_${platformId}_${today}`;
      const existing = await prisma.adminNotification.findFirst({ where: { dedupeKey } });
      if (!existing) {
        const notif = await prisma.adminNotification.create({
          data: {
            type: 'platform_dead',
            title: 'Platform Became Dead',
            message: `${platformName} has transitioned to DEAD status — accounts are critically degraded.`,
            platformId,
            platformName,
            severity: 'critical',
            isRead: 0,
            dedupeKey,
            createdAt: now,
          },
        });
        emitAdminEvent('platform_dead_alert', {
          notificationId: notif.id,
          platformId,
          platformName,
          message: notif.message,
          severity: 'critical',
          createdAt: now,
        });
      }
    } catch (e) {
      console.error(`Dead-platform notification error for platform ${platformId}:`, e.message);
    }
  }

  if (updated > 0) {
    console.log(`Auto-recheck: updated ${updated} accounts`);
    const { invalidateAccountCaches } = await import('./utils/cache.js');
    invalidateAccountCaches();
    emitAdminEvent('accounts_rechecked', { updated, total: accounts.length });
  }
  return { updated, total: accounts.length };
}

function scheduleAutoRecheck() {
  accountQueue.add('auto_recheck', autoRecheckJob, {}, { maxAttempts: 2, retryDelay: 5000 });
}

accountQueue.on('failed', (data) => {
  console.error(`Job ${data.name} failed after ${data.attempts} attempts: ${data.error}`);
});

const SESSION_STALE_SECONDS = 30;
const SESSION_CLEANUP_INTERVAL = 10 * 1000;

async function cleanupStaleSessions() {
  try {
    const nowMs = Date.now();
    const accountCutoffMs = nowMs - SESSION_STALE_SECONDS * 1000;
    const userCutoffMs = nowMs - 30 * 60 * 1000;

    const accountCutoff = cutoffISO(SESSION_STALE_SECONDS);
    const userSessionCutoff = cutoffISO(30 * 60);

    const storeBefore = sessionStore.getStats();

    const staleAccountRows = await prisma.accountSession.findMany({
      where: {
        status: 'active',
        OR: [
          { lastActiveAt: { gt: 0, lt: BigInt(accountCutoffMs) } },
          { lastActiveAt: 0, lastActive: { lt: accountCutoff, not: '' } },
        ],
      },
      select: { id: true },
    });

    if (staleAccountRows.length > 0) {
      const staleSessions = await prisma.accountSession.findMany({
        where: { id: { in: staleAccountRows.map(s => s.id) } },
        select: { id: true, userId: true, platformId: true, accountId: true, lastActiveAt: true },
      });
      const staleIds = staleSessions.map(s => s.id);
      await prisma.accountSession.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'inactive', reason: 'stale_timeout' },
      });
      const userPlatformMap = new Map();
      for (const s of staleSessions) {
        sessionStore.releaseAccountSession(s.id);
        const ageMs = nowMs - Number(s.lastActiveAt || 0);
        console.log(`[slot-release] stale_timeout sessionId=${s.id} user=${s.userId} platform=${s.platformId} account=${s.accountId} age=${Math.round(ageMs/1000)}s`);
        emitUserEvent(s.userId, 'session_ended', { session_id: s.id, platform_id: s.platformId, reason: 'stale_timeout' });
        const key = `${s.userId}:${s.platformId}`;
        if (!userPlatformMap.has(key)) userPlatformMap.set(key, { userId: s.userId, platformId: s.platformId, sids: [] });
        userPlatformMap.get(key).sids.push(s.id);
      }
      for (const [, entry] of userPlatformMap) {
        emitUserEvent(entry.userId, 'slot_released', { platform_id: entry.platformId, session_ids: entry.sids, released: entry.sids.length, reason: 'stale_timeout' });
      }
      console.log(`[cleanup] Released ${staleIds.length} stale account session(s) (cutoffMs=${accountCutoffMs}, store had ${storeBefore.activeAccountSessions})`);
      emitAdminEvent('sessions_cleaned', { released: staleIds.length });
    }

    const staleUserRows = await prisma.userSession.findMany({
      where: {
        status: 'active',
        OR: [
          { lastActivityAt: { gt: 0, lt: BigInt(userCutoffMs) } },
          { lastActivityAt: 0, lastActivity: { lt: userSessionCutoff, not: '' } },
        ],
      },
      select: { id: true },
    });

    if (staleUserRows.length > 0) {
      const staleUserIds = staleUserRows.map(s => s.id);
      await prisma.userSession.updateMany({
        where: { id: { in: staleUserIds } },
        data: { status: 'inactive', logoutReason: 'stale_timeout' },
      });
      for (const id of staleUserIds) sessionStore.releaseUserSession(id);
      console.log(`[cleanup] Marked ${staleUserIds.length} stale user session(s) inactive (cutoffMs=${userCutoffMs}, store had ${storeBefore.activeUserSessions})`);
    }
  } catch (err) {
    console.error('Session cleanup error:', err.message);
  }
}

export { SESSION_STALE_SECONDS };

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`ClearOrbit Node.js server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (isReplit) console.log(`Replit domain: ${process.env.REPLIT_DEV_DOMAIN}`);

  await sessionStore.syncFromDb(prisma);

  setInterval(scheduleAutoRecheck, AUTO_RECHECK_INTERVAL);
  setTimeout(scheduleAutoRecheck, 10000);

  setInterval(cleanupStaleSessions, SESSION_CLEANUP_INTERVAL);
  setTimeout(cleanupStaleSessions, 5000);

  const SLOT_SYNC_INTERVAL = 60 * 1000;
  setInterval(sessionStore.runSlotSyncCheck(prisma), SLOT_SYNC_INTERVAL);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
