const DANGEROUS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=/gi,
  /data\s*:\s*text\/html/gi,
];

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  let cleaned = str;
  for (const pattern of DANGEROUS_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function sanitizeValue(val, options = {}) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    if (options.skipSanitize) return val;
    return sanitizeString(val);
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.map(v => sanitizeValue(v, options));
  if (typeof val === 'object') {
    const result = {};
    for (const [key, v] of Object.entries(val)) {
      result[sanitizeString(key)] = sanitizeValue(v, options);
    }
    return result;
  }
  return val;
}

const COOKIE_DATA_FIELDS = new Set(['cookie_data', 'cookie_string', 'cookieData', 'raw_cookie']);

export function sanitizeMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();

  if (req.body && typeof req.body === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (COOKIE_DATA_FIELDS.has(key)) {
        sanitized[key] = value;
      } else {
        sanitized[key] = sanitizeValue(value);
      }
    }
    req.body = sanitized;
  }

  next();
}

const ALLOWED_FIELDS = {
  manage_platform_accounts: new Set(['action', 'account_id', 'platform_id', 'slot_name', 'cookie_data', 'max_users', 'profile_index', 'expires_at', 'is_active', 'ids', 'account_ids', 'days', 'default_expiry_days']),
  add_account_unified: new Set(['action', 'platform_id', 'cookie_data', 'cookie_string', 'slot_name', 'max_users', 'slot_count', 'profile_index']),
  validate_cookie: new Set(['cookie_string', 'cookie_id', 'action', 'account_id']),
  verify_login: new Set(['action', 'account_id']),
};

export function massAssignmentGuard(routeName) {
  const allowed = ALLOWED_FIELDS[routeName];
  if (!allowed) return (req, res, next) => next();

  return (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return next();
    if (!req.body || typeof req.body !== 'object') return next();

    const filtered = {};
    for (const key of Object.keys(req.body)) {
      if (allowed.has(key)) filtered[key] = req.body[key];
    }
    req.body = filtered;
    next();
  };
}

export function validatePayload(schema) {
  return (req, res, next) => {
    if (!req.body) return res.status(400).json({ success: false, message: 'Request body required' });
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];
      if (rules.required && (value === undefined || value === null || value === '')) {
        return res.status(400).json({ success: false, message: `${field} is required` });
      }
      if (value !== undefined && value !== null) {
        if (rules.type === 'number' && (typeof value !== 'number' || isNaN(value))) {
          const parsed = Number(value);
          if (isNaN(parsed)) return res.status(400).json({ success: false, message: `${field} must be a number` });
          req.body[field] = parsed;
        }
        if (rules.type === 'string' && typeof value !== 'string') {
          return res.status(400).json({ success: false, message: `${field} must be a string` });
        }
        if (rules.min !== undefined && Number(value) < rules.min) {
          return res.status(400).json({ success: false, message: `${field} must be at least ${rules.min}` });
        }
        if (rules.max !== undefined && Number(value) > rules.max) {
          return res.status(400).json({ success: false, message: `${field} must be at most ${rules.max}` });
        }
        if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
          return res.status(400).json({ success: false, message: `${field} is too long (max ${rules.maxLength})` });
        }
        if (rules.enum && !rules.enum.includes(value)) {
          return res.status(400).json({ success: false, message: `${field} must be one of: ${rules.enum.join(', ')}` });
        }
      }
    }
    next();
  };
}
