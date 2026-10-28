'use strict';

const { resolveAlgorithm } = require('../limiters');
const { normalizeIp } = require('../core/identity');
const { enforce, setRateLimitHeaders, sendBlocked } = require('../core/enforce');
const { validateLimits } = require('../config/rules');

/**
 * Express-middleware для встраивания в своё Node-приложение.
 *
 *   const { createStore, rateLimit } = require('rateshield');
 *   const store = createStore({ url: process.env.REDIS_URL });
 *   app.set('trust proxy', 1);                      // если стоите за nginx/Caddy/балансировщиком
 *   app.use('/api', rateLimit(store, { algorithm: 'token', limit: 100, windowSec: 60 }));
 *
 * Опции: algorithm (fixed|sliding|token), limit, windowSec, keyGenerator(req),
 *        prefix, failMode (open|closed), skip(req).
 */
function rateLimit(store, options = {}) {
  const algo = resolveAlgorithm(options.algorithm || 'token');
  const { limit, windowSec } = validateLimits({
    limit: options.limit ?? 60,
    windowSec: options.windowSec ?? options.window ?? 60,
  }, 'rateLimit()');
  const prefix = options.prefix || 'rs';
  const failMode = options.failMode || 'open';
  const keyGenerator = options.keyGenerator || ((req) => normalizeIp(req.ip));

  return async function rateLimitMiddleware(req, res, next) {
    try {
      if (options.skip && options.skip(req)) return next();
      const id = await keyGenerator(req);
      const r = await enforce(store, {
        algorithm: algo.id,
        key: `${prefix}:mw:${algo.id}:${id}`,
        limit,
        windowSec,
        failMode,
        source: 'middleware',
      });
      if (!r.allowed) return sendBlocked(res, r);
      setRateLimitHeaders(res, r);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = rateLimit;
