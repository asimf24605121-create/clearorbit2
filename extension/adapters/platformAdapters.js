const PLATFORM_ADAPTERS = {
  1: {
    name: 'Netflix',
    domain: '.netflix.com',
    strategy: 'cookies_only',
    authType: 'cookie',
    requiredCookies: ['NetflixId', 'SecureNetflixId'],
    verifyApi: null,
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },

  2: {
    name: 'Spotify',
    domain: '.spotify.com',
    strategy: 'cookie_plus_token',
    authType: 'cookie_plus_token',
    requiredCookies: ['sp_dc', 'sp_key'],
    verifyApi: {
      url: 'https://api.spotify.com/v1/me',
      method: 'GET',
      headers: {},
      successFields: ['display_name', 'id'],
      failFields: ['error'],
    },
    localStorage: {
      'sp_last_login_ts': () => String(Date.now()),
    },
    sessionStorage: {},
    reconstructionScripts: [
      {
        name: 'spotify_token_exchange',
        run: 'fetchAccessToken',
      },
    ],
  },

  3: {
    name: 'Disney+',
    domain: '.disneyplus.com',
    strategy: 'cookies_only',
    authType: 'cookie',
    requiredCookies: ['disney_token', 'dss_id'],
    verifyApi: null,
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },

  4: {
    name: 'ChatGPT',
    domain: '.openai.com',
    strategy: 'full_session',
    authType: 'cookie_plus_token',
    requiredCookies: ['__Secure-next-auth.session-token'],
    verifyApi: {
      url: 'https://chat.openai.com/api/auth/session',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      successFields: ['user', 'accessToken'],
      failFields: ['error'],
    },
    localStorage: {
      'oai/apps/hasSeenOnboarding/chat': () => JSON.stringify(true),
    },
    sessionStorage: {},
    reconstructionScripts: [
      {
        name: 'chatgpt_device_id',
        run: 'initDeviceId',
      },
      {
        name: 'chatgpt_session_init',
        run: 'fetchSessionToken',
      },
    ],
  },

  5: {
    name: 'Canva',
    domain: '.canva.com',
    strategy: 'cookies_only',
    authType: 'cookie',
    requiredCookies: ['canva_session'],
    verifyApi: null,
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },

  6: {
    name: 'Udemy',
    domain: '.udemy.com',
    strategy: 'cookie_plus_token',
    authType: 'cookie_plus_token',
    requiredCookies: ['access_token', 'client_id'],
    verifyApi: {
      url: 'https://www.udemy.com/api-2.0/users/me/',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      successFields: ['title', 'name'],
      failFields: ['detail'],
    },
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },

  7: {
    name: 'Coursera',
    domain: '.coursera.org',
    strategy: 'full_session',
    authType: 'cookie_plus_token',
    requiredCookies: ['CAUTH', 'CSRF3-Token'],
    verifyApi: {
      url: 'https://www.coursera.org/api/adminUserPermissions.v1?q=my',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      successFields: ['elements'],
      failFields: ['errorCode', 'Unauthorized'],
    },
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [
      {
        name: 'coursera_csrf_extract',
        run: 'extractCsrfToken',
      },
    ],
  },

  8: {
    name: 'Skillshare',
    domain: '.skillshare.com',
    strategy: 'cookies_only',
    authType: 'cookie',
    requiredCookies: ['skillshare_session'],
    verifyApi: null,
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },

  9: {
    name: 'Grammarly',
    domain: '.grammarly.com',
    strategy: 'full_session',
    authType: 'cookie_plus_token',
    requiredCookies: ['grauth', 'csrf-token'],
    verifyApi: null,
    localStorage: {},
    sessionStorage: {},
    reconstructionScripts: [],
  },
};

function getAdapterForPlatform(platformId) {
  return PLATFORM_ADAPTERS[platformId] || null;
}

function getAdapterByDomain(domain) {
  const clean = domain.replace(/^\./, '').toLowerCase();
  for (const [id, adapter] of Object.entries(PLATFORM_ADAPTERS)) {
    const adapterDomain = adapter.domain.replace(/^\./, '').toLowerCase();
    if (clean === adapterDomain || clean.endsWith('.' + adapterDomain)) {
      return { ...adapter, platformId: parseInt(id) };
    }
  }
  return null;
}

function checkRequiredCookies(platformId, cookieNames) {
  const adapter = PLATFORM_ADAPTERS[platformId];
  if (!adapter) return { known: false, complete: false, missing: [] };

  const lowerNames = cookieNames.map(n => n.toLowerCase());
  const missing = adapter.requiredCookies.filter(
    req => !lowerNames.includes(req.toLowerCase())
  );

  return {
    known: true,
    complete: missing.length === 0,
    missing,
    strategy: adapter.strategy,
    needsStorage: adapter.strategy !== 'cookies_only',
  };
}
