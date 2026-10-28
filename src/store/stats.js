'use strict';

const MAX_TIMELINE = 50;

const state = {
  startedAt: Date.now(),
  totals: { ok: 0, blocked: 0, error: 0 },
  byAlgorithm: {
    'fixed-window': { ok: 0, blocked: 0 },
    'sliding-window': { ok: 0, blocked: 0 },
    'token-bucket': { ok: 0, blocked: 0 },
  },
  bySource: {}, // demo | proxy | check | middleware
  timeline: [],
};

function record({ algorithm, allowed, source = 'middleware' }) {
  const bucket = allowed ? 'ok' : 'blocked';
  state.totals[bucket] += 1;
  if (state.byAlgorithm[algorithm]) state.byAlgorithm[algorithm][bucket] += 1;
  const s = (state.bySource[source] ||= { ok: 0, blocked: 0 });
  s[bucket] += 1;
  state.timeline.push({ t: Date.now(), algorithm, allowed });
  if (state.timeline.length > MAX_TIMELINE) state.timeline.shift();
}

function recordError() {
  state.totals.error += 1;
}

function snapshot() {
  const total = state.totals.ok + state.totals.blocked + state.totals.error;
  return {
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    totals: state.totals,
    blockRatePercent: total ? Math.round((state.totals.blocked / total) * 1000) / 10 : 0,
    byAlgorithm: state.byAlgorithm,
    bySource: state.bySource,
    timeline: state.timeline,
  };
}

module.exports = { record, recordError, snapshot };
