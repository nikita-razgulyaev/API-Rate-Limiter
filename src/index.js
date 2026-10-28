'use strict';

/** Публичный API библиотеки: require('rateshield') */
const { createStore, MemoryStore, RedisStore } = require('./config/store');
const rateLimit = require('./middleware/rateLimit');
const { ALGORITHMS, resolveAlgorithm } = require('./limiters');
const { enforce } = require('./core/enforce');

module.exports = { createStore, MemoryStore, RedisStore, rateLimit, enforce, ALGORITHMS, resolveAlgorithm };
