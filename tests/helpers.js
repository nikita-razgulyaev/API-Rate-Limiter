'use strict';

const http = require('http');
const createApp = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { buildRuleSet } = require('../src/config/rules');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Запускает RateShield в тестовом режиме на случайном порту. */
async function startApp({ env = {}, store, rulesConfig }) {
  const config = loadConfig({ MODE: 'demo', ...env });
  const rules = buildRuleSet(rulesConfig || { defaults: config.defaults });
  const app = createApp({ config, store, getRules: () => rules });
  const server = http.createServer(app);
  const port = await listen(server);
  return { port, server, config, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Простой апстрим-сервер, который эхом возвращает, что получил. */
async function startUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (handler) return handler(req, res, body);
      res.setHeader('x-upstream', 'yes');
      res.setHeader('x-ratelimit-limit', 'upstream-should-be-overridden');
      res.end(JSON.stringify({ ok: true, url: req.url, body }));
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startApp, startUpstream, request, sleep };
