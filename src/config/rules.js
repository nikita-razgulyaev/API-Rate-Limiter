'use strict';

const fs = require('fs');
const { resolveAlgorithm } = require('../limiters');
const { normalizePath, compileKeyStrategy } = require('../core/identity');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function validateLimits(r, where) {
  const limit = Number(r.limit);
  const windowSec = Number(r.windowSec);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error(`${where}: limit must be an integer 1..1000000`);
  if (!Number.isInteger(windowSec) || windowSec < 1 || windowSec > 86_400) throw new Error(`${where}: windowSec must be an integer 1..86400`);
  return { limit, windowSec };
}

function compileMatch(match) {
  let method = null;
  let pattern = String(match || '*').trim();
  const m = pattern.match(/^([A-Za-z]+)\s+(.*)$/);
  if (m && METHODS.includes(m[1].toUpperCase())) { method = m[1].toUpperCase(); pattern = m[2].trim(); }
  const norm = pattern === '*' ? '*' : normalizePath(pattern).replace(/\/$/, '') || '/';
  const source = norm.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return { method, regex: new RegExp(`^${source}$`) };
}

function compileRule(raw, index, defaults) {
  const name = raw.name || `rule-${index + 1}`;
  const rule = { ...defaults, ...raw, name };
  const { regex, method } = compileMatch(raw.match);
  const base = { name, method, regex, skip: Boolean(raw.skip) };
  if (base.skip) return base;
  const { limit, windowSec } = validateLimits(rule, `rule "${name}"`);
  return {
    ...base,
    algorithm: resolveAlgorithm(rule.algorithm),
    limit,
    windowSec,
    keySpec: rule.key || 'ip',
    keyFn: compileKeyStrategy(rule.key || 'ip'),
  };
}

/**
 * config = { defaults: {...}, rules: [{ name, match, algorithm, limit, windowSec, key, skip }] }
 * Первое подходящее правило побеждает; если ничего не подошло — применяются defaults.
 */
function buildRuleSet(config) {
  const defaults = { algorithm: 'token', limit: 60, windowSec: 60, key: 'ip', ...(config.defaults || {}) };
  const list = (config.rules || []).map((r, i) => compileRule(r, i, defaults));
  const fallback = compileRule({ name: 'default', match: '*' }, 0, defaults);
  const byName = new Map([...list, fallback].map((r) => [r.name, r]));

  return {
    list,
    fallback,
    byName: (name) => byName.get(name),
    find(method, reqPath) {
      const p = normalizePath(reqPath);
      for (const r of list) {
        if (r.method && r.method !== method) continue;
        if (r.regex.test(p)) return r;
      }
      return fallback;
    },
    describe: () => [...list, fallback].map((r) => (r.skip
      ? { name: r.name, skip: true }
      : { name: r.name, algorithm: r.algorithm.id, limit: r.limit, windowSec: r.windowSec, key: r.keySpec })),
  };
}

function loadRuleSet(file, defaults) {
  if (!file) return buildRuleSet({ defaults });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return buildRuleSet({ ...parsed, defaults: { ...defaults, ...(parsed.defaults || {}) } });
}

module.exports = { buildRuleSet, loadRuleSet, validateLimits };
