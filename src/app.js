'use strict';

const path = require('path');
const express = require('express');
const adminAuth = require('./middleware/adminAuth');
const buildCheckRouter = require('./routes/check');
const buildDemoRouter = require('./routes/demo');
const createGateway = require('./proxy/gateway');
const stats = require('./store/stats');

/**
 * createApp({ config, store, getRules })
 * getRules — функция, а не объект: правила можно перечитать по SIGHUP без перезапуска.
 */
function createApp({ config, store, getRules }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // --- control plane: всегда под /_rateshield, чтобы не пересекаться с роутами продукта ---
  const control = express.Router();

  control.get('/health', async (req, res) => {
    let ok = true;
    try { await store.ping(); } catch { ok = false; }
    // Всегда 200: при падении Redis сервис продолжает работать по FAIL_MODE, рестарт контейнера не нужен.
    res.json({ status: ok ? 'ok' : 'degraded', store: store.mode, mode: config.mode });
  });

  if (config.adminToken) {
    const auth = adminAuth(config.adminToken);
    control.use(auth);
    control.get('/stats', (req, res) => res.json(stats.snapshot()));
    control.get('/rules', (req, res) => res.json({ rules: getRules().describe(), failMode: config.failMode }));
    control.use(buildCheckRouter({ config, store, rules: { get fallback() { return getRules().fallback; }, byName: (n) => getRules().byName(n) } }));
  }
  app.use('/_rateshield', control);

  if (config.mode === 'demo') {
    app.use(express.static(path.join(__dirname, '..', 'public')));
    app.use(buildDemoRouter({ config, store }));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  } else {
    app.use(createGateway({ config, store, getRules }));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    console.error(JSON.stringify({ level: 'error', message: err.message }));
    return res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

module.exports = createApp;
