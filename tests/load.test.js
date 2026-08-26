/**
 * Нагрузочный тест Rate Limiter
 *
 * Запуск: node tests/load.test.js
 */

const http = require('http');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;
const ENDPOINT = process.env.ENDPOINT || '/fixed';
const REQUESTS = parseInt(process.env.REQUESTS) || 20;
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 5;

function request() {
  return new Promise((resolve) => {
    const req = http.get('http://' + HOST + ':' + PORT + ENDPOINT, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: {} });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, error: true }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, timeout: true }); });
  });
}

async function run() {
  console.log('🔥 Нагрузочный тест: ' + REQUESTS + ' запросов, concurrency ' + CONCURRENCY);
  console.log('   Endpoint: ' + ENDPOINT + '
');

  const results = { ok: 0, blocked: 0, error: 0 };
  const start = Date.now();

  for (let i = 0; i < REQUESTS; i += CONCURRENCY) {
    const batchSize = Math.min(CONCURRENCY, REQUESTS - i);
    const batch = [];
    for (let j = 0; j < batchSize; j++) batch.push(request());
    const batchResults = await Promise.all(batch);

    batchResults.forEach(r => {
      if (r.status === 200) results.ok++;
      else if (r.status === 429) results.blocked++;
      else results.error++;
    });
  }

  const duration = Date.now() - start;

  console.log('Результаты:');
  console.log('  ✅ OK:        ' + results.ok);
  console.log('  ❌ Blocked:   ' + results.blocked);
  console.log('  ⚠️  Error:     ' + results.error);
  console.log('  ⏱️  Duration:  ' + duration + 'ms');
  console.log('  🚀 RPS:       ' + (REQUESTS / (duration / 1000)).toFixed(1));
}

run().catch(console.error);
