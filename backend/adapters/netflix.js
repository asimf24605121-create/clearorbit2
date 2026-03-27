import { PlatformAdapter } from './base.js';

export const netflixAdapter = new PlatformAdapter({
  platformName: 'Netflix',
  domain: '.netflix.com',
  loginUrl: 'https://www.netflix.com/login',
  dashboardUrl: 'https://www.netflix.com/browse',

  requiredCookies: ['NetflixId', 'SecureNetflixId'],
  optionalCookies: ['nfvdid', 'memclid', 'flwssn', 'profilesNewSession', 'lhpuuidh-browse-'],

  requiredLocalStorage: [],
  requiredSessionStorage: [],
  requiredHeaders: {},

  verifyEndpoint: 'https://www.netflix.com/api/shakti/mre/pathEvaluator?withSize=true&materialize=true',
  verifyMethod: 'GET',
  verifyHeaders: {
    'Accept': 'application/json',
  },
  verifySuccessIndicators: ['profiles', 'memberIDP', 'value'],
  verifyFailIndicators: ['errorCode', 'login', 'redirectUrl'],

  successSelectors: [
    '.profile-icon',
    '[data-uia="profile-link"]',
    '.avatar-wrapper',
    '.account-menu-item',
    '[aria-label="Account"]',
    '[data-uia="browse-title-card"]',
  ],
  failSelectors: [
    '[data-uia="login-page-container"]',
    '.login-form',
    '[data-uia="login-submit-button"]',
  ],
  failUrlPatterns: ['/login', '/Login', '/LoginHelp'],

  injectionStrategy: 'cookies_only',
  authType: 'cookie',
});
