'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * IPv4 как есть; IPv6 схлопываем до /64 — иначе один клиент с целой подсетью
 * обходит лимит, просто меняя адрес.
 */
function normalizeIp(raw) {
  let ip = String(raw || 'unknown').split('%')[0];
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  if (!ip.includes(':')) return ip;

  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  let groups = h;
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  }
  return 'v6:' + groups.slice(0, 4).map((g) => (g || '0').toLowerCase()).join(':');
}

/** Нормализация пути перед сопоставлением с правилами: регистр, %-кодирование, //, /./, /../, хвостовой /. */
function normalizePath(p) {
  let out = String(p || '/');
  try { out = decodeURIComponent(out); } catch { /* оставляем как есть */ }
  out = path.posix.normalize('/' + out.replace(/\/{2,}/g, '/'));
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out.toLowerCase();
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * Стратегии идентификации клиента:
 *   "ip"            — адрес клиента (req.ip с учётом TRUST_PROXY)
 *   "header:<name>" — значение заголовка (хешируется; нет заголовка -> откат на ip)
 *   "global"        — один общий счётчик на правило
 */
function compileKeyStrategy(spec = 'ip') {
  if (spec === 'ip') return (req) => 'ip:' + normalizeIp(req.ip);
  if (spec === 'global') return () => 'global';
  if (typeof spec === 'string' && spec.startsWith('header:')) {
    const name = spec.slice(7).trim().toLowerCase();
    if (!name) throw new Error('key "header:" requires a header name');
    return (req) => {
      const v = req.headers[name];
      return v ? `h:${sha(Array.isArray(v) ? v[0] : v)}` : 'ip:' + normalizeIp(req.ip);
    };
  }
  throw new Error(`Unknown key strategy "${spec}". Use: ip | global | header:<name>`);
}

module.exports = { normalizeIp, normalizePath, compileKeyStrategy, sha };
