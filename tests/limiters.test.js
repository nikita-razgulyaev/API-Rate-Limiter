'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, createStore } = require('../src/config/store');
const { resolveAlgorithm } = require('../src/limiters');
const { sleep } = require('./helpers');

const stores = [['memory', () => new MemoryStore()]];
if (process.env.TEST_REDIS_URL) stores.push(['redis', () => createStore({ url: process.env.TEST_REDIS_URL })]);

const run = (store, algo, key, limit, windowSec) => resolveAlgorithm(algo).fn(store, key, limit, windowSec);
const uid = () => Math.random().toString(36).slice(2);

for (const [name, make] of stores) {
  describe(`limiters [${name}]`, () => {
    const store = make();
    after(() => store.close());

    test('fixed window: пропускает limit запросов, дальше блокирует', async () => {
      const key = 't:fixed:' + uid();
      const out = [];
      for (let i = 0; i < 5; i++) out.push((await run(store, 'fixed', key, 3, 60)).allowed);
      assert.deepEqual(out, [true, true, true, false, false]);
    });

    test('fixed window: окно сбрасывается', async () => {
      const key = 't:fixedreset:' + uid();
      assert.equal((await run(store, 'fixed', key, 1, 1)).allowed, true);
      assert.equal((await run(store, 'fixed', key, 1, 1)).allowed, false);
      await sleep(1100);
      assert.equal((await run(store, 'fixed', key, 1, 1)).allowed, true);
    });

    test('sliding window: лимит, remaining и освобождение слота', async () => {
      const key = 't:sliding:' + uid();
      const a = await run(store, 'sliding', key, 2, 1);
      const b = await run(store, 'sliding', key, 2, 1);
      const c = await run(store, 'sliding', key, 2, 1);
      assert.equal(a.allowed, true);
      assert.equal(b.allowed, true);
      assert.equal(b.remaining, 0);
      assert.equal(c.allowed, false);
      await sleep(1100);
      assert.equal((await run(store, 'sliding', key, 2, 1)).allowed, true);
    });

    test('sliding window: отклонённые запросы не продлевают блокировку', async () => {
      const key = 't:slidingrej:' + uid();
      await run(store, 'sliding', key, 1, 1);
      for (let i = 0; i < 20; i++) await run(store, 'sliding', key, 1, 1); // спам во время блокировки
      await sleep(1100);
      assert.equal((await run(store, 'sliding', key, 1, 1)).allowed, true);
    });

    test('token bucket: всплеск до capacity, затем пополнение', async () => {
      const key = 't:token:' + uid();
      const burst = [];
      for (let i = 0; i < 4; i++) burst.push((await run(store, 'token', key, 3, 3)).allowed); // 1 токен/сек
      assert.deepEqual(burst, [true, true, true, false]);
      const blocked = await run(store, 'token', key, 3, 3);
      assert.ok(blocked.resetIn >= 1);
      await sleep(1100);
      assert.equal((await run(store, 'token', key, 3, 3)).allowed, true);
    });

    test('атомарность: 300 параллельных запросов при limit=50 -> ровно 50 разрешено', async () => {
      for (const algo of ['fixed', 'sliding', 'token']) {
        const key = `t:atomic:${algo}:${uid()}`;
        // token bucket с окном 3600с пополняется ничтожно медленно -> строго capacity запросов
        const results = await Promise.all(Array.from({ length: 300 }, () => run(store, algo, key, 50, 3600)));
        assert.equal(results.filter((r) => r.allowed).length, 50, algo);
      }
    });
  });
}
