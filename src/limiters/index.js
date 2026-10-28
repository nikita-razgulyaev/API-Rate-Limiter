'use strict';

const fixedWindow = require('./fixedWindow');
const slidingWindow = require('./slidingWindow');
const tokenBucket = require('./tokenBucket');

const ALGORITHMS = {
  fixed: { id: 'fixed', name: 'fixed-window', fn: fixedWindow },
  sliding: { id: 'sliding', name: 'sliding-window', fn: slidingWindow },
  token: { id: 'token', name: 'token-bucket', fn: tokenBucket },
};

const ALIASES = {
  'fixed-window': 'fixed',
  'sliding-window': 'sliding',
  'token-bucket': 'token',
};

function resolveAlgorithm(name) {
  const id = ALIASES[name] || name;
  const algo = ALGORITHMS[id];
  if (!algo) throw new Error(`Unknown algorithm "${name}". Use: fixed | sliding | token`);
  return algo;
}

module.exports = { ALGORITHMS, resolveAlgorithm };
