import { PlatformAdapter } from './base.js';

export const canvaAdapter = new PlatformAdapter({
  platformName: 'Canva',
  domain: '.canva.com',
  loginUrl: 'https://www.canva.com/login',
  dashboardUrl: 'https://www.canva.com/',

  requiredCookies: ['canva_session', 'csrf'],
  optionalCookies: ['canvasession', 'CAN_SESS', 'locale'],

  requiredLocalStorage: [],
  requiredSessionStorage: [],
  requiredHeaders: {
    'X-CSRF-Token': 'CSRF token from csrf cookie',
  },

  verifyEndpoint: 'https://www.canva.com/api/user/me',
  verifyMethod: 'GET',
  verifyHeaders: { 'Accept': 'application/json' },
  verifySuccessIndicators: ['user', 'email', 'displayName'],
  verifyFailIndicators: ['error', 'unauthorized', 'login'],

  successSelectors: [
    '[data-testid="header-account-button"]',
    '.UmBLm',
    '._3bOaQ',
  ],
  failSelectors: [
    '[data-testid="login-button"]',
    '[data-testid="login-email-input"]',
  ],
  failUrlPatterns: ['/login'],

  injectionStrategy: 'cookies_only',
  authType: 'cookie',
});
