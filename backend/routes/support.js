import { Router } from 'express';
import { prisma } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { nowISO, cutoffISO, paginate } from '../utils/helpers.js';

const router = Router();

router.get('/get_tickets', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (status) where.status = status;

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: { user: { select: { username: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.supportTicket.count({ where }),
    ]);

    res.json({
      success: true,
      tickets: tickets.map(t => ({
        id: t.id, user_id: t.userId, username: t.user?.username,
        user_name: t.user?.name, platform_name: t.platformName,
        message: t.message, status: t.status, created_at: t.createdAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_ticket', authenticate, async (req, res) => {
  try {
    const { platform_name, message } = req.body;
    if (!platform_name || !message) {
      return res.status(400).json({ success: false, message: 'Platform name and message required' });
    }

    const ticket = await prisma.supportTicket.create({
      data: { userId: req.user.id, platformName: platform_name, message, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Ticket created', ticket_id: ticket.id });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_ticket', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ticket_id, status } = req.body;
    if (!ticket_id) return res.status(400).json({ success: false, message: 'Ticket ID required' });

    await prisma.supportTicket.update({
      where: { id: parseInt(ticket_id) },
      data: { status: status || 'resolved' },
    });

    res.json({ success: true, message: 'Ticket updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/submit_contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message required' });
    }

    await prisma.contactMessage.create({
      data: { name, email, message, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_contacts', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const [contacts, total] = await Promise.all([
      prisma.contactMessage.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.contactMessage.count(),
    ]);

    res.json({
      success: true,
      contacts: contacts.map(c => ({
        id: c.id, name: c.name, email: c.email, message: c.message,
        is_read: c.isRead, created_at: c.createdAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_contact', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { contact_id, is_read } = req.body;
    if (!contact_id) return res.status(400).json({ success: false, message: 'Contact ID required' });

    await prisma.contactMessage.update({
      where: { id: parseInt(contact_id) },
      data: { isRead: is_read !== undefined ? parseInt(is_read) : 1 },
    });

    res.json({ success: true, message: 'Contact updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_active_announcement', async (req, res) => {
  try {
    const announcement = await prisma.announcement.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      announcement: announcement ? {
        id: announcement.id, title: announcement.title, message: announcement.message,
        type: announcement.type,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/manage_announcement', authenticate, requireAdmin(), async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({
      success: true,
      announcements: announcements.map(a => ({
        id: a.id, title: a.title, message: a.message, type: a.type,
        status: a.status, start_time: a.startTime, end_time: a.endTime,
        created_at: a.createdAt,
      })),
    });
  } catch (err) {
    console.error('manage_announcement GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/manage_announcement', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action, id, announcement_id, title, message, type, status, start_time, end_time } = req.body;
    const annId = id || announcement_id;

    if (action === 'create') {
      if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });

      const data = { title, message, type: type || 'popup', status: 'active', createdAt: nowISO() };
      if (start_time) data.startTime = start_time;
      if (end_time) data.endTime = end_time;
      const ann = await prisma.announcement.create({ data });
      return res.json({ success: true, message: 'Announcement created', id: ann.id });
    }

    if (action === 'update' && annId) {
      const data = {};
      if (title !== undefined) data.title = title;
      if (message !== undefined) data.message = message;
      if (type !== undefined) data.type = type;
      if (status !== undefined) data.status = status;
      if (start_time !== undefined) data.startTime = start_time;
      if (end_time !== undefined) data.endTime = end_time;

      await prisma.announcement.update({ where: { id: parseInt(annId) }, data });
      return res.json({ success: true, message: 'Announcement updated' });
    }

    if (action === 'toggle' && annId) {
      const ann = await prisma.announcement.findUnique({ where: { id: parseInt(annId) } });
      if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
      await prisma.announcement.update({ where: { id: parseInt(annId) }, data: { status: ann.status === 'active' ? 'inactive' : 'active' } });
      return res.json({ success: true, message: 'Announcement toggled' });
    }

    if (action === 'delete' && annId) {
      await prisma.announcement.delete({ where: { id: parseInt(annId) } });
      return res.json({ success: true, message: 'Announcement deleted' });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_notifications', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const notifications = await prisma.userNotification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      notifications: notifications.map(n => ({
        id: n.id, title: n.title, message: n.message,
        type: n.type, is_read: n.isRead, created_at: n.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/mark_notification_read', authenticate, async (req, res) => {
  try {
    const { notification_id } = req.body;
    if (notification_id === 'all') {
      await prisma.userNotification.updateMany({
        where: { userId: req.user.id },
        data: { isRead: 1 },
      });
    } else if (notification_id) {
      await prisma.userNotification.update({
        where: { id: parseInt(notification_id) },
        data: { isRead: 1 },
      });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_activity_logs', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        orderBy: { createdAt: 'desc' }, skip, take,
        include: { user: { select: { username: true, name: true } } },
      }),
      prisma.activityLog.count(),
    ]);

    res.json({
      success: true,
      logs: logs.map(l => ({
        id: l.id, user_id: l.userId, action: l.action,
        username: l.user?.name || l.user?.username || 'System',
        ip_address: l.ipAddress, created_at: l.createdAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_log', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { log_id, delete_all, log_ids } = req.body;
    if (delete_all || log_id === 'all') {
      await prisma.activityLog.deleteMany();
      return res.json({ success: true, message: 'All logs deleted' });
    }
    if (Array.isArray(log_ids) && log_ids.length) {
      const ids = log_ids.map(Number).filter(n => n > 0);
      const result = await prisma.activityLog.deleteMany({ where: { id: { in: ids } } });
      return res.json({ success: true, message: `${result.count} log(s) deleted`, count: result.count });
    }
    if (log_id) {
      await prisma.activityLog.delete({ where: { id: parseInt(log_id) } });
      return res.json({ success: true, message: 'Log deleted' });
    }
    res.status(400).json({ success: false, message: 'No log ID provided' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_login_attempts', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status: filterStatus } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (filterStatus && filterStatus !== 'all') where.status = filterStatus;

    const since24h = cutoffISO(24 * 60 * 60);
    const [attempts, total, failedCount, blockedCount, successCount] = await Promise.all([
      prisma.loginAttemptLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.loginAttemptLog.count({ where }),
      prisma.loginAttemptLog.count({ where: { status: 'failed', createdAt: { gte: since24h } } }),
      prisma.loginAttemptLog.count({ where: { status: 'blocked', createdAt: { gte: since24h } } }),
      prisma.loginAttemptLog.count({ where: { status: 'success', createdAt: { gte: since24h } } }),
    ]);

    res.json({
      success: true,
      attempts: attempts.map(a => ({
        id: a.id, username: a.username, ip_address: a.ipAddress,
        device_type: a.deviceType, browser: a.browser, os: a.os,
        status: a.status, reason: a.reason, created_at: a.createdAt,
      })),
      stats_24h: { failed: failedCount, blocked: blockedCount, success: successCount },
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/admin_delete_login_logs', authenticate, requireAdmin(), async (req, res) => {
  try {
    await prisma.loginAttemptLog.deleteMany();
    res.json({ success: true, message: 'Login logs cleared' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_settings', async (req, res) => {
  try {
    const settings = await prisma.siteSetting.findMany();
    const result = {};
    for (const s of settings) {
      result[s.settingKey] = s.settingValue;
    }
    res.json({ success: true, settings: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/save_settings', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, message: 'Settings object required' });
    }

    for (const [key, value] of Object.entries(settings)) {
      await prisma.siteSetting.upsert({
        where: { settingKey: key },
        update: { settingValue: String(value), updatedAt: nowISO() },
        create: { settingKey: key, settingValue: String(value), updatedAt: nowISO() },
      });
    }

    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_whatsapp', authenticate, async (req, res) => {
  try {
    const setting = await prisma.siteSetting.findUnique({ where: { settingKey: 'whatsapp_number' } });
    const msgSetting = await prisma.siteSetting.findUnique({ where: { settingKey: 'whatsapp_message' } });

    res.json({
      success: true,
      whatsapp_number: setting?.settingValue || '',
      whatsapp_message: msgSetting?.settingValue || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/save_whatsapp', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { whatsapp_number, whatsapp_message } = req.body;

    if (whatsapp_number !== undefined) {
      await prisma.siteSetting.upsert({
        where: { settingKey: 'whatsapp_number' },
        update: { settingValue: whatsapp_number, updatedAt: nowISO() },
        create: { settingKey: 'whatsapp_number', settingValue: whatsapp_number, updatedAt: nowISO() },
      });
    }
    if (whatsapp_message !== undefined) {
      await prisma.siteSetting.upsert({
        where: { settingKey: 'whatsapp_message' },
        update: { settingValue: whatsapp_message, updatedAt: nowISO() },
        create: { settingKey: 'whatsapp_message', settingValue: whatsapp_message, updatedAt: nowISO() },
      });
    }

    res.json({ success: true, message: 'WhatsApp settings saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
