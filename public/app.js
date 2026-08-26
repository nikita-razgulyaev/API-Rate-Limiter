const $ = (id) => document.getElementById(id);

// ---------- Playground ----------

const sendBtn = $('sendBtn');
const spamBtn = $('spamBtn');
const clearBtn = $('clearBtn');
const logEl = $('log');
const algorithmSelect = $('algorithm');
const limitInput = $('limit');
const windowInput = $('window');

const statusLimit = $('statusLimit');
const statusRemaining = $('statusRemaining');
const statusReset = $('statusReset');
const statusAlgo = $('statusAlgo');

limitInput.addEventListener('input', () => { $('limitValue').textContent = limitInput.value; });
windowInput.addEventListener('input', () => { $('windowValue').textContent = windowInput.value; });

function addLog(status, message, detail) {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + status;

  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  const statusText = status === 'ok' ? '✅ OK' : status === 'blocked' ? '❌ 429' : '⚠️ ERR';

  entry.innerHTML =
    '<span class="time">' + time + '</span>' +
    '<span class="status ' + status + '">' + statusText + '</span>' +
    '<span class="detail">' + message + ' ' + (detail || '') + '</span>';

  logEl.insertBefore(entry, logEl.firstChild);
}

async function sendRequest() {
  const base = algorithmSelect.value;
  const params = new URLSearchParams({ limit: limitInput.value, window: windowInput.value });
  const endpoint = base + '?' + params.toString();

  try {
    const res = await fetch(endpoint);
    const data = await res.json();

    statusLimit.textContent = res.headers.get('X-RateLimit-Limit');
    statusRemaining.textContent = res.headers.get('X-RateLimit-Remaining');
    statusReset.textContent = res.headers.get('X-RateLimit-Reset') + 'с';
    statusAlgo.textContent = res.headers.get('X-RateLimit-Algorithm');

    if (res.status === 429) {
      addLog('blocked', 'Запрос заблокирован', '— retry через ' + data.retryAfter + 'с');
    } else if (res.ok) {
      addLog('ok', data.message, '— осталось ' + data.remaining);
    } else {
      addLog('error', data.error || 'Ошибка');
    }
  } catch (err) {
    addLog('error', 'Сетевой сбой', err.message);
  }

  refreshDashboard();
}

sendBtn.addEventListener('click', sendRequest);

spamBtn.addEventListener('click', async () => {
  spamBtn.disabled = true;
  spamBtn.textContent = 'Отправка...';

  for (let i = 0; i < 10; i++) {
    await sendRequest();
    await new Promise((r) => setTimeout(r, 100));
  }

  spamBtn.disabled = false;
  spamBtn.textContent = 'Спам 10 запросов';
});

clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; });

// ---------- Nav status ----------

async function pingStatus() {
  const navStatus = $('navStatus');
  try {
    const res = await fetch('/status');
    const data = await res.json();
    const dotClass = data.redis === 'connected' || data.redis === 'n/a (in-memory demo mode)' ? 'dot--ok' : 'dot--err';
    const label = data.store === 'redis' ? 'redis · connected' : 'in-memory demo mode';
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
