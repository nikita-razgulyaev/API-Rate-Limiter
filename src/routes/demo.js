'use strict';

const express = require('express');
const { enforce, sendBlocked, setRateLimitHeaders } = require('../core/enforce');
const { normalizeIp } = require('../core/identity');
const stats = require('../store/stats');

const MAX_DEMO_LIMIT = 100;
const MAX_DEMO_WINDOW = 300;

function clampInt(v, def, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : def;
}

/** Публичные демо-эндпоинты: лимит/окно задаёт плейграунд (с потолком, чтобы не раздувать Redis). */
function buildDemoRouter({ config, store }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });

  const makeHandler = (algorithm) => async (req, res) => {
    const limit = clampInt(req.query.limit, config.defaults.limit, MAX_DEMO_LIMIT);
    const windowSec = clampInt(req.query.window, config.defaults.windowSec, MAX_DEMO_WINDOW);
    // sid — «сессия» плейграунда: новый sid = чистые счётчики (кнопка «Сбросить»), старые ключи истекают по TTL.
    const sid = String(req.query.sid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const r = await enforce(store, {
      algorithm,
      key: `${config.keyPrefix}:demo:${algorithm}:${normalizeIp(req.ip)}:${sid}:${limit}:${windowSec}`,
      limit,
      windowSec,
      failMode: config.failMode,
      source: 'demo',
    });

    if (r.unavailable) return sendBlocked(res, r);
    setRateLimitHeaders(res, r);

    // Полное состояние алгоритма — из него плейграунд рисует визуализации (в том числе в ответе 429).
    const state = {
      algorithm: r.algorithm,
      allowed: r.allowed,
      limit,
      windowSec,
      current: r.current,
      remaining: r.remaining,
      resetMs: r.resetMs ?? 0,
      retryAfter: r.resetIn,
      ...(r.tokens !== undefined ? { tokens: Math.round(r.tokens * 1000) / 1000 } : {}),
      degraded: r.degraded,
    };
    if (!r.allowed) return res.status(429).json({ error: 'Too Many Requests', ...state });
    return res.json({
      message: '✅ Запрос принят!',
      ...state,
      requestsMade: r.current,
      resetInSeconds: r.resetIn,
    });
  };

  router.get('/fixed', makeHandler('fixed'));
  router.get('/sliding', makeHandler('sliding'));
  router.get('/token', makeHandler('token'));

  router.get('/status', async (req, res) => {
    let redis = 'n/a (in-memory demo mode)';
    if (store.mode === 'redis') {
      try { redis = (await store.ping()) === 'PONG' ? 'connected' : 'error'; } catch { redis = 'error'; }
    }
    res.json({
      store: store.mode,
      redis,
      fallback: typeof store.usingFallback === 'function' ? store.usingFallback() : false,
      mode: config.mode,
      failMode: config.failMode,
      clientIp: normalizeIp(req.ip),
      features: { checkApi: Boolean(config.adminToken), proxy: config.mode === 'proxy' },
    });
  });

  router.get('/api/stats', (req, res) => res.json(stats.snapshot()));

  return router;
}

module.exports = buildDemoRouter;
