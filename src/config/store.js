'use strict';

/**
 * Хранилище для лимитеров. Два бэкенда с одинаковым интерфейсом:
 *  - RedisStore  — прод: все проверки выполняются Lua-скриптами, то есть атомарно
 *                  (никаких гонок при параллельных запросах и нескольких инстансах);
 *  - MemoryStore — dev/демо: Map внутри процесса, без внешних зависимостей.
 *
 * Интерфейс:
 *   incrExpire(key, windowMs)                         -> { count, ttlMs }
 *   slidingCount(key, limit, windowMs, now)           -> { allowed, count, ttlMs }
 *   tokenBucket(key, capacity, refillPerSec, now, ttlMs) -> { allowed, tokens, ttlMs }
 */

const { log, warnOnce, resolveWarn } = require('../utils/logger');

// ---------- Lua-скрипты (атомарны на стороне Redis) ----------

const LUA_FIXED = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

// Отклонённые запросы НЕ попадают в журнал — клиент не «залипает» в блокировке.
const LUA_SLIDING = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', KEYS[1], window)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local ttl = window
if oldest[2] then ttl = math.max(0, math.floor(tonumber(oldest[2]) + window - now)) end
return {allowed, count, ttl}
`;

const LUA_TOKEN = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + (math.max(0, now - ts) / 1000) * refill)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(math.max(ts, now)))
redis.call('PEXPIRE', KEYS[1], ttl)
local wait = 0
if allowed == 0 then wait = math.ceil((1 - tokens) / refill * 1000) end
return {allowed, tostring(tokens), wait}
`;

// ---------- In-memory ----------

class MemoryStore {
  constructor() {
    this.mode = 'memory';
    this.counters = new Map(); // key -> { count, expiresAt }
    this.sortedSets = new Map(); // key -> { items: [{score}], expiresAt }
    this.buckets = new Map(); // key -> { tokens, last, expiresAt }
    this._timer = setInterval(() => this._sweep(), 30_000);
    this._timer.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const m of [this.counters, this.sortedSets, this.buckets]) {
      for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
    }
  }

  async waitReady() { return true; }
  async ping() { return 'PONG'; }
  async close() { clearInterval(this._timer); }

  async incrExpire(key, windowMs) {
    const now = Date.now();
    let e = this.counters.get(key);
    if (!e || e.expiresAt <= now) {
      e = { count: 0, expiresAt: now + windowMs };
      this.counters.set(key, e);
    }
    e.count += 1;
    return { count: e.count, ttlMs: e.expiresAt - now };
  }

  async slidingCount(key, limit, windowMs, now) {
    let s = this.sortedSets.get(key);
    if (!s) { s = { items: [], expiresAt: 0 }; this.sortedSets.set(key, s); }
    const cutoff = now - windowMs;
    while (s.items.length && s.items[0] <= cutoff) s.items.shift();
    let allowed = false;
    if (s.items.length < limit) { s.items.push(now); allowed = true; }
    s.expiresAt = now + windowMs;
    const ttlMs = s.items.length ? Math.max(0, s.items[0] + windowMs - now) : windowMs;
    return { allowed, count: s.items.length, ttlMs };
  }

  async tokenBucket(key, capacity, refillPerSec, now, ttlMs) {
    let b = this.buckets.get(key);
    if (!b || b.expiresAt <= now) b = { tokens: capacity, last: now, expiresAt: 0 };
    b.tokens = Math.min(capacity, b.tokens + (Math.max(0, now - b.last) / 1000) * refillPerSec);
    b.last = Math.max(b.last, now);
    b.expiresAt = now + ttlMs;
    this.buckets.set(key, b);
    let allowed = false;
    if (b.tokens >= 1) { b.tokens -= 1; allowed = true; }
    const wait = allowed ? 0 : Math.ceil(((1 - b.tokens) / refillPerSec) * 1000);
    return { allowed, tokens: b.tokens, ttlMs: wait };
  }
}

// ---------- Redis ----------

class RedisStore {
  constructor(client) {
    this.mode = 'redis';
    this.client = client;
    client.defineCommand('rsFixed', { numberOfKeys: 1, lua: LUA_FIXED });
    client.defineCommand('rsSliding', { numberOfKeys: 1, lua: LUA_SLIDING });
    client.defineCommand('rsToken', { numberOfKeys: 1, lua: LUA_TOKEN });
  }

  /** Ждёт первого успешного подключения; не бросает — сервис стартует и в деградированном режиме. */
  async waitReady(timeoutMs = 5000) {
    if (this.client.status === 'ready') return true;
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(t); this.client.off('ready', onReady); resolve(ok); };
      const onReady = () => done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      this.client.once('ready', onReady);
    });
  }

  isReady() { return this.client.status === 'ready'; }

  async ping() { return this.client.ping(); }

  async close() {
    try { await this.client.quit(); } catch { this.client.disconnect(); }
  }

  async incrExpire(key, windowMs) {
    const [count, ttlMs] = await this.client.rsFixed(key, windowMs);
    return { count, ttlMs };
  }

  async slidingCount(key, limit, windowMs, now) {
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, count, ttlMs] = await this.client.rsSliding(key, now, windowMs, limit, member);
    return { allowed: allowed === 1, count, ttlMs };
  }

  async tokenBucket(key, capacity, refillPerSec, now, ttlMs) {
    const [allowed, tokens, wait] = await this.client.rsToken(key, capacity, refillPerSec, now, ttlMs);
    return { allowed: allowed === 1, tokens: Number(tokens), ttlMs: wait };
  }
}

