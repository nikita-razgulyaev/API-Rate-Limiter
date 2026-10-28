'use strict';

const { resolveAlgorithm } = require('../limiters');
const stats = require('../store/stats');
const { warnOnce, resolveWarn } = require('../utils/logger');

/**
 * Единая точка принятия решения: прогоняет алгоритм и обрабатывает сбой хранилища
 * согласно failMode:
 *   open   — при сбое Redis пропускаем запросы (доступность важнее строгости), degraded=true
 *   closed — при сбое отвечаем 503 (строгость важнее доступности), unavailable=true
 */
async function enforce(store, { algorithm, key, limit, windowSec, failMode = 'open', source }) {
  const algo = resolveAlgorithm(algorithm);
  try {
    const r = await algo.fn(store, key, limit, windowSec);
    stats.record({ algorithm: algo.name, allowed: r.allowed, source });
    resolveWarn('limiter-error');
    return { ...r, algorithm: algo.name, degraded: false, unavailable: false };
  } catch (err) {
    stats.recordError();
    warnOnce('limiter-error', 'Rate limiter store error', { error: err.message, failMode });
    if (failMode === 'closed') {
      return { allowed: false, limit, remaining: 0, resetIn: 5, algorithm: algo.name, degraded: true, unavailable: true };
    }
    return { allowed: true, limit, remaining: limit, resetIn: 0, algorithm: algo.name, degraded: true, unavailable: false };
  }
}

function setRateLimitHeaders(res, r) {
  res.setHeader('X-RateLimit-Limit', r.limit);
  res.setHeader('X-RateLimit-Remaining', r.remaining);
  res.setHeader('X-RateLimit-Reset', r.resetIn);
  res.setHeader('X-RateLimit-Algorithm', r.algorithm);
  if (r.degraded) res.setHeader('X-RateLimit-Degraded', '1');
  if (!r.allowed) res.setHeader('Retry-After', r.resetIn);
}

function sendBlocked(res, r) {
  setRateLimitHeaders(res, r);
  if (r.unavailable) return res.status(503).json({ error: 'Rate limiter unavailable', retryAfter: r.resetIn });
  return res.status(429).json({ error: 'Too Many Requests', algorithm: r.algorithm, retryAfter: r.resetIn });
}

module.exports = { enforce, setRateLimitHeaders, sendBlocked };
