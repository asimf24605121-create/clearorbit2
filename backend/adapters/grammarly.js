import { PlatformAdapter } from './base.js';

export const grammarlyAdapter = new PlatformAdapter({
  platformName: 'Grammarly',
  domain: '.grammarly.com',
  loginUrl: 'https://www.grammarly.com/signin',
  dashboardUrl: 'https://app.grammarly.com/',

  requiredCookies: ['grauth', 'csrf-token'],
  optionalCookies: ['gnar_containerId', 'funnelType', 'experiment_groups'],

  requiredLocalStorage: [
    { key: 'grammarly_user_id', description: 'User ID for client-side auth state' },
  ],
  requiredSessionStorage: [],

  requiredHeaders: {
    'X-CSRF-Token': 'CSRF token from csrf-token cookie',
    'X-Client-Type': 'Client type identifier (funnel)',
  },

  verifyEndpoint: 'https://app.grammarly.com/api/auth/v2/user',
  verifyMethod: 'GET',
  verifyHeaders: { 'Accept': 'application/json' },
  verifySuccessIndicators: ['id', 'email', 'premium'],
  verifyFailIndicators: ['error', 'unauthorized', 'loginRequired'],

  successSelectors: [
    '[data-aid="sidebar-main"]',
    '.sidebar_user_info',
    '.user-avatar',
  ],
  failSelectors: [
    '[data-aid="login-button"]',
    '[data-aid="signin-form"]',
  ],
  failUrlPatterns: ['/signin'],

  injectionStrategy: 'full_session',
  authType: 'cookie_plus_token',
});
