import { PlatformAdapter } from './base.js';

export const spotifyAdapter = new PlatformAdapter({
  platformName: 'Spotify',
  domain: '.spotify.com',
  loginUrl: 'https://accounts.spotify.com/login',
  dashboardUrl: 'https://open.spotify.com/',

  requiredCookies: ['sp_dc', 'sp_key'],
  optionalCookies: ['sp_t', 'sp_landing', 'sp_gaid', 'sp_new'],

  requiredLocalStorage: [
    { key: 'sp_last_login_ts', description: 'Last login timestamp' },
  ],
  requiredSessionStorage: [],

  requiredHeaders: {
    'Authorization': 'Bearer access token from sp_dc exchange',
  },

  verifyEndpoint: 'https://api.spotify.com/v1/me',
  verifyMethod: 'GET',
  verifyHeaders: {
    'Accept': 'application/json',
  },
  verifySuccessIndicators: ['display_name', 'id', 'product'],
  verifyFailIndicators: ['error', 'Unauthorized', 'invalid_token'],

  successSelectors: [
    '.Root__nav-bar',
    '[data-testid="user-widget-link"]',
    '.user-widget',
    '[data-testid="home-page"]',
    '[data-testid="user-widget-name"]',
  ],
  failSelectors: [
    '[data-testid="login-button"]',
    '#login-username',
    '#login-password',
  ],
  failUrlPatterns: ['/login'],

  injectionStrategy: 'cookie_plus_token',
  authType: 'cookie_plus_token',

  tokenExtractor: {
    tokenSource: 'api',
    tokenEndpoint: 'https://open.spotify.com/get_access_token',
    tokenField: 'accessToken',
    refreshMethod: 'cookie_exchange',
  },

  sessionReconstructionSteps: [
    {
      type: 'api_call',
      description: 'Exchange sp_dc cookie for access token',
      url: 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      method: 'GET',
      extractField: 'accessToken',
      storeAs: 'spotifyAccessToken',
    },
  ],
});
