'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createStore, rateLimit } = require('../src');
const { request } = require('./helpers');

test('библиотека: rateLimit() как Express-middleware', async () => {
  const store = createStore({ url: '' });
  const app = express();
  app.use('/api', rateLimit(store, { algorithm: 'fixed', limit: 2, windowSec: 60 }));
  app.get('/api/ping', (req, res) => res.json({ pong: true }));
  app.get('/free', (req, res) => res.json({ free: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await request(port, { path: '/api/ping' })).status);
  assert.deepEqual(codes, [200, 200, 429]);
  assert.equal((await request(port, { path: '/free' })).status, 200); // вне префикса — без лимита

  const blocked = await request(port, { path: '/api/ping' });
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);

  assert.throws(() => rateLimit(store, { limit: 0 }), /limit/);
  server.closeAllConnections?.(); server.close(); await store.close();
});
