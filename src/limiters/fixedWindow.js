'use strict';

/**
 * Fixed Window: a simple counter per time bucket.
 * Cheapest algorithm, but allows up to 2x the limit at window boundaries
 * (burst at the edge of two adjacent windows).
 */
async function fixedWindow(store, key, limit, windowSec) {
  const windowMs = windowSec * 1000;
  const { count, ttlMs } = await store.incrExpire(key, windowMs);

  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);

  return {
    allowed,
    limit,
    current: count,
    remaining,
    resetIn: Math.ceil(ttlMs / 1000),
  };
}

module.exports = fixedWindow;
