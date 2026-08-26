'use strict';

/**
 * Token Bucket: a bucket refills continuously at `capacity / windowSec`
 * tokens/sec, up to `capacity`. Every request costs 1 token.
 * Allows short bursts (up to full capacity instantly) while still
 * enforcing the average rate over time — the algorithm most APIs
 * (Stripe, GitHub, AWS) use in production.
 */
async function tokenBucket(store, key, capacity, windowSec) {
  const refillPerSec = capacity / windowSec;
  const now = Date.now();
  const ttlMs = windowSec * 1000 * 2; // keep idle buckets around a couple windows, then let them expire

  const { allowed, tokens, ttlMs: resetMs } = await store.tokenBucket(key, capacity, refillPerSec, now, ttlMs);

  return {
    allowed,
    limit: capacity,
    current: capacity - Math.floor(tokens),
    remaining: Math.floor(tokens),
    resetIn: Math.ceil(resetMs / 1000) || 1,
  };
}

module.exports = tokenBucket;
