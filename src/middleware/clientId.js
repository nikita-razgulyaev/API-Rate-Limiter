'use strict';

/**
 * Identifies the caller for rate-limiting purposes. This is an open demo, so
 * identification is just by IP — no accounts, no keys, nothing commercial.
 * Swapping this for real auth later (API keys, JWT, etc.) is a one-file change.
 */
function resolveClientId(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'demo-user';

  return `ip:${ip}`;
}

module.exports = { resolveClientId };
