import { createHash } from 'crypto';

const PLATFORM_DOMAINS = {
  '.netflix.com': 'Netflix',
  '.spotify.com': 'Spotify',
  '.disneyplus.com': 'Disney+',
  '.openai.com': 'ChatGPT',
  '.canva.com': 'Canva',
  '.udemy.com': 'Udemy',
  '.coursera.org': 'Coursera',
  '.skillshare.com': 'Skillshare',
  '.grammarly.com': 'Grammarly',
  '.hulu.com': 'Hulu',
  '.amazon.com': 'Amazon Prime',
  '.hbomax.com': 'HBO Max',
  '.max.com': 'HBO Max',
  '.crunchyroll.com': 'Crunchyroll',
  '.youtube.com': 'YouTube Premium',
  '.primevideo.com': 'Amazon Prime',
  '.duolingo.com': 'Duolingo',
  '.linkedin.com': 'LinkedIn Learning',
  '.paramount.com': 'Paramount+',
  '.peacocktv.com': 'Peacock',
  '.apple.com': 'Apple TV+',
  '.tv.apple.com': 'Apple TV+',
};

const PLATFORM_COOKIE_KEYS = {
  Netflix: ['NetflixId', 'SecureNetflixId', 'nfvdid', 'memclid', 'flwssn'],
  Spotify: ['sp_dc', 'sp_key', 'sp_t', 'spotify_remember_me'],
  'Disney+': ['disney_token', 'dss_id', 'BAMdss', 'BAMSESSIONID'],
  ChatGPT: ['__Secure-next-auth.session-token', 'cf_clearance', '__cf_bm'],
  Canva: ['canva_session', 'csrf', 'canvasession'],
  Udemy: ['access_token', 'ud_cache_user', 'client_id'],
  Coursera: ['CAUTH', 'CSRF3-Token', 'masters_enrolled'],
  Skillshare: ['skillshare_session'],
  Grammarly: ['grauth', 'csrf-token', 'gnar_containerId'],
  'YouTube Premium': ['SAPISID', 'SSID', 'SID', 'HSID', 'LOGIN_INFO'],
  'Amazon Prime': ['session-id', 'ubid-main', 'x-main', 'at-main'],
  Hulu: ['_hulu_session', '_hulu_uid', '__h_uid'],
  'HBO Max': ['hbo_session', 'hbosession', 'TNT_TOKEN'],
  Crunchyroll: ['session_id', 'etp_rt'],
};

const NETFLIX_TOKEN_PATTERN = /^v%3D\d+%26ct%3D|^v=\d+&ct=/i;
const NETFLIX_NFTOKEN_PATTERN = /^[A-Za-z0-9+/=_-]{60,}/;

export function parseRawCookieString(raw) {
  if (!raw || typeof raw !== 'string') return [];

  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(c => ({
        name: c.name || '',
        value: c.value || '',
        domain: c.domain || '',
        path: c.path || '/',
        expires: c.expirationDate || c.expires || c.expiry || -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || 'None',
      }));
    }
  } catch (e) {}

  if (trimmed.includes('\t')) {
    return parseNetscapeFormat(trimmed);
  }

  const netflixResult = tryParseNetflixFormat(trimmed);
  if (netflixResult) return netflixResult;

  return parseKeyValueFormat(trimmed);
}

function tryParseNetflixFormat(text) {
  if (NETFLIX_TOKEN_PATTERN.test(text)) {
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch (e) {}

    if (/^v=\d+&ct=/.test(decoded)) {
      return [{
        name: 'NetflixId',
        value: text,
        domain: '.netflix.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'None',
      }];
    }
  }

  const netflixCookiePattern = /NetflixId=([^;]+)/i;
  const secureNetflixPattern = /SecureNetflixId=([^;]+)/i;
  if (netflixCookiePattern.test(text) || secureNetflixPattern.test(text)) {
    return parseKeyValueFormat(text);
  }

  return null;
}

function parseNetscapeFormat(text) {
  const cookies = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        name: parts[5],
        value: parts[6],
        domain: parts[0],
        path: parts[2],
        expires: parseInt(parts[4]) || -1,
        httpOnly: parts[1] === 'TRUE',
        secure: parts[3] === 'TRUE',
        sameSite: 'None',
      });
    }
  }
  return cookies;
}

function parseKeyValueFormat(text) {
  const cookies = [];
  const pairs = text.split(';').map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const name = pair.substring(0, eqIndex).trim();
      const value = pair.substring(eqIndex + 1).trim();
      if (name) {
        cookies.push({
          name,
          value,
          domain: inferDomainFromName(name),
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        });
      }
    }
  }
  return cookies;
}

function inferDomainFromName(name) {
  const lname = name.toLowerCase();
  for (const [platform, keys] of Object.entries(PLATFORM_COOKIE_KEYS)) {
    if (keys.some(k => k.toLowerCase() === lname)) {
      const domainEntry = Object.entries(PLATFORM_DOMAINS).find(([, p]) => p === platform);
      if (domainEntry) return domainEntry[0];
    }
  }
  return '';
}

