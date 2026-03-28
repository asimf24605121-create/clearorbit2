import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { generateCsrfToken } from '../middleware/csrf.js';
import { nowISO, cutoffISO, todayISO, futureDate, paginate, isPermanentSuperAdmin } from '../utils/helpers.js';

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
    console.error('admin_init error:', err);
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
    console.error('admin_stats error:', err);
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
      expiringSubs24h, expiringSubs7d, pendingPayments,
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

    let systemHealth = 'healthy';
    const alerts = [];
    if (slotUtil >= 90) { systemHealth = 'critical'; alerts.push({ type: 'danger', message: 'Slot utilization above 90%' }); }
    else if (slotUtil >= 75) { systemHealth = 'warning'; alerts.push({ type: 'warning', message: 'Slot utilization above 75%' }); }
    if (expiringSubs24h > 0) alerts.push({ type: 'warning', message: `${expiringSubs24h} subscription(s) expiring within 24 hours` });
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
    console.error('admin_overview error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_users', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, search, status } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = { role: 'user' };
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { name: { contains: search } },
        { email: { contains: search } },
      ];
    }
    if (status === 'active') where.isActive = 1;
    else if (status === 'disabled') where.isActive = 0;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, username: true, name: true, email: true, phone: true,
          isActive: true, createdAt: true, expiryDate: true, country: true,
          subscriptions: {
            where: { isActive: 1 },
            select: { platform: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      users: users.map(u => ({
        id: u.id, username: u.username, name: u.name, email: u.email,
        phone: u.phone, is_active: u.isActive, created_at: u.createdAt,
        expiry_date: u.expiryDate, country: u.country,
        subscription_count: u.subscriptions.length,
        active_platforms: u.subscriptions.map(s => s.platform.name),
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    console.error('get_users error:', err);
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
    console.error('add_user error:', err);
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
    console.error('edit_user error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_user', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });

    await prisma.user.delete({ where: { id: parseInt(user_id) } });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Deleted user ID: ${user_id}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    console.error('delete_user error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_user', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'User ID required' });

    const user = await prisma.user.findUnique({ where: { id: parseInt(user_id) } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const newStatus = user.isActive ? 0 : 1;
    await prisma.user.update({ where: { id: user.id }, data: { isActive: newStatus } });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `${newStatus ? 'Enabled' : 'Disabled'} user: ${user.username}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: `User ${newStatus ? 'enabled' : 'disabled'}`, is_active: newStatus });
  } catch (err) {
    console.error('toggle_user error:', err);
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
    console.error('get_admins error:', err);
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
    console.error('create_admin error:', err);
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
    console.error('delete_admin error:', err);
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
    console.error('toggle_admin error:', err);
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
    console.error('force_logout error:', err);
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
    console.error('admin_kill_session error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_user_with_sub', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { username, password, name, email, phone, platform_id, platform_ids, duration_days, duration_in_days, expiry_date } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });

    const duration = parseInt(duration_in_days) || parseInt(duration_days) || 0;
    const pids = (Array.isArray(platform_ids) ? platform_ids.map(Number) : (platform_id ? [parseInt(platform_id)] : [])).filter(n => Number.isFinite(n) && n > 0);

    const existing = await prisma.user.findUnique({ where: { username } });
    let user, userStatus;

    if (existing) {
      user = existing;
      userStatus = 'updated';
    } else {
      const hash = await bcrypt.hash(password, 10);
      user = await prisma.user.create({
        data: {
          username, passwordHash: hash, role: 'user', isActive: 1,
          name: name || null, email: email || null, phone: phone || null,
          expiryDate: expiry_date || (duration > 0 ? futureDate(duration) : null),
          createdAt: nowISO(),
        },
      });
      userStatus = 'created';
    }

    const platformsAssigned = [];
    const platformsExtended = [];

    if (pids.length > 0 && duration > 0) {
      for (const pid of pids) {
        const platform = await prisma.platform.findUnique({ where: { id: pid } });
        if (!platform) continue;

        const existingSub = await prisma.userSubscription.findFirst({
          where: { userId: user.id, platformId: pid, isActive: 1 },
        });

        if (existingSub) {
          const currentEnd = new Date(existingSub.endDate);
          const baseDate = currentEnd > new Date() ? currentEnd : new Date();
          const newEnd = new Date(baseDate.getTime() + duration * 24 * 60 * 60 * 1000);
          await prisma.userSubscription.update({
            where: { id: existingSub.id },
            data: { endDate: newEnd.toISOString().split('T')[0] },
          });
          platformsExtended.push(platform.name);
        } else {
          await prisma.userSubscription.create({
            data: {
              userId: user.id, platformId: pid,
              startDate: todayISO(), endDate: futureDate(duration),
              isActive: 1,
            },
          });
          platformsAssigned.push(platform.name);
        }
      }
    }

    const totalAssigned = platformsAssigned.length + platformsExtended.length;
    const msg = userStatus === 'created'
      ? `User "${username}" created with ${totalAssigned} platform(s)`
      : `User "${username}" updated with ${totalAssigned} platform(s)`;

    res.json({
      success: true,
      message: msg,
      user_id: user.id,
      username,
      user_status: userStatus,
      total_platforms: totalAssigned,
      duration_days: duration,
      platforms_assigned: platformsAssigned,
      platforms_extended: platformsExtended,
    });
  } catch (err) {
    console.error('create_user_with_sub error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/assign_platforms', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id, platform_ids, duration_in_days } = req.body;
    if (!user_id || !Array.isArray(platform_ids) || !platform_ids.length) {
      return res.status(400).json({ success: false, message: 'User ID and platform IDs required' });
    }
    const duration = parseInt(duration_in_days) || 30;
    const user = await prisma.user.findUnique({ where: { id: parseInt(user_id) } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const assigned = [];
    const extended = [];
    for (const pid of platform_ids.map(Number).filter(n => n > 0)) {
      const platform = await prisma.platform.findUnique({ where: { id: pid } });
      if (!platform) continue;
      const existingSub = await prisma.userSubscription.findFirst({
        where: { userId: user.id, platformId: pid, isActive: 1 },
      });
      if (existingSub) {
        const currentEnd = new Date(existingSub.endDate);
        const baseDate = currentEnd > new Date() ? currentEnd : new Date();
        const newEnd = new Date(baseDate.getTime() + duration * 86400000);
        await prisma.userSubscription.update({
          where: { id: existingSub.id },
          data: { endDate: newEnd.toISOString().split('T')[0] },
        });
        extended.push(platform.name);
      } else {
        await prisma.userSubscription.create({
          data: { userId: user.id, platformId: pid, startDate: todayISO(), endDate: futureDate(duration), isActive: 1 },
        });
        assigned.push(platform.name);
      }
    }

    const newExpiry = futureDate(duration);
    if (!user.expiryDate || new Date(user.expiryDate) < new Date(newExpiry)) {
      await prisma.user.update({ where: { id: user.id }, data: { expiryDate: newExpiry } });
    }

    const total = assigned.length + extended.length;
    res.json({
      success: true,
      message: `${total} platform(s) assigned to "${user.username}"`,
      platforms_assigned: assigned,
      platforms_extended: extended,
    });
  } catch (err) {
    console.error('assign_platforms error:', err);
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
    console.error('user_intelligence error:', err);
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
    console.error('user_intelligence POST error:', err);
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
    console.error('verify_login error:', err);
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
    console.error('get_active_sessions error:', err);
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

export default router;
