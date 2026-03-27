import { PlatformAdapter } from './base.js';

export const courseraAdapter = new PlatformAdapter({
  platformName: 'Coursera',
  domain: '.coursera.org',
  loginUrl: 'https://www.coursera.org/?authMode=login',
  dashboardUrl: 'https://www.coursera.org/',

  requiredCookies: ['CAUTH', 'CSRF3-Token'],
  optionalCookies: ['__204u', 'maestro_login_flag', 'CSRF3-Token-plain'],

  requiredLocalStorage: [
    { key: 'persist:root', description: 'Redux state with auth tokens' },
    { key: 'jwtToken', description: 'JWT bearer token for API calls' },
  ],
  requiredSessionStorage: [],

  requiredHeaders: {
    'X-CSRF3-Token': 'CSRF protection token (extracted from CSRF3-Token cookie)',
    'Authorization': 'Bearer JWT token for GraphQL API',
  },

  verifyEndpoint: 'https://www.coursera.org/api/adminUserPermissions.v1?q=my',
  verifyMethod: 'GET',
  verifyHeaders: {
    'Accept': 'application/json',
  },
  verifySuccessIndicators: ['elements', 'ppiData', 'userId'],
  verifyFailIndicators: ['errorCode', 'Unauthorized', 'LoginRequired'],

  successSelectors: [
    '[data-e2e="header-user-dropdown"]',
    '.c-ph-avatar',
    '[data-testid="header-profile-avatar"]',
    '[data-e2e="header-user-menu"]',
  ],
  failSelectors: [
    '[data-e2e="header-login-button"]',
    '#email',
    '[data-e2e="login-form"]',
  ],
  failUrlPatterns: ['/login', '/?authMode=login'],

  injectionStrategy: 'full_session',
  authType: 'cookie_plus_token',

  tokenExtractor: {
    jwtSource: 'cookie:CAUTH',
    csrfSource: 'cookie:CSRF3-Token',
    extractMethod: 'parse_jwt_from_cauth',
  },

  sessionReconstructionSteps: [
    {
      type: 'extract_token',
      source: 'cookie',
      cookieName: 'CSRF3-Token',
      target: 'header',
      headerName: 'X-CSRF3-Token',
    },
    {
      type: 'execute_script',
      description: 'Set Coursera auth state in localStorage',
      script: 'coursera_reconstruct_session',
    },
  ],
});