export function detectPlatformFromCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;

  for (const cookie of cookies) {
    const domain = (cookie.domain || '').toLowerCase();
    for (const [domainPattern, platform] of Object.entries(PLATFORM_DOMAINS)) {
      if (domain && domain.includes(domainPattern.replace(/^\./, ''))) {
        return { platform, domain: domainPattern };
      }
    }
  }

  const cookieNames = cookies.map(c => (c.name || '').toLowerCase());
  for (const [platform, keys] of Object.entries(PLATFORM_COOKIE_KEYS)) {
    const matchCount = keys.filter(k => cookieNames.includes(k.toLowerCase())).length;
    if (matchCount >= 1) {
      const domainEntry = Object.entries(PLATFORM_DOMAINS).find(([, p]) => p === platform);
      return { platform, domain: domainEntry ? domainEntry[0] : null };
    }
  }

  for (const cookie of cookies) {
    const value = (cookie.value || '').toLowerCase();
    let decoded = value;
    try { decoded = decodeURIComponent(value).toLowerCase(); } catch (e) {}

    if (/^v=\d+&ct=/.test(decoded) || /^v%3d\d+%26ct%3d/i.test(value)) {
      return { platform: 'Netflix', domain: '.netflix.com' };
    }
    if (value.startsWith('sp_dc=') || (cookie.name || '').toLowerCase() === 'sp_dc') {
      return { platform: 'Spotify', domain: '.spotify.com' };
    }
  }

  for (const cookie of cookies) {
    const name = (cookie.name || '').toLowerCase();
    if (/netflix/i.test(name) || name === 'netflixid' || name === 'nfvdid') {
      return { platform: 'Netflix', domain: '.netflix.com' };
    }
    if (/spotify/i.test(name) || name === 'sp_dc') {
      return { platform: 'Spotify', domain: '.spotify.com' };
    }
    if (/disney/i.test(name) || name === 'dss_id') {
      return { platform: 'Disney+', domain: '.disneyplus.com' };
    }
  }

  return null;
}

