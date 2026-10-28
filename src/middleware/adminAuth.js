'use strict';

const crypto = require('crypto');

const h = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Bearer-токен (ADMIN_TOKEN). Сравнение в постоянное время. */
function adminAuth(token) {
  const expected = h(token);
  return (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m && crypto.timingSafeEqual(h(m[1].trim()), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = adminAuth;
