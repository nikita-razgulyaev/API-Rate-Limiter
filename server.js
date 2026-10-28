'use strict';

const fs = require('fs');

// Подхватываем .env без внешних зависимостей (Node 20.12+); переменные окружения имеют приоритет.
if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) process.loadEnvFile('.env');

const createApp = require('./src/app');
const { loadConfig } = require('./src/config/env');
const { loadRuleSet } = require('./src/config/rules');
const { createStore } = require('./src/config/store');
const { log } = require('./src/utils/logger');

async function main() {
  const config = loadConfig();
  let rules = loadRuleSet(config.rulesFile, config.defaults);
  const store = createStore({ url: config.redisUrl, timeoutMs: config.redisTimeoutMs, fallbackToMemory: config.mode === 'demo' });

  // Не блокируем старт ожиданием Redis: порт открывается сразу (health-check платформы), а при проблемах
  // с хранилищем сервис работает по FAIL_MODE и сам подхватывает Redis, когда он появится.
  store.waitReady(5000).then((ok) => {
    if (!ok) log('warn', config.mode === 'demo'
        ? 'Redis пока недоступен — демо считает лимиты в памяти, пока он не появится'
        : 'Redis пока недоступен — работаем в деградированном режиме', { failMode: config.failMode });
  });

  const app = createApp({ config, store, getRules: () => rules });
  const server = app.listen(config.port, () => {
    log('info', 'RateShield запущен', {
      port: config.port, mode: config.mode, store: store.mode, failMode: config.failMode,
      upstream: config.upstream ? config.upstream.origin : undefined,
      checkApi: Boolean(config.adminToken),
    });
  });
  // Больше, чем idle-таймауты типичных балансировщиков (60s) — иначе редкие 502 на переиспользуемых соединениях.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Горячая перезагрузка правил: kill -HUP <pid>  /  docker kill -s HUP <container>
  process.on('SIGHUP', () => {
    try {
      rules = loadRuleSet(config.rulesFile, config.defaults);
      log('info', 'Правила перечитаны', { rules: rules.list.length });
    } catch (err) {
      log('error', 'Не удалось перечитать правила, оставлены прежние', { error: err.message });
    }
  });

  const shutdown = (signal) => {
    log('info', 'Останавливаемся', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => { await store.close(); process.exit(0); });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`Ошибка конфигурации: ${err.message}`);
  process.exit(1);
});
