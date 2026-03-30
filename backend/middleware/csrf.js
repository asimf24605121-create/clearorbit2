import crypto from 'crypto';

if (process.env.NODE_ENV === 'production' && !process.env.CSRF_SECRET) {
  throw new Error('CSRF_SECRET must be set in production');
}
const CSRF_SECRET = process.env.CSRF_SECRET || process.env.JWT_SECRET || 'clearorbit_csrf_secret_change_in_production';
const TOKEN_TTL = 4 * 3600000;

export function generateCsrfToken(userId) {
  const uid = userId != null ? userId : 'anon';
  const timestamp = Date.now().toString(36);
  const payload = `${uid}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function isValidCsrfToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [userId, timestamp, hmac] = parts;
  const payload = `${userId}:${timestamp}`;
  const expected = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return false;
  const tokenTime = parseInt(timestamp, 36);
  if (Date.now() - tokenTime > TOKEN_TTL) return false;
  return true;
}

export function validateCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
    return next();
  }

  const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
  if (!isValidCsrfToken(token)) {
    return res.status(403).json({ success: false, message: 'Invalid CSRF token' });
  }

  next();
}

const CSRF_EXEMPT = new Set([
  '/login', '/csrf_token', '/submit_contact', '/forgot_password',
  '/reset_password', '/get_settings', '/get_public_platforms',
  '/get_active_announcement', '/reseller_signup', '/release_session',
  '/get_public_pricing',
  '/get_public_payment_methods',
]);

export function csrfMiddleware(req, res, next) {
  if (CSRF_EXEMPT.has(req.path)) return next();
  return validateCsrf(req, res, next);
}
