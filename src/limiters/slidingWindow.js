'use strict';

/**
 * Sliding Window — скользящий журнал таймстампов (sorted set).
 * Нет всплеска на границе окон; дороже по памяти. Отклонённые запросы не засчитываются.
 */
async function slidingWindow(store, key, limit, windowSec) {
  const { allowed, count, ttlMs } = await store.slidingCount(key, limit, windowSec * 1000, Date.now());
  return {
    allowed,
    limit,
    current: count,
    remaining: Math.max(0, limit - count),
    resetIn: Math.max(1, Math.ceil(ttlMs / 1000)),
    resetMs: ttlMs, // через сколько мс освободится ближайший слот
  };
}

module.exports = slidingWindow;
