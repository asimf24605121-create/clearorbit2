import { Router } from 'express';
import { prisma, emitAdminEvent, emitUserEvent } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { adminActionLimiter } from '../middleware/rateLimit.js';
import { nowISO, todayISO, futureDate, computeEndDate, extendEndDate, isSubExpired, parseEndDateUTC, getRemainingMs, getRemainingObj, getSubStatus, paginate } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  },
});

const router = Router();

router.get('/get_subscriptions', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, platform_id, status, search, sort, user_id } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);
    const today = todayISO();

    const where = {};
    if (platform_id) where.platformId = parseInt(platform_id);
    if (user_id) where.userId = parseInt(user_id);
    if (search) {
      where.user = {
        OR: [
          { username: { contains: search } },
          { name: { contains: search } },
        ],
      };
    }

    if (status === 'revoked') {
      where.isActive = 0;
    }

    let orderBy = { endDate: 'desc' };
    if (sort === 'expiry_asc') orderBy = { endDate: 'asc' };
    else if (sort === 'expiry_desc') orderBy = { endDate: 'desc' };
    else if (sort === 'newest') orderBy = { id: 'desc' };
    else if (sort === 'oldest') orderBy = { id: 'asc' };
    else if (sort === 'user') orderBy = { user: { username: 'asc' } };
    else if (sort === 'platform') orderBy = { platform: { name: 'asc' } };

    const allSubs = await prisma.userSubscription.findMany({
      where,
      include: {
        user: { select: { username: true, name: true, profileImage: true } },
        platform: { select: { name: true, logoUrl: true, bgColorHex: true } },
      },
      orderBy,
    });

    let mapped = allSubs.map(s => {
      const remaining = getRemainingObj(s.endDate);
      const computedStatus = getSubStatus(s.endDate, s.isActive);
      return {
        id: s.id, user_id: s.userId, username: s.user?.username,
        user_name: s.user?.name, user_avatar: s.user?.profileImage,
        platform_id: s.platformId,
        platform_name: s.platform?.name, platform_logo: s.platform?.logoUrl,
        platform_color: s.platform?.bgColorHex,
        start_date: s.startDate, end_date: s.endDate, is_active: s.isActive,
        remaining, days_left: remaining.days, status: computedStatus,
        duration_value: s.durationValue, duration_unit: s.durationUnit || 'days',
      };
    });

    if (status === 'active') {
      mapped = mapped.filter(s => s.status === 'active' || s.status === 'expiring');
    } else if (status === 'expired') {
      mapped = mapped.filter(s => s.status === 'expired' || s.status === 'revoked');
    } else if (status === 'expiring_soon') {
      mapped = mapped.filter(s => s.status === 'expiring');
    } else if (status === 'revoked') {
      mapped = mapped.filter(s => s.status === 'revoked');
    }

    const total = mapped.length;
    const paged = mapped.slice(skip, skip + take);

    res.json({
      success: true,
      subscriptions: paged,
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    console.error('get_subscriptions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/bulk_extend_subscriptions', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { subscription_ids, days, extend_value, extend_unit } = req.body;
    if (!Array.isArray(subscription_ids) || !subscription_ids.length) {
      return res.status(400).json({ success: false, message: 'subscription_ids array required' });
    }
    const unit = ['minutes', 'hours', 'days'].includes(extend_unit) ? extend_unit : 'days';
    const val = parseInt(extend_value) || parseInt(days) || 0;
    if (isNaN(val) || val < 1) return res.status(400).json({ success: false, message: 'Extension value must be a positive number' });

    const parsedIds = subscription_ids.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!parsedIds.length) return res.status(400).json({ success: false, message: 'No valid subscription IDs' });

    const userIds = await prisma.$transaction(async (tx) => {
      const subs = await tx.userSubscription.findMany({ where: { id: { in: parsedIds } } });
      const affectedUsers = new Set();

      for (const sub of subs) {
        const newEnd = extendEndDate(sub.endDate, val, unit);
        const updateData = { endDate: newEnd, isActive: 1 };
        if (unit !== 'days' || (sub.durationUnit && sub.durationUnit !== 'days')) {
          updateData.durationUnit = unit;
          updateData.durationValue = val;
        }
        await tx.userSubscription.update({ where: { id: sub.id }, data: updateData });
        affectedUsers.add(sub.userId);
      }

      for (const uid of affectedUsers) {
        const activeSubs = await tx.userSubscription.findMany({ where: { userId: uid, isActive: 1 }, select: { endDate: true } });
        const validSubs = activeSubs.filter(s => !isSubExpired(s.endDate));
        const newExpiry = validSubs.length > 0
          ? validSubs.reduce((max, s) => { const e = parseEndDateUTC(s.endDate); return e > max ? e : max; }, parseEndDateUTC(validSubs[0].endDate)).toISOString().replace('T', ' ').substring(0, 19)
          : null;
        await tx.user.update({ where: { id: uid }, data: { expiryDate: newExpiry } });
      }

      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Bulk extended ${subs.length} subscriptions by ${val} ${unit}`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return { count: subs.length, userIds: [...affectedUsers] };
    });

    for (const uid of userIds.userIds) {
      try { emitUserEvent(uid, 'subscription_updated', { message: `Your subscription has been extended by ${val} ${unit}` }); } catch (_) {}
    }

    logger.subscription('bulk_extend', { adminId: req.user.id, count: userIds.count, extension: `${val} ${unit}` });
    res.json({ success: true, message: `${userIds.count} subscription(s) extended by ${val} ${unit}` });
  } catch (err) {
    logger.error('subscription', { action: 'bulk_extend', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/bulk_revoke_subscriptions', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { subscription_ids } = req.body;
    if (!Array.isArray(subscription_ids) || !subscription_ids.length) {
      return res.status(400).json({ success: false, message: 'subscription_ids array required' });
    }

    const parsedIds = subscription_ids.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!parsedIds.length) return res.status(400).json({ success: false, message: 'No valid subscription IDs' });

    const result = await prisma.$transaction(async (tx) => {
      const affectedSubs = await tx.userSubscription.findMany({
        where: { id: { in: parsedIds } },
        select: { userId: true },
      });

      const revokeResult = await tx.userSubscription.updateMany({
        where: { id: { in: parsedIds } },
        data: { isActive: 0 },
      });

      const uniqueUserIds = [...new Set(affectedSubs.map(s => s.userId))];
      for (const uid of uniqueUserIds) {
        const remaining = await tx.userSubscription.findMany({ where: { userId: uid, isActive: 1 }, select: { endDate: true } });
        const valid = remaining.filter(s => !isSubExpired(s.endDate));
        const newExpiry = valid.length > 0
          ? valid.reduce((max, s) => { const e = parseEndDateUTC(s.endDate); return e > max ? e : max; }, parseEndDateUTC(valid[0].endDate)).toISOString().replace('T', ' ').substring(0, 19)
          : null;
        await tx.user.update({ where: { id: uid }, data: { expiryDate: newExpiry } });
      }

      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Bulk revoked ${revokeResult.count} subscriptions`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return { count: revokeResult.count, userIds: uniqueUserIds };
    });

    for (const uid of result.userIds) {
      try { emitUserEvent(uid, 'subscription_revoked', { message: 'A subscription has been revoked' }); } catch (_) {}
    }

    logger.subscription('bulk_revoke', { adminId: req.user.id, count: result.count });
    res.json({ success: true, message: `${result.count} subscription(s) revoked` });
  } catch (err) {
    logger.error('subscription', { action: 'bulk_revoke', error: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_user_subscriptions', authenticate, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.query.user_id && req.user.role && (req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.role === 'manager')) {
      userId = parseInt(req.query.user_id);
    }

    const subs = await prisma.userSubscription.findMany({
      where: { userId },
      include: {
        platform: { select: { id: true, name: true, logoUrl: true, bgColorHex: true, loginUrl: true } },
      },
      orderBy: { endDate: 'desc' },
    });

    res.json({
      success: true,
      subscriptions: subs.map(s => {
        const remaining = getRemainingObj(s.endDate);
        const computedStatus = getSubStatus(s.endDate, s.isActive);
        let statusLabel = 'ACTIVE';
        if (computedStatus === 'expired' || computedStatus === 'revoked') statusLabel = 'EXPIRED';
        else if (computedStatus === 'expiring') statusLabel = 'WARNING';

        return {
          id: s.id, platform_id: s.platformId, platform_name: s.platform?.name,
          platform_logo: s.platform?.logoUrl, platform_color: s.platform?.bgColorHex,
          login_url: s.platform?.loginUrl, start_date: s.startDate,
          end_date: s.endDate, is_active: s.isActive,
          remaining, days_left: remaining.days, status: statusLabel,
          duration_value: s.durationValue, duration_unit: s.durationUnit || 'days',
        };
      }),
    });
  } catch (err) {
    console.error('get_user_subscriptions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_subscription', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { user_id, platform_id, duration_days, duration_value, duration_unit, end_date } = req.body;
    if (!user_id || !platform_id) {
      return res.status(400).json({ success: false, message: 'User ID and Platform ID required' });
    }

    const parsedUserId = parseInt(user_id);
    const parsedPlatformId = parseInt(platform_id);
    if (isNaN(parsedUserId) || isNaN(parsedPlatformId)) {
      return res.status(400).json({ success: false, message: 'Invalid user or platform ID' });
    }

    const unit = ['minutes', 'hours', 'days'].includes(duration_unit) ? duration_unit : 'days';
    const durVal = parseInt(duration_value) || parseInt(duration_days) || 30;
    if (isNaN(durVal) || durVal < 1) return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
    const endDateValue = end_date || computeEndDate(durVal, unit);

    const sub = await prisma.$transaction(async (tx) => {
      const existing = await tx.userSubscription.findFirst({
        where: { userId: parsedUserId, platformId: parsedPlatformId, isActive: 1 },
      });
      if (existing) {
        if (parseEndDateUTC(existing.endDate) > Date.now()) {
          throw Object.assign(new Error('User already has an active subscription for this platform. Use extend instead.'), { statusCode: 409 });
        }
      }

      const created = await tx.userSubscription.create({
        data: {
          userId: parsedUserId, platformId: parsedPlatformId,
          startDate: nowISO(), endDate: endDateValue, isActive: 1,
          durationValue: durVal, durationUnit: unit,
        },
      });

      await tx.activityLog.create({
        data: { userId: req.user.id, action: `Added subscription for user ${user_id} on platform ${platform_id} (${durVal} ${unit})`, ipAddress: req.ip || null, createdAt: nowISO() },
      });

      return created;
    });

    logger.subscription('add', { adminId: req.user.id, userId: parsedUserId, platformId: parsedPlatformId, duration: `${durVal} ${unit}`, subscriptionId: sub.id });
    res.json({ success: true, message: 'Subscription added', subscription_id: sub.id });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ success: false, message: err.message });
    logger.error('subscription', { action: 'add', error: err.message, userId: req.body?.user_id });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_subscription', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { subscription_id } = req.body;
    if (!subscription_id) return res.status(400).json({ success: false, message: 'Subscription ID required' });

    await prisma.userSubscription.delete({ where: { id: parseInt(subscription_id) } });
    res.json({ success: true, message: 'Subscription deleted' });
  } catch (err) {
    console.error('delete_subscription error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/extend_subscription', authenticate, requireAdmin(), adminActionLimiter, async (req, res) => {
  try {
    const { subscription_id, days, extend_value, extend_unit } = req.body;
    if (!subscription_id) return res.status(400).json({ success: false, message: 'Subscription ID required' });

    const parsedId = parseInt(subscription_id);
    if (isNaN(parsedId)) return res.status(400).json({ success: false, message: 'Invalid subscription ID' });

    const unit = ['minutes', 'hours', 'days'].includes(extend_unit) ? extend_unit : 'days';
    const val = parseInt(extend_value) || parseInt(days) || 0;
    if (isNaN(val) || val < 1) return res.status(400).json({ success: false, message: 'Extension value must be a positive number' });

    const result = await prisma.$transaction(async (tx) => {
      const sub = await tx.userSubscription.findUnique({ where: { id: parsedId } });
      if (!sub) throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });

      const newEndDate = extendEndDate(sub.endDate, val, unit);
      const updateData = { endDate: newEndDate, isActive: 1 };
      if (unit !== 'days' || sub.durationUnit !== 'days') {
        updateData.durationUnit = unit;
        updateData.durationValue = val;
      }
      await tx.userSubscription.update({ where: { id: sub.id }, data: updateData });
      return { newEndDate, userId: sub.userId };
    });

    try { emitUserEvent(result.userId, 'subscription_updated', { message: `Your subscription has been extended by ${val} ${unit}` }); } catch (_) {}

    logger.subscription('extend', { adminId: req.user.id, subscriptionId: parsedId, extension: `${val} ${unit}`, newEndDate: result.newEndDate });
    res.json({ success: true, message: 'Subscription extended', new_end_date: result.newEndDate });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    logger.error('subscription', { action: 'extend', error: err.message, subscriptionId: req.body?.subscription_id });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const VALID_DURATION_UNITS = ['minutes', 'hours', 'days'];
const VALID_BADGES = ['Popular', 'Best Value', 'Limited Offer'];

function makeDurationKey(value, unit) {
  return `${value}_${unit}`;
}

function formatPlan(p) {
  return {
    id: p.id,
    platform_id: p.platformId,
    platform_name: p.platform?.name || null,
    duration_key: p.durationKey,
    duration_value: p.durationValue,
    duration_unit: p.durationUnit,
    shared_price: p.sharedPrice,
    private_price: p.privatePrice,
    original_price: p.originalPrice,
    is_active: p.isActive === 1,
    badge: p.badge,
    sort_order: p.sortOrder,
  };
}

function computeSortOrder(value, unit) {
  const multiplier = unit === 'minutes' ? 1 : unit === 'hours' ? 60 : 1440;
  return value * multiplier;
}

router.get('/get_pricing', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id } = req.query;
    const where = {};
    if (platform_id) {
      const pid = parseInt(platform_id);
      if (isNaN(pid)) return res.status(400).json({ success: false, message: 'Invalid platform ID' });
      where.platformId = pid;
    }

    const plans = await prisma.pricingPlan.findMany({
      where,
      include: { platform: { select: { name: true } } },
      orderBy: [{ platformId: 'asc' }, { sortOrder: 'asc' }],
    });

    res.json({
      success: true,
      plans: plans.map(formatPlan),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_public_pricing', async (req, res) => {
  try {
    const { platform_id } = req.query;
    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });

    const pid = parseInt(platform_id);
    if (isNaN(pid)) return res.status(400).json({ success: false, message: 'Invalid platform ID' });

    const [platform, plans, whatsappConfig] = await Promise.all([
      prisma.platform.findUnique({ where: { id: pid } }),
      prisma.pricingPlan.findMany({
        where: { platformId: pid, isActive: 1, platform: { isActive: 1 } },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.whatsappConfig.findUnique({ where: { platformId: pid } }),
    ]);

    if (!platform || platform.isActive !== 1) {
      return res.json({ success: true, plans: [] });
    }

    res.json({
      success: true,
      plans: plans.map(p => ({
        id: p.id,
        duration_key: p.durationKey,
        duration_value: p.durationValue,
        duration_unit: p.durationUnit,
        shared_price: p.sharedPrice,
        private_price: p.privatePrice,
        original_price: p.originalPrice,
        badge: p.badge,
      })),
      whatsapp: {
        shared_number: whatsappConfig?.sharedNumber || '',
        private_number: whatsappConfig?.privateNumber || '',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, duration_value, duration_unit, shared_price, private_price, original_price, badge, is_active } = req.body;

    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });
    const dv = parseInt(duration_value);
    if (!dv || dv <= 0) return res.status(400).json({ success: false, message: 'Duration value must be greater than 0' });
    if (!VALID_DURATION_UNITS.includes(duration_unit)) return res.status(400).json({ success: false, message: 'Duration unit must be minutes, hours, or days' });
    const sp = parseFloat(shared_price);
    const pp = parseFloat(private_price);
    if (isNaN(sp) || sp < 0) return res.status(400).json({ success: false, message: 'Shared price must be a valid number >= 0' });
    if (isNaN(pp) || pp < 0) return res.status(400).json({ success: false, message: 'Private price must be a valid number >= 0' });
    if (sp === 0 && pp === 0) return res.status(400).json({ success: false, message: 'At least one price must be greater than 0' });
    if (badge && !VALID_BADGES.includes(badge)) return res.status(400).json({ success: false, message: 'Invalid badge value' });

    const platformExists = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) } });
    if (!platformExists) return res.status(404).json({ success: false, message: 'Platform not found' });

    const durationKey = makeDurationKey(dv, duration_unit);
    const existing = await prisma.pricingPlan.findFirst({
      where: { platformId: parseInt(platform_id), durationKey },
    });
    if (existing) return res.status(409).json({ success: false, message: `A plan for ${dv} ${duration_unit} already exists for this platform` });

    const op = original_price != null ? parseFloat(original_price) : null;

    const plan = await prisma.pricingPlan.create({
      data: {
        platformId: parseInt(platform_id),
        durationKey,
        durationValue: dv,
        durationUnit: duration_unit,
        sharedPrice: sp,
        privatePrice: pp,
        originalPrice: op,
        badge: badge || null,
        isActive: 1,
        sortOrder: computeSortOrder(dv, duration_unit),
      },
      include: { platform: { select: { name: true } } },
    });

    res.json({ success: true, message: 'Pricing plan added', plan: formatPlan(plan) });
  } catch (err) {
    console.error('add_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/update_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { plan_id, duration_value, duration_unit, shared_price, private_price, original_price, badge, is_active } = req.body;

    if (!plan_id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(plan_id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    const updateData = {};

    if (duration_value !== undefined && duration_unit !== undefined) {
      const dv = parseInt(duration_value);
      if (!dv || dv <= 0) return res.status(400).json({ success: false, message: 'Duration value must be greater than 0' });
      if (!VALID_DURATION_UNITS.includes(duration_unit)) return res.status(400).json({ success: false, message: 'Duration unit must be minutes, hours, or days' });
      const newKey = makeDurationKey(dv, duration_unit);
      if (newKey !== existing.durationKey) {
        const dup = await prisma.pricingPlan.findFirst({
          where: { platformId: existing.platformId, durationKey: newKey, id: { not: existing.id } },
        });
        if (dup) return res.status(409).json({ success: false, message: `A plan for ${dv} ${duration_unit} already exists for this platform` });
      }
      updateData.durationKey = newKey;
      updateData.durationValue = dv;
      updateData.durationUnit = duration_unit;
      updateData.sortOrder = computeSortOrder(dv, duration_unit);
    }

    if (shared_price !== undefined) {
      const sp = parseFloat(shared_price);
      if (isNaN(sp) || sp < 0) return res.status(400).json({ success: false, message: 'Shared price must be >= 0' });
      updateData.sharedPrice = sp;
    }
    if (private_price !== undefined) {
      const pp = parseFloat(private_price);
      if (isNaN(pp) || pp < 0) return res.status(400).json({ success: false, message: 'Private price must be >= 0' });
      updateData.privatePrice = pp;
    }
    if (original_price !== undefined) {
      if (original_price === null || original_price === '') {
        updateData.originalPrice = null;
      } else {
        const op = parseFloat(original_price);
        if (isNaN(op) || op < 0) return res.status(400).json({ success: false, message: 'Original price must be >= 0' });
        updateData.originalPrice = op;
      }
    }
    if (badge !== undefined) {
      if (badge !== null && badge !== '' && !VALID_BADGES.includes(badge)) return res.status(400).json({ success: false, message: 'Invalid badge value' });
      updateData.badge = badge || null;
    }
    if (is_active !== undefined) {
      updateData.isActive = is_active ? 1 : 0;
    }

    const finalShared = updateData.sharedPrice !== undefined ? updateData.sharedPrice : existing.sharedPrice;
    const finalPrivate = updateData.privatePrice !== undefined ? updateData.privatePrice : existing.privatePrice;
    if (finalShared === 0 && finalPrivate === 0) {
      return res.status(400).json({ success: false, message: 'At least one price must be greater than 0' });
    }

    const plan = await prisma.pricingPlan.update({
      where: { id: parseInt(plan_id) },
      data: updateData,
      include: { platform: { select: { name: true } } },
    });

    res.json({ success: true, message: 'Pricing plan updated', plan: formatPlan(plan) });
  } catch (err) {
    console.error('update_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(plan_id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    const plan = await prisma.pricingPlan.update({
      where: { id: parseInt(plan_id) },
      data: { isActive: existing.isActive === 1 ? 0 : 1 },
      include: { platform: { select: { name: true } } },
    });

    res.json({ success: true, message: `Plan ${plan.isActive === 1 ? 'activated' : 'deactivated'}`, plan: formatPlan(plan) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/delete_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(plan_id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    await prisma.pricingPlan.delete({ where: { id: parseInt(plan_id) } });

    res.json({ success: true, message: 'Pricing plan deleted' });
  } catch (err) {
    console.error('delete_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/add_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, duration_value, duration_unit, shared_price, private_price, original_price, badge } = req.body;

    if (!platform_id) return res.status(400).json({ success: false, message: 'Platform ID required' });
    const dv = parseInt(duration_value);
    if (!dv || dv <= 0) return res.status(400).json({ success: false, message: 'Duration value must be greater than 0' });
    if (!VALID_UNITS.includes(duration_unit)) return res.status(400).json({ success: false, message: 'Duration unit must be minutes, hours, or days' });
    const sp = parseFloat(shared_price);
    const pp = parseFloat(private_price);
    if (isNaN(sp) || sp <= 0) return res.status(400).json({ success: false, message: 'Shared price must be greater than 0' });
    if (isNaN(pp) || pp <= 0) return res.status(400).json({ success: false, message: 'Private price must be greater than 0' });
    if (badge && !VALID_BADGES.includes(badge)) return res.status(400).json({ success: false, message: 'Invalid badge value' });
    if (original_price !== undefined && original_price !== null && original_price !== '') {
      const op = parseFloat(original_price);
      if (isNaN(op) || op < 0) return res.status(400).json({ success: false, message: 'Original price must be a valid number' });
    }

    const platform = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) } });
    if (!platform) return res.status(404).json({ success: false, message: 'Platform not found' });

    const existing = await prisma.pricingPlan.findFirst({
      where: { platformId: parseInt(platform_id), durationValue: dv, durationUnit: duration_unit },
    });
    if (existing) return res.status(409).json({ success: false, message: 'A plan with this duration already exists for this platform' });

    const plan = await prisma.pricingPlan.create({
      data: {
        platformId: parseInt(platform_id),
        durationKey: makeDurationKey(dv, duration_unit),
        durationValue: dv,
        durationUnit: duration_unit,
        sharedPrice: sp,
        privatePrice: pp,
        originalPrice: original_price ? parseFloat(original_price) : null,
        badge: badge || null,
        isActive: is_active !== undefined ? (parseInt(is_active) ? 1 : 0) : 1,
      },
    });

    res.json({
      success: true,
      message: 'Plan added',
      plan: {
        id: plan.id, duration_key: plan.durationKey, duration_value: plan.durationValue,
        duration_unit: plan.durationUnit, shared_price: plan.sharedPrice, private_price: plan.privatePrice,
        original_price: plan.originalPrice, is_active: plan.isActive, badge: plan.badge,
      },
    });
  } catch (err) {
    console.error('add_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/update_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { id, duration_value, duration_unit, shared_price, private_price, original_price, badge, is_active } = req.body;

    if (!id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    const updateData = {};

    if (duration_value !== undefined || duration_unit !== undefined) {
      const dv = parseInt(duration_value ?? existing.durationValue);
      const du = duration_unit ?? existing.durationUnit;
      if (dv <= 0) return res.status(400).json({ success: false, message: 'Duration value must be greater than 0' });
      if (!VALID_UNITS.includes(du)) return res.status(400).json({ success: false, message: 'Duration unit must be minutes, hours, or days' });

      if (dv !== existing.durationValue || du !== existing.durationUnit) {
        const dup = await prisma.pricingPlan.findFirst({
          where: { platformId: existing.platformId, durationValue: dv, durationUnit: du, id: { not: parseInt(id) } },
        });
        if (dup) return res.status(409).json({ success: false, message: 'A plan with this duration already exists' });
      }

      updateData.durationValue = dv;
      updateData.durationUnit = du;
      updateData.durationKey = makeDurationKey(dv, du);
    }

    if (shared_price !== undefined) {
      const sp = parseFloat(shared_price);
      if (isNaN(sp) || sp <= 0) return res.status(400).json({ success: false, message: 'Shared price must be greater than 0' });
      updateData.sharedPrice = sp;
    }
    if (private_price !== undefined) {
      const pp = parseFloat(private_price);
      if (isNaN(pp) || pp <= 0) return res.status(400).json({ success: false, message: 'Private price must be greater than 0' });
      updateData.privatePrice = pp;
    }
    if (original_price !== undefined) {
      if (original_price !== null && original_price !== '' && original_price !== 0) {
        const op = parseFloat(original_price);
        if (isNaN(op) || op < 0) return res.status(400).json({ success: false, message: 'Original price must be a valid number' });
        updateData.originalPrice = op;
      } else {
        updateData.originalPrice = null;
      }
    }
    if (badge !== undefined) {
      if (badge && !VALID_BADGES.includes(badge)) return res.status(400).json({ success: false, message: 'Invalid badge value' });
      updateData.badge = badge || null;
    }
    if (is_active !== undefined) {
      updateData.isActive = parseInt(is_active) ? 1 : 0;
    }

    const plan = await prisma.pricingPlan.update({ where: { id: parseInt(id) }, data: updateData });

    res.json({
      success: true,
      message: 'Plan updated',
      plan: {
        id: plan.id, duration_key: plan.durationKey, duration_value: plan.durationValue,
        duration_unit: plan.durationUnit, shared_price: plan.sharedPrice, private_price: plan.privatePrice,
        original_price: plan.originalPrice, is_active: plan.isActive, badge: plan.badge,
      },
    });
  } catch (err) {
    console.error('update_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/delete_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    await prisma.pricingPlan.delete({ where: { id: parseInt(id) } });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (err) {
    console.error('delete_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/toggle_pricing_plan', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Plan ID required' });

    const existing = await prisma.pricingPlan.findUnique({ where: { id: parseInt(id) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    const plan = await prisma.pricingPlan.update({
      where: { id: parseInt(id) },
      data: { isActive: existing.isActive === 1 ? 0 : 1 },
    });

    res.json({
      success: true,
      message: `Plan ${plan.isActive === 1 ? 'activated' : 'deactivated'}`,
      is_active: plan.isActive,
    });
  } catch (err) {
    console.error('toggle_pricing_plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/save_pricing', authenticate, requireAdmin(), async (req, res) => {
  res.status(410).json({ success: false, message: 'This endpoint is deprecated. Use add_pricing_plan, update_pricing_plan, delete_pricing_plan instead.' });
});

router.post('/upload_payment_screenshot', authenticate, (req, res) => {
  screenshotUpload.single('screenshot')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'File too large. Max 5MB.' });
      return res.status(400).json({ success: false, message: 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    res.json({ success: true, screenshot_url: `/uploads/${req.file.filename}` });
  });
});

router.post('/create_payment', authenticate, async (req, res) => {
  try {
    const { platform_id, account_type, payment_method, screenshot, plan_id, duration_key } = req.body;
    if (!platform_id) {
      return res.status(400).json({ success: false, message: 'Platform ID required' });
    }

    let plan;
    if (plan_id) {
      plan = await prisma.pricingPlan.findFirst({
        where: { id: parseInt(plan_id), platformId: parseInt(platform_id), isActive: 1 },
      });
    } else if (duration_key) {
      plan = await prisma.pricingPlan.findFirst({
        where: { platformId: parseInt(platform_id), durationKey: duration_key, isActive: 1 },
      });
    }

    if (!plan) {
      return res.status(400).json({ success: false, message: 'Valid pricing plan is required' });
    }

    const acctType = account_type || 'shared';
    const price = acctType === 'private' ? plan.privatePrice : plan.sharedPrice;
    const now = nowISO();

    const platform = await prisma.platform.findUnique({ where: { id: parseInt(platform_id) }, select: { name: true } });

    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id, platformId: parseInt(platform_id),
        username: req.user.username, durationKey: plan.durationKey,
        accountType: acctType, price,
        planDurationValue: plan.durationValue,
        planDurationUnit: plan.durationUnit,
        planId: plan.id,
        status: 'pending', paymentMethod: payment_method || null,
        screenshot: screenshot || null, createdAt: now, updatedAt: now,
      },
    });

    try {
      await prisma.adminNotification.create({
        data: {
          type: 'new_payment',
          title: 'New Payment Request',
          message: `${req.user.username} submitted payment for ${platform?.name || 'Unknown'} (Rs. ${price})`,
          severity: 'info',
          isRead: 0,
          createdAt: now,
        },
      });
      emitAdminEvent('new_payment', {
        payment_id: payment.id,
        username: req.user.username,
        platform_name: platform?.name,
        price,
      });
    } catch (e) { console.error('Payment notification error:', e.message); }

    res.json({ success: true, message: 'Payment request created', payment_id: payment.id });
  } catch (err) {
    console.error('create_payment error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_payments', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status, search, platform_id, payment_method, date_from, date_to } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (status && status !== 'all') where.status = status;
    if (platform_id) where.platformId = parseInt(platform_id);
    if (payment_method) where.paymentMethod = payment_method;
    if (search) {
      where.OR = [
        { username: { contains: search } },
      ];
    }
    if (date_from) where.createdAt = { ...(where.createdAt || {}), gte: date_from };
    if (date_to) where.createdAt = { ...(where.createdAt || {}), lte: date_to };

    const [payments, total, pendingCount, approvedToday, rejectedToday, totalRevenue] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          platform: { select: { name: true } },
          user: { select: { username: true, name: true, email: true, profileImage: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.payment.count({ where }),
      prisma.payment.count({ where: { status: 'pending' } }),
      prisma.payment.count({ where: { status: 'approved', reviewedAt: { gte: todayISO() } } }),
      prisma.payment.count({ where: { status: 'rejected', reviewedAt: { gte: todayISO() } } }),
      prisma.payment.aggregate({ where: { status: 'approved' }, _sum: { price: true } }),
    ]);

    const pendingRevenue = await prisma.payment.aggregate({ where: { status: 'pending' }, _sum: { price: true } });

    res.json({
      success: true,
      payments: payments.map(p => ({
        id: p.id, user_id: p.userId, username: p.username,
        user_name: p.user?.name, user_email: p.user?.email,
        user_avatar: p.user?.profileImage,
        platform_id: p.platformId, platform_name: p.platform?.name,
        duration_key: p.durationKey, account_type: p.accountType,
        price: p.price, status: p.status, payment_method: p.paymentMethod,
        screenshot: p.screenshot,
        plan_duration_value: p.planDurationValue, plan_duration_unit: p.planDurationUnit,
        reviewed_at: p.reviewedAt, reviewed_by: p.reviewedBy,
        rejection_reason: p.rejectionReason, admin_note: p.adminNote,
        created_at: p.createdAt, updated_at: p.updatedAt,
      })),
      stats: {
        pending: pendingCount,
        approved_today: approvedToday,
        rejected_today: rejectedToday,
        total_revenue: totalRevenue._sum.price || 0,
        pending_revenue: pendingRevenue._sum.price || 0,
      },
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    console.error('get_payments error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/approve_payment', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { payment_id, action: payAction, reject_reason } = req.body;
    if (!payment_id) return res.status(400).json({ success: false, message: 'Payment ID required' });

    const parsedPaymentId = parseInt(payment_id);
    if (isNaN(parsedPaymentId)) return res.status(400).json({ success: false, message: 'Invalid payment ID' });

    const newStatus = payAction === 'reject' ? 'rejected' : 'approved';
    const now = nowISO();

    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: parsedPaymentId } });
      if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
      if (payment.status !== 'pending') {
        throw Object.assign(new Error(`Payment already ${payment.status}. Cannot process again.`), { statusCode: 409 });
      }

      const updateData = { status: newStatus, updatedAt: now, reviewedAt: now, reviewedBy: req.user.id };
      if (payAction === 'reject' && reject_reason) updateData.rejectionReason = reject_reason;
      await tx.payment.update({ where: { id: payment.id }, data: updateData });

      let subscriptionId = null;
      if (newStatus === 'approved' && payment.userId) {
        let durValue, durUnit;
        if (payment.planDurationValue && payment.planDurationUnit) {
          durValue = payment.planDurationValue;
          durUnit = payment.planDurationUnit;
        } else {
          const plan = await tx.pricingPlan.findFirst({
            where: { platformId: payment.platformId, durationKey: payment.durationKey },
          });
          if (plan && plan.durationValue > 0) {
            durValue = plan.durationValue;
            durUnit = plan.durationUnit;
          } else {
            const fallback = { '1_week': 7, '1_month': 30, '6_months': 180, '1_year': 365 };
            durValue = fallback[payment.durationKey] || 30;
            durUnit = 'days';
          }
        }

        const existingActive = await tx.userSubscription.findFirst({
          where: { userId: payment.userId, platformId: payment.platformId, isActive: 1 },
        });
        let sub;
        if (existingActive && parseEndDateUTC(existingActive.endDate) > Date.now()) {
          const newEnd = extendEndDate(existingActive.endDate, durValue, durUnit);
          await tx.userSubscription.update({ where: { id: existingActive.id }, data: { endDate: newEnd } });
          sub = existingActive;
        } else {
          sub = await tx.userSubscription.create({
            data: {
              userId: payment.userId, platformId: payment.platformId,
              startDate: now, endDate: computeEndDate(durValue, durUnit), isActive: 1,
              durationValue: durValue, durationUnit: durUnit,
            },
          });
        }
        subscriptionId = sub.id;
      }

      return { payment, subscriptionId };
    });

    if (newStatus === 'approved' && result.payment.userId) {
      try {
        await prisma.userNotification.create({
          data: {
            userId: result.payment.userId,
            title: 'Payment Approved',
            message: `Your payment for ${result.payment.durationKey} has been approved. Subscription is now active!`,
            type: 'success', isRead: 0, createdAt: now,
          },
        });
        emitUserEvent(result.payment.userId, 'payment_approved', { payment_id: result.payment.id });
      } catch (e) { logger.error('notification', { action: 'payment_approved', error: e.message }); }
    }

    if (newStatus === 'rejected' && result.payment.userId) {
      try {
        await prisma.userNotification.create({
          data: {
            userId: result.payment.userId,
            title: 'Payment Rejected',
            message: reject_reason || 'Your payment was rejected. Please contact support.',
            type: 'warning', isRead: 0, createdAt: now,
          },
        });
        emitUserEvent(result.payment.userId, 'payment_rejected', { payment_id: result.payment.id, reason: reject_reason });
      } catch (e) { logger.error('notification', { action: 'payment_rejected', error: e.message }); }
    }

    logger.payment(newStatus, { adminId: req.user.id, paymentId: parsedPaymentId, userId: result.payment.userId });
    res.json({ success: true, message: `Payment ${newStatus}` });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    logger.error('payment', { action: 'approve', error: err.message, paymentId: req.body?.payment_id });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
