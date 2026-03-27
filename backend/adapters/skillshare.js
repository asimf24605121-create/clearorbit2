import { PlatformAdapter } from './base.js';

export const skillshareAdapter = new PlatformAdapter({
  platformName: 'Skillshare',
  domain: '.skillshare.com',
  loginUrl: 'https://www.skillshare.com/login',
  dashboardUrl: 'https://www.skillshare.com/',

  requiredCookies: ['skillshare_session'],
  optionalCookies: ['XSRF-TOKEN', 'bc_pbl_co'],

  requiredLocalStorage: [],
  requiredSessionStorage: [],
  requiredHeaders: {},

  verifyEndpoint: null,
  successSelectors: [
    '.user-avatar',
    '.header-profile',
    '.authenticated',
  ],
  failSelectors: [
    '.login-form',
    '[href="/login"]',
  ],
  failUrlPatterns: ['/login', '/signup'],

  injectionStrategy: 'cookies_only',
  authType: 'cookie',
});
