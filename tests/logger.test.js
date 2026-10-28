'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { warnOnce, resolveWarn } = require('../src/utils/logger');

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(JSON.parse(l));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('warnOnce: одна запись на сбой, повтор после resolveWarn', () => {
  const lines = capture(() => {
    for (let i = 0; i < 50; i++) warnOnce('t-key', 'сбой', { i });
    assert.equal(resolveWarn('t-key'), true);
    warnOnce('t-key', 'сбой снова', {});
    warnOnce('t-key', 'сбой снова', {});
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message, 'сбой');
  assert.equal(lines[1].message, 'сбой снова');
});

test('resolveWarn без активной проблемы возвращает false', () => {
  assert.equal(resolveWarn('nope-key'), false);
});
