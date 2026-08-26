/**
 * Простой логгер запросов
 */

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    ...meta
  };
  console.log(JSON.stringify(entry));
}

module.exports = { log };
