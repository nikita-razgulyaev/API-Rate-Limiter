'use strict';

/** Минимальный JSON-логгер + троттлинг повторяющихся предупреждений. */

function log(level, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

const active = new Set();

/**
 * Пишет предупреждение ОДИН раз за «сбой»: повторные вызовы с тем же key молчат,
 * пока проблему не пометят решённой через resolveWarn(key). Так недоступный Redis
 * даёт одну запись в логе, а не поток повторов на каждую попытку переподключения.
 */
function warnOnce(key, message, meta = {}) {
  if (active.has(key)) return;
  active.add(key);
  log('warn', message, meta);
}

/** Помечает проблему решённой (следующий сбой снова попадёт в лог). Возвращает true, если она была активна. */
function resolveWarn(key) {
  return active.delete(key);
}

module.exports = { log, warnOnce, resolveWarn };
