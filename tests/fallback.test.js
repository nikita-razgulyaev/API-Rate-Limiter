'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, FallbackStore } = require('../src/config/store');
const { resolveAlgorithm } = require('../src/limiters');

const fixed = (store, key) => resolveAlgorithm('fixed').fn(store, key, 2, 60);

function fakePrimary() {
  const mem = new MemoryStore();
  const p = {
    mode: 'redis', ready: false, broken: false,
    isReady() { return this.ready; },
    waitReady: async () => this.ready, ping: async () => 'PONG', close: async () => mem.close(),
    incrExpire(...a) { if (this.broken) return Promise.reject(new Error('boom')); return mem.incrExpire(...a); },
  };
  return p;
}

test('FallbackStore: Redis недоступен -> лимит всё равно работает (в памяти)', async () => {
  const primary = fakePrimary();
  const store = new FallbackStore(primary, new MemoryStore());
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fixed(store, 'k1')).allowed);
  assert.deepEqual(codes, [true, true, false, false]);
  assert.equal(store.usingFallback(), true);
  await store.close();
});

test('FallbackStore: Redis готов -> используется он; сбой команды -> откат на память', async () => {
  const primary = fakePrimary();
  primary.ready = true;
  const store = new FallbackStore(primary, new MemoryStore());
  assert.equal((await fixed(store, 'k2')).allowed, true);
  assert.equal(store.usingFallback(), false);

  primary.broken = true; // команда падает, хотя соединение «готово»
  assert.equal((await fixed(store, 'k3')).allowed, true);
  assert.equal(store.usingFallback(), true);

  primary.broken = false; // Redis вернулся
  await fixed(store, 'k4');
  assert.equal(store.usingFallback(), false);
  await store.close();
});
