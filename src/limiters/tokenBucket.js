'use strict';

/**
 * Token Bucket — бакет пополняется со скоростью capacity/windowSec токенов в секунду.
 * Допускает короткие всплески до capacity, держит средний темп.
 */
async function tokenBucket(store, key, capacity, windowSec) {
  const refillPerSec = capacity / windowSec;
  const ttlMs = windowSec * 1000 * 2; // простаивающие бакеты живут пару окон и удаляются
  const { allowed, tokens, ttlMs: waitMs } = await store.tokenBucket(key, capacity, refillPerSec, Date.now(), ttlMs);
  return {
    allowed,
    limit: capacity,
    current: capacity - Math.floor(tokens),
    remaining: Math.floor(tokens),
    resetIn: Math.max(1, Math.ceil(waitMs / 1000)),
    resetMs: waitMs, // до следующего токена (0, если запрос принят)
    tokens, // точное число токенов после запроса (дробное)
  };
}

module.exports = tokenBucket;
