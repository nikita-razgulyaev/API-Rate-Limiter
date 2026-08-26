'use strict';

/**
 * Storage abstraction for the rate limiters.
 *
 * Two implementations share the same interface:
 *  - RedisStore  -> production mode, backed by Redis / Upstash (ioredis)
 *  - MemoryStore -> zero-config demo mode, backed by an in-process Map
 *
 * This means the demo runs out of the box with `npm start` and no external
 * dependencies, but flipping on REDIS_URL in .env instantly makes it a real,
 * distributed rate limiter — the same code path a production deployment uses.
 */

class MemoryStore {
  constructor() {
    this.counters = new Map(); // key -> { count, expiresAt }
    this.sortedSets = new Map(); // key -> Array<{ member, score }>
    this.buckets = new Map(); // key -> { tokens, last, expiresAt }
    this.mode = 'memory';

    setInterval(() => this._sweep(), 30_000).unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.counters) if (v.expiresAt <= now) this.counters.delete(k);
    for (const [k, v] of this.buckets) if (v.expiresAt <= now) this.buckets.delete(k);
  }

  async ping() {
    return 'PONG';
  }

  async incrExpire(key, windowMs) {
    const now = Date.now();
    let entry = this.counters.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + windowMs };
      this.counters.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, ttlMs: entry.expiresAt - now };
  }

  async slidingCount(key, now, windowMs) {
    let set = this.sortedSets.get(key);
    if (!set) {
      set = [];
      this.sortedSets.set(key, set);
    }
    const cutoff = now - windowMs;
    while (set.length && set[0].score <= cutoff) set.shift();
    set.push({ member: `${now}-${Math.random().toString(36).slice(2, 8)}`, score: now });
    const oldest = set[0].score;
    const ttlMs = Math.max(0, oldest + windowMs - now);
    return { count: set.length, ttlMs };
  }

  async tokenBucket(key, capacity, refillPerSec, now, ttlMs) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: now, expiresAt: now + ttlMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = Math.max(0, (now - bucket.last) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.last = now;
    bucket.expiresAt = now + ttlMs;

    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }
    const secToNextToken = allowed ? 0 : (1 - bucket.tokens) / refillPerSec;
    return { allowed, tokens: bucket.tokens, capacity, ttlMs: Math.ceil(secToNextToken * 1000) };
  }
}

class RedisStore {
  constructor(client) {
    this.client = client;
    this.mode = 'redis';
  }

  async ping() {
    return this.client.ping();
  }

  async incrExpire(key, windowMs) {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.pexpire(key, windowMs);
    }
    const ttlMs = await this.client.pttl(key);
    return { count, ttlMs: ttlMs > 0 ? ttlMs : windowMs };
  }

  async slidingCount(key, now, windowMs) {
    const cutoff = now - windowMs;
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

    const pipeline = this.client.pipeline();
    pipeline.zremrangebyscore(key, 0, cutoff);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs);
    pipeline.zrange(key, 0, 0, 'WITHSCORES');
    const results = await pipeline.exec();

    const count = results[2][1];
    const oldestPair = results[4][1]; // [member, score]
    const oldest = oldestPair && oldestPair.length ? Number(oldestPair[1]) : now;
    const ttlMs = Math.max(0, oldest + windowMs - now);
    return { count, ttlMs };
  }

  async tokenBucket(key, capacity, refillPerSec, now, ttlMs) {
    const raw = await this.client.get(key);
    let tokens = capacity;
    let last = now;
    if (raw) {
      const parsed = JSON.parse(raw);
      tokens = parsed.tokens;
      last = parsed.last;
    }

    const elapsedSec = Math.max(0, (now - last) / 1000);
    tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);

    let allowed = false;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = true;
    }

    await this.client.set(key, JSON.stringify({ tokens, last: now }), 'PX', ttlMs);

    const secToNextToken = allowed ? 0 : (1 - tokens) / refillPerSec;
    return { allowed, tokens, capacity, ttlMs: Math.ceil(secToNextToken * 1000) };
  }
}

function createStore() {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.log('ℹ️  REDIS_URL не задан — работаем в demo-режиме (in-memory store).');
    console.log('   Для продакшена и распределённого лимитинга задай REDIS_URL в .env (например, Upstash).');
    return new MemoryStore();
  }

  try {
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on('error', (err) => console.error('Redis error:', err.message));
    console.log('🔌 Подключаемся к Redis:', url.replace(/:[^:@/]*@/, ':***@'));
    return new RedisStore(client);
  } catch (err) {
    console.error('⚠️  Не удалось инициализировать Redis, переключаюсь на in-memory store:', err.message);
    return new MemoryStore();
  }
}

module.exports = { createStore, MemoryStore, RedisStore };
