class MemCache {
  constructor(options = {}) {
    this.store = new Map();
    this.defaultTTL = options.defaultTTL || 60000;
    this.maxSize = options.maxSize || 500;
    this.hits = 0;
    this.misses = 0;

    setInterval(() => this._sweep(), 30000);
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    entry.lastAccess = Date.now();
    return entry.value;
  }

  set(key, value, ttl) {
    if (this.store.size >= this.maxSize) this._evict();
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl || this.defaultTTL),
      lastAccess: Date.now(),
      createdAt: Date.now(),
    });
  }

  invalidate(key) {
    return this.store.delete(key);
  }

  invalidatePattern(pattern) {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  clear() {
    const size = this.store.size;
    this.store.clear();
    return size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
    };
  }

  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  _evict() {
    let oldest = null, oldestKey = null;
    for (const [key, entry] of this.store) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry;
        oldestKey = key;
      }
    }
    if (oldestKey) this.store.delete(oldestKey);
  }
}

export const accountCache = new MemCache({ defaultTTL: 30000, maxSize: 200 });
export const intelligenceCache = new MemCache({ defaultTTL: 60000, maxSize: 50 });
export const platformCache = new MemCache({ defaultTTL: 120000, maxSize: 100 });

export function invalidateAccountCaches() {
  accountCache.invalidatePattern('accounts:');
  intelligenceCache.invalidatePattern('intel:');
  platformCache.invalidatePattern('platform:');
}

export function getCacheStats() {
  return {
    accounts: accountCache.stats(),
    intelligence: intelligenceCache.stats(),
    platform: platformCache.stats(),
  };
}
