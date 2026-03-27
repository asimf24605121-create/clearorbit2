import { prisma } from '../server.js';
import { nowISO } from './helpers.js';

export async function logAdminAction(adminId, action, entityType, entityId, details, ipAddress) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId,
        action,
        entityType,
        entityId: entityId || null,
        details: typeof details === 'object' ? JSON.stringify(details) : (details || ''),
        ipAddress: ipAddress || null,
        createdAt: nowISO(),
      },
    });
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

export async function getSetting(key, defaultValue = '') {
  try {
    const row = await prisma.systemSettings.findUnique({ where: { key } });
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function setSetting(key, value) {
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
}
