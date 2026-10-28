'use strict';

/**
 * Fixed Window — счётчик на временное окно.
 * Дешевле всех, но на стыке окон допускает до 2x лимита.
 */
async function fixedWindow(store, key, limit, windowSec) {
  const { count, ttlMs } = await store.incrExpire(key, windowSec * 1000);
  return {
    allowed: count <= limit,
    limit,
    current: count,
    remaining: Math.max(0, limit - count),
    resetIn: Math.max(1, Math.ceil(ttlMs / 1000)),
    resetMs: ttlMs, // сколько мс осталось до обнуления окна
  };
}

module.exports = fixedWindow;
