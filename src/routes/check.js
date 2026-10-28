'use strict';

const express = require('express');
const { resolveAlgorithm } = require('../limiters');
const { enforce, setRateLimitHeaders } = require('../core/enforce');
const { validateLimits } = require('../config/rules');

/**
 * POST /_rateshield/v1/check  (Authorization: Bearer <ADMIN_TOKEN>)
 * Язык-независимый API решений: ваш бэкенд (Python, PHP, Go, Java...) спрашивает,
 * можно ли пропустить запрос, и сам решает, что отвечать клиенту.
 *
 * body: { key: "user:42", rule?: "login", algorithm?, limit?, windowSec? }
 * 200:  { allowed, limit, remaining, resetIn, retryAfter, algorithm, degraded }
 */
function buildCheckRouter({ config, store, rules }) {
  const router = express.Router();

  router.post('/v1/check', express.json({ limit: '4kb' }), async (req, res) => {
    const b = req.body || {};
    if (typeof b.key !== 'string' || !b.key.length || b.key.length > 256) {
      return res.status(400).json({ error: '"key" must be a non-empty string up to 256 chars' });
    }

    let base = rules.fallback;
    if (b.rule !== undefined) {
      base = rules.byName(String(b.rule));
      if (!base || base.skip) return res.status(400).json({ error: `Unknown rule "${b.rule}"` });
    }

    let algo; let limits;
    try {
      algo = resolveAlgorithm(b.algorithm || base.algorithm.id);
      limits = validateLimits({ limit: b.limit ?? base.limit, windowSec: b.windowSec ?? base.windowSec }, 'check');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const r = await enforce(store, {
      algorithm: algo.id,
      key: `${config.keyPrefix}:check:${base.name}:${algo.id}:${b.key}`,
      ...limits,
      failMode: config.failMode,
      source: 'check',
    });

    if (r.unavailable) return res.status(503).json({ error: 'Rate limiter unavailable', retryAfter: r.resetIn });
    setRateLimitHeaders(res, r);
    return res.json({
      allowed: r.allowed,
      limit: r.limit,
      remaining: r.remaining,
      resetIn: r.resetIn,
      retryAfter: r.allowed ? 0 : r.resetIn,
      algorithm: r.algorithm,
      degraded: r.degraded,
    });
  });

  return router;
}

module.exports = buildCheckRouter;
