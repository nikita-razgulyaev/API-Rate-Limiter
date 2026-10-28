'use strict';

function int(env, name, def, min, max) {
  if (env[name] === undefined || env[name] === '') return def;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

function parseTrustProxy(v) {
  // По умолчанию доверяем X-Forwarded-For только от локальных/приватных адресов
  // (nginx, Caddy, docker-сеть, внутренний прокси PaaS). Прямой клиент из интернета подделать IP не сможет.
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function loadConfig(env = process.env) {
  const mode = (env.MODE || 'demo').toLowerCase();
  if (!['demo', 'proxy'].includes(mode)) throw new Error('MODE must be "demo" or "proxy"');

  const failMode = (env.FAIL_MODE || 'open').toLowerCase();
  if (!['open', 'closed'].includes(failMode)) throw new Error('FAIL_MODE must be "open" or "closed"');

  const adminToken = env.ADMIN_TOKEN || '';
  if (adminToken && adminToken.length < 16) {
    throw new Error('ADMIN_TOKEN is too short (min 16 chars). Generate one: openssl rand -hex 32');
  }

  let upstream = null;
  if (mode === 'proxy') {
    if (!env.UPSTREAM_URL) throw new Error('MODE=proxy requires UPSTREAM_URL (e.g. http://localhost:8080)');
    try { upstream = new URL(env.UPSTREAM_URL); } catch { throw new Error('UPSTREAM_URL is not a valid URL'); }
    if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('UPSTREAM_URL must be http:// or https://');
  }

  return {
    mode,
    port: int(env, 'PORT', 3000, 1, 65535),
    redisUrl: env.REDIS_URL || '',
    redisTimeoutMs: int(env, 'REDIS_TIMEOUT_MS', 1000, 50, 30000),
    keyPrefix: env.KEY_PREFIX || 'rs',
    failMode,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    adminToken,
    upstream,
    upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 30000, 100, 600000),
    preserveHost: env.PROXY_PRESERVE_HOST === 'true',
    rulesFile: env.RULES_FILE || '',
    defaults: {
      algorithm: env.RATE_ALGORITHM || 'token',
      limit: int(env, 'RATE_LIMIT', mode === 'demo' ? 5 : 60, 1, 1_000_000),
      windowSec: int(env, 'RATE_WINDOW', 60, 1, 86400),
      key: 'ip',
    },
  };
}

module.exports = { loadConfig };