// ---------- Redis с запасным in-memory (только для demo) ----------

/**
 * Для публичной демонстрации важно, чтобы лимиты работали ВСЕГДА. Пока Redis готов — используем его;
 * если недоступен (или команда упала) — считаем в памяти процесса, не дожидаясь таймаутов.
 * В боевом режиме (proxy) НЕ используется: там поведение при сбое задаёт FAIL_MODE.
 */
class FallbackStore {
  constructor(primary, fallback) {
    this.mode = primary.mode;
    this.primary = primary;
    this.fallback = fallback;
    this.commandFailed = false; // true, если последняя команда к «готовому» Redis упала
  }

  usingFallback() { return !this.primary.isReady() || this.commandFailed; }
  waitReady(ms) { return this.primary.waitReady(ms); }
  ping() { return this.primary.ping(); }
  async close() { await this.primary.close(); await this.fallback.close(); }

  async _call(method, args) {
    if (this.primary.isReady()) {
      try {
        const r = await this.primary[method](...args);
        this.commandFailed = false;
        resolveWarn('redis-fallback');
        return r;
      } catch (err) {
        this.commandFailed = true;
        warnOnce('redis-fallback', 'Redis не ответил — счёт ведётся в памяти (demo)', { error: err.message });
      }
    }
    return this.fallback[method](...args);
  }

  incrExpire(...a) { return this._call('incrExpire', a); }
  slidingCount(...a) { return this._call('slidingCount', a); }
  tokenBucket(...a) { return this._call('tokenBucket', a); }
}

function describeConnectError(err) {
  const code = err.code || '';
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(err.message)) {
    return 'Хост не отвечает. Проверьте адрес и порт в REDIS_URL; для облачных Redis (Upstash и др.) нужен rediss://; '
      + 'внутренние адреса Render/Railway работают только внутри их сети; проверьте IP-allowlist базы.';
  }
  if (code === 'ENOTFOUND') return 'Имя хоста не найдено — проверьте адрес в REDIS_URL.';
  if (code === 'ECONNREFUSED') return 'Соединение отклонено — Redis не запущен на этом адресе/порту.';
  if (/WRONGPASS|NOAUTH|invalid password/i.test(err.message)) return 'Неверный пароль или пользователь в REDIS_URL.';
  if (/ECONNRESET|EPROTO|SSL|TLS|wrong version/i.test(`${code} ${err.message}`)) {
    return 'Ошибка TLS/протокола: для защищённых Redis используйте rediss://, для обычных — redis://.';
  }
  return undefined;
}

/**
 * createStore({ url, timeoutMs, fallbackToMemory })
 * Если REDIS_URL задан — используем Redis. В боевых режимах молчаливого отката на память нет:
 * при проблемах с Redis поведение определяет FAIL_MODE (open/closed).
 * fallbackToMemory (для demo) — запасной in-memory, чтобы демонстрация лимитов работала всегда.
 */
function createStore(options = {}) {
  const url = options.url !== undefined ? options.url : process.env.REDIS_URL;

  if (!url) {
    log('info', 'REDIS_URL не задан — in-memory режим (счётчики живут в процессе и не общие между инстансами)');
    return new MemoryStore();
  }

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('REDIS_URL — некорректный URL (ожидается redis://… или rediss://…)'); }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL должен начинаться с redis:// или rediss://');

  // Облачные Redis вроде Upstash принимают только TLS: если забыли вторую «s», включаем TLS сами.
  const needsTls = parsed.protocol === 'redis:' && /\.upstash\.io$/i.test(parsed.hostname);
  const tls = parsed.protocol === 'rediss:' || needsTls;
  log('info', 'Redis: подключаемся', { host: parsed.hostname, port: Number(parsed.port) || 6379, tls });
  if (needsTls) log('warn', 'Upstash требует TLS — включён автоматически; лучше укажите rediss:// в REDIS_URL');

  const Redis = require('ioredis');
  const client = new Redis(url, {
    ...(needsTls ? { tls: { servername: parsed.hostname } } : {}),
    maxRetriesPerRequest: 1,
    commandTimeout: options.timeoutMs || 1000,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  client.on('ready', () => {
    const wasDown = resolveWarn('redis-error');
    resolveWarn('redis-fallback');
    resolveWarn('limiter-error');
    log('info', wasDown ? 'Redis снова доступен' : 'Redis подключён');
  });
  // Одна запись на сбой (а не на каждую попытку переподключения); при восстановлении — сообщение выше.
  client.on('error', (err) => {
    warnOnce('redis-error', 'Redis недоступен', { error: err.message, code: err.code, hint: describeConnectError(err) });
  });

  const store = new RedisStore(client);
  return options.fallbackToMemory ? new FallbackStore(store, new MemoryStore()) : store;
}

module.exports = { createStore, MemoryStore, RedisStore, FallbackStore };
