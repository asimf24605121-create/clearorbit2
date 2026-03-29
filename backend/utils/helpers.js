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

export function computeEndDate(value, unit) {
  const now = new Date();
  if (unit === 'minutes') {
    now.setMinutes(now.getMinutes() + value);
    return now.toISOString().replace('T', ' ').substring(0, 19);
  } else if (unit === 'hours') {
    now.setHours(now.getHours() + value);
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }
  now.setDate(now.getDate() + value);
  return now.toISOString().substring(0, 10);
}

export function extendEndDate(currentEnd, value, unit) {
  const current = new Date(currentEnd);
  const base = current > new Date() ? current : new Date();
  if (unit === 'minutes') {
    base.setMinutes(base.getMinutes() + value);
    return base.toISOString().replace('T', ' ').substring(0, 19);
  } else if (unit === 'hours') {
    base.setHours(base.getHours() + value);
    return base.toISOString().replace('T', ' ').substring(0, 19);
  }
  base.setDate(base.getDate() + value);
  return base.toISOString().substring(0, 10);
}

export function isSubExpired(endDate) {
  if (!endDate) return true;
  const end = new Date(endDate.includes(' ') ? endDate.replace(' ', 'T') : endDate);
  return end <= new Date();
}

export async function getUserAccessMode(prisma, userId) {
  const now = new Date();
  const activeSubs = await prisma.userSubscription.findMany({
    where: { userId, isActive: 1 },
    select: { endDate: true, durationUnit: true },
  });
  const validSubs = activeSubs.filter(s => {
    const end = new Date(s.endDate.includes(' ') ? s.endDate.replace(' ', 'T') : s.endDate);
    return end > now;
  });
  if (validSubs.length === 0) return 'none';
  const hasDays = validSubs.some(s => s.durationUnit === 'days');
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

function isPrivateIP(ip) {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.') ||
    ip.startsWith('fc00:') ||
    ip.startsWith('fd') ||
    ip.startsWith('::ffff:10.') ||
    ip.startsWith('::ffff:192.168.') ||
    ip.startsWith('::ffff:172.')
  );
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
