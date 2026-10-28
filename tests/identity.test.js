'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIp, normalizePath, compileKeyStrategy } = require('../src/core/identity');
const { buildRuleSet } = require('../src/config/rules');

test('normalizeIp: IPv4 и ipv4-mapped', () => {
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
});

test('normalizeIp: IPv6 схлопывается до /64', () => {
  const a = normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  const b = normalizeIp('2001:db8:1:2::1');
  assert.equal(a, b);
  assert.notEqual(a, normalizeIp('2001:db8:1:3::1'));
  assert.equal(normalizeIp('::1'), 'v6:0:0:0:0');
});

test('normalizePath: регистр, %-кодирование, //, ..', () => {
  assert.equal(normalizePath('/API//Login/'), '/api/login');
  assert.equal(normalizePath('/%6Cogin'), '/login');
  assert.equal(normalizePath('/api/../auth/login'), '/auth/login');
  assert.equal(normalizePath('/'), '/');
});

test('правила: первое совпадение побеждает, метод и glob, обход через регистр/слэши невозможен', () => {
  const rules = buildRuleSet({
    defaults: { limit: 100 },
    rules: [
      { name: 'login', match: 'POST /auth/login', algorithm: 'fixed', limit: 5, windowSec: 60 },
      { name: 'health', match: '/health', skip: true },
      { name: 'api', match: '/api/*', limit: 10, windowSec: 10 },
    ],
  });
  assert.equal(rules.find('POST', '/auth/login').name, 'login');
  assert.equal(rules.find('POST', '/AUTH//Login/').name, 'login');
  assert.equal(rules.find('POST', '/auth/%6Cogin').name, 'login');
  assert.equal(rules.find('GET', '/auth/login').name, 'default'); // метод не совпал
  assert.equal(rules.find('GET', '/health').skip, true);
  assert.equal(rules.find('GET', '/api/users/1').name, 'api');
  assert.equal(rules.find('GET', '/other').name, 'default');
  assert.equal(rules.find('GET', '/other').limit, 100);
});

test('правила: валидация падает громко', () => {
  assert.throws(() => buildRuleSet({ rules: [{ match: '/x', limit: 0 }] }), /limit/);
  assert.throws(() => buildRuleSet({ rules: [{ match: '/x', algorithm: 'nope' }] }), /Unknown algorithm/);
  assert.throws(() => buildRuleSet({ rules: [{ match: '/x', key: 'cookie:sid' }] }), /Unknown key strategy/);
});

test('key header: хешируется, без заголовка — откат на ip', () => {
  const fn = compileKeyStrategy('header:x-api-key');
  const withKey = fn({ headers: { 'x-api-key': 'secret-123' }, ip: '1.1.1.1' });
  assert.match(withKey, /^h:[0-9a-f]{32}$/);
  assert.ok(!withKey.includes('secret'));
  assert.equal(fn({ headers: {}, ip: '1.1.1.1' }), 'ip:1.1.1.1');
});
