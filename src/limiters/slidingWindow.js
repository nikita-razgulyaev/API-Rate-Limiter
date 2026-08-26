'use strict';

/**
 * Sliding Window: a rolling log of timestamps (Redis sorted set).
 * No boundary burst issue, smooth distribution, but costs more memory
 * (one entry per request within the window) than Fixed Window.
 */
async function slidingWindow(store, key, limit, windowSec) {
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const { count, ttlMs } = await store.slidingCount(key, now, windowMs);

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

module.exports = slidingWindow;
