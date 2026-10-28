'use strict';

const http = require('http');
const https = require('https');
const { enforce, setRateLimitHeaders, sendBlocked } = require('../core/enforce');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Reverse proxy с лимитами: клиент ставит RateShield перед своим API, ничего не меняя в коде продукта.
 * Не поддерживает WebSocket/Upgrade. Тело запроса стримится, не буферизуется.
 */
function createGateway({ config, store, getRules }) {
  const { upstream } = config;
  const transport = upstream.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 256 });
  const basePath = upstream.pathname.replace(/\/$/, '');
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');

  function forward(req, res, rateResult) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;

    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-proto'] = req.protocol;
    if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
    if (!config.preserveHost) headers.host = upstream.host;

    let timedOut = false;
    const proxyReq = transport.request({
      agent,
      hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: basePath + req.originalUrl,
      headers,
    }, (proxyRes) => {
      const out = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      res.statusCode = proxyRes.statusCode;
      res.statusMessage = proxyRes.statusMessage;
      for (const [k, v] of Object.entries(out)) res.setHeader(k, v);
      if (!rateResult._skip) setRateLimitHeaders(res, rateResult); // наши заголовки перекрывают апстримные
      proxyRes.pipe(res);
    });

    proxyReq.setTimeout(config.upstreamTimeoutMs, () => {
      timedOut = true;
      proxyReq.destroy(new Error('upstream timeout'));
    });

    proxyReq.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      const status = timedOut ? 504 : 502;
      return res.status(status).json({ error: timedOut ? 'Gateway Timeout' : 'Bad Gateway', detail: err.code || err.message });
    });

    res.on('close', () => { if (!res.writableFinished) proxyReq.destroy(); });
    req.pipe(proxyReq);
  }

  return async function gateway(req, res, next) {
    try {
      const rule = getRules().find(req.method, req.path);
      if (rule.skip) {
        return forward(req, res, { limit: 0, remaining: 0, resetIn: 0, algorithm: 'skipped', allowed: true, _skip: true });
      }
      const r = await enforce(store, {
        algorithm: rule.algorithm.id,
        key: `${config.keyPrefix}:gw:${rule.name}:${rule.algorithm.id}:${rule.keyFn(req)}`,
        limit: rule.limit,
        windowSec: rule.windowSec,
        failMode: config.failMode,
        source: 'proxy',
      });
      if (!r.allowed) return sendBlocked(res, r);
      return forward(req, res, r);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = createGateway;
