import { Router } from 'express';
import { prisma } from '../server.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { adminActionLimiter } from '../middleware/rateLimit.js';
import { nowISO, todayISO, futureDate, computeEndDate, extendEndDate, isSubExpired, parseEndDateUTC, getRemainingMs, getRemainingObj, getSubStatus, paginate } from '../utils/helpers.js';

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
    if (val < 1) return res.status(400).json({ success: false, message: 'Extension value required' });

    const subs = await prisma.userSubscription.findMany({
      where: { id: { in: subscription_ids.map(id => parseInt(id)) } },
    });

    let updated = 0;
    for (const sub of subs) {
      const newEnd = extendEndDate(sub.endDate, val, unit);
      const updateData = { endDate: newEnd, isActive: 1 };
      if (unit !== 'days' || (sub.durationUnit && sub.durationUnit !== 'days')) {
        updateData.durationUnit = unit;
        updateData.durationValue = val;
      }
      await prisma.userSubscription.update({
        where: { id: sub.id },
        data: updateData,
      });
      updated++;
    }

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Bulk extended ${updated} subscriptions by ${val} ${unit}`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: `${updated} subscription(s) extended by ${val} ${unit}` });
  } catch (err) {
    console.error('bulk_extend error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/bulk_revoke_subscriptions', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { subscription_ids } = req.body;
    if (!Array.isArray(subscription_ids) || !subscription_ids.length) {
      return res.status(400).json({ success: false, message: 'subscription_ids array required' });
    }

    const result = await prisma.userSubscription.updateMany({
      where: { id: { in: subscription_ids.map(id => parseInt(id)) } },
      data: { isActive: 0 },
    });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Bulk revoked ${result.count} subscriptions`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: `${result.count} subscription(s) revoked` });
  } catch (err) {
    console.error('bulk_revoke error:', err);
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

    const unit = ['minutes', 'hours', 'days'].includes(duration_unit) ? duration_unit : 'days';
    const durVal = parseInt(duration_value) || parseInt(duration_days) || 30;
    const endDateValue = end_date || computeEndDate(durVal, unit);

    const sub = await prisma.userSubscription.create({
      data: {
        userId: parseInt(user_id), platformId: parseInt(platform_id),
        startDate: nowISO(), endDate: endDateValue, isActive: 1,
        durationValue: durVal, durationUnit: unit,
      },
    });

    await prisma.activityLog.create({
      data: { userId: req.user.id, action: `Added subscription for user ${user_id} on platform ${platform_id} (${durVal} ${unit})`, ipAddress: req.ip || null, createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Subscription added', subscription_id: sub.id });
  } catch (err) {
    console.error('add_subscription error:', err);
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

    const sub = await prisma.userSubscription.findUnique({ where: { id: parseInt(subscription_id) } });
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

    const unit = ['minutes', 'hours', 'days'].includes(extend_unit) ? extend_unit : 'days';
    const val = parseInt(extend_value) || parseInt(days) || 0;
    if (val < 1) return res.status(400).json({ success: false, message: 'Extension value required' });

    const newEndDate = extendEndDate(sub.endDate, val, unit);

    const updateData = { endDate: newEndDate, isActive: 1 };
    if (unit !== 'days' || sub.durationUnit !== 'days') {
      updateData.durationUnit = unit;
      updateData.durationValue = val;
    }
    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: updateData,
    });

    res.json({ success: true, message: 'Subscription extended', new_end_date: newEndDate });
  } catch (err) {
    console.error('extend_subscription error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_pricing', authenticate, async (req, res) => {
  try {
    const { platform_id } = req.query;
    const where = {};
    if (platform_id) where.platformId = parseInt(platform_id);

    const plans = await prisma.pricingPlan.findMany({
      where,
      include: { platform: { select: { name: true } } },
      orderBy: [{ platformId: 'asc' }, { durationKey: 'asc' }],
    });

    const grouped = {};
    for (const p of plans) {
      if (!grouped[p.platformId]) {
        grouped[p.platformId] = { platform_id: p.platformId, platform_name: p.platform?.name, plans: {} };
      }
      grouped[p.platformId].plans[p.durationKey] = { shared: p.sharedPrice, private: p.privatePrice };
    }

    res.json({
      success: true,
      pricing: Object.values(grouped),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/save_pricing', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { platform_id, plans, pricing } = req.body;
    if (!platform_id || (!plans && !pricing)) return res.status(400).json({ success: false, message: 'Platform ID and pricing required' });

    if (plans && typeof plans === 'object') {
      for (const [durationKey, prices] of Object.entries(plans)) {
        await prisma.pricingPlan.upsert({
          where: { platformId_durationKey: { platformId: parseInt(platform_id), durationKey } },
          update: { sharedPrice: parseFloat(prices.shared || 0), privatePrice: parseFloat(prices.private || 0) },
          create: {
            platformId: parseInt(platform_id), durationKey,
            sharedPrice: parseFloat(prices.shared || 0), privatePrice: parseFloat(prices.private || 0),
          },
        });
      }
    } else if (Array.isArray(pricing)) {
      for (const plan of pricing) {
        await prisma.pricingPlan.upsert({
          where: { platformId_durationKey: { platformId: parseInt(platform_id), durationKey: plan.duration_key } },
          update: { sharedPrice: parseFloat(plan.shared_price), privatePrice: parseFloat(plan.private_price) },
          create: {
            platformId: parseInt(platform_id), durationKey: plan.duration_key,
            sharedPrice: parseFloat(plan.shared_price), privatePrice: parseFloat(plan.private_price),
          },
        });
      }
    }

    res.json({ success: true, message: 'Pricing saved' });
  } catch (err) {
    console.error('save_pricing error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create_payment', authenticate, async (req, res) => {
  try {
    const { platform_id, duration_key, account_type, payment_method, screenshot } = req.body;
    if (!platform_id || !duration_key) {
      return res.status(400).json({ success: false, message: 'Platform ID and duration required' });
    }

    const plan = await prisma.pricingPlan.findFirst({
      where: { platformId: parseInt(platform_id), durationKey: duration_key },
    });

    const price = plan ? (account_type === 'private' ? plan.privatePrice : plan.sharedPrice) : 0;

    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id, platformId: parseInt(platform_id),
        username: req.user.username, durationKey: duration_key,
        accountType: account_type || 'shared', price,
        status: 'pending', paymentMethod: payment_method || null,
        screenshot: screenshot || null, createdAt: nowISO(), updatedAt: nowISO(),
      },
    });

    res.json({ success: true, message: 'Payment request created', payment_id: payment.id });
  } catch (err) {
    console.error('create_payment error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/get_payments', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { page, per_page, status } = req.query;
    const { skip, take, page: p, perPage: pp } = paginate(page, per_page);

    const where = {};
    if (status) where.status = status;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          platform: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({
      success: true,
      payments: payments.map(p => ({
        id: p.id, user_id: p.userId, username: p.username,
        platform_id: p.platformId, platform_name: p.platform?.name,
        duration_key: p.durationKey, account_type: p.accountType,
        price: p.price, status: p.status, payment_method: p.paymentMethod,
        screenshot: p.screenshot, created_at: p.createdAt,
      })),
      pagination: { total_count: total, page: p, per_page: pp, total_pages: Math.ceil(total / pp) },
    });
  } catch (err) {
    console.error('get_payments error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/approve_payment', authenticate, requireAdmin('super_admin'), async (req, res) => {
  try {
    const { payment_id, action: payAction } = req.body;
    if (!payment_id) return res.status(400).json({ success: false, message: 'Payment ID required' });

    const payment = await prisma.payment.findUnique({ where: { id: parseInt(payment_id) } });
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

    const newStatus = payAction === 'reject' ? 'rejected' : 'approved';
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: newStatus, updatedAt: nowISO() },
    });

    if (newStatus === 'approved' && payment.userId) {
      const durationDays = { '1_week': 7, '1_month': 30, '6_months': 180, '1_year': 365 };
      const days = durationDays[payment.durationKey] || 30;

      await prisma.userSubscription.create({
        data: {
          userId: payment.userId, platformId: payment.platformId,
          startDate: nowISO(), endDate: computeEndDate(days, 'days'), isActive: 1,
          durationValue: days, durationUnit: 'days',
        },
      });
    }

    res.json({ success: true, message: `Payment ${newStatus}` });
  } catch (err) {
    console.error('approve_payment error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
