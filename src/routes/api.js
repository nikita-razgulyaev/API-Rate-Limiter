'use strict';

const express = require('express');
const fixedWindow = require('../limiters/fixedWindow');
const slidingWindow = require('../limiters/slidingWindow');
const tokenBucket = require('../limiters/tokenBucket');
const { resolveClientId } = require('../middleware/clientId');
const stats = require('../store/stats');

const DEFAULT_LIMIT = parseInt(process.env.RATE_LIMIT, 10) || 5;
const DEFAULT_WINDOW = parseInt(process.env.RATE_WINDOW, 10) || 60;

const LIMITERS = {
  fixed: { fn: fixedWindow, name: 'fixed-window' },
  sliding: { fn: slidingWindow, name: 'sliding-window' },
  token: { fn: tokenBucket, name: 'token-bucket' },
};

function buildRouter(store) {
  const router = express.Router();

  function makeHandler(algoKey) {
    const { fn, name } = LIMITERS[algoKey];

    return async (req, res) => {
      const clientId = resolveClientId(req);

      // The playground sliders control limit/window directly — this is an
      // open demo, not a metered product, so anyone can experiment freely.
      const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
      const windowSec = req.query.window ? Math.max(1, parseInt(req.query.window, 10) || DEFAULT_WINDOW) : DEFAULT_WINDOW;

      const key = `rate:${name}:${clientId}:${limit}:${windowSec}`;

      try {
        const result = await fn(store, key, limit, windowSec);
        stats.record({ algorithm: name, allowed: result.allowed });

        res.set({
          'X-RateLimit-Limit': result.limit,
          'X-RateLimit-Remaining': result.remaining,
          'X-RateLimit-Reset': result.resetIn,
          'X-RateLimit-Algorithm': name,
        });

        if (!result.allowed) {
          return res.status(429).json({
            error: 'Too Many Requests',
            algorithm: name,
            retryAfter: result.resetIn,
          });
        }

        return res.status(200).json({
          message: '✅ Запрос принят!',
          algorithm: name,
          requestsMade: result.current,
          remaining: result.remaining,
          resetInSeconds: result.resetIn,
        });
      } catch (err) {
        stats.recordError();
        return res.status(500).json({ error: err.message });
      }
    };
  }

  router.get('/fixed', makeHandler('fixed'));
  router.get('/sliding', makeHandler('sliding'));
  router.get('/token', makeHandler('token'));

  router.get('/status', async (req, res) => {
    try {
      const pong = await store.ping();
      res.json({
        store: store.mode,
        redis: store.mode === 'redis' ? (pong === 'PONG' ? 'connected' : 'error') : 'n/a (in-memory demo mode)',
        url: process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:[^:@/]*@/, ':***@') : 'not set',
      });
    } catch (err) {
      res.status(500).json({ store: store.mode, redis: 'error', message: err.message });
    }
  });

  router.get('/api/stats', (req, res) => {
    res.json(stats.snapshot());
  });

  return router;
}

module.exports = buildRouter;
