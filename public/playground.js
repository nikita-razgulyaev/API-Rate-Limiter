/*
 * Playground: режимы (один алгоритм / сравнение трёх), «дорожки» с живой визуализацией
 * состояния каждого алгоритма и сценарии нагрузки.
 *
 * Визуализация строится из состояния, которое сервер возвращает в каждом ответе
 * (current / resetMs / tokens), и дальше «доигрывается» на клиенте во времени:
 * таймеры идут, токены капают, слоты освобождаются.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SPAN_MS = 30_000; // ширина ленты решений
  const ABORT = Symbol('abort');
  const ORDER = ['fixed', 'sliding', 'token'];

  const ALGOS = {
    fixed: {
      path: '/fixed', name: 'Fixed Window', icon: '▦', chip: 'Fixed',
      how: '',
    },
    sliding: {
      path: '/sliding', name: 'Sliding Window', icon: '◔', chip: 'Sliding',
      how: '',
    },
    token: {
      path: '/token', name: 'Token Bucket', icon: '⛁', chip: 'Token',
      how: '',
    },
  };

  const S = {
    mode: 'fixed',
    limit: 5,
    windowSec: 15, // короче по умолчанию — чтобы обычному человеку было видно сброс
    sid: rid(),
    lanes: {},
    run: null,
  };

  function rid() { return Math.random().toString(36).slice(2, 10); }
  const fmtN = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
  const fmtTok = (n) => fmtN(Math.floor(n * 10 + 1e-9) / 10); // вниз: 0,96 -> «0,9», а не «1,0»
  function fmtS(ms) {
    const s = Math.max(0, ms) / 1000;
    return (s < 10 ? fmtN(s) : String(Math.ceil(s))) + ' с';
  }

  // ------------------------------------------------------------------ Lane

  class Lane {
    constructor(key, host) {
      this.key = key;
      this.meta = ALGOS[key];
      this.el = document.createElement('article');
      this.el.className = `lane lane--${key}`;
      this.el.innerHTML = `
        <header class="lane__head">
          <span class="lane__icon">${this.meta.icon}</span>
          <h3 class="lane__title">${this.meta.name}</h3>
          <div class="lane__tally">
            <span class="tally tally--ok" data-ok title="ок">0</span>
            <span class="tally tally--bad" data-bad title="отказ">0</span>
          </div>
        </header>
        <div class="lane__viz">${this.vizHtml()}</div>
        <p class="lane__explain" data-explain></p>
        <div class="strip" data-strip><i class="strip__now"></i></div>`;
      host.appendChild(this.el);

      const q = (sel) => this.el.querySelector(sel);
      this.cellsEl = q('[data-cells]');
      this.meterEl = q('[data-meter]');
      this.meterLabelEl = q('[data-meterlabel]');
      this.explainEl = q('[data-explain]');
      this.stripEl = q('[data-strip]');
      this.footEl = { textContent: '', innerHTML: '', style: {} }; // stub — foot removed
      this.cache = this.cache || {};
      this.okEl = q('[data-ok]');
      this.badEl = q('[data-bad]');
      this.reset();
    }

    vizHtml() {
      if (this.key === 'fixed') {
        return `<div class="cells" data-cells></div>
                <div class="meter"><div class="meter__bar" data-meter></div></div>
                <div class="meter__label" data-meterlabel></div>`;
      }
      if (this.key === 'sliding') {
        return `<div class="cells cells--slots" data-cells></div>
                <div class="meter__label" data-meterlabel></div>`;
      }
      return `<div class="tokens" data-cells></div>
              <div class="meter"><div class="meter__bar" data-meter></div></div>
              <div class="meter__label" data-meterlabel></div>`;
    }

    reset() {
      this.events = [];
      this.acc = []; // времена принятых запросов
      this.ok = 0;
      this.bad = 0;
      this.okEl.textContent = '0';
      this.badEl.textContent = '0';
      this.state = null;
      this.slots = [];
      this.marks = [];
      this.windowEnd = 0;
      this.wasActive = false;
      this.cache = {};
      this.dots = [];
      this.markEls = [];
      this.stripEl.querySelectorAll('.strip__dot, .strip__mark').forEach((n) => n.remove());

      this.cellsEl.innerHTML = '';
      this.items = Array.from({ length: S.limit }, () => {
        const el = document.createElement('div');
        el.className = this.key === 'fixed' ? 'cell' : this.key === 'sliding' ? 'slot' : 'tok';
        if (this.key === 'sliding') el.innerHTML = '<i class="slot__fill"></i>';
        this.cellsEl.appendChild(el);
        return el;
      });
      this.render(Date.now());
    }

    record({ t, allowed, data }) {
      this.events.push({ t, allowed });
      if (this.events.length > 400) this.events.shift();
      if (allowed) { this.ok += 1; this.acc.push(t); } else { this.bad += 1; }

      if (data && typeof data.current === 'number') {
        this.state = { t, ...data };
        const W = S.windowSec * 1000;
        if (this.key === 'fixed') {
          this.windowEnd = t + (data.resetMs || 0);
          const last = this.marks[this.marks.length - 1];
          if (!last || Math.abs(last - this.windowEnd) > 700) this.marks.push(this.windowEnd);
          if (this.marks.length > 6) this.marks.shift();
        }
        if (this.key === 'sliding') {
          if (allowed) this.slots.push({ exp: t + W });
          while (this.slots.length > data.current) this.slots.shift(); // сервер уже освободил слоты
          if (this.slots.length && data.resetMs > 0) this.slots[0].exp = t + data.resetMs; // сверка по серверу
        }
      }
      this.okEl.textContent = this.ok;
      this.badEl.textContent = this.bad;
      this.render(Date.now());
    }

    /** Максимум принятых запросов в любом промежутке короче окна (и минимальная длительность такого пика). */
    peak() {
      const W = S.windowSec * 1000;
      const a = this.acc;
      let best = { n: 0, ms: 0 };
      let j = 0;
      for (let i = 0; i < a.length; i++) {
        if (j < i) j = i;
        while (j + 1 < a.length && a[j + 1] - a[i] < W) j += 1;
        const n = j - i + 1;
        const ms = a[j] - a[i];
        if (n > best.n || (n === best.n && ms < best.ms)) best = { n, ms };
      }
      return best;
    }

    setText(el, key, html) {
      if (this.cache[key] !== html) { this.cache[key] = html; el.innerHTML = html; }
    }

    render(now) {
      const L = S.limit;
      const W = S.windowSec * 1000;
      const st = this.state;
      let explain = '';
      let blocked = false;

      if (this.key === 'fixed') {
        const active = Boolean(st) && now < this.windowEnd;
        const cur = active ? Math.min(st.current, L) : 0;
        this.items.forEach((el, i) => el.classList.toggle('is-on', i < cur));
        const left = active ? this.windowEnd - now : 0;
        this.meterEl.style.width = `${((left / W) * 100).toFixed(1)}%`;
        this.setText(this.meterLabelEl, 'ml', active ? `сброс через <b>${fmtS(left)}</b>` : 'ожидание');

        if (this.wasActive && !active) {
          this.el.classList.add('is-reset-flash');
          setTimeout(() => this.el.classList.remove('is-reset-flash'), 750);
        }
        this.wasActive = active;

        if (!st) explain = `Первый запрос откроет окно на <b>${S.windowSec} с</b>`;
        else if (!active) explain = `Окно закончилось — счётчик обнулился`;
        else if (st.current >= L) {
          blocked = true;
          explain = `Лимит <b>${L}/${L}</b> · сброс через <b>${fmtS(left)}</b>`;
        } else explain = `<b>${cur}/${L}</b> · сброс через <b>${fmtS(left)}</b>`;
      }

      if (this.key === 'sliding') {
        while (this.slots.length && this.slots[0].exp <= now) this.slots.shift();
        const n = this.slots.length;
        this.items.forEach((el, i) => {
          const s = this.slots[i];
          el.classList.toggle('is-on', Boolean(s));
          el.firstChild.style.width = s ? `${Math.max(0, ((s.exp - now) / W) * 100).toFixed(1)}%` : '0%';
        });
        if (n === 0) explain = `Свободно <b>${L}</b> слотов`;
        else if (n >= L) {
          blocked = true;
          explain = `Занято <b>${n}/${L}</b> · слот через <b>${fmtS(this.slots[0].exp - now)}</b>`;
        } else explain = `<b>${n}/${L}</b> · слот через <b>${fmtS(this.slots[0].exp - now)}</b>`;
      }

      if (this.key === 'token') {
        const refill = L / S.windowSec; // токенов в секунду
        const tokens = st ? Math.min(L, st.tokens + ((now - st.t) / 1000) * refill) : L;
        const full = Math.floor(tokens + 1e-9);
        const frac = tokens - full;
        this.items.forEach((el, i) => {
          const isFull = i < full;
          el.classList.toggle('is-full', isFull);
          el.style.setProperty('--p', isFull ? '360deg' : (i === full ? `${Math.round(frac * 360)}deg` : '0deg'));
        });
        const full1 = tokens >= L - 1e-9;
        this.meterEl.style.width = full1 ? '100%' : `${(frac * 100).toFixed(1)}%`;
        const nextMs = ((1 - frac) / refill) * 1000;
        this.setText(this.meterLabelEl, 'ml', full1 ? 'бак полон' : `+1 через <b>${fmtS(nextMs)}</b>`);

        if (st && tokens < 1) {
          blocked = true;
          explain = `Токены кончились · +1 каждые <b>${fmtN(1 / refill)} с</b>`;
        } else if (full1) {
          explain = `Бак полон · можно <b>${L}</b> подряд`;
        } else {
          explain = `<b>${fmtTok(tokens)}</b> / ${L} · +1 каждые <b>${fmtN(1 / refill)} с</b>`;
        }
      }

      this.explainEl.classList.toggle('is-blocked', blocked);
      this.setText(this.explainEl, 'ex', explain);

      this.renderStrip(now);

      const pk = this.peak();
      this.setText(
        this.footEl,
        'foot',
        this.acc.length
          ? `Максимум принятых подряд: <b class="${pk.n > L && this.key !== 'token' ? 'is-over' : ''}">${pk.n}</b>${pk.n > 1 ? ` за ${fmtS(pk.ms)}` : ''} ${this.key === 'token' ? `(бак ${L} + капли)` : `(лимит ${L} / ${S.windowSec} с)`}`
          : 'Пока ни одного принятого запроса',
      );
    }

    renderStrip(now) {
      let k = 0;
      for (let i = this.events.length - 1; i >= 0; i--) {
        const e = this.events[i];
        const age = now - e.t;
        if (age > SPAN_MS) break;
        let d = this.dots[k];
        if (!d) { d = document.createElement('i'); this.stripEl.appendChild(d); this.dots.push(d); }
        d.style.display = '';
        d.className = 'strip__dot' + (e.allowed ? '' : ' is-bad');
        d.style.left = `${((1 - age / SPAN_MS) * 100).toFixed(2)}%`;
        k += 1;
      }
      for (; k < this.dots.length; k++) this.dots[k].style.display = 'none';

      if (this.key === 'fixed') {
        let m = 0;
        for (const t of this.marks) {
          const age = now - t;
          if (age < 0 || age > SPAN_MS) continue;
          let el = this.markEls[m];
          if (!el) { el = document.createElement('i'); el.className = 'strip__mark'; this.stripEl.appendChild(el); this.markEls.push(el); }
          el.style.display = '';
          el.style.left = `${((1 - age / SPAN_MS) * 100).toFixed(2)}%`;
          m += 1;
        }
        for (; m < this.markEls.length; m++) this.markEls[m].style.display = 'none';
      }
    }
  }

  // ------------------------------------------------------------------ Controller

  const lanesHost = $('lanes');
  const logEl = $('log');
  const hintEl = $('pgHint');
  const sendBtn = $('sendBtn');
  const stopBtn = $('stopBtn');
  const limitInput = $('limit');
  const windowInput = $('window');

  const activeKeys = () => (S.mode === 'compare' ? ORDER : [S.mode]);

  function defaultHint() {
    return S.mode === 'compare'
      ? 'Один клик — запрос во все три алгоритма сразу'
      : 'Нажмите «Отправить» 6–7 раз подряд';
  }

  function buildLanes() {
    lanesHost.innerHTML = '';
    S.lanes = {};
    lanesHost.className = 'lanes ' + (S.mode === 'compare' ? 'lanes--compare' : 'lanes--single');
    activeKeys().forEach((k) => { S.lanes[k] = new Lane(k, lanesHost); });
    $('statusBar').hidden = true; // показываем только после первого ответа
  }

  function resetStatusBar() {
    ['statusLimit', 'statusRemaining', 'statusReset', 'statusAlgo'].forEach((id) => { $(id).textContent = '–'; });
  }

  function resetAll() {
    abortRun();
    S.sid = rid();
    Object.values(S.lanes).forEach((l) => l.reset());
    resetStatusBar();
    $('verdict').hidden = true;
  }

  function setMode(mode) {
    abortRun();
    S.mode = mode;
    document.querySelectorAll('.pg-mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    buildLanes();
    resetAll();
    hintEl.textContent = defaultHint();
  }

  function setParams(limit, windowSec) {
    S.limit = limit;
    S.windowSec = windowSec;
    limitInput.value = limit;
    windowInput.value = windowSec;
    $('limitValue').textContent = limit;
    $('windowValue').textContent = windowSec;
    resetAll();
  }

  // ---- log

  function logText(key, ok, d) {
    const L = d.limit;
    if (key === 'fixed') {
      return ok
        ? `окно ${d.current}/${L} · сброс через ${fmtS(d.resetMs)}`
        : `окно исчерпано (${L}/${L}) · сброс через ${fmtS(d.resetMs)}`;
    }
    if (key === 'sliding') {
      return ok
        ? `в окне ${d.current}/${L} · старейший уйдёт через ${fmtS(d.resetMs)}`
        : `в окне ${L}/${L} · слот освободится через ${fmtS(d.resetMs)}`;
    }
    return ok
      ? `токенов ${fmtTok(d.tokens)}/${L} · +1 каждые ${fmtN(d.windowSec / L)} с`
      : `токены закончились (${fmtTok(d.tokens)}) · следующий через ${fmtS(d.resetMs)}`;
  }

  function addLog(key, allowed, d) {
    const status = allowed === true ? 'ok' : allowed === false ? 'blocked' : 'error';
    const entry = document.createElement('div');
    entry.className = `log-entry ${status}`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false });

    const st = document.createElement('span');
    st.className = `status ${status}`;
    st.textContent = status === 'ok' ? '✅ OK' : status === 'blocked' ? '❌ 429' : '⚠️ ERR';

    const chip = document.createElement('span');
    chip.className = `chip chip--${key}`;
    chip.textContent = ALGOS[key].chip;

    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = status === 'error' ? (d.error || 'Ошибка') : logText(key, allowed, d);

    entry.append(time, st, chip, detail);
    logEl.insertBefore(entry, logEl.firstChild);
    while (logEl.children.length > 200) logEl.lastChild.remove();
  }

  // ---- запросы

  let dashTimer = null;
  function scheduleDashboard() {
    clearTimeout(dashTimer);
    dashTimer = setTimeout(() => { if (typeof refreshDashboard === 'function') refreshDashboard(); }, 600);
  }

  function updateStatusBar(res) {
    $('statusBar').hidden = false;
    $('statusLimit').textContent = res.headers.get('X-RateLimit-Limit');
    $('statusRemaining').textContent = res.headers.get('X-RateLimit-Remaining');
    $('statusReset').textContent = (res.headers.get('X-RateLimit-Reset') || '–') + 'с';
    $('statusAlgo').textContent = res.headers.get('X-RateLimit-Algorithm');
  }

  async function callLane(key) {
    const lane = S.lanes[key];
    if (!lane) return;
    const sid = S.sid;
    const url = `${ALGOS[key].path}?limit=${S.limit}&window=${S.windowSec}&sid=${sid}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (sid !== S.sid) return; // пока шёл запрос, нажали «Сбросить»
      const t = Date.now();
      if (res.status === 200 || res.status === 429) {
        lane.record({ t, allowed: res.status === 200, data });
        addLog(key, res.status === 200, data);
        if (S.mode !== 'compare') updateStatusBar(res);
      } else {
        addLog(key, null, { error: data.error || `HTTP ${res.status}` });
      }
    } catch (err) {
      addLog(key, null, { error: `Сетевой сбой: ${err.message}` });
    }
  }

  async function fireRound() {
    await Promise.all(activeKeys().map(callLane));
    scheduleDashboard();
  }

  // ------------------------------------------------------------------ Сценарии

  const SCENARIOS = {
    burst: {
      title: 'Всплеск',
      params: [5, 15],
      hint: 'Много запросов сразу, потом редкие проверки',
      async run(c) {
        const n = Math.min(c.limit * 2, 30);
        for (let i = 0; i < n; i++) { await c.fire(); await c.sleep(30); }
        const t0 = Date.now();
        for (let k = 1; k * 2000 <= (c.windowSec + 3) * 1000; k++) {
          await c.sleepUntil(t0 + k * 2000);
          await c.fire();
        }
      },
      verdict: (lanes, { L, W }) => `После всплеска: Fixed и Sliding ждут конца окна, Token отдаёт по 1 каждые <b>${fmtN(W / L)} с</b>.`,
    },
    steady: {
      title: 'Постоянно',
      params: [5, 10],
      hint: 'Запрос каждую секунду',
      async run(c) {
        const t0 = Date.now();
        for (let i = 0; i < 20; i++) { await c.sleepUntil(t0 + i * 1000); await c.fire(); }
      },
      verdict: (lanes, { L, W }) => `Fixed и Sliding — пачками по ${L}. Token — ровно 1 каждые <b>${fmtN(W / L)} с</b>.`,
    },
    boundary: {
      title: 'Граница окна',
      params: [5, 10],
      hint: 'Лимит в конце окна + сразу после сброса',
      async run(c) {
        await c.fire();
        const end = c.windowEnd() || (Date.now() + c.windowSec * 1000);
        await c.sleepUntil(end - 900);
        for (let i = 0; i < c.limit - 1; i++) { await c.fire(); await c.sleep(50); }
        await c.sleepUntil(end + 350);
        for (let i = 0; i < c.limit; i++) { await c.fire(); await c.sleep(50); }
      },
      verdict: (lanes, { L, W }) => {
        const f = lanes.fixed && lanes.fixed.peak();
        if (f && f.n > L) {
          return `<b>Fixed</b> пропустил <b>${f.n}</b> за <b>${fmtS(f.ms)}</b> (лимит ${L}) — стык окон. Sliding и Token держат лимит.`;
        }
        if (f) return 'Стык не поймался — запустите ещё раз.';
        return 'Сравните, сколько прошло у каждого.';
      },
    },
  };

  function abortRun() {
    if (!S.run) return;
    S.run.aborted = true;
    S.run.cancels.forEach((f) => f());
  }

  function setRunningUI(name) {
    const running = Boolean(name);
    sendBtn.hidden = running; // «Стоп» занимает место кнопки отправки — ряд не переносится
    stopBtn.hidden = !running;
    limitInput.disabled = running;
    windowInput.disabled = running;
    document.querySelectorAll('.pg-scn').forEach((b) => {
      b.disabled = running;
      b.classList.toggle('is-running', b.dataset.scn === name);
    });
  }

  async function startScenario(name) {
    if (S.run) return;
    const sc = SCENARIOS[name];
    setParams(sc.params[0], sc.params[1]);
    hintEl.textContent = sc.hint;

    const run = { aborted: false, cancels: new Set() };
    S.run = run;
    setRunningUI(name);

    const sleep = (ms) => new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      run.cancels.add(() => { clearTimeout(id); reject(ABORT); });
    });
    const ctx = {
      limit: S.limit,
      windowSec: S.windowSec,
      sleep,
      sleepUntil: (t) => sleep(Math.max(0, t - Date.now())),
      fire: async () => { if (run.aborted) throw ABORT; await fireRound(); },
      windowEnd: () => (S.lanes.fixed && S.lanes.fixed.windowEnd) || 0,
    };

    try {
      await sleep(250);
      await sc.run(ctx);
    } catch (e) {
      if (e !== ABORT) console.error(e);
    }
    S.run = null;
    setRunningUI(null);
    if (!run.aborted) showVerdict(sc);
  }

  function showVerdict(sc) {
    const L = S.limit;
    const W = S.windowSec;
    const rows = activeKeys().map((k) => {
      const l = S.lanes[k];
      const pk = l.peak();
      return `<span class="verdict__row verdict__row--${k}"><b>${ALGOS[k].name}</b> принято ${l.ok} · отклонено ${l.bad} · пик ${pk.n}${pk.n > 1 ? ` за ${fmtS(pk.ms)}` : ''}</span>`;
    }).join('');
    const v = $('verdict');
    v.innerHTML = `<div class="verdict__title">Итог сценария «${sc.title}» (лимит ${L} на ${W} с)</div>
      <div class="verdict__rows">${rows}</div>
      <div class="verdict__text">${sc.verdict(S.lanes, { L, W })}</div>`;
    v.hidden = false;
  }

  // ------------------------------------------------------------------ События UI

  document.querySelectorAll('.pg-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.pg-scn').forEach((b) => b.addEventListener('click', () => startScenario(b.dataset.scn)));

  sendBtn.addEventListener('click', () => { $('verdict').hidden = true; fireRound(); });
  stopBtn.addEventListener('click', () => { abortRun(); hintEl.textContent = defaultHint(); });
  $('resetBtn').addEventListener('click', () => { resetAll(); hintEl.textContent = defaultHint(); });
  $('clearBtn').addEventListener('click', () => { logEl.innerHTML = ''; });

  limitInput.addEventListener('input', () => { $('limitValue').textContent = limitInput.value; });
  windowInput.addEventListener('input', () => { $('windowValue').textContent = windowInput.value; });
  const applySliders = () => { S.limit = Number(limitInput.value); S.windowSec = Number(windowInput.value); resetAll(); };
  limitInput.addEventListener('change', applySliders);
  windowInput.addEventListener('change', applySliders);

  // ------------------------------------------------------------------ Цикл отрисовки

  let visible = true;
  const pg = $('pg');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(pg);
  }
  let last = 0;
  function frame(ts) {
    if (visible && !document.hidden && ts - last > 45) {
      last = ts;
      const now = Date.now();
      Object.values(S.lanes).forEach((l) => l.render(now));
    }
    requestAnimationFrame(frame);
  }

  setMode('fixed');
  requestAnimationFrame(frame);
})();
