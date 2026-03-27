import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../server.js';
import { authenticate, requireRole, requireAdmin } from '../middleware/auth.js';
import { nowISO, todayISO, futureDate, paginate } from '../utils/helpers.js';

const router = Router();

router.get('/reseller_dashboard', authenticate, requireRole('reseller', 'admin'), async (req, res) => {
  try {
    const userId = req.user.role === 'reseller' ? req.user.id : parseInt(req.query.user_id || req.user.id);

    const reseller = await prisma.reseller.findUnique({ where: { userId } });
    if (!reseller) return res.status(404).json({ success: false, message: 'Reseller not found' });

    const [users, recentTx] = await Promise.all([
      prisma.user.findMany({
        where: { resellerId: userId },
        select: { id: true, username: true, name: true, isActive: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.resellerTransaction.findMany({
        where: { resellerId: reseller.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    res.json({
      success: true,
      reseller: {
        id: reseller.id, balance: reseller.balance, commission_rate: reseller.commissionRate,
        total_earnings: reseller.totalEarnings, total_users: reseller.totalUsers,
        status: reseller.status,
      },
      users: users.map(u => ({
        id: u.id, username: u.username, name: u.name,
        is_active: u.isActive, created_at: u.createdAt,
      })),
      recent_transactions: recentTx.map(t => ({
        id: t.id, type: t.type, amount: t.amount, balance_after: t.balanceAfter,
        description: t.description, status: t.status, created_at: t.createdAt,
      })),
    });
  } catch (err) {
    console.error('reseller_dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reseller_signup', async (req, res) => {
  try {
    const { username, password, name, email, phone } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ success: false, message: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username, passwordHash: hash, role: 'reseller', isActive: 1,
        name: name || null, email: email || null, phone: phone || null,
        createdAt: nowISO(),
      },
    });

    await prisma.reseller.create({
      data: { userId: user.id, status: 'pending', createdAt: nowISO() },
    });

    res.json({ success: true, message: 'Reseller registration submitted for approval' });
  } catch (err) {
    console.error('reseller_signup error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reseller_users', authenticate, requireRole('reseller', 'admin'), async (req, res) => {
  try {
    const resellerId = req.user.role === 'reseller' ? req.user.id : parseInt(req.query.reseller_id || req.user.id);

    const users = await prisma.user.findMany({
      where: { resellerId },
      select: {
        id: true, username: true, name: true, email: true, isActive: true,
        createdAt: true, expiryDate: true,
        subscriptions: { select: { platformId: true, endDate: true, isActive: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      users: users.map(u => ({
        id: u.id, username: u.username, name: u.name, email: u.email,
        is_active: u.isActive, created_at: u.createdAt, expiry_date: u.expiryDate,
        subscription_count: u.subscriptions.length,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reseller_wallet', authenticate, requireRole('reseller', 'admin'), async (req, res) => {
  try {
    const userId = req.user.role === 'reseller' ? req.user.id : parseInt(req.query.user_id || req.user.id);

    const reseller = await prisma.reseller.findUnique({ where: { userId } });
    if (!reseller) return res.status(404).json({ success: false, message: 'Reseller not found' });

    const transactions = await prisma.resellerTransaction.findMany({
      where: { resellerId: reseller.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const pendingRecharges = await prisma.rechargeRequest.findMany({
      where: { resellerId: reseller.id, status: 'pending' },
    });

    res.json({
      success: true,
      balance: reseller.balance,
      total_earnings: reseller.totalEarnings,
      transactions: transactions.map(t => ({
        id: t.id, type: t.type, amount: t.amount, balance_after: t.balanceAfter,
        description: t.description, status: t.status, created_at: t.createdAt,
      })),
      pending_recharges: pendingRecharges.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reseller_wallet', authenticate, requireAdmin(), async (req, res) => {
  try {
    const { action } = req.body;

    if (action === 'list_resellers') {
      const resellers = await prisma.reseller.findMany({
        include: {
          user: { select: { id: true, username: true, name: true, email: true, phone: true, isActive: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return res.json({
        success: true,
        resellers: resellers.map(r => ({
          id: r.id, user_id: r.userId, username: r.user?.username, name: r.user?.name,
          email: r.user?.email, phone: r.user?.phone, balance: r.balance,
          commission_rate: r.commissionRate, total_earnings: r.totalEarnings,
          total_users: r.totalUsers, user_count: r.totalUsers, status: r.status,
          is_active: r.user?.isActive, created_at: r.createdAt,
        })),
      });
    }

    if (action === 'add_balance') {
      const { reseller_id, amount } = req.body;
      if (!reseller_id || !amount) return res.status(400).json({ success: false, message: 'Reseller ID and amount required' });
      const reseller = await prisma.reseller.findUnique({ where: { id: parseInt(reseller_id) } });
      if (!reseller) return res.status(404).json({ success: false, message: 'Reseller not found' });
      const newBalance = reseller.balance + parseFloat(amount);
      await prisma.reseller.update({ where: { id: parseInt(reseller_id) }, data: { balance: newBalance } });
      await prisma.resellerTransaction.create({
        data: {
          resellerId: parseInt(reseller_id), type: 'credit', amount: parseFloat(amount),
          balanceAfter: newBalance, description: 'Admin balance top-up', status: 'completed',
          createdAt: nowISO(),
        },
      });
      return res.json({ success: true, message: `Added ${amount} to balance. New balance: ${newBalance}` });
    }

    if (action === 'add_reseller') {
      const { username, email, password, commission_rate } = req.body;
      if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
      if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) return res.status(400).json({ success: false, message: 'Username already exists' });

      const hash = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: {
          username, passwordHash: hash, role: 'reseller', isActive: 1,
          email: email || null, createdAt: nowISO(),
        },
      });

      await prisma.reseller.create({
        data: {
          userId: user.id,
          commissionRate: (commission_rate !== undefined && commission_rate !== null && commission_rate !== '') ? Math.min(100, Math.max(0, parseInt(commission_rate))) : 10,
          status: 'active',
          createdAt: nowISO(),
        },
      });

      return res.json({ success: true, message: `Reseller "${username}" created successfully` });
    }

    if (action === 'update_reseller') {
      const { reseller_id, status } = req.body;
      if (!reseller_id || !status) return res.status(400).json({ success: false, message: 'Reseller ID and status required' });
      await prisma.reseller.update({ where: { id: parseInt(reseller_id) }, data: { status } });
      return res.json({ success: true, message: `Reseller status updated to ${status}` });
    }

    if (action === 'list_recharges') {
      const { status } = req.body;
      const where = {};
      if (status) where.status = status;
      const requests = await prisma.rechargeRequest.findMany({
        where,
        include: { reseller: { include: { user: { select: { username: true, name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return res.json({
        success: true,
        requests: requests.map(r => ({
          id: r.id, reseller_id: r.resellerId,
          username: r.reseller?.user?.username || r.reseller?.user?.name || 'Unknown',
          reseller_name: r.reseller?.user?.name || r.reseller?.user?.username,
          amount: r.amount, method: r.method, screenshot: r.screenshot,
          status: r.status, admin_note: r.adminNote, created_at: r.createdAt,
        })),
      });
    }

    if (action === 'approve_recharge') {
      const { request_id } = req.body;
      if (!request_id) return res.status(400).json({ success: false, message: 'Request ID required' });
      const request = await prisma.rechargeRequest.findUnique({ where: { id: parseInt(request_id) } });
      if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
      if (request.status !== 'pending') return res.status(400).json({ success: false, message: 'Request already processed' });
      const reseller = await prisma.reseller.findUnique({ where: { id: request.resellerId } });
      const newBalance = (reseller?.balance || 0) + request.amount;
      await prisma.$transaction([
        prisma.rechargeRequest.update({ where: { id: parseInt(request_id) }, data: { status: 'approved', updatedAt: nowISO() } }),
        prisma.reseller.update({ where: { id: request.resellerId }, data: { balance: newBalance } }),
        prisma.resellerTransaction.create({
          data: {
            resellerId: request.resellerId, type: 'recharge', amount: request.amount,
            balanceAfter: newBalance, description: `Recharge approved (#${request_id})`,
            status: 'completed', createdAt: nowISO(),
          },
        }),
      ]);
      return res.json({ success: true, message: 'Recharge approved and balance updated' });
    }

    if (action === 'reject_recharge') {
      const { request_id, note } = req.body;
      if (!request_id) return res.status(400).json({ success: false, message: 'Request ID required' });
      await prisma.rechargeRequest.update({
        where: { id: parseInt(request_id) },
        data: { status: 'rejected', adminNote: note || null, updatedAt: nowISO() },
      });
      return res.json({ success: true, message: 'Recharge rejected' });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    console.error('reseller_wallet POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
