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
  timeline: [], // last N events for the live sparkline
};

function record({ algorithm, allowed }) {
  const bucket = allowed ? 'ok' : 'blocked';
  state.totals[bucket] += 1;
  if (state.byAlgorithm[algorithm]) state.byAlgorithm[algorithm][bucket] += 1;

  state.timeline.push({ t: Date.now(), algorithm, allowed });
  if (state.timeline.length > MAX_TIMELINE) state.timeline.shift();
}

function recordError() {
  state.totals.error += 1;
}

function snapshot() {
  const total = state.totals.ok + state.totals.blocked + state.totals.error;
  const blockRate = total ? Math.round((state.totals.blocked / total) * 1000) / 10 : 0;
  return {
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    totals: state.totals,
    blockRatePercent: blockRate,
    byAlgorithm: state.byAlgorithm,
    timeline: state.timeline,
  };
}

module.exports = { record, recordError, snapshot };
