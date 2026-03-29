import crypto from 'crypto';

export function nowISO() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

export function cutoffISO(secondsAgo) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

export function todayISO() {
  return new Date().toISOString().substring(0, 10);
}

export function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().substring(0, 10);
}

export function parseEndDateUTC(endDate) {
  if (!endDate) return new Date(0);
  const s = String(endDate).trim();
  let d;
  if (s.includes('T')) {
    d = new Date(s.endsWith('Z') || s.includes('+') || s.includes('-', 11) ? s : s + 'Z');
  } else if (s.includes(' ')) {
    d = new Date(s.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(s + 'T23:59:59Z');
  }
  return isNaN(d.getTime()) ? new Date(0) : d;
}

export function computeEndDate(value, unit) {
  const now = new Date();
  if (unit === 'minutes') {
    now.setMinutes(now.getMinutes() + value);
  } else if (unit === 'hours') {
    now.setHours(now.getHours() + value);
  } else {
    now.setDate(now.getDate() + value);
  }
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

export function extendEndDate(currentEnd, value, unit) {
  const current = parseEndDateUTC(currentEnd);
  const base = current > new Date() ? current : new Date();
  if (unit === 'minutes') {
    base.setMinutes(base.getMinutes() + value);
  } else if (unit === 'hours') {
    base.setHours(base.getHours() + value);
  } else {
    base.setDate(base.getDate() + value);
  }
  return base.toISOString().replace('T', ' ').substring(0, 19);
}

export function isSubExpired(endDate) {
  if (!endDate) return true;
  return parseEndDateUTC(endDate) <= new Date();
}

export function getRemainingMs(endDate) {
  if (!endDate) return 0;
  return Math.max(0, parseEndDateUTC(endDate) - new Date());
}

export function formatRemainingLabel(endDate) {
  const ms = getRemainingMs(endDate);
  if (ms <= 0) return 'Expired';
  const totalMins = Math.ceil(ms / 60000);
  if (totalMins < 60) return `${totalMins}m left`;
  const totalHours = Math.ceil(ms / 3600000);
  if (totalHours < 24) return `${totalHours}h left`;
  const totalDays = Math.ceil(ms / 86400000);
  return `${totalDays}d left`;
}

export function getSubStatus(endDate, isActive) {
  if (!isActive || isActive === 0) return 'revoked';
  if (isSubExpired(endDate)) return 'expired';
  const ms = getRemainingMs(endDate);
  const daysLeft = ms / 86400000;
  if (daysLeft <= 3) return 'expiring';
  return 'active';
}

export function getRemainingObj(endDate) {
  const ms = getRemainingMs(endDate);
  if (ms <= 0) return { days: 0, hours: 0, minutes: 0, expired: true, total_seconds: 0 };
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return { days, hours, minutes, seconds, expired: false, total_seconds: totalSec };
}

export async function getUserAccessMode(prisma, userId) {
  const now = new Date();
  const activeSubs = await prisma.userSubscription.findMany({
    where: { userId, isActive: 1 },
    select: { endDate: true, durationUnit: true },
  });
  const validSubs = activeSubs.filter(s => parseEndDateUTC(s.endDate) > now);
  if (validSubs.length === 0) return 'none';
  const hasDays = validSubs.some(s => !s.durationUnit || s.durationUnit === 'days');
  return hasDays ? 'regular' : 'short';
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function getClientIP(req) {
  const cfIP = req.headers['cf-connecting-ip'];
  if (cfIP) return cfIP.trim();

  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[0];
  }

  return req.socket?.remoteAddress || '0.0.0.0';
}

export function parseUserAgent(ua) {
  if (!ua) return { deviceType: 'desktop', browser: 'Unknown', os: 'Unknown' };

  let deviceType = 'desktop';
  if (/mobile|android.*mobile|iphone|ipod/i.test(ua)) deviceType = 'mobile';
  else if (/tablet|ipad|android(?!.*mobile)/i.test(ua)) deviceType = 'tablet';

  let browser = 'Unknown';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua) || /opera/i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';

  return { deviceType, browser, os };
}

export function paginate(page = 1, perPage = 25) {
  const p = Math.max(1, parseInt(page) || 1);
  const pp = Math.min(100, Math.max(1, parseInt(perPage) || 25));
  return { skip: (p - 1) * pp, take: pp, page: p, perPage: pp };
}

export function jsonResponse(res, data, statusCode = 200) {
  return res.status(statusCode).json(data);
}

export function isPermanentSuperAdmin(email) {
  return email === 'asimf24605121@gmail.com';
}
