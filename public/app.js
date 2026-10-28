const $ = (id) => document.getElementById(id);

// ---------- Nav status ----------

async function pingStatus() {
  const navStatus = $('navStatus');
  try {
    const res = await fetch('/status');
    const data = await res.json();
    let dotClass = 'dot--ok';
    let label = 'in-memory demo mode';
    if (data.store === 'redis' && data.redis !== 'connected') {
      // Redis недоступен: демо продолжает работать на запасном in-memory хранилище
      dotClass = data.fallback ? 'dot--pending' : 'dot--err';
      label = data.fallback ? 'redis недоступен · считаем в памяти' : 'redis · error';
    } else if (data.store === 'redis') {
      label = 'redis · connected';
    }
    navStatus.innerHTML = `<span class="dot ${dotClass}"></span>${label}`;
  } catch {
    navStatus.innerHTML = '<span class="dot dot--err"></span>offline';
  }
}

// ---------- Dashboard ----------

const ALGO_LABELS = {
  'fixed-window': 'Fixed Window',
  'sliding-window': 'Sliding Window',
  'token-bucket': 'Token Bucket',
};

async function refreshDashboard() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    const total = data.totals.ok + data.totals.blocked + data.totals.error;
    $('statTotal').textContent = total;
    $('statOk').textContent = data.totals.ok;
    $('statBlocked').textContent = data.totals.blocked;
    $('statRate').textContent = data.blockRatePercent + '%';

    const breakdown = $('algoBreakdown');
    breakdown.innerHTML = '';
    Object.entries(data.byAlgorithm).forEach(([algo, counts]) => {
      const algoTotal = counts.ok + counts.blocked;
      const okPct = algoTotal ? (counts.ok / algoTotal) * 100 : 0;
      const row = document.createElement('div');
      row.className = 'breakdown-row';
      row.innerHTML =
        `<span>${ALGO_LABELS[algo] || algo}</span>` +
        `<span class="breakdown-row__bar"><span class="breakdown-row__ok" style="width:${okPct}%"></span></span>` +
        `<span>${algoTotal}</span>`;
      breakdown.appendChild(row);
    });

    const timeline = $('timeline');
    timeline.innerHTML = '';
    data.timeline.forEach((evt) => {
      const bar = document.createElement('div');
      bar.className = 'timeline-bar' + (evt.allowed ? '' : ' blocked');
      timeline.appendChild(bar);
    });
  } catch {
    // dashboard is best-effort — don't break the playground if it fails
  }
}

pingStatus();
refreshDashboard();
setInterval(refreshDashboard, 4000);
setInterval(pingStatus, 15000);
