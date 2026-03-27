const locks = new Map();
const LOCK_TTL = 10000;
const MAX_WAIT = 5000;

function sweepExpired() {
  const now = Date.now();
  for (const [key, lock] of locks) {
    if (now > lock.expiresAt) locks.delete(key);
  }
}

setInterval(sweepExpired, 15000);

export async function acquireSlotLock(accountId, userId) {
  const key = `slot:${accountId}`;
  const deadline = Date.now() + MAX_WAIT;

  while (Date.now() < deadline) {
    const existing = locks.get(key);
    if (!existing || Date.now() > existing.expiresAt) {
      locks.set(key, { userId, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL });
      return true;
    }
    if (existing.userId === userId) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

export function releaseSlotLock(accountId, userId) {
  const key = `slot:${accountId}`;
  const existing = locks.get(key);
  if (existing && (existing.userId === userId || Date.now() > existing.expiresAt)) {
    locks.delete(key);
    return true;
  }
  return false;
}

export function isSlotLocked(accountId) {
  const key = `slot:${accountId}`;
  const existing = locks.get(key);
  if (!existing) return false;
  if (Date.now() > existing.expiresAt) { locks.delete(key); return false; }
  return true;
}

export function getActiveLocks() {
  sweepExpired();
  const result = [];
  for (const [key, lock] of locks) {
    result.push({ key, userId: lock.userId, acquiredAt: lock.acquiredAt, expiresAt: lock.expiresAt });
  }
  return result;
}

export async function withSlotLock(accountId, userId, fn) {
  const acquired = await acquireSlotLock(accountId, userId);
  if (!acquired) throw new Error('Slot is currently being assigned to another user. Please try again.');
  try {
    return await fn();
  } finally {
    releaseSlotLock(accountId, userId);
  }
}
