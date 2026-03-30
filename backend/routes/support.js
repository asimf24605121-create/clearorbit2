import { Router } from 'express';
import { prisma, emitAdminEvent, emitUserEvent } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { nowISO, cutoffISO, paginate } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { contactLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.get('/get_tickets', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status, category, priority, search } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    const { archived } = req.query;
    if (archived === 'true') {
      where.archivedAt = { not: null };
    } else if (archived !== 'all') {
      where.archivedAt = null;
    }
    if (status && status !== 'all') where.status = status;
    if (category && category !== 'all') where.category = category;
    if (priority && priority !== 'all') where.priority = priority;
    if (search) {
      where.OR = [
        { subject: { contains: search } },
        { message: { contains: search } },
        { user: { username: { contains: search } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: {
          user: { select: { username: true, name: true } },
          replies: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { replies: true } },
        },
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
        subject: t.subject, category: t.category,
        message: t.message, status: t.status,
        priority: t.priority || 'medium',
        assigned_to: t.assignedTo,
        resolved_at: t.resolvedAt,
        resolved_by: t.resolvedBy,
        resolution_note: t.resolutionNote,
        archived_at: t.archivedAt,
        reply_count: t._count.replies,
        last_reply: t.replies[0] ? {
          message: t.replies[0].message,
          is_admin: t.replies[0].isAdmin,
          created_at: t.replies[0].createdAt,
        } : null,
        needs_admin_reply: t.replies[0] ? t.replies[0].isAdmin === 0 : true,
        created_at: t.createdAt, updated_at: t.updatedAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    logger.error('support', { action: 'get_tickets', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_user_tickets', authenticate, async (req, res) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user.id },
      include: {
        _count: { select: { replies: true } },
        replies: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      tickets: tickets.map(t => ({
        id: t.id, platform_name: t.platformName,
        subject: t.subject, category: t.category,
        message: t.message, status: t.status,
        reply_count: t._count.replies,
        has_admin_reply: t.replies[0]?.isAdmin === 1,
        created_at: t.createdAt, updated_at: t.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_ticket', authenticate, async (req, res) => {
  try {
    const { platform_name, message, subject, category } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    const now = nowISO();
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        platformName: platform_name || 'General',
        subject: subject || '',
        category: category || 'general',
        message,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      },
    });

    try {
      await prisma.adminNotification.create({
        data: {
          type: 'new_ticket',
          title: 'New Support Ticket',
          message: `${req.user.username} submitted ticket: ${subject || message.substring(0, 60)}`,
          severity: 'info',
          isRead: 0,
          createdAt: now,
        },
      });
      emitAdminEvent('new_ticket', {
        ticket_id: ticket.id,
        username: req.user.username,
        subject: subject || message.substring(0, 60),
      });
    } catch (e) { logger.warn('support', { action: 'ticket_notification', error: e.message }); }

    res.json({ success: true, message: 'Ticket created', ticket_id: ticket.id });
  } catch (err) {
    logger.error('support', { action: 'create_ticket', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_ticket', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ticket_id } = req.body;
    const tid = parseInt(ticket_id);
    if (!tid || isNaN(tid)) return res.status(400).json({ success: false, message: 'Valid ticket ID required' });
    await prisma.ticketReply.deleteMany({ where: { ticketId: tid } });
    await prisma.supportTicket.delete({ where: { id: tid } });
    logger.admin({ action: 'delete_ticket', ticket_id, admin: req.user.id });
    res.json({ success: true, message: 'Ticket deleted' });
  } catch (err) {
    logger.error('support', { action: 'delete_ticket', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/archive_ticket', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ticket_id } = req.body;
    const tid = parseInt(ticket_id);
    if (!tid || isNaN(tid)) return res.status(400).json({ success: false, message: 'Valid ticket ID required' });
    const now = nowISO();
    await prisma.supportTicket.update({
      where: { id: tid },
      data: { archivedAt: now, updatedAt: now },
    });
    logger.admin({ action: 'archive_ticket', ticket_id, admin: req.user.id });
    res.json({ success: true, message: 'Ticket archived' });
  } catch (err) {
    logger.error('support', { action: 'archive_ticket', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/unarchive_ticket', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ticket_id } = req.body;
    const tid = parseInt(ticket_id);
    if (!tid || isNaN(tid)) return res.status(400).json({ success: false, message: 'Valid ticket ID required' });
    await prisma.supportTicket.update({
      where: { id: tid },
      data: { archivedAt: null, updatedAt: nowISO() },
    });
    res.json({ success: true, message: 'Ticket unarchived' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_ticket', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { ticket_id, status, priority, assigned_to, resolution_note } = req.body;
    if (!ticket_id) return res.status(400).json({ success: false, message: 'Ticket ID required' });

    const validStatuses = ['open', 'in_progress', 'waiting_for_user', 'resolved', 'closed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: 'Invalid priority' });
    }

    const now = nowISO();
    const data = { updatedAt: now };
    if (status) data.status = status;
    if (priority) data.priority = priority;
    if (assigned_to !== undefined) data.assignedTo = assigned_to ? parseInt(assigned_to) : null;
    if (resolution_note !== undefined) data.resolutionNote = resolution_note;

    if (status === 'resolved') {
      data.resolvedAt = now;
      data.resolvedBy = req.user.id;
    }

    const ticket = await prisma.supportTicket.update({
      where: { id: parseInt(ticket_id) },
      data,
    });

    if (ticket.userId) {
      const statusLabels = { open: 'Open', in_progress: 'In Progress', waiting_for_user: 'Waiting for Your Response', resolved: 'Resolved', closed: 'Closed' };
      const statusMsg = status ? `Status changed to: ${statusLabels[status] || status}` : '';
      const priorityMsg = priority ? `Priority set to: ${priority}` : '';
      const msg = [statusMsg, priorityMsg].filter(Boolean).join('. ');

      if (msg) {
        await prisma.userNotification.create({
          data: {
            userId: ticket.userId,
            title: 'Ticket Updated',
            message: `Your ticket #${ticket.id} has been updated. ${msg}`,
            type: status === 'resolved' ? 'success' : 'info',
            isRead: 0,
            createdAt: now,
          },
        });
        emitUserEvent(ticket.userId, 'ticket_updated', {
          ticket_id: ticket.id, status: ticket.status, priority: ticket.priority,
        });
      }
    }

    res.json({ success: true, message: 'Ticket updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_ticket_replies', authenticate, async (req, res) => {
  try {
    const { ticket_id } = req.query;
    if (!ticket_id) return res.status(400).json({ success: false, message: 'Ticket ID required' });

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: parseInt(ticket_id) },
      include: { user: { select: { username: true, name: true } } },
    });

    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin && ticket.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const replies = await prisma.ticketReply.findMany({
      where: { ticketId: parseInt(ticket_id) },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      ticket: {
        id: ticket.id, subject: ticket.subject, category: ticket.category,
        message: ticket.message, status: ticket.status,
        platform_name: ticket.platformName,
        username: ticket.user?.username, user_name: ticket.user?.name,
        created_at: ticket.createdAt,
      },
      replies: replies.map(r => ({
        id: r.id, message: r.message, is_admin: r.isAdmin,
        created_at: r.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_ticket_reply', authenticate, async (req, res) => {
  try {
    const { ticket_id, message } = req.body;
    if (!ticket_id || !message) {
      return res.status(400).json({ success: false, message: 'Ticket ID and message required' });
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id: parseInt(ticket_id) } });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin && ticket.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const now = nowISO();
    const reply = await prisma.ticketReply.create({
      data: {
        ticketId: parseInt(ticket_id),
        userId: req.user.id,
        isAdmin: isAdmin ? 1 : 0,
        message,
        createdAt: now,
      },
    });

    const newStatus = isAdmin ? 'in_progress' : ticket.status;
    await prisma.supportTicket.update({
      where: { id: parseInt(ticket_id) },
      data: { status: newStatus, updatedAt: now },
    });

    if (isAdmin && ticket.userId) {
      try {
        await prisma.userNotification.create({
          data: {
            userId: ticket.userId,
            title: 'Ticket Reply',
            message: `Admin replied to your ticket: ${ticket.subject || 'Support Ticket #' + ticket.id}`,
            type: 'info',
            isRead: 0,
            createdAt: now,
          },
        });
        emitUserEvent(ticket.userId, 'ticket_reply', {
          ticket_id: ticket.id, message: message.substring(0, 100),
        });
      } catch (e) { logger.warn('support', { action: 'reply_notification', error: e.message }); }
    }

    if (!isAdmin) {
      try {
        emitAdminEvent('ticket_reply', {
          ticket_id: ticket.id,
          username: req.user.username,
          message: message.substring(0, 100),
        });
      } catch (e) { logger.warn('support', { action: 'admin_notify', error: e.message }); }
    }

    res.json({ success: true, message: 'Reply added', reply_id: reply.id });
  } catch (err) {
    logger.error('support', { action: 'create_ticket_reply', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/submit_contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message required' });
    }

    const now = nowISO();
    const contact = await prisma.contactMessage.create({
      data: { name, email, message, createdAt: now },
    });

    try {
      await prisma.adminNotification.create({
        data: {
          type: 'new_contact',
          title: 'New Contact Message',
          message: `${name} (${email}): ${message.substring(0, 80)}`,
          severity: 'info',
          isRead: 0,
          createdAt: now,
        },
      });
      emitAdminEvent('new_contact', {
        contact_id: contact.id, name, email,
        preview: message.substring(0, 80),
      });
    } catch (e) { logger.warn('support', { action: 'contact_notification', error: e.message }); }

    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_contacts', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, filter, search } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (filter === 'unread') where.isRead = 0;
    else if (filter === 'read') where.isRead = 1;
    else if (filter === 'replied') where.adminReply = { not: null };
    else if (filter === 'archived') where.archivedAt = { not: null };
    else if (filter === 'spam') where.isSpam = 1;

    if (filter !== 'archived') {
      where.archivedAt = null;
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
        { message: { contains: search } },
      ];
    }

    const [contacts, total] = await Promise.all([
      prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.contactMessage.count({ where }),
    ]);

    res.json({
      success: true,
      contacts: contacts.map(c => ({
        id: c.id, name: c.name, email: c.email, message: c.message,
        is_read: c.isRead, admin_reply: c.adminReply, replied_at: c.repliedAt,
        archived_at: c.archivedAt, created_at: c.createdAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_contact', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { contact_id, is_read, admin_reply, action } = req.body;
    if (!contact_id) return res.status(400).json({ success: false, message: 'Contact ID required' });

    const now = nowISO();

    if (action === 'archive') {
      await prisma.contactMessage.update({
        where: { id: parseInt(contact_id) },
        data: { archivedAt: now, isRead: 1 },
      });
      return res.json({ success: true, message: 'Message archived' });
    }

    if (action === 'unarchive') {
      await prisma.contactMessage.update({
        where: { id: parseInt(contact_id) },
        data: { archivedAt: null },
      });
      return res.json({ success: true, message: 'Message unarchived' });
    }

    if (action === 'delete') {
      await prisma.contactMessage.delete({ where: { id: parseInt(contact_id) } });
      return res.json({ success: true, message: 'Message deleted' });
    }

    const data = {};
    if (is_read !== undefined) data.isRead = parseInt(is_read);
    if (admin_reply !== undefined) {
      data.adminReply = admin_reply;
      data.repliedAt = now;
      data.isRead = 1;
    }

    await prisma.contactMessage.update({
      where: { id: parseInt(contact_id) },
      data,
    });

    res.json({ success: true, message: 'Contact updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_active_announcement', async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      announcements: announcements.map(a => ({
        id: a.id, title: a.title, message: a.message,
        type: a.type, created_at: a.createdAt,
      })),
      announcement: announcements[0] ? {
        id: announcements[0].id, title: announcements[0].title,
        message: announcements[0].message, type: announcements[0].type,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/manage_announcement', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { status: filterStatus } = req.query;
    const where = {};
    if (filterStatus && filterStatus !== 'all') where.status = filterStatus;

    const announcements = await prisma.announcement.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({
      success: true,
      announcements: announcements.map(a => ({
        id: a.id, title: a.title, message: a.message, type: a.type,
        display_style: a.displayStyle || 'banner',
        status: a.status, priority: a.priority || 0,
        is_pinned: a.isPinned || 0, target_audience: a.targetAudience || 'all',
        start_time: a.startTime, end_time: a.endTime,
        view_count: a.viewCount || 0, dismiss_count: a.dismissCount || 0,
        created_at: a.createdAt,
      })),
    });
  } catch (err) {
    logger.error('support', { action: 'manage_announcement', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/manage_announcement', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action, id, announcement_id, title, message, type, status, start_time, end_time,
            display_style, priority, is_pinned, target_audience } = req.body;
    const annId = id || announcement_id;

    if (action === 'create') {
      if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });

      const validTypes = ['info', 'success', 'warning', 'critical'];
      const annType = validTypes.includes(type) ? type : 'info';
      const validStyles = ['banner', 'popup', 'dashboard_card', 'toast'];
      const annStyle = validStyles.includes(display_style) ? display_style : 'banner';

      const data = {
        title, message, type: annType, displayStyle: annStyle,
        status: status || 'active', createdAt: nowISO(),
        priority: priority || 0, isPinned: is_pinned ? 1 : 0,
        targetAudience: target_audience || 'all',
      };
      if (start_time) data.startTime = start_time;
      if (end_time) data.endTime = end_time;
      const ann = await prisma.announcement.create({ data });
      if (data.status === 'active') {
        try {
          const { io } = await import('../server.js');
          io.emit('announcement_published', { id: ann.id, title: ann.title, type: ann.type });
        } catch (_) {}
      }
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
      if (display_style !== undefined) data.displayStyle = display_style;
      if (priority !== undefined) data.priority = priority;
      if (is_pinned !== undefined) data.isPinned = is_pinned ? 1 : 0;
      if (target_audience !== undefined) data.targetAudience = target_audience;

      const updated = await prisma.announcement.update({ where: { id: parseInt(annId) }, data });
      if (updated.status === 'active') {
        try {
          const { io } = await import('../server.js');
          io.emit('announcement_published', { id: updated.id, title: updated.title, type: updated.type });
        } catch (_) {}
      }
      return res.json({ success: true, message: 'Announcement updated' });
    }

    if (action === 'toggle' && annId) {
      const ann = await prisma.announcement.findUnique({ where: { id: parseInt(annId) } });
      if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
      const newStatus = ann.status === 'active' ? 'inactive' : 'active';
      await prisma.announcement.update({ where: { id: parseInt(annId) }, data: { status: newStatus } });
      if (newStatus === 'active') {
        try {
          const { io } = await import('../server.js');
          io.emit('announcement_published', { id: ann.id, title: ann.title, type: ann.type });
        } catch (_) {}
      }
      return res.json({ success: true, message: 'Announcement toggled' });
    }

    if (action === 'duplicate' && annId) {
      const ann = await prisma.announcement.findUnique({ where: { id: parseInt(annId) } });
      if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
      const dup = await prisma.announcement.create({
        data: {
          title: `${ann.title} (Copy)`, message: ann.message, type: ann.type,
          displayStyle: ann.displayStyle, status: 'draft', priority: ann.priority,
          isPinned: 0, targetAudience: ann.targetAudience, createdAt: nowISO(),
        },
      });
      return res.json({ success: true, message: 'Announcement duplicated', id: dup.id });
    }

    if (action === 'archive' && annId) {
      await prisma.announcement.update({ where: { id: parseInt(annId) }, data: { status: 'archived' } });
      return res.json({ success: true, message: 'Announcement archived' });
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

router.post('/create_whatsapp_order', authenticate, async (req, res) => {
  try {
    const { platform_id, plan_id, account_type } = req.body;
    if (!platform_id) {
      return res.status(400).json({ success: false, message: 'Platform ID required' });
    }

    const platform = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) } });
    if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });

    let plan = null;
    let price = 0;
    const acctType = account_type || 'shared';

    if (plan_id) {
      plan = await prisma.pricingPlan.findFirst({
        where: { id: parseInt(plan_id), platformId: parseInt(platform_id), isActive: 1 },
      });
      if (plan) {
        price = acctType === 'private' ? plan.privatePrice : plan.sharedPrice;
      }
    }

    const msgParts = [
      `Platform: ${platform.name}`,
      plan ? `Plan: ${plan.durationValue} ${plan.durationUnit}` : '',
      `Type: ${acctType}`,
      price ? `Price: Rs. ${price}` : '',
      `Username: ${req.user.username}`,
    ].filter(Boolean);

    const now = nowISO();
    const order = await prisma.whatsAppOrder.create({
      data: {
        userId: req.user.id,
        platformId: parseInt(platform_id),
        planId: plan ? plan.id : null,
        accountType: acctType,
        price,
        message: msgParts.join('\n'),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
    });

    try {
      await prisma.adminNotification.create({
        data: {
          type: 'new_whatsapp_order',
          title: 'New WhatsApp Order',
          message: `${req.user.username} placed WhatsApp order for ${platform.name}`,
          severity: 'info',
          isRead: 0,
          createdAt: now,
        },
      });
      emitAdminEvent('new_whatsapp_order', {
        order_id: order.id,
        username: req.user.username,
        platform_name: platform.name,
        price,
      });
    } catch (e) { logger.warn('support', { action: 'wa_order_notification', error: e.message }); }

    res.json({
      success: true,
      message: 'WhatsApp order created',
      order_id: order.id,
      whatsapp_message: msgParts.join(' | '),
    });
  } catch (err) {
    logger.error('support', { action: 'create_whatsapp_order', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_whatsapp_orders', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status, search } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (status && status !== 'all') where.status = status;
    if (search) {
      const searchInt = parseInt(search);
      where.OR = [
        { message: { contains: search } },
        ...(searchInt ? [{ userId: searchInt }] : []),
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.whatsAppOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.whatsAppOrder.count({ where }),
    ]);

    const userIds = [...new Set(orders.map(o => o.userId))];
    const platformIds = [...new Set(orders.map(o => o.platformId))];
    const [users, platforms] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, name: true } }),
      prisma.platform.findMany({ where: { id: { in: platformIds } }, select: { id: true, name: true } }),
    ]);
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const platMap = Object.fromEntries(platforms.map(p => [p.id, p]));

    res.json({
      success: true,
      orders: orders.map(o => ({
        id: o.id, user_id: o.userId,
        username: userMap[o.userId]?.username || '',
        user_name: userMap[o.userId]?.name || '',
        platform_id: o.platformId,
        platform_name: platMap[o.platformId]?.name || '',
        plan_id: o.planId, account_type: o.accountType,
        price: o.price, message: o.message,
        status: o.status, admin_notes: o.adminNotes,
        created_at: o.createdAt, updated_at: o.updatedAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    logger.error('support', { action: 'get_whatsapp_orders', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_whatsapp_order', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { order_id, status, admin_notes } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'Order ID required' });

    const validStatuses = ['pending', 'contacted', 'paid', 'completed', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const data = { updatedAt: nowISO() };
    if (status) data.status = status;
    if (admin_notes !== undefined) data.adminNotes = admin_notes;

    const order = await prisma.whatsAppOrder.update({
      where: { id: parseInt(order_id) },
      data,
    });

    if (order.userId) {
      emitUserEvent(order.userId, 'whatsapp_order_updated', {
        order_id: order.id, status: order.status,
      });
    }

    res.json({ success: true, message: 'Order updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_admin_notifications', authenticate, requireAdmin(), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const notifications = await prisma.adminNotification.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const unreadCount = await prisma.adminNotification.count({ where: { isRead: 0 } });

    res.json({
      success: true,
      notifications: notifications.map(n => ({
        id: n.id, type: n.type, title: n.title, message: n.message,
        platform_id: n.platformId, platform_name: n.platformName,
        severity: n.severity, is_read: n.isRead, created_at: n.createdAt,
      })),
      unread_count: unreadCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/mark_admin_notification_read', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { notification_id } = req.body;
    if (notification_id === 'all') {
      await prisma.adminNotification.updateMany({
        data: { isRead: 1 },
      });
    } else if (notification_id) {
      await prisma.adminNotification.update({
        where: { id: parseInt(notification_id) },
        data: { isRead: 1 },
      });
    }
    res.json({ success: true, message: 'Notification marked as read' });
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

    const unreadCount = notifications.filter(n => n.isRead === 0).length;
    res.json({
      success: true,
      notifications: notifications.map(n => ({
        id: n.id, title: n.title, message: n.message,
        type: n.type, is_read: n.isRead, created_at: n.createdAt,
      })),
      unread_count: unreadCount,
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
      await prisma.userNotification.updateMany({
        where: { id: parseInt(notification_id), userId: req.user.id },
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

    const configs = await prisma.whatsappConfig.findMany({
      include: { platform: { select: { name: true } } },
    });

    res.json({
      success: true,
      whatsapp_number: setting?.settingValue || '',
      whatsapp_message: msgSetting?.settingValue || '',
      whatsapp: configs.map(c => ({
        platform_id: c.platformId,
        platform_name: c.platform?.name || '',
        number: c.sharedNumber || c.privateNumber || '',
        shared_number: c.sharedNumber || '',
        private_number: c.privateNumber || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/save_whatsapp', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { whatsapp_number, whatsapp_message, platform_id, number } = req.body;

    if (platform_id && number !== undefined) {
      await prisma.whatsappConfig.upsert({
        where: { platformId: parseInt(platform_id) },
        update: { sharedNumber: number, privateNumber: number },
        create: { platformId: parseInt(platform_id), sharedNumber: number, privateNumber: number },
      });
      return res.json({ success: true, message: 'Platform WhatsApp config saved' });
    }

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
