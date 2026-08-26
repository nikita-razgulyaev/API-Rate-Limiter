/**
 * Express/Fastify-совместимый middleware
 *
 * Использование:
 *   app.use(rateLimit(redis, { limit: 10, window: 60 }));
 */

const fixedWindow = require('../limiters/fixedWindow');

function rateLimit(redis, options = {}) {
  const limit = options.limit || 5;
  const window = options.window || 60;
  const keyPrefix = options.keyPrefix || 'rate';

  return async function(req, res, next) {
    const clientId = req.ip
                  || req.headers['x-forwarded-for']?.split(',')[0]
                  || 'unknown';

    const key = keyPrefix + ':' + clientId;

    try {
      const result = await fixedWindow(redis, key, limit, window);

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetIn);

      if (!result.allowed) {
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: result.resetIn
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = rateLimit;