export function generateFingerprint(rawCookieString) {
  if (!rawCookieString) return null;
  const normalized = rawCookieString.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

export function generateNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain || '.unknown.com';
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expires && c.expires > 0 ? String(c.expires) : '0';
    lines.push(`${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n');
}

export function extractCookieExpiry(cookies) {
  let maxExpiry = null;
  for (const c of cookies) {
    const exp = c.expires || c.expirationDate;
    if (exp && exp > 0) {
      const d = new Date(exp * 1000);
      if (!maxExpiry || d > maxExpiry) maxExpiry = d;
    }
  }
  return maxExpiry ? maxExpiry.toISOString().replace('T', ' ').substring(0, 19) : null;
}

export function computeCookieScore(cookies) {
  if (!cookies || cookies.length === 0) return 0;
  let score = 50;
  if (cookies.length >= 5) score += 10;
  if (cookies.length >= 10) score += 10;
  const hasExpiry = cookies.some(c => c.expires && c.expires > 0);
  if (hasExpiry) score += 15;
  const hasSecure = cookies.some(c => c.secure);
  if (hasSecure) score += 10;
  const hasHttpOnly = cookies.some(c => c.httpOnly);
  if (hasHttpOnly) score += 5;
  return Math.min(100, score);
}

const PLATFORM_SESSION_REQUIREMENTS = {
  Netflix: {
    authType: 'cookie',
    critical: ['NetflixId', 'SecureNetflixId'],
    important: ['nfvdid', 'memclid'],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
  Spotify: {
    authType: 'cookie_plus_token',
    critical: ['sp_dc', 'sp_key'],
    important: ['sp_t'],
    localStorage: ['sp_last_login_ts'],
    sessionStorage: [],
    tokens: ['Authorization'],
  },
  'Disney+': {
    authType: 'cookie',
    critical: ['disney_token', 'dss_id'],
    important: ['BAMdss', 'BAMSESSIONID'],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
  ChatGPT: {
    authType: 'cookie_plus_token',
    critical: ['__Secure-next-auth.session-token'],
    important: ['cf_clearance'],
    localStorage: ['oai/apps/hasSeenOnboarding/chat', 'oai-did'],
    sessionStorage: [],
    tokens: ['Authorization'],
  },
  Canva: {
    authType: 'cookie',
    critical: ['canva_session'],
    important: ['csrf'],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
  Udemy: {
    authType: 'cookie_plus_token',
    critical: ['access_token', 'client_id'],
    important: ['csrftoken'],
    localStorage: [],
    sessionStorage: [],
    tokens: ['Authorization', 'X-Udemy-Authorization'],
  },
  Coursera: {
    authType: 'cookie_plus_token',
    critical: ['CAUTH', 'CSRF3-Token'],
    important: ['__204u', 'maestro_login_flag'],
    localStorage: ['persist:root', 'jwtToken'],
    sessionStorage: [],
    tokens: ['X-CSRF3-Token', 'Authorization'],
  },
  Skillshare: {
    authType: 'cookie',
    critical: ['skillshare_session'],
    important: [],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
  Grammarly: {
    authType: 'cookie_plus_token',
    critical: ['grauth', 'csrf-token'],
    important: ['gnar_containerId'],
    localStorage: ['grammarly_user_id'],
    sessionStorage: [],
    tokens: ['X-CSRF-Token'],
  },
  'YouTube Premium': {
    authType: 'cookie',
    critical: ['SID', 'SSID', 'HSID'],
    important: ['SAPISID', 'LOGIN_INFO'],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
  'Amazon Prime': {
    authType: 'cookie',
    critical: ['session-id', 'ubid-main'],
    important: ['x-main', 'at-main'],
    localStorage: [],
    sessionStorage: [],
    tokens: [],
  },
};

export function classifyCookieCompleteness(cookies, platformName) {
  if (!cookies || cookies.length === 0) {
    return { status: 'EMPTY', score: 0, missing: [], present: [], authType: 'unknown', needsStorage: false, details: 'No cookies provided' };
  }

  const platform = platformName || detectPlatformFromCookies(cookies)?.platform;
  if (!platform) {
    return { status: 'UNKNOWN_PLATFORM', score: computeCookieScore(cookies), missing: [], present: [], authType: 'unknown', needsStorage: false, details: 'Platform not detected' };
  }

  const requirements = PLATFORM_SESSION_REQUIREMENTS[platform];
  if (!requirements) {
    return { status: 'NO_REQUIREMENTS', score: computeCookieScore(cookies), missing: [], present: [], authType: 'unknown', needsStorage: false, details: 'No session requirements defined for: ' + platform };
  }

  const cookieNames = cookies.map(c => (c.name || '').toLowerCase());
  const missing = [];
  const present = [];
  let criticalMet = 0;

  for (const name of requirements.critical) {
    if (cookieNames.includes(name.toLowerCase())) {
      present.push({ name, level: 'critical' });
      criticalMet++;
    } else {
      missing.push({ name, level: 'critical' });
    }
  }

  let importantMet = 0;
  for (const name of requirements.important) {
    if (cookieNames.includes(name.toLowerCase())) {
      present.push({ name, level: 'important' });
      importantMet++;
    } else {
      missing.push({ name, level: 'important' });
    }
  }

  const needsStorage = requirements.localStorage.length > 0 || requirements.sessionStorage.length > 0;
  const needsTokens = requirements.tokens.length > 0;
  const criticalTotal = requirements.critical.length;
  const criticalRatio = criticalTotal > 0 ? criticalMet / criticalTotal : 1;

  let status, score;
  if (criticalRatio === 1 && !needsStorage && !needsTokens) {
    status = 'COMPLETE';
    score = 90 + Math.min(10, importantMet * 2);
  } else if (criticalRatio === 1) {
    status = 'COOKIES_COMPLETE';
    score = 70 + Math.min(20, importantMet * 3);
  } else if (criticalRatio >= 0.5) {
    status = 'PARTIAL';
    score = Math.round(criticalRatio * 60);
  } else {
    status = 'INSUFFICIENT';
    score = Math.round(criticalRatio * 30);
  }

  const expiredCookies = cookies.filter(c => {
    if (c.expires && c.expires > 0) {
      return new Date(c.expires * 1000) < new Date();
    }
    return false;
  });
  if (expiredCookies.length > 0 && expiredCookies.length === cookies.length) {
    status = 'EXPIRED';
    score = 0;
  }

  return {
    status,
    score,
    platform,
    authType: requirements.authType,
    missing,
    present,
    needsStorage,
    needsTokens,
    storageKeys: requirements.localStorage,
    tokenHeaders: requirements.tokens,
    details: status === 'COMPLETE' ? 'All session components present'
      : status === 'COOKIES_COMPLETE' ? `Cookies OK but needs ${needsStorage ? 'storage data' : ''}${needsStorage && needsTokens ? ' and ' : ''}${needsTokens ? 'auth tokens' : ''}`
      : status === 'PARTIAL' ? `Missing ${missing.filter(m => m.level === 'critical').length} critical cookie(s)`
      : status === 'EXPIRED' ? 'All cookies are expired'
      : `Missing ${missing.filter(m => m.level === 'critical').length} critical session components`,
  };
}

export function detectRequiredSessionComponents(cookies) {
  const platform = detectPlatformFromCookies(cookies)?.platform;
  if (!platform) return null;

  const requirements = PLATFORM_SESSION_REQUIREMENTS[platform];
  if (!requirements) return null;

  return {
    platform,
    authType: requirements.authType,
    cookiesOnly: requirements.authType === 'cookie',
    needsFullSession: requirements.authType === 'cookie_plus_token',
    required: {
      cookies: requirements.critical,
      localStorage: requirements.localStorage,
      sessionStorage: requirements.sessionStorage,
      headers: requirements.tokens,
    },
    optional: {
      cookies: requirements.important,
    },
  };
}
