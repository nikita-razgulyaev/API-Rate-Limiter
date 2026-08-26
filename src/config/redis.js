const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  tls: redisUrl.startsWith('rediss://') || redisUrl.includes('upstash') ? {} : undefined,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3
});

redis.on('connect', () => console.log('✅ Redis подключен'));
redis.on('error', (err) => console.error('❌ Redis ошибка:', err.message));

module.exports = redis;
