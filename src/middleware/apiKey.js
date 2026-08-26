'use strict';

const { resolveKey, PLANS } = require('../store/keys');

/**
 * Resolves the request to a tenant: either a registered API key (with its
 * plan-based limit/window), or an anonymous caller falling back to the Free
 * plan and rate-limited by IP. This is the piece that turns "a rate limiter"
 * into "a rate limiter you can sell to different customers on different
 * plans" — the core of the business pitch.
 */
function resolveTenant(req) {
  const apiKey = req.headers['x-api-key'];
  const resolved = apiKey ? resolveKey(apiKey) : null;

  if (resolved) {
    return {
      clientId: `key:${resolved.apiKey}`,
      plan: resolved.plan,
      planName: resolved.name,
      limit: resolved.limit,
      windowSec: resolved.windowSec,
    };
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'demo-user';

  return {
    clientId: `ip:${ip}`,
    plan: 'free',
    planName: PLANS.free.name,
    limit: PLANS.free.limit,
    windowSec: PLANS.free.windowSec,
  };
}

module.exports = { resolveTenant };
