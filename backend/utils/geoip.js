import { prisma } from '../server.js';

const CACHE_HOURS = 72;
const REQUEST_TIMEOUT = 4000;

function isPrivateIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  let v4 = ip;
  if (v4.startsWith('::ffff:')) v4 = v4.substring(7);
  if (v4.startsWith('10.') || v4.startsWith('192.168.') || v4 === '0.0.0.0') return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (ip.startsWith('fc00:') || ip.startsWith('fd')) return true;
  return false;
}

function normalizeIP(ip) {
  if (!ip) return '';
  ip = ip.trim();
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

function makeLocalResult(ip) {
  return {
    ip,
    country: 'Local',
    countryCode: 'LO',
    region: 'Local',
    city: 'Local',
    isp: 'Local Network',
    lat: 0,
    lon: 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    status: 'local',
    cached: false,
  };
}

function makeUnknownResult(ip) {
  return {
    ip,
    country: 'Unknown',
    countryCode: '--',
    region: 'Unknown',
    city: 'Unknown',
    isp: 'Unknown',
    lat: 0,
    lon: 0,
    timezone: '',
    status: 'failed',
    cached: false,
  };
}

async function fetchWithTimeout(url, timeoutMs, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchFromPrimary(ip) {
  const url = `https://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,isp,lat,lon,timezone,proxy,hosting`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT);
  const data = await res.json();
  if (data.status !== 'success') return null;
  return {
    ip,
    country: data.country || 'Unknown',
    countryCode: data.countryCode || '--',
    region: data.regionName || 'Unknown',
    city: data.city || 'Unknown',
    isp: data.isp || 'Unknown',
    lat: data.lat || 0,
    lon: data.lon || 0,
    timezone: data.timezone || '',
    proxy: data.proxy ? 1 : 0,
    hosting: data.hosting ? 1 : 0,
    status: 'success',
    cached: false,
  };
}

async function fetchFromFallback(ip) {
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT);
  const data = await res.json();
  if (data.error) return null;
  return {
    ip,
    country: data.country_name || 'Unknown',
    countryCode: data.country_code || '--',
    region: data.region || 'Unknown',
    city: data.city || 'Unknown',
    isp: data.org || 'Unknown',
    lat: data.latitude || 0,
    lon: data.longitude || 0,
    timezone: data.timezone || '',
    proxy: 0,
    hosting: 0,
    status: 'success',
    cached: false,
  };
}

async function getFromCache(ip) {
  try {
    const cutoffMs = Date.now() - CACHE_HOURS * 3600000;
    const cached = await prisma.ipGeoCache.findUnique({ where: { ipAddress: ip } });
    if (!cached || !cached.lookedUpAt) return null;
    const cachedTime = new Date(cached.lookedUpAt.replace(' ', 'T')).getTime();
    if (isNaN(cachedTime) || cachedTime < cutoffMs) return null;
    return {
      ip,
      country: cached.country || 'Unknown',
      countryCode: cached.countryCode || '--',
      region: cached.region || 'Unknown',
      city: cached.city || 'Unknown',
      isp: cached.isp || 'Unknown',
      lat: cached.lat || 0,
      lon: cached.lon || 0,
      timezone: cached.timezone || '',
      proxy: cached.proxy || 0,
      hosting: cached.hosting || 0,
      status: 'success',
      cached: true,
    };
  } catch {
    return null;
  }
}

async function saveToCache(ip, data) {
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await prisma.ipGeoCache.upsert({
      where: { ipAddress: ip },
      update: {
        country: data.country, countryCode: data.countryCode,
        region: data.region, city: data.city, isp: data.isp,
        lat: data.lat, lon: data.lon, timezone: data.timezone,
        proxy: data.proxy || 0, hosting: data.hosting || 0,
        lookedUpAt: now,
      },
      create: {
        ipAddress: ip,
        country: data.country, countryCode: data.countryCode,
        region: data.region, city: data.city, isp: data.isp,
        lat: data.lat, lon: data.lon, timezone: data.timezone,
        proxy: data.proxy || 0, hosting: data.hosting || 0,
        lookedUpAt: now,
      },
    });
  } catch (err) {
    ;
  }
}

export async function lookupIP(rawIp) {
  const ip = normalizeIP(rawIp);
  if (!ip || isPrivateIP(ip)) return makeLocalResult(ip || rawIp);

  const cached = await getFromCache(ip);
  if (cached) return cached;

  try {
    const primary = await fetchFromPrimary(ip);
    if (primary) {
      saveToCache(ip, primary);
      return primary;
    }
  } catch (err) {
    ;
  }

  try {
    const fallback = await fetchFromFallback(ip);
    if (fallback) {
      saveToCache(ip, fallback);
      return fallback;
    }
  } catch (err) {
    ;
  }

  return makeUnknownResult(ip);
}

export async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const res = await fetchWithTimeout(url, 5000, { headers: { 'User-Agent': 'ClearOrbit/1.0' } });
    const data = await res.json();
    if (data.error) return null;

    const addr = data.address || {};
    return {
      address: data.display_name || '',
      city: addr.city || addr.town || addr.village || addr.suburb || '',
      region: addr.state || addr.county || '',
      country: addr.country || '',
      countryCode: addr.country_code?.toUpperCase() || '',
    };
  } catch (err) {
    ;
    return null;
  }
}

export function computeConfidence(ipGeo, deviceLocation) {
  if (deviceLocation && deviceLocation.deviceLat != null && deviceLocation.deviceLon != null) {
    if (deviceLocation.deviceAccuracy != null && deviceLocation.deviceAccuracy <= 100) {
      return 'high';
    }
    return 'medium';
  }
  if (ipGeo && ipGeo.status === 'success' && ipGeo.city && ipGeo.city !== 'Unknown') {
    return 'medium';
  }
  if (ipGeo && ipGeo.status === 'success' && ipGeo.country && ipGeo.country !== 'Unknown') {
    return 'low';
  }
  return 'none';
}
