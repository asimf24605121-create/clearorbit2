import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { adminActionLimiter } from '../middleware/rateLimit.js';
import { generateCsrfToken } from '../middleware/csrf.js';
import { nowISO, cutoffISO, todayISO, futureDate, computeEndDate, extendEndDate, isSubExpired, parseEndDateUTC, getRemainingMs, formatRemainingMs, paginate, isPermanentSuperAdmin } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.get('/admin_init', authenticate, requireAdmin(), async (req, res) => {
  try {
    const csrfToken = generateCsrfToken(req.user.id);
    const now = nowISO();
    const today = todayISO();

    const [
      recentUsers,
      platforms,
      cookies,
      totalUsers,
      activeUsers,
      newUsersToday,
      totalPlatforms,
      activeSubs,
      newSubsToday,
      expiringSoon,
      expiringSubs7d,
      allActiveSubs,
      activeSessions,
      recentLogs,
      pendingPayments,
      pendingTickets,
    ] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'user' },
        select: {
          id: true, username: true, name: true, email: true, phone: true,
          isActive: true, createdAt: true, expiryDate: true, country: true,
          city: true, gender: true, profileImage: true, resellerId: true,
          subscriptions: {
            select: { id: true, platformId: true, startDate: true, endDate: true, isActive: true, platform: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.platform.findMany({
        include: {
          platformAccounts: { select: { id: true, slotName: true, isActive: true, healthStatus: true, cookieStatus: true } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.cookieVault.findMany({
        include: { platform: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      prisma.user.count({ where: { role: 'user' } }),
      prisma.user.count({ where: { role: 'user', isActive: 1 } }),
      prisma.user.count({ where: { role: 'user', createdAt: { gte: today } } }),
      prisma.platform.count(),
      prisma.userSubscription.count({ where: { isActive: 1 } }),
      prisma.userSubscription.count({ where: { isActive: 1, startDate: { gte: today } } }),
      prisma.userSubscription.count({
        where: { isActive: 1, endDate: { lte: futureDate(1) } },
      }),
      prisma.userSubscription.count({
        where: { isActive: 1, endDate: { lte: futureDate(7) } },
      }),
      prisma.userSubscription.findMany({
        where: { isActive: 1 },
        select: { userId: true, endDate: true },
      }),
      prisma.userSession.count({ where: { status: 'active' } }),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.payment.count({ where: { status: 'pending' } }),
      prisma.supportTicket.count({ where: { status: 'pending' } }),
    ]);

    res.json({
      success: true,
      csrf_token: csrfToken,
      user_id: req.user.id,
      admin_level: req.user.adminLevel,
      recent_users: recentUsers.map(u => ({
        id: u.id, username: u.username, name: u.name, email: u.email,
        phone: u.phone, is_active: u.isActive, created_at: u.createdAt,
        expiry_date: u.expiryDate, country: u.country, city: u.city,
        gender: u.gender, profile_image: u.profileImage, reseller_id: u.resellerId,
        subscription_count: u.subscriptions.length,
        active_platforms: u.subscriptions.filter(s => s.isActive).map(s => s.platform.name),
        subscriptions: u.subscriptions.map(s => ({
          id: s.id, platform_id: s.platformId, start_date: s.startDate,
          end_date: s.endDate, is_active: s.isActive,
        })),
      })),
      platforms: platforms.map(p => ({
        id: p.id, name: p.name, logo_url: p.logoUrl, bg_color_hex: p.bgColorHex,
        is_active: p.isActive, max_slots_per_cookie: p.maxSlotsPerCookie,
        cookie_domain: p.cookieDomain, login_url: p.loginUrl,
        health_score: p.healthScore, health_status: p.healthStatus,
        total_accounts: p.totalAccounts,
        accounts: p.platformAccounts.map(a => ({
          id: a.id, slot_name: a.slotName, is_active: a.isActive,
          health_status: a.healthStatus, cookie_status: a.cookieStatus,
        })),
      })),
      cookies: cookies.map(c => ({
        id: c.id, platform_id: c.platformId, platform_name: c.platform?.name || 'Unknown',
        cookie_string: c.cookieString, expires_at: c.expiresAt,
        updated_at: c.updatedAt, cookie_count: c.cookieCount,
        cookie_status: c.cookieStatus, login_status: c.loginStatus,
        score: c.score, fingerprint: c.fingerprint,
      })),
      kpi: (() => {
        let totalSlots = 0, usedSlots = 0;
        platforms.forEach(p => {
          const accts = p.platformAccounts || [];
          totalSlots += accts.length;
          usedSlots += accts.filter(a => a.isActive).length;
        });
        const slotUtil = totalSlots > 0 ? Math.round((usedSlots / totalSlots) * 100) : 0;
        const now = Date.now();
        const userNearestMs = {};
        for (const sub of allActiveSubs) {
          const ms = Math.max(0, parseEndDateUTC(sub.endDate) - now);
          if (!(sub.userId in userNearestMs) || ms < userNearestMs[sub.userId]) {
            userNearestMs[sub.userId] = ms;
          }
        }
        let expCritical = 0, expHigh = 0, expWarning = 0;
        for (const uid in userNearestMs) {
          const ms = userNearestMs[uid];
          if (ms > 0 && ms < 3600000) expCritical++;
          else if (ms > 0 && ms < 6 * 3600000) expHigh++;
          else if (ms > 0 && ms < 86400000) expWarning++;
        }
        return {
          total_users: totalUsers,
          active_users: activeUsers,
          live_sessions: activeSessions,
          slot_utilization: slotUtil,
          active_subs: activeSubs,
          expiring_subs_24h: expiringSoon,
          total_platforms: totalPlatforms,
          new_users_today: newUsersToday,
          used_slots: usedSlots,
          total_slots: totalSlots,
          new_subs_today: newSubsToday,
          expiring_subs_7d: expiringSubs7d,
          pending_payments: pendingPayments,
          pending_tickets: pendingTickets,
          errors_last_hour: 0,
          expiry_users_critical: expCritical,
          expiry_users_high: expHigh,
          expiry_users_warning: expWarning,
          expiry_users_total: expCritical + expHigh + expWarning,
        };
      })(),
      system_health: 'healthy',
      alerts: [],
      recent_logs: recentLogs.map(l => ({
        id: l.id, user_id: l.userId, action: l.action,
        ip_address: l.ipAddress, created_at: l.createdAt,
      })),
    });
  } catch (err) {
    logger.error('admin', { action: 'admin_init', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/admin_stats', authenticate, requireAdmin(), async (req, res) => {
  try {
    const today = todayISO();

    const [users, platforms, cookies, logs] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'user' },
        select: {
          id: true, username: true, name: true, email: true, phone: true,
          isActive: true, createdAt: true, expiryDate: true, country: true,
          city: true, gender: true, profileImage: true, resellerId: true,
          subscriptions: {
            select: { id: true, platformId: true, startDate: true, endDate: true, isActive: true, platform: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.platform.findMany({
        include: {
          platformAccounts: { select: { id: true, slotName: true, isActive: true, healthStatus: true, cookieStatus: true } },
        },
      }),
      prisma.cookieVault.findMany({
        include: { platform: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.isActive).length;

    res.json({
      success: true,
      recent_users: users.map(u => ({
        id: u.id, username: u.username, name: u.name, email: u.email,
        phone: u.phone, is_active: u.isActive, created_at: u.createdAt,
        expiry_date: u.expiryDate, country: u.country, city: u.city,
        gender: u.gender, profile_image: u.profileImage, reseller_id: u.resellerId,
        subscription_count: u.subscriptions.length,
        active_platforms: u.subscriptions.filter(s => s.isActive).map(s => s.platform.name),
        subscriptions: u.subscriptions.map(s => ({
          id: s.id, platform_id: s.platformId, start_date: s.startDate,
          end_date: s.endDate, is_active: s.isActive,
        })),
      })),
      platforms: platforms.map(p => ({
        id: p.id, name: p.name, logo_url: p.logoUrl, bg_color_hex: p.bgColorHex,
        is_active: p.isActive, health_score: p.healthScore, health_status: p.healthStatus,
        total_accounts: p.totalAccounts,
      })),
      cookies: cookies.map(c => ({
        id: c.id, platform_id: c.platformId, platform_name: c.platform?.name || 'Unknown',
        cookie_string: c.cookieString, expires_at: c.expiresAt,
        updated_at: c.updatedAt, cookie_count: c.cookieCount,
        cookie_status: c.cookieStatus, login_status: c.loginStatus,
        score: c.score, fingerprint: c.fingerprint,
      })),
      recent_logs: logs.map(l => ({
        id: l.id, user_id: l.userId, action: l.action,
        ip_address: l.ipAddress, created_at: l.createdAt,
      })),
      kpi: { total_users: totalUsers, active_users: activeUsers },
    });
  } catch (err) {
    logger.error('admin', { action: 'admin_stats', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/admin_overview', authenticate, requireAdmin(), async (req, res) => {
  try {
    const now = nowISO();
    const today = todayISO();
    const oneHourAgo = cutoffISO(3600);

    const [
      totalUsers, activeUsers, newUsersToday, totalPlatforms,
      activeSessions, activeSubs, newSubsToday,
      expiringSubs24h, expiringSubs7d, ovAllActiveSubs, pendingPayments,
      platforms, recentLogs, recentPayments, securityLogs,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'user' } }),
      prisma.user.count({ where: { role: 'user', isActive: 1 } }),
      prisma.user.count({ where: { role: 'user', createdAt: { gte: today } } }),
      prisma.platform.count(),
      prisma.userSession.count({ where: { status: 'active' } }),
      prisma.userSubscription.count({ where: { isActive: 1 } }),
      prisma.userSubscription.count({ where: { isActive: 1, startDate: { gte: today } } }),
      prisma.userSubscription.count({ where: { isActive: 1, endDate: { lte: futureDate(1) } } }),
      prisma.userSubscription.count({ where: { isActive: 1, endDate: { lte: futureDate(7) } } }),
      prisma.userSubscription.findMany({
        where: { isActive: 1 },
        select: { userId: true, endDate: true },
      }),
      prisma.payment.count({ where: { status: 'pending' } }),
      prisma.platform.findMany({
        include: { platformAccounts: { select: { id: true, isActive: true } } },
      }),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.payment.findMany({
        where: { status: 'approved' },
        select: { price: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.activityLog.findMany({
        where: { action: { in: ['login', 'failed_login', 'logout', 'password_change'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    let totalSlots = 0;
    let usedSlots = 0;
    const platformHealth = platforms.map(p => {
      const accounts = p.platformAccounts || [];
      const activeAccounts = accounts.filter(a => a.isActive).length;
      totalSlots += accounts.length;
      usedSlots += activeAccounts;
      return {
        name: p.name,
        health_score: p.healthScore || 100,
        health_status: p.healthStatus || 'healthy',
        total_accounts: accounts.length,
        active_accounts: activeAccounts,
      };
    });
    const slotUtil = totalSlots > 0 ? Math.round((usedSlots / totalSlots) * 100) : 0;

    const totalRevenue = recentPayments.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);
    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);
    const monthRevenue = recentPayments
      .filter(p => new Date(p.createdAt) >= thisMonthStart)
      .reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);
    const todayRevenue = recentPayments
      .filter(p => p.createdAt >= today)
      .reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

    const revenueHistory = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const dayStr = d.toISOString().split('T')[0];
      const dayLabel = d.toLocaleDateString('en', { weekday: 'short' });
      const amount = recentPayments
        .filter(p => p.createdAt?.startsWith?.(dayStr) || (typeof p.createdAt === 'string' && p.createdAt.startsWith(dayStr)))
        .reduce((s, p) => s + (parseFloat(p.price) || 0), 0);
      revenueHistory.push({ label: dayLabel, amount });
    }

    const userGrowth = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const dayStr = d.toISOString().split('T')[0];
      const dayLabel = d.toLocaleDateString('en', { weekday: 'short' });
      userGrowth.push({ label: dayLabel, count: i === 0 ? newUsersToday : 0 });
    }

    const errorsLastHour = await prisma.activityLog.count({
      where: { action: 'failed_login', createdAt: { gte: oneHourAgo } },
    });

    const ovNow = Date.now();
    const ovUserNearestMs = {};
    for (const sub of ovAllActiveSubs) {
      const ms = Math.max(0, parseEndDateUTC(sub.endDate) - ovNow);
      if (!(sub.userId in ovUserNearestMs) || ms < ovUserNearestMs[sub.userId]) {
        ovUserNearestMs[sub.userId] = ms;
      }
    }
    let ovExpCritical = 0, ovExpHigh = 0, ovExpWarning = 0;
    for (const uid in ovUserNearestMs) {
      const ms = ovUserNearestMs[uid];
      if (ms > 0 && ms < 3600000) ovExpCritical++;
      else if (ms > 0 && ms < 6 * 3600000) ovExpHigh++;
      else if (ms > 0 && ms < 86400000) ovExpWarning++;
    }

    let systemHealth = 'healthy';
    const alerts = [];
    if (slotUtil >= 90) { systemHealth = 'critical'; alerts.push({ type: 'danger', message: 'Slot utilization above 90%' }); }
    else if (slotUtil >= 75) { systemHealth = 'warning'; alerts.push({ type: 'warning', message: 'Slot utilization above 75%' }); }
    if (ovExpCritical > 0) alerts.push({ type: 'danger', message: `${ovExpCritical} user(s) expiring within 1 hour — immediate action needed` });
    if (ovExpHigh > 0) alerts.push({ type: 'warning', message: `${ovExpHigh} user(s) expiring within 6 hours` });
    if (ovExpWarning > 0) alerts.push({ type: 'warning', message: `${ovExpWarning} user(s) expiring within 24 hours` });
    if (pendingPayments > 0) alerts.push({ type: 'info', message: `${pendingPayments} pending payment(s) awaiting approval` });

    res.json({
      success: true,
      kpi: {
        total_users: totalUsers,
        active_users: activeUsers,
        live_sessions: activeSessions,
        slot_utilization: slotUtil,
        active_subs: activeSubs,
        expiring_subs_24h: expiringSubs24h,
        total_platforms: totalPlatforms,
        new_users_today: newUsersToday,
        used_slots: usedSlots,
        total_slots: totalSlots,
        new_subs_today: newSubsToday,
        expiring_subs_7d: expiringSubs7d,
        pending_payments: pendingPayments,
        errors_last_hour: errorsLastHour,
        expiry_users_critical: ovExpCritical,
        expiry_users_high: ovExpHigh,
        expiry_users_warning: ovExpWarning,
        expiry_users_total: ovExpCritical + ovExpHigh + ovExpWarning,
      },
      system_health: systemHealth,
      alerts,
      revenue: {
        total: totalRevenue,
        this_month: monthRevenue,
        today: todayRevenue,
        pending: pendingPayments,
        history: revenueHistory,
      },
      user_growth: userGrowth,
      platform_health: platformHealth,
      platform_load: platforms.map(p => ({
        name: p.name,
        active: (p.platformAccounts || []).filter(a => a.isActive).length,
        total: (p.platformAccounts || []).length,
      })),
      slot_intelligence: {
        total: totalSlots,
        used: usedSlots,
        available: totalSlots - usedSlots,
        utilization: slotUtil,
      },
      recent_events: recentLogs.map(l => ({
        id: l.id, action: l.action, user_id: l.userId,
        ip_address: l.ipAddress, created_at: l.createdAt, details: l.details,
      })),
      user_tracking: [],
      security_events: securityLogs.map(l => ({
        id: l.id, action: l.action, user_id: l.userId,
        ip_address: l.ipAddress, created_at: l.createdAt,
      })),
    });
  } catch (err) {
    logger.error('admin', { action: 'admin_overview', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function getExpiryUrgency(nearestRemainingMs) {
  if (nearestRemainingMs === null || nearestRemainingMs === undefined) return 'none';
  if (nearestRemainingMs <= 0) return 'expired';
  if (nearestRemainingMs < 3600000) return 'critical';
  if (nearestRemainingMs < 6 * 3600000) return 'high';
  if (nearestRemainingMs < 86400000) return 'warning';
  return 'normal';
}

function computeUserStatus(user, today) {
  if (!user.isActive) return 'disabled';
  const subs = (user.subscriptions || []);
  const activeSubs = subs.filter(s => s.isActive === 1 && !isSubExpired(s.endDate));
  const expiredSubs = subs.filter(s => s.isActive === 1 && isSubExpired(s.endDate));
  if (activeSubs.length === 0 && expiredSubs.length === 0 && subs.length === 0) return 'no_access';
  if (activeSubs.length === 0) return 'expired';
  const nearestMs = activeSubs.reduce((min, s) => {
    const ms = getRemainingMs(s.endDate);
    return ms < min ? ms : min;
  }, Infinity);
  if (expiredSubs.length > 0) return 'partial';
  if (nearestMs <= 7 * 86400000) return 'expiring';
  return 'active';
}

function mapUserRow(u, today) {
  const subs = (u.subscriptions || []);
  const activeSubs = subs.filter(s => s.isActive === 1 && !isSubExpired(s.endDate));
  const activePlatforms = activeSubs.map(s => s.platform?.name).filter(Boolean);
  let nearestExpiry = null;
  let nearestRemainingMs = null;
  let nearestRemainingLabel = null;
  if (activeSubs.length > 0) {
    let nearestEnd = parseEndDateUTC(activeSubs[0].endDate);
    for (const s of activeSubs) {
      const end = parseEndDateUTC(s.endDate);
      if (end < nearestEnd) nearestEnd = end;
    }
    nearestExpiry = nearestEnd.toISOString().replace('T', ' ').substring(0, 19);
    nearestRemainingMs = Math.max(0, nearestEnd - new Date());
    nearestRemainingLabel = formatRemainingMs(nearestRemainingMs);
  }
  const userStatus = computeUserStatus(u, today);
  return {
    id: u.id, username: u.username, name: u.name, email: u.email,
    phone: u.phone, is_active: u.isActive, created_at: u.createdAt,
    expiry_date: u.expiryDate, country: u.country, city: u.city,
    gender: u.gender, profile_image: u.profileImage, reseller_id: u.resellerId,
    subscription_count: subs.length,
    active_platform_count: activePlatforms.length,
    active_platforms: activePlatforms,
    nearest_expiry: nearestExpiry,
    nearest_remaining_ms: nearestRemainingMs,
    nearest_remaining_label: nearestRemainingLabel,
    expiry_urgency: userStatus === 'expired' ? 'expired' : getExpiryUrgency(nearestRemainingMs),
    status: userStatus,
    device_id: u.deviceId || null,
    last_login_ip: u.lastLoginIp || null,
    last_login_at: u.lastLoginAt || null,
    geo_lat: u.geoLat ?? null,
    geo_lon: u.geoLon ?? null,
    geo_city: u.geoCity || null,
    geo_country: u.geoCountry || null,
    geo_updated_at: u.geoUpdatedAt || null,
  };
}

router.get('/get_users', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, search, status, sort } = req.query;
    const { page: p, perPage: pp } = paginate(page, per_page);
    const today = todayISO();

    const where = { role: 'user' };
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { name: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }
    if (status === 'disabled') where.isActive = 0;
    else if (status && status !== 'all') where.isActive = 1;

    let orderBy = { createdAt: 'desc' };
    if (sort === 'oldest') orderBy = { createdAt: 'asc' };
    else if (sort === 'name') orderBy = { name: 'asc' };
    else if (sort === 'name_desc') orderBy = { name: 'desc' };
    else if (sort === 'expiry') orderBy = { expiryDate: 'asc' };
    else if (sort === 'expiry_desc') orderBy = { expiryDate: 'desc' };
    else if (sort === 'username') orderBy = { username: 'asc' };
    else if (sort === 'recent_login') orderBy = { lastLoginAt: 'desc' };

    const needsComputedSort = sort === 'urgency';
    const needsComputedFilter = needsComputedSort || (status && !['all', 'disabled'].includes(status));

    const userSelect = {
      id: true, username: true, name: true, email: true, phone: true,
      isActive: true, createdAt: true, expiryDate: true, country: true,
      city: true, gender: true, profileImage: true, resellerId: true,
      deviceId: true, lastLoginIp: true, lastLoginAt: true, geoLat: true, geoLon: true, geoCity: true, geoCountry: true, geoUpdatedAt: true,
      subscriptions: {
        select: {
          id: true, platformId: true, startDate: true, endDate: true, isActive: true,
          platform: { select: { name: true } },
        },
      },
    };

    if (needsComputedFilter) {
      const allUsers = await prisma.user.findMany({ where, select: userSelect, orderBy });
      const allMapped = allUsers.map(u => mapUserRow(u, today));
      let filtered = (status && !['all', 'disabled'].includes(status))
        ? allMapped.filter(u => u.status === status)
        : allMapped;
      if (needsComputedSort) {
        const urgRank = { expired: 0, critical: 1, high: 2, warning: 3, normal: 4, none: 5 };
        filtered.sort((a, b) => {
          const ra = urgRank[a.expiry_urgency] ?? 5;
          const rb = urgRank[b.expiry_urgency] ?? 5;
          if (ra !== rb) return ra - rb;
          const ma = a.nearest_remaining_ms ?? Infinity;
          const mb = b.nearest_remaining_ms ?? Infinity;
          return ma - mb;
        });
      }
      const total = filtered.length;
      const skip = (p - 1) * pp;
      const paged = filtered.slice(skip, skip + pp);
      res.json({
        success: true,
        users: paged,
        pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
      });
    } else {
      const skip = (p - 1) * pp;
      const [users, total] = await Promise.all([
        prisma.user.findMany({ where, select: userSelect, orderBy, skip, take: pp }),
        prisma.user.count({ where }),
      ]);
      const mapped = users.map(u => mapUserRow(u, today));
      res.json({
        success: true,
        users: mapped,
        pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
      });
    }
  } catch (err) {
    logger.error('admin', { action: 'get_users', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_user', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { username, password, name, email, phone, expiry_date, country, city, gender } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ success: false, message: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username, passwordHash: hash, role: 'user', isActive: 1,
        name: name || null, email: email || null, phone: phone || null,
        expiryDate: expiry_date || null, country: country || null,
        city: city || null, gender: gender || null, createdAt: nowISO(),
      },
    });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Created user: ${username}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'User created', user_id: user.id });
  } catch (err) {
    logger.error('admin', { action: 'add_user', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/edit_user', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id, username, name, email, phone, expiry_date, country, city, gender, password } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });

    const data = {};
    if (username !== undefined) data.username = username;
    if (name !== undefined) data.name = name;
    if (email !== undefined) data.email = email;
    if (phone !== undefined) data.phone = phone;
    if (expiry_date !== undefined) data.expiryDate = expiry_date;
    if (country !== undefined) data.country = country;
    if (city !== undefined) data.city = city;
    if (gender !== undefined) data.gender = gender;
    if (password) data.passwordHash = await bcrypt.hash(password, 10);

    await prisma.user.update({ where: { id: parseInt(user_id) }, data });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Edited user ID: ${user_id}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    logger.error('admin', { action: 'edit_user', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_user_preview', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });
    const uid = parseInt(user_id);

    const [user, subCount, sessionCount, paymentCount, pendingPayments] = await Promise.all([
      prisma.user.findUnique({ where: { id: uid }, select: { id: true, username: true, name: true, email: true } }),
      prisma.userSubscription.count({ where: { userId: uid } }),
      prisma.userSession.count({ where: { userId: uid, status: 'active' } }),
      prisma.payment.count({ where: { userId: uid } }),
      prisma.payment.count({ where: { userId: uid, status: 'pending' } }),
    ]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({
      success: true,
      preview: {
        user_id: user.id, username: user.username, name: user.name, email: user.email,
        subscription_count: subCount,
        active_session_count: sessionCount,
        total_payment_count: paymentCount,
        pending_payment_count: pendingPayments,
        has_pending_payments: pendingPayments > 0,
      },
    });
  } catch (err) {
    logger.error('admin', { action: 'delete_user_preview', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_user', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { user_id, confirm_username } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });
    const uid = parseInt(user_id);

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!confirm_username || confirm_username !== user.username) {
      return res.status(400).json({ success: false, message: 'Type the exact username to confirm deletion.' });
    }

    const pendingPayments = await prisma.payment.count({ where: { userId: uid, status: 'pending' } });
    if (pendingPayments > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete: user has ${pendingPayments} pending payment(s). Resolve payments first.` });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userSession.updateMany({
        where: { userId: uid, status: 'active' },
        data: { status: 'inactive', logoutReason: 'user_deleted' },
      });
      await tx.user.delete({ where: { id: uid } });
      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Deleted user: ${user.username} (ID: ${user_id})`, ipAddress: req.ip || null, createdAt: nowISO() },
      });
    });

    res.json({ success: true, message: `User "${user.username}" permanently deleted` });
  } catch (err) {
    logger.error('admin', { action: 'delete_user', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/revoke_subscription', authenticate, requireAdmin(), adminActionLimiter, async (req, res) => {
  try {
    const { subscription_id } = req.body;
    if (!subscription_id) return res.status(400).json({ success: false, message: 'Subscription ID required' });

    const parsedId = parseInt(subscription_id);
    if (isNaN(parsedId)) return res.status(400).json({ success: false, message: 'Invalid subscription ID' });

    const subInfo = await prisma.userSubscription.findUnique({
      where: { id: parsedId },
      include: { platform: { select: { name: true } }, user: { select: { id: true, username: true } } },
    });
    if (!subInfo) return res.status(404).json({ success: false, message: 'Subscription not found' });

    await prisma.$transaction(async (tx) => {
      await tx.userSubscription.update({
        where: { id: subInfo.id },
        data: { isActive: 0 },
      });

      const remainingActive = await tx.userSubscription.findMany({
        where: { userId: subInfo.userId, isActive: 1, id: { not: subInfo.id } },
        select: { endDate: true },
      });
      const validRemaining = remainingActive.filter(s => !isSubExpired(s.endDate));
      const newExpiry = validRemaining.length > 0
        ? validRemaining.reduce((max, s) => {
            const end = parseEndDateUTC(s.endDate);
            return end > max ? end : max;
          }, parseEndDateUTC(validRemaining[0].endDate)).toISOString().replace('T', ' ').substring(0, 19)
        : null;
      await tx.user.update({ where: { id: subInfo.userId }, data: { expiryDate: newExpiry } });

      await tx.activityLog.create({
        data: {
          userId: req.user.id,
          action: `Revoked ${subInfo.platform?.name || 'unknown'} access for user: ${subInfo.user?.username || subInfo.userId}`,
          ipAddress: req.ip || null, createdAt: nowISO(),
        },
      });
    });

    try {
      const { emitUserEvent } = await import('../server.js');
      emitUserEvent(subInfo.userId, 'subscription_revoked', { message: `${subInfo.platform?.name || 'Platform'} access has been revoked` });
    } catch (_) {}

    logger.subscription('revoke', { adminId: req.user.id, subscriptionId: parsedId, userId: subInfo.userId, platform: subInfo.platform?.name });
    res.json({ success: true, message: `${subInfo.platform?.name || 'Platform'} access revoked` });
  } catch (err) {
    logger.error('subscription', { action: 'revoke', error: err.message, subscriptionId: req.body?.subscription_id });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/export_users_csv', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { search, status } = req.query;
    const today = todayISO();
    const where = { role: 'user' };
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { name: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }
    if (status === 'disabled') where.isActive = 0;

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, username: true, name: true, email: true, phone: true,
        isActive: true, createdAt: true, expiryDate: true, country: true,
        city: true, gender: true, deviceId: true, lastLoginIp: true, lastLoginAt: true, geoLat: true, geoLon: true, geoCity: true, geoCountry: true, geoUpdatedAt: true,
        subscriptions: {
          select: { endDate: true, isActive: true, platform: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const headers = ['Username','Name','Email','Phone','Country','City','Gender','Status','Active Platforms','Total Subscriptions','Nearest Expiry','Join Date','Last Login IP','Device Locked'];
    const esc = (v) => '"' + String(v || '').replace(/"/g, '""') + '"';
    const rows = users.map(u => {
      const mapped = mapUserRow(u, today);
      return [
        esc(u.username), esc(u.name), esc(u.email), esc(u.phone),
        esc(u.country), esc(u.city), esc(u.gender), esc(mapped.status),
        esc(mapped.active_platforms.join('; ')), esc(mapped.subscription_count),
        esc(mapped.nearest_expiry), esc(u.createdAt),
        esc(u.lastLoginIp), esc(u.deviceId ? 'Yes' : 'No'),
      ].join(',');
    });

    let filtered = rows;
    if (status && !['all', 'disabled'].includes(status)) {
      const mappedUsers = users.map(u => mapUserRow(u, today));
      filtered = [];
      for (let i = 0; i < mappedUsers.length; i++) {
        if (mappedUsers[i].status === status) filtered.push(rows[i]);
      }
    }

    const csv = '\uFEFF' + headers.join(',') + '\n' + filtered.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clearorbit_users_${today}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('admin', { action: 'export_users_csv', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_user', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id, action } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });

    const user = await prisma.user.findUnique({ where: { id: parseInt(user_id) } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let newStatus;
    if (action === 'disable' || action === 'deactivate') newStatus = 0;
    else if (action === 'enable' || action === 'activate') newStatus = 1;
    else newStatus = user.isActive ? 0 : 1;

    await prisma.user.update({ where: { id: user.id }, data: { isActive: newStatus } });

    if (newStatus === 0) {
      const revokedSessions = await prisma.userSession.updateMany({
        where: { userId: user.id, status: 'active' },
        data: { status: 'inactive', logoutReason: 'admin_disabled' },
      });
      if (revokedSessions.count > 0) {
        await prisma.activityLog.create({
          data: { userId: req.user.id, action: `Revoked ${revokedSessions.count} session(s) for disabled user: ${user.username}`, ipAddress: req.ip || null, createdAt: nowISO() },
        });
      }
    }

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `${newStatus ? 'Enabled' : 'Disabled'} user: ${user.username}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: `User ${newStatus ? 'enabled' : 'disabled'}`, is_active: newStatus });
  } catch (err) {
    logger.error('admin', { action: 'toggle_user', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_admins', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { id: true, username: true, name: true, email: true, adminLevel: true, isActive: true, lastLoginIp: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      admins: admins.map(a => ({
        id: a.id, username: a.username, name: a.name, email: a.email,
        admin_level: a.adminLevel, is_active: a.isActive, last_login_ip: a.lastLoginIp,
        created_at: a.createdAt, is_permanent: isPermanentSuperAdmin(a.username),
      })),
    });
  } catch (err) {
    logger.error('admin', { action: 'get_admins', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_admin', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { username, password, name, email, admin_level } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ success: false, message: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        username, passwordHash: hash, role: 'admin', isActive: 1,
        adminLevel: admin_level || 'manager',
        name: name || null, email: email || null, createdAt: nowISO(),
      },
    });

    res.json({ success: true, message: 'Admin created' });
  } catch (err) {
    logger.error('admin', { action: 'create_admin', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_admin', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { admin_id } = req.body;
    const admin = await prisma.user.findUnique({ where: { id: parseInt(admin_id) } });
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (isPermanentSuperAdmin(admin.username)) {
      return res.status(403).json({ success: false, message: 'Cannot delete permanent super admin' });
    }

    await prisma.user.delete({ where: { id: admin.id } });
    res.json({ success: true, message: 'Admin deleted' });
  } catch (err) {
    logger.error('admin', { action: 'delete_admin', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_admin', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { admin_id } = req.body;
    const admin = await prisma.user.findUnique({ where: { id: parseInt(admin_id) } });
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (isPermanentSuperAdmin(admin.username)) {
      return res.status(403).json({ success: false, message: 'Cannot modify permanent super admin' });
    }

    const newStatus = admin.isActive ? 0 : 1;
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: newStatus } });
    res.json({ success: true, message: `Admin ${newStatus ? 'enabled' : 'disabled'}` });
  } catch (err) {
    logger.error('admin', { action: 'toggle_admin', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/force_logout', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });

    await prisma.userSession.updateMany({
      where: { userId: parseInt(user_id), status: 'active' },
      data: { status: 'inactive', logoutReason: 'admin_force_logout' },
    });

    await prisma.loginHistory.create({
      data: { userId: parseInt(user_id), action: 'force_logout', createdAt: nowISO() },
    });

    res.json({ success: true, message: 'User sessions terminated' });
  } catch (err) {
    logger.error('admin', { action: 'force_logout', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/admin_kill_session', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, message: 'Session ID required' });

    await prisma.accountSession.update({
      where: { id: parseInt(session_id) },
      data: { status: 'inactive' },
    });

    res.json({ success: true, message: 'Session killed' });
  } catch (err) {
    logger.error('admin', { action: 'admin_kill_session', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/check_username', authenticate, requireAdmin(), async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    if (!username) return res.json({ available: false });
    const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    res.json({ available: !existing });
  } catch (err) {
    logger.error('admin', { action: 'check_username', error: err.message });
    res.json({ available: false });
  }
});

router.post('/create_user_with_sub', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { username, password, name, email, phone, platform_ids, duration_days, duration_in_days, duration_value, duration_unit, expiry_date } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ success: false, message: `Username "${username}" already exists. Use the edit modal to assign platforms to an existing user.` });

    const unit = ['minutes', 'hours', 'days'].includes(duration_unit) ? duration_unit : 'days';
    const durVal = parseInt(duration_value) || parseInt(duration_in_days) || parseInt(duration_days) || 0;
    const pids = (Array.isArray(platform_ids) ? platform_ids.map(Number) : []).filter(n => Number.isFinite(n) && n > 0);

    const platforms = pids.length > 0
      ? await prisma.platform.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, isActive: true } })
      : [];
    const activePlatforms = platforms.filter(p => p.isActive);
    const skippedPlatforms = platforms.filter(p => !p.isActive).map(p => p.name);

    const hash = await bcrypt.hash(password, 10);
    const computedExpiry = durVal > 0 && activePlatforms.length > 0
      ? computeEndDate(durVal, unit)
      : (expiry_date || null);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username, passwordHash: hash, role: 'user', isActive: 1,
          name: name || null, email: email || null, phone: phone || null,
          expiryDate: computedExpiry, createdAt: nowISO(),
        },
      });

      const platformsAssigned = [];
      if (activePlatforms.length > 0 && durVal > 0) {
        const startNow = nowISO();
        const endDate = computeEndDate(durVal, unit);
        for (const p of activePlatforms) {
          await tx.userSubscription.create({
            data: { userId: user.id, platformId: p.id, startDate: startNow, endDate, isActive: 1, durationValue: durVal, durationUnit: unit },
          });
          platformsAssigned.push(p.name);
        }
      }

      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Created user: ${username} with ${platformsAssigned.length} platform(s)`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return { user, platformsAssigned };
    });

    res.json({
      success: true,
      message: `User "${username}" created with ${result.platformsAssigned.length} platform(s)`,
      user_id: result.user.id, username,
      user_status: 'created',
      total_platforms: result.platformsAssigned.length,
      duration_value: durVal,
      duration_unit: unit,
      platforms_assigned: result.platformsAssigned,
      platforms_extended: [],
      platforms_skipped: skippedPlatforms,
    });
  } catch (err) {
    logger.error('admin', { action: 'create_user_with_sub', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/assign_platforms', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id, platform_ids, duration_in_days, duration_value, duration_unit } = req.body;
    if (!user_id || !Array.isArray(platform_ids) || !platform_ids.length) {
      return res.status(400).json({ success: false, message: 'User ID and platform IDs required' });
    }
    const unit = ['minutes', 'hours', 'days'].includes(duration_unit) ? duration_unit : 'days';
    const durVal = parseInt(duration_value) || parseInt(duration_in_days) || 30;
    const uid = parseInt(user_id);
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const pids = platform_ids.map(Number).filter(n => n > 0);
    const [platforms, existingSubs] = await Promise.all([
      prisma.platform.findMany({ where: { id: { in: pids } }, select: { id: true, name: true } }),
      prisma.userSubscription.findMany({ where: { userId: uid, platformId: { in: pids }, isActive: 1 } }),
    ]);
    const platformMap = new Map(platforms.map(p => [p.id, p.name]));
    const existingSubMap = new Map(existingSubs.map(s => [s.platformId, s]));

    const result = await prisma.$transaction(async (tx) => {
      const assigned = [];
      const extended = [];
      for (const pid of pids) {
        const platName = platformMap.get(pid);
        if (!platName) continue;
        const existingSub = existingSubMap.get(pid);
        if (existingSub) {
          const newEnd = extendEndDate(existingSub.endDate, durVal, unit);
          await tx.userSubscription.update({
            where: { id: existingSub.id },
            data: { endDate: newEnd, durationValue: durVal, durationUnit: unit },
          });
          extended.push(platName);
        } else {
          await tx.userSubscription.create({
            data: { userId: uid, platformId: pid, startDate: nowISO(), endDate: computeEndDate(durVal, unit), isActive: 1, durationValue: durVal, durationUnit: unit },
          });
          assigned.push(platName);
        }
      }

      const allActive = await tx.userSubscription.findMany({
        where: { userId: uid, isActive: 1 },
        select: { endDate: true },
      });
      const validActive = allActive.filter(s => !isSubExpired(s.endDate));
      const maxExpiry = validActive.length > 0
        ? validActive.reduce((max, s) => {
            const end = parseEndDateUTC(s.endDate);
            return end > max ? end : max;
          }, parseEndDateUTC(validActive[0].endDate)).toISOString().replace('T', ' ').substring(0, 19)
        : null;
      await tx.user.update({ where: { id: uid }, data: { expiryDate: maxExpiry } });

      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Assigned ${assigned.length + extended.length} platform(s) to user: ${user.username}`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return { assigned, extended };
    });

    res.json({
      success: true,
      message: `${result.assigned.length + result.extended.length} platform(s) assigned to "${user.username}"`,
      platforms_assigned: result.assigned,
      platforms_extended: result.extended,
    });
  } catch (err) {
    logger.error('admin', { action: 'assign_platforms', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/user_intelligence', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action, user_id } = req.query;

    if (action === 'live_sessions') {
      const sessions = await prisma.userSession.findMany({
        where: { status: 'active' },
        include: { user: { select: { id: true, username: true, name: true } } },
        orderBy: { lastActivity: 'desc' },
      });
      return res.json({
        success: true,
        sessions: sessions.map(s => ({
          id: s.id, user_id: s.userId, username: s.user?.username,
          name: s.user?.name, ip_address: s.ipAddress, device: s.device,
          last_activity: s.lastActivity, created_at: s.createdAt,
        })),
      });
    }

    if (action === 'user_history' && user_id) {
      const logins = await prisma.activityLog.findMany({
        where: { userId: parseInt(user_id), action: { in: ['login', 'logout', 'force_logout', 'failed_login'] } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const ips = [...new Set(logins.map(l => l.ipAddress).filter(Boolean))];
      return res.json({
        success: true,
        logins: logins.map(l => ({
          action: l.action, ip_address: l.ipAddress,
          created_at: l.createdAt, details: l.details,
          browser: '', os: '',
        })),
        unique_ips: ips.length,
        ip_list: ips,
        security_events: [],
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    logger.error('admin', { action: 'user_intelligence', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/user_intelligence', authenticate, requireAdmin(), async (req, res) => {
  try {
    const action = req.query.action || req.body.action;

    if (action === 'force_logout') {
      const { user_id, reason } = req.body;
      if (!user_id) return res.status(400).json({ success: false, message: 'user_id required' });

      await prisma.userSession.updateMany({
        where: { userId: parseInt(user_id), status: 'active' },
        data: { status: 'terminated', updatedAt: nowISO() },
      });

      await prisma.activityLog.create({
        data: {
          userId: parseInt(user_id), action: 'force_logout',
          ipAddress: req.ip, details: reason || 'Admin forced logout',
          createdAt: nowISO(),
        },
      });

      return res.json({ success: true, message: 'User sessions terminated' });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    logger.error('admin', { action: 'user_intelligence_post', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/verify_login', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action, account_id } = req.body;

    const verifyAccount = async (id) => {
      const account = await prisma.platformAccount.findUnique({
        where: { id: parseInt(id) },
        include: { platform: true },
      });
      if (!account) return { id: parseInt(id), success: false, message: 'Not found' };

      let loginValid = false;
      let loginStatus = 'INVALID';
      let loginScore = 0;
      let loginLabel = 'Invalid';
      const issues = [];

      const hasCookieData = account.cookieData && account.cookieData.length > 10;
      if (!hasCookieData) {
        issues.push('No cookie data');
      }

      const cookieCount = account.cookieCount || 0;
      if (cookieCount === 0) {
        issues.push('Zero cookies');
      }

      let isExpired = false;
      if (account.expiresAt) {
        isExpired = new Date(account.expiresAt) < new Date();
        if (isExpired) issues.push('Cookies expired');
      }

      const total = (account.successCount || 0) + (account.failCount || 0);
      let successRate = 0;
      if (total > 0) {
        successRate = (account.successCount || 0) / total;
        if (successRate < 0.3) issues.push('High failure rate');
      }

      if (hasCookieData && cookieCount > 0 && !isExpired) {
        if (issues.length === 0) {
          loginValid = true;
          loginStatus = 'VALID';
          loginScore = Math.min(100, 60 + Math.round(successRate * 40));
          loginLabel = 'Valid';
        } else if (issues.length <= 1) {
          loginValid = true;
          loginStatus = 'PARTIAL';
          loginScore = Math.min(70, 40 + Math.round(successRate * 30));
          loginLabel = 'Partial';
        }
      }

      if (!loginValid) {
        loginScore = Math.max(0, 20 - issues.length * 5);
      }

      const healthStatus = loginValid ? 'healthy' : 'degraded';

      await prisma.platformAccount.update({
        where: { id: parseInt(id) },
        data: {
          loginStatus, healthStatus,
          lastVerifiedAt: nowISO(),
          lastCheckedAt: nowISO(),
          updatedAt: nowISO(),
        },
      });

      return {
        id: parseInt(id),
        success: true,
        login_valid: loginValid,
        login_status: loginStatus,
        login_score: loginScore,
        login_label: loginLabel,
        health_status: healthStatus,
        issues,
        slot_name: account.slotName,
        platform_name: account.platform?.name || 'Unknown',
      };
    };

    if (action === 'verify_single' && account_id) {
      const result = await verifyAccount(account_id);
      if (!result.success) return res.status(404).json(result);
      return res.json({ success: true, message: 'Login verified', ...result });
    }

    if (action === 'verify_all') {
      const accounts = await prisma.platformAccount.findMany({ where: { isActive: 1 }, select: { id: true } });
      const results = [];
      let valid = 0, invalid = 0;
      for (const acc of accounts) {
        const r = await verifyAccount(acc.id);
        results.push(r);
        if (r.login_valid) valid++; else invalid++;
      }
      return res.json({ success: true, message: `Verified ${accounts.length} accounts`, total: accounts.length, valid, invalid, results });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    logger.error('admin', { action: 'verify_login', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_active_sessions', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const [sessions, total] = await Promise.all([
      prisma.userSession.findMany({
        where: { status: 'active' },
        include: { user: { select: { username: true, name: true } } },
        orderBy: { lastActivity: 'desc' },
        skip, take,
      }),
      prisma.userSession.count({ where: { status: 'active' } }),
    ]);

    res.json({
      success: true,
      sessions: sessions.map(s => ({
        id: s.id, user_id: s.userId, username: s.user?.username,
        user_name: s.user?.name, device_type: s.deviceType,
        browser: s.browser, os: s.os, ip_address: s.ipAddress,
        last_activity: s.lastActivity, created_at: s.createdAt,
        is_suspicious: false, suspicious_reason: null,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    logger.error('admin', { action: 'get_active_sessions', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/kill_session', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, message: 'Session ID required' });
    await prisma.userSession.update({
      where: { id: parseInt(session_id) },
      data: { status: 'terminated', logoutReason: 'Admin terminated' },
    });
    res.json({ success: true, message: 'Session terminated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_session', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { session_id, session_ids } = req.body;
    if (session_ids === 'all') {
      await prisma.userSession.deleteMany();
    } else if (session_ids && Array.isArray(session_ids)) {
      await prisma.userSession.deleteMany({ where: { id: { in: session_ids.map(Number) } } });
    } else if (session_id) {
      await prisma.userSession.delete({ where: { id: parseInt(session_id) } });
    } else {
      return res.status(400).json({ success: false, message: 'Session ID(s) required' });
    }
    res.json({ success: true, message: 'Session(s) deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/admin/notifications', authenticate, requireAdmin(), async (req, res) => {
  try {
    const notifications = await prisma.adminNotification.findMany({
      orderBy: { id: 'desc' },
      take: 30,
    });
    const unreadCount = notifications.filter(n => n.isRead === 0).length;
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/admin/notifications/mark-read', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { id } = req.body;
    if (id) {
      await prisma.adminNotification.updateMany({ where: { id: parseInt(id), isRead: 0 }, data: { isRead: 1 } });
    } else {
      await prisma.adminNotification.updateMany({ where: { isRead: 0 }, data: { isRead: 1 } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function geoFetchWithTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    clearTimeout(t);
    return await r.json();
  } catch { clearTimeout(t); return null; }
}

async function multiProviderGeoLookup(cleanIp) {
  const results = await Promise.allSettled([
    geoFetchWithTimeout(`https://ipwhois.app/json/${encodeURIComponent(cleanIp)}`),
    geoFetchWithTimeout(`http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,message,country,countryCode,regionName,city,isp,lat,lon,timezone,proxy,hosting,query`),
    geoFetchWithTimeout(`https://freeipapi.com/api/json/${encodeURIComponent(cleanIp)}`),
  ]);

  const providers = [];

  const d1 = results[0].status === 'fulfilled' ? results[0].value : null;
  if (d1 && d1.success) {
    const ispName = d1.isp || d1.connection?.org || d1.connection?.isp || 'Unknown';
    const isHosting = /hosting|server|cloud|data.?cent|vps|dedicated|colocation/i.test(ispName);
    providers.push({
      source: 'ipwhois', country: d1.country || 'Unknown', country_code: d1.country_code || '--',
      region: d1.region || 'Unknown', city: d1.city || 'Unknown', isp: ispName,
      lat: d1.latitude || 0, lon: d1.longitude || 0,
      timezone: (typeof d1.timezone === 'string' ? d1.timezone : d1.timezone?.id) || '',
      proxy: !!(d1.security?.proxy || d1.security?.vpn || d1.security?.tor),
      hosting: isHosting
    });
  }

  const d2 = results[1].status === 'fulfilled' ? results[1].value : null;
  if (d2 && d2.status === 'success') {
    providers.push({
      source: 'ip-api', country: d2.country || 'Unknown', country_code: d2.countryCode || '--',
      region: d2.regionName || 'Unknown', city: d2.city || 'Unknown', isp: d2.isp || 'Unknown',
      lat: d2.lat || 0, lon: d2.lon || 0, timezone: d2.timezone || '',
      proxy: !!d2.proxy, hosting: !!d2.hosting
    });
  }

  const d3 = results[2].status === 'fulfilled' ? results[2].value : null;
  if (d3 && d3.countryName) {
    const ispName3 = d3.isp || 'Unknown';
    const isHosting3 = /hosting|server|cloud|data.?cent|vps|dedicated|colocation/i.test(ispName3);
    providers.push({
      source: 'freeipapi', country: d3.countryName || 'Unknown', country_code: d3.countryCode || '--',
      region: d3.regionName || 'Unknown', city: d3.cityName || 'Unknown', isp: ispName3,
      lat: d3.latitude || 0, lon: d3.longitude || 0,
      timezone: (Array.isArray(d3.timeZones) ? d3.timeZones[0] : d3.timeZone) || '',
      proxy: !!d3.isProxy, hosting: isHosting3
    });
  }

  if (!providers.length) return null;

  const proxyVotes = providers.filter(p => p.proxy).length;
  const hostingVotes = providers.filter(p => p.hosting).length;
  const isProxy = proxyVotes >= 1;
  const isHosting = hostingVotes >= 1;

  const primary = providers[0];
  const geo = {
    country: primary.country, country_code: primary.country_code,
    region: primary.region, city: primary.city, isp: primary.isp,
    lat: primary.lat, lon: primary.lon, timezone: primary.timezone,
    proxy: isProxy,
    hosting: isHosting
  };

  if (providers.length > 1) {
    const cities = [...new Set(providers.map(p => p.city).filter(c => c && c !== 'Unknown'))];
    if (cities.length > 1) geo.alt_cities = cities;
  }

  return geo;
}

router.post('/geo_lookup', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip || typeof ip !== 'string') return res.json({ success: false, message: 'IP required' });
    const cleanIp = ip.trim();
    const cached = await prisma.ipGeoCache.findUnique({ where: { ipAddress: cleanIp } });
    if (cached) {
      const age = Date.now() - new Date(cached.lookedUpAt).getTime();
      if (age < 72 * 60 * 60 * 1000) {
        return res.json({ success: true, geo: { country: cached.country, country_code: cached.countryCode, region: cached.region, city: cached.city, isp: cached.isp, lat: cached.lat, lon: cached.lon, timezone: cached.timezone, proxy: !!cached.proxy, hosting: !!cached.hosting, cached: true } });
      }
    }
    const geo = await multiProviderGeoLookup(cleanIp);
    if (geo) {
      await prisma.ipGeoCache.upsert({
        where: { ipAddress: cleanIp },
        update: { country: geo.country, countryCode: geo.country_code, region: geo.region, city: geo.city, isp: geo.isp, lat: geo.lat, lon: geo.lon, timezone: geo.timezone, proxy: geo.proxy ? 1 : 0, hosting: geo.hosting ? 1 : 0, lookedUpAt: new Date().toISOString() },
        create: { ipAddress: cleanIp, country: geo.country, countryCode: geo.country_code, region: geo.region, city: geo.city, isp: geo.isp, lat: geo.lat, lon: geo.lon, timezone: geo.timezone, proxy: geo.proxy ? 1 : 0, hosting: geo.hosting ? 1 : 0, lookedUpAt: new Date().toISOString() }
      });
      return res.json({ success: true, geo: { ...geo, cached: false } });
    }
    if (cached) return res.json({ success: true, geo: { country: cached.country, country_code: cached.countryCode, region: cached.region, city: cached.city, isp: cached.isp, lat: cached.lat, lon: cached.lon, timezone: cached.timezone, proxy: !!cached.proxy, hosting: !!cached.hosting, cached: true } });
    return res.json({ success: false, message: 'All geo providers failed' });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

export default router;
