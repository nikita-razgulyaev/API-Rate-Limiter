'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../src/config/store');
const { startApp, startUpstream, request } = require('./helpers');

const TOKEN = 'test-token-0123456789abcdef';

describe('режим proxy', () => {
  let upstream; let app; let store;

  before(async () => {
    upstream = await startUpstream();
    store = new MemoryStore();
    app = await startApp({
      store,
      env: { MODE: 'proxy', UPSTREAM_URL: `http://127.0.0.1:${upstream.port}`, ADMIN_TOKEN: TOKEN },
      rulesConfig: {
        defaults: { algorithm: 'fixed', limit: 100, windowSec: 60 },
        rules: [
          { name: 'login', match: 'POST /auth/login', algorithm: 'fixed', limit: 3, windowSec: 60 },
          { name: 'health', match: '/health', skip: true },
          { name: 'keyed', match: '/keyed/*', algorithm: 'fixed', limit: 2, windowSec: 60, key: 'header:x-api-key' },
        ],
      },
    });
  });
  after(async () => { await app.close(); await upstream.close(); await store.close(); });

  test('проксирует метод, путь, query и тело; наши заголовки перекрывают апстримные', async () => {
    const r = await request(app.port, { method: 'POST', path: '/echo?a=1&b=2', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    assert.equal(r.status, 200);
    assert.equal(r.json.url, '/echo?a=1&b=2');
    assert.equal(r.json.body, 'hello');
    assert.equal(r.headers['x-upstream'], 'yes');
    assert.equal(r.headers['x-ratelimit-limit'], '100'); // не 'upstream-should-be-overridden'
    const seen = upstream.seen.at(-1);
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
    assert.match(seen.headers['x-forwarded-for'], /127\.0\.0\.1/);
    assert.equal(seen.headers['x-forwarded-proto'], 'http');
  });

  test('правило login: 3 запроса проходят, 4-й -> 429 с Retry-After', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await request(app.port, { method: 'POST', path: '/auth/login' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    const blocked = await request(app.port, { method: 'POST', path: '/auth/login' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.json.error, 'Too Many Requests');
  });

  test('заблокированный запрос не доходит до апстрима', async () => {
    const before = upstream.seen.length;
    await request(app.port, { method: 'POST', path: '/auth/login' });
    assert.equal(upstream.seen.length, before);
  });

  test('обход правила через регистр/двойной слэш/%-кодирование не работает', async () => {
    for (const p of ['/AUTH/Login', '//auth//login/', '/auth/%6Cogin']) {
      const r = await request(app.port, { method: 'POST', path: p });
      assert.equal(r.status, 429, p);
    }
  });

  test('skip-правило не лимитируется и без X-RateLimit-* заголовков', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await request(app.port, { path: '/health' })).status, 200);
    const r = await request(app.port, { path: '/health' });
    assert.equal(r.headers['x-ratelimit-limit'], 'upstream-should-be-overridden'); // заголовок апстрима не тронут
  });

  test('key header: разные ключи — раздельные счётчики', async () => {
    const hit = (k) => request(app.port, { path: '/keyed/x', headers: { 'x-api-key': k } });
    assert.equal((await hit('A')).status, 200);
    assert.equal((await hit('A')).status, 200);
    assert.equal((await hit('A')).status, 429);
    assert.equal((await hit('B')).status, 200);
  });

  test('апстрим недоступен -> 502, таймаут -> 504', async () => {
    const dead = await startApp({
      store: new MemoryStore(),
      env: { MODE: 'proxy', UPSTREAM_URL: 'http://127.0.0.1:1' },
    });
    const r = await request(dead.port, { path: '/x' });
    assert.equal(r.status, 502);
    await dead.close();

    const slow = await startUpstream(() => { /* никогда не отвечает */ });
    const gw = await startApp({
      store: new MemoryStore(),
      env: { MODE: 'proxy', UPSTREAM_URL: `http://127.0.0.1:${slow.port}`, UPSTREAM_TIMEOUT_MS: '200' },
    });
    const t = await request(gw.port, { path: '/slow' });
    assert.equal(t.status, 504);
    await gw.close(); await slow.close();
  });

  test('control plane: health открыт, остальное требует токен', async () => {
    assert.equal((await request(app.port, { path: '/_rateshield/health' })).status, 200);
    assert.equal((await request(app.port, { path: '/_rateshield/stats' })).status, 401);
    assert.equal((await request(app.port, { path: '/_rateshield/stats', headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status, 401);
    const ok = await request(app.port, { path: '/_rateshield/stats', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.bySource.proxy.ok > 0);
    const rules = await request(app.port, { path: '/_rateshield/rules', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(rules.json.rules[0].name, 'login');
  });
});

describe('POST /_rateshield/v1/check', () => {
  let app; let store;
  const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const check = (body, headers = H) => request(app.port, { method: 'POST', path: '/_rateshield/v1/check', headers, body: JSON.stringify(body) });

  before(async () => {
    store = new MemoryStore();
    app = await startApp({
      store,
      env: { ADMIN_TOKEN: TOKEN },
      rulesConfig: { defaults: { limit: 100, windowSec: 60 }, rules: [{ name: 'login', match: '/x', algorithm: 'fixed', limit: 2, windowSec: 60 }] },
    });
  });
  after(async () => { await app.close(); await store.close(); });

  test('без токена -> 401', async () => {
    assert.equal((await check({ key: 'u1' }, { 'content-type': 'application/json' })).status, 401);
  });

  test('явные параметры: решения и remaining', async () => {
    const body = { key: 'user:1', algorithm: 'fixed', limit: 2, windowSec: 60 };
    const a = await check(body); const b = await check(body); const c = await check(body);
    assert.equal(a.json.allowed, true);
    assert.equal(a.json.remaining, 1);
    assert.equal(b.json.allowed, true);
    assert.equal(c.status, 200); // решение — не HTTP-ошибка
    assert.equal(c.json.allowed, false);
    assert.ok(c.json.retryAfter >= 1);
  });

  test('именованное правило и независимость ключей', async () => {
    assert.equal((await check({ key: 'a', rule: 'login' })).json.allowed, true);
    assert.equal((await check({ key: 'a', rule: 'login' })).json.allowed, true);
    assert.equal((await check({ key: 'a', rule: 'login' })).json.allowed, false);
    assert.equal((await check({ key: 'b', rule: 'login' })).json.allowed, true);
  });

  test('валидация входа -> 400', async () => {
    assert.equal((await check({})).status, 400);
    assert.equal((await check({ key: 'x'.repeat(300) })).status, 400);
    assert.equal((await check({ key: 'k', rule: 'nope' })).status, 400);
    assert.equal((await check({ key: 'k', limit: -5 })).status, 400);
    assert.equal((await check({ key: 'k', algorithm: 'zzz' })).status, 400);
    const bad = await request(app.port, { method: 'POST', path: '/_rateshield/v1/check', headers: H, body: '{oops' });
    assert.equal(bad.status, 400);
  });
});

describe('демо-режим', () => {
  test('потолки limit/window и отсутствие control plane без ADMIN_TOKEN', async () => {
    const store = new MemoryStore();
    const app = await startApp({ store });
    const r = await request(app.port, { path: '/fixed?limit=999999&window=999999' });
    assert.equal(r.headers['x-ratelimit-limit'], '100');
    assert.equal((await request(app.port, { path: '/_rateshield/stats' })).status, 404);
    assert.equal((await request(app.port, { method: 'POST', path: '/_rateshield/v1/check' })).status, 404);
    await app.close(); await store.close();
  });
});

describe('демо: состояние для визуализаций', () => {
  test('ответы содержат состояние алгоритма (в т.ч. 429), sid изолирует счётчики', async () => {
    const store = new MemoryStore();
    const app = await startApp({ store });
    const get = (algo, sid) => request(app.port, { path: `/${algo}?limit=2&window=30&sid=${sid}` });

    const a = await get('fixed', 'aaa');
    assert.equal(a.json.current, 1);
    assert.ok(a.json.resetMs > 29_000 && a.json.resetMs <= 30_000);
    await get('fixed', 'aaa');
    const blocked = await get('fixed', 'aaa');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.allowed, false);
    assert.equal(blocked.json.limit, 2);
    assert.ok(blocked.json.resetMs > 0);
    assert.equal((await get('fixed', 'bbb')).status, 200); // другой sid — чистый счётчик

    const s1 = await get('sliding', 'aaa');
    assert.equal(s1.json.current, 1);
    assert.ok(s1.json.resetMs > 29_000);

    const t1 = await get('token', 'aaa');
    assert.equal(t1.json.tokens, 1); // 2 токена - 1
    await get('token', 'aaa');
    const t3 = await get('token', 'aaa');
    assert.equal(t3.status, 429);
    assert.ok(t3.json.tokens < 1);
    assert.ok(t3.json.resetMs > 0 && t3.json.resetMs <= 15_000); // 1 токен / 15 с
    await app.close(); await store.close();
  });
});
