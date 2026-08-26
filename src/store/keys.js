'use strict';

const crypto = require('crypto');

/**
 * Demo plan catalogue. In a real product these limits would live in a
 * billing DB (Stripe metadata, Postgres, etc.) — here they're static so the
 * business logic (multi-tenant limits by plan) is visible without needing
 * a database for the MVP.
 */
const PLANS = {
  free: { name: 'Free', limit: 5, windowSec: 60, price: '$0/mo' },
  pro: { name: 'Pro', limit: 50, windowSec: 60, price: '$29/mo' },
  enterprise: { name: 'Enterprise', limit: 500, windowSec: 60, price: 'Custom' },
};

// apiKey -> { plan, createdAt, label }
const keys = new Map();

function generateKey(plan = 'free', label = '') {
  if (!PLANS[plan]) throw new Error(`Unknown plan: ${plan}`);
  const apiKey = 'rl_' + crypto.randomBytes(18).toString('hex');
  keys.set(apiKey, { plan, label, createdAt: Date.now() });
  return { apiKey, ...PLANS[plan] };
}

function resolveKey(apiKey) {
  if (!apiKey) return null;
  const entry = keys.get(apiKey);
  if (!entry) return null;
  return { apiKey, ...entry, ...PLANS[entry.plan] };
}

function listPlans() {
  return PLANS;
}

module.exports = { PLANS, generateKey, resolveKey, listPlans };
