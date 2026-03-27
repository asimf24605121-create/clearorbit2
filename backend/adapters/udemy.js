import { PlatformAdapter } from './base.js';

export const udemyAdapter = new PlatformAdapter({
  platformName: 'Udemy',
  domain: '.udemy.com',
  loginUrl: 'https://www.udemy.com/join/login-popup/',
  dashboardUrl: 'https://www.udemy.com/',

  requiredCookies: ['access_token', 'client_id'],
  optionalCookies: ['ud_cache_user', 'csrftoken', 'dj_session_id'],

  requiredLocalStorage: [
    { key: 'ud_firstvisit', description: 'First visit flag' },
  ],
  requiredSessionStorage: [],

  requiredHeaders: {
    'Authorization': 'Bearer access_token cookie value',
    'X-Udemy-Authorization': 'Bearer access_token cookie value',
  },

  verifyEndpoint: 'https://www.udemy.com/api-2.0/users/me/',
  verifyMethod: 'GET',
  verifyHeaders: { 'Accept': 'application/json' },
  verifySuccessIndicators: ['title', 'name', 'email', 'id'],
  verifyFailIndicators: ['detail', 'Authentication credentials', 'NotAuthenticated'],

  successSelectors: [
    '.ud-header--instructor',
    '[data-purpose="header-profile"]',
    '.header--gap-button--',
  ],
  failSelectors: [
    '[data-purpose="header-login"]',
    '[name="email"]',
  ],
  failUrlPatterns: ['/join/login-popup'],

  injectionStrategy: 'cookie_plus_token',
  authType: 'cookie_plus_token',

  tokenExtractor: {
    tokenSource: 'cookie',
    cookieName: 'access_token',
    headerFormat: 'Bearer {value}',
  },
});
