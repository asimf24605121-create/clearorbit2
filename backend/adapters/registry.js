import { netflixAdapter } from './netflix.js';
import { spotifyAdapter } from './spotify.js';
import { courseraAdapter } from './coursera.js';
import { chatgptAdapter } from './chatgpt.js';
import { canvaAdapter } from './canva.js';
import { udemyAdapter } from './udemy.js';
import { grammarlyAdapter } from './grammarly.js';
import { skillshareAdapter } from './skillshare.js';

const adapters = new Map();

function register(adapter) {
  adapters.set(adapter.platformName.toLowerCase(), adapter);
  const domainKey = adapter.domain.replace(/^\./, '').toLowerCase();
  adapters.set(domainKey, adapter);
}

register(netflixAdapter);
register(spotifyAdapter);
register(courseraAdapter);
register(chatgptAdapter);
register(canvaAdapter);
register(udemyAdapter);
register(grammarlyAdapter);
register(skillshareAdapter);

export function getAdapter(platformNameOrDomain) {
  if (!platformNameOrDomain) return null;
  const key = platformNameOrDomain.replace(/^\./, '').toLowerCase();
  return adapters.get(key) || null;
}

export function getAllAdapters() {
  const unique = new Map();
  for (const [, adapter] of adapters) {
    unique.set(adapter.platformName, adapter);
  }
  return Array.from(unique.values());
}

export function getAdapterByDomain(domain) {
  if (!domain) return null;
  const clean = domain.replace(/^\./, '').toLowerCase();
  for (const [, adapter] of adapters) {
    const adapterDomain = adapter.domain.replace(/^\./, '').toLowerCase();
    if (clean === adapterDomain || clean.endsWith('.' + adapterDomain) || adapterDomain.endsWith('.' + clean)) {
      return adapter;
    }
  }
  return null;
}

export function checkSessionCompleteness(platformNameOrDomain, sessionData) {
  const adapter = getAdapter(platformNameOrDomain);
  if (!adapter) {
    return {
      complete: false,
      score: 0,
      missing: [],
      present: [],
      warnings: ['No adapter found for platform: ' + platformNameOrDomain],
      components: { cookies: 'unknown', localStorage: 'unknown', sessionStorage: 'unknown', tokens: 'unknown' },
    };
  }
  return adapter.checkSessionCompleteness(sessionData);
}

export function getInjectionPlan(platformNameOrDomain, sessionData) {
  const adapter = getAdapter(platformNameOrDomain);
  if (!adapter) return null;
  return adapter.getInjectionPlan(sessionData);
}

export function detectMissingComponents(platformNameOrDomain, cookies) {
  const adapter = getAdapter(platformNameOrDomain);
  if (!adapter) return { platform: platformNameOrDomain, adapter: false, analysis: null };

  const sessionData = { cookies, localStorage: {}, sessionStorage: {}, tokens: {} };
  const completeness = adapter.checkSessionCompleteness(sessionData);

  return {
    platform: adapter.platformName,
    adapter: true,
    authType: adapter.authType,
    injectionStrategy: adapter.injectionStrategy,
    analysis: completeness,
    recommendation: completeness.complete ? 'ready' :
      adapter.injectionStrategy === 'cookies_only' ? 'missing_cookies' :
      'needs_full_session',
  };
}
