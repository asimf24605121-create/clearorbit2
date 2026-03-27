import { PlatformAdapter } from './base.js';

export const chatgptAdapter = new PlatformAdapter({
  platformName: 'ChatGPT',
  domain: '.openai.com',
  loginUrl: 'https://chat.openai.com/auth/login',
  dashboardUrl: 'https://chat.openai.com/',

  requiredCookies: ['__Secure-next-auth.session-token'],
  optionalCookies: ['cf_clearance', '__cf_bm', '__Secure-next-auth.callback-url', '_cfuvid'],

  requiredLocalStorage: [
    { key: 'oai/apps/hasSeenOnboarding/chat', description: 'Onboarding flag' },
    { key: 'oai-did', description: 'Device ID for request fingerprinting' },
  ],
  requiredSessionStorage: [],

  requiredHeaders: {
    'Authorization': 'Bearer access token from session API',
  },

  verifyEndpoint: 'https://chat.openai.com/api/auth/session',
  verifyMethod: 'GET',
  verifyHeaders: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  verifySuccessIndicators: ['user', 'accessToken', 'expires'],
  verifyFailIndicators: ['error', 'unauthenticated', 'redirect'],

  successSelectors: [
    '[data-testid="profile-button"]',
    '#prompt-textarea',
    '[id="prompt-textarea"]',
    'nav',
    '.text-token-text-primary',
  ],
  failSelectors: [
    '[data-testid="login-button"]',
    '.auth0-lock',
    '[data-testid="auth-page"]',
  ],
  failUrlPatterns: ['/auth/login'],

  injectionStrategy: 'full_session',
  authType: 'cookie_plus_token',

  tokenExtractor: {
    tokenSource: 'api',
    tokenEndpoint: 'https://chat.openai.com/api/auth/session',
    tokenField: 'accessToken',
    refreshMethod: 'session_cookie',
  },

  sessionReconstructionSteps: [
    {
      type: 'api_call',
      description: 'Fetch session to get access token from session cookie',
      url: 'https://chat.openai.com/api/auth/session',
      method: 'GET',
      extractField: 'accessToken',
      storeAs: 'openaiAccessToken',
    },
    {
      type: 'execute_script',
      description: 'Initialize device ID in localStorage',
      script: 'chatgpt_init_device_id',
    },
  ],
});
