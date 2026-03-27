export class PlatformAdapter {
  constructor(config) {
    this.platformName = config.platformName;
    this.domain = config.domain;
    this.loginUrl = config.loginUrl;
    this.dashboardUrl = config.dashboardUrl;

    this.requiredCookies = config.requiredCookies || [];
    this.optionalCookies = config.optionalCookies || [];
    this.requiredLocalStorage = config.requiredLocalStorage || [];
    this.requiredSessionStorage = config.requiredSessionStorage || [];
    this.requiredHeaders = config.requiredHeaders || {};

    this.verifyEndpoint = config.verifyEndpoint || null;
    this.verifyMethod = config.verifyMethod || 'GET';
    this.verifyHeaders = config.verifyHeaders || {};
    this.verifySuccessIndicators = config.verifySuccessIndicators || [];
    this.verifyFailIndicators = config.verifyFailIndicators || [];

    this.successSelectors = config.successSelectors || [];
    this.failSelectors = config.failSelectors || [];
    this.failUrlPatterns = config.failUrlPatterns || [];

    this.injectionStrategy = config.injectionStrategy || 'cookies_only';
    this.authType = config.authType || 'cookie';
    this.tokenExtractor = config.tokenExtractor || null;
    this.sessionReconstructionSteps = config.sessionReconstructionSteps || [];
  }

  getRequiredComponents() {
    return {
      cookies: this.requiredCookies,
      localStorage: this.requiredLocalStorage,
      sessionStorage: this.requiredSessionStorage,
      headers: this.requiredHeaders,
    };
  }

  checkSessionCompleteness(sessionData) {
    const result = {
      complete: true,
      missing: [],
      present: [],
      warnings: [],
      score: 0,
      components: { cookies: 'missing', localStorage: 'missing', sessionStorage: 'missing', tokens: 'missing' },
    };

    const cookieNames = (sessionData.cookies || []).map(c => (c.name || '').toLowerCase());
    let cookieScore = 0;
    for (const req of this.requiredCookies) {
      if (cookieNames.includes(req.toLowerCase())) {
        result.present.push({ type: 'cookie', name: req });
        cookieScore++;
      } else {
        result.missing.push({ type: 'cookie', name: req, critical: true });
        result.complete = false;
      }
    }
    for (const opt of this.optionalCookies) {
      if (cookieNames.includes(opt.toLowerCase())) {
        result.present.push({ type: 'cookie', name: opt, optional: true });
        cookieScore++;
      }
    }
    const totalCookies = this.requiredCookies.length + this.optionalCookies.length;
    result.components.cookies = totalCookies > 0 ? (cookieScore >= this.requiredCookies.length ? 'complete' : 'partial') : 'not_required';

    const ls = sessionData.localStorage || {};
    let lsScore = 0;
    for (const key of this.requiredLocalStorage) {
      const keyName = typeof key === 'object' ? key.key : key;
      if (ls[keyName]) {
        result.present.push({ type: 'localStorage', name: keyName });
        lsScore++;
      } else {
        result.missing.push({ type: 'localStorage', name: keyName, critical: true });
        result.complete = false;
      }
    }
    result.components.localStorage = this.requiredLocalStorage.length > 0
      ? (lsScore >= this.requiredLocalStorage.length ? 'complete' : 'partial')
      : 'not_required';

    const ss = sessionData.sessionStorage || {};
    let ssScore = 0;
    for (const key of this.requiredSessionStorage) {
      const keyName = typeof key === 'object' ? key.key : key;
      if (ss[keyName]) {
        result.present.push({ type: 'sessionStorage', name: keyName });
        ssScore++;
      } else {
        result.missing.push({ type: 'sessionStorage', name: keyName, critical: true });
        result.complete = false;
      }
    }
    result.components.sessionStorage = this.requiredSessionStorage.length > 0
      ? (ssScore >= this.requiredSessionStorage.length ? 'complete' : 'partial')
      : 'not_required';

    const tokens = sessionData.tokens || {};
    let tokenScore = 0;
    const tokenKeys = Object.keys(this.requiredHeaders);
    const tokensAreRequired = this.authType === 'cookie_plus_token' || this.injectionStrategy === 'full_session';
    for (const header of tokenKeys) {
      if (tokens[header]) {
        result.present.push({ type: 'token', name: header });
        tokenScore++;
      } else {
        result.missing.push({ type: 'token', name: header, critical: tokensAreRequired });
        if (tokensAreRequired) {
          result.complete = false;
        }
        result.warnings.push(`Missing auth header: ${header}`);
      }
    }
    result.components.tokens = tokenKeys.length > 0
      ? (tokenScore >= tokenKeys.length ? 'complete' : 'partial')
      : 'not_required';

    const tokenCount = tokensAreRequired ? tokenKeys.length : 0;
    const totalRequired = this.requiredCookies.length + this.requiredLocalStorage.length + this.requiredSessionStorage.length + tokenCount;
    const totalPresent = result.present.filter(p => !p.optional).length;
    result.score = totalRequired > 0 ? Math.round((totalPresent / totalRequired) * 100) : 100;

    if (sessionData.cookies) {
      for (const cookie of sessionData.cookies) {
        if (cookie.expires && cookie.expires > 0) {
          const expiryDate = new Date(cookie.expires * 1000);
          if (expiryDate < new Date()) {
            result.warnings.push(`Cookie "${cookie.name}" is expired`);
            result.complete = false;
          } else {
            const hoursUntilExpiry = (expiryDate - new Date()) / 3600000;
            if (hoursUntilExpiry < 24) {
              result.warnings.push(`Cookie "${cookie.name}" expires in ${Math.round(hoursUntilExpiry)}h`);
            }
          }
        }
      }
    }

    return result;
  }

  getInjectionPlan(sessionData) {
    const plan = {
      strategy: this.injectionStrategy,
      steps: [],
    };

    if (sessionData.cookies && sessionData.cookies.length > 0) {
      plan.steps.push({
        type: 'clear_cookies',
        domain: this.domain,
      });
      plan.steps.push({
        type: 'inject_cookies',
        cookies: sessionData.cookies,
        domain: this.domain,
      });
    }

    if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
      plan.steps.push({
        type: 'inject_localStorage',
        data: sessionData.localStorage,
        url: this.dashboardUrl || this.loginUrl,
      });
    }

    if (sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length > 0) {
      plan.steps.push({
        type: 'inject_sessionStorage',
        data: sessionData.sessionStorage,
        url: this.dashboardUrl || this.loginUrl,
      });
    }

    if (this.sessionReconstructionSteps.length > 0) {
      plan.steps.push(...this.sessionReconstructionSteps);
    }

    plan.steps.push({
      type: 'navigate',
      url: this.dashboardUrl || this.loginUrl,
    });

    plan.steps.push({
      type: 'verify',
      method: this.verifyEndpoint ? 'api' : 'dom',
      config: this.verifyEndpoint ? {
        endpoint: this.verifyEndpoint,
        method: this.verifyMethod,
        headers: this.verifyHeaders,
        successIndicators: this.verifySuccessIndicators,
        failIndicators: this.verifyFailIndicators,
      } : {
        successSelectors: this.successSelectors,
        failSelectors: this.failSelectors,
        failUrlPatterns: this.failUrlPatterns,
      },
    });

    return plan;
  }

  getVerificationConfig() {
    return {
      endpoint: this.verifyEndpoint,
      method: this.verifyMethod,
      headers: this.verifyHeaders,
      successIndicators: this.verifySuccessIndicators,
      failIndicators: this.verifyFailIndicators,
      successSelectors: this.successSelectors,
      failSelectors: this.failSelectors,
      failUrlPatterns: this.failUrlPatterns,
    };
  }

  toJSON() {
    return {
      platformName: this.platformName,
      domain: this.domain,
      authType: this.authType,
      injectionStrategy: this.injectionStrategy,
      requiredComponents: this.getRequiredComponents(),
      verifyEndpoint: this.verifyEndpoint,
    };
  }
}
