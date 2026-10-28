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
      how: 'Один счётчик на окно. Когда окно заканчивается, счётчик обнуляется разом.',
    },
    sliding: {
      path: '/sliding', name: 'Sliding Window', icon: '◔', chip: 'Sliding',
      how: 'Каждый запрос занимает слот на всё окно и освобождает его сам, независимо от других.',
    },
    token: {
      path: '/token', name: 'Token Bucket', icon: '⛁', chip: 'Token',
      how: 'Токены капают в бакет непрерывно. Запрос забирает один: всплеск допустим, средний темп держится.',
    },
  };

  const S = {
    mode: 'fixed',
    limit: 5,
    windowSec: 60,
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
          <div>
            <h3 class="lane__title">${this.meta.name}</h3>
            <p class="lane__sub">${this.meta.how}</p>
          </div>
          <div class="lane__tally">
            <span class="tally tally--ok" data-ok title="принято">0</span>
            <span class="tally tally--bad" data-bad title="отклонено (429)">0</span>
          </div>
        </header>
        <div class="lane__viz">${this.vizHtml()}</div>
        <p class="lane__explain" data-explain></p>
        <div>
          <div class="strip" data-strip><i class="strip__now"></i></div>
          <div class="strip__cap"><span>−30 с</span><span>решения по запросам</span><span>сейчас</span></div>
        </div>
        <div class="lane__foot" data-foot></div>`;
      host.appendChild(this.el);

      const q = (sel) => this.el.querySelector(sel);
      this.cellsEl = q('[data-cells]');
      this.meterEl = q('[data-meter]');
      this.meterLabelEl = q('[data-meterlabel]');
      this.explainEl = q('[data-explain]');
      this.stripEl = q('[data-strip]');
      this.footEl = q('[data-foot]');
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
                <div class="meter__label" data-meterlabel>Каждая полоска — отдельный запрос. Она тает и освобождает слот сама.</div>`;
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
        this.setText(this.meterLabelEl, 'ml', active ? `до сброса окна: <b>${fmtS(left)}</b>` : 'окно откроется первым запросом');

        if (this.wasActive && !active) {
          this.el.classList.add('is-reset-flash');
          setTimeout(() => this.el.classList.remove('is-reset-flash'), 750);
        }
        this.wasActive = active;

        if (!st) explain = `Окно ещё не открыто. Первый запрос запустит его на <b>${S.windowSec} с</b>.`;
        else if (!active) explain = `Окно закончилось: счётчик <b>обнулён</b>, снова доступно ${L}.`;
        else if (st.current >= L) {
          blocked = true;
          explain = `Лимит окна исчерпан: <b>${L}/${L}</b>. До сброса все запросы получат 429. Разблокировка произойдёт <b>разом</b> через <b>${fmtS(left)}</b>.`;
        } else explain = `Окно: <b>${cur}/${L}</b>. Счётчик обнулится целиком через <b>${fmtS(left)}</b>.`;
      }

      if (this.key === 'sliding') {
        while (this.slots.length && this.slots[0].exp <= now) this.slots.shift();
        const n = this.slots.length;
        this.items.forEach((el, i) => {
          const s = this.slots[i];
          el.classList.toggle('is-on', Boolean(s));
          el.firstChild.style.width = s ? `${Math.max(0, ((s.exp - now) / W) * 100).toFixed(1)}%` : '0%';
        });
        if (n === 0) explain = `Окно пусто: свободны все <b>${L}</b> слотов.`;
        else if (n >= L) {
          blocked = true;
          explain = `В окне <b>${n}/${L}</b>. Ближайший слот освободится через <b>${fmtS(this.slots[0].exp - now)}</b>. Отклонённые запросы слоты не занимают.`;
        } else explain = `В окне <b>${n}/${L}</b>. Старейший запрос покинет окно через <b>${fmtS(this.slots[0].exp - now)}</b>, слоты освобождаются по одному.`;
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
        this.setText(this.meterLabelEl, 'ml', full1 ? 'бакет полон' : `следующий токен через <b>${fmtS(nextMs)}</b>`);

        if (st && tokens < 1) {
          blocked = true;
          explain = `Токены закончились (<b>${fmtTok(tokens)}</b>). Дальше запросы проходят по одному, в темпе пополнения: +1 токен каждые <b>${fmtN(1 / refill)} с</b>.`;
        } else if (full1) {
          explain = `Бакет полон: сразу можно отправить <b>${L}</b> запросов подряд (всплеск). Пополнение: +1 токен каждые <b>${fmtN(1 / refill)} с</b>.`;
        } else {
          explain = `В бакете <b>${fmtTok(tokens)}</b> из ${L}. Токены капают непрерывно: +1 каждые <b>${fmtN(1 / refill)} с</b>.`;
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
          ? `Пик принятых: <b class="${pk.n > L && this.key !== 'token' ? 'is-over' : ''}">${pk.n}</b>${pk.n > 1 ? ` за ${fmtS(pk.ms)}` : ''} ${this.key === 'token' ? `(ёмкость ${L} + пополнение)` : `(лимит ${L} на ${S.windowSec} с)`}`
          : 'Принятых запросов пока нет',
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
      ? 'Каждый запрос уходит на все три алгоритма одновременно, а реакция у каждого своя. Запусти сценарий и сравни.'
      : 'Отправляй запросы вручную или запусти сценарий. Всё на дорожке живёт во времени: таймеры идут, токены капают.';
  }

  function buildLanes() {
    lanesHost.innerHTML = '';
    S.lanes = {};
    lanesHost.className = 'lanes ' + (S.mode === 'compare' ? 'lanes--compare' : 'lanes--single');
    activeKeys().forEach((k) => { S.lanes[k] = new Lane(k, lanesHost); });
    $('statusBar').hidden = S.mode === 'compare';
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
    $('statusLimit').textContent = res.headers.get('X-RateLimit-Limit');
    $('statusRemaining').textContent = res.headers.get('X-RateLimit-Remaining');
    $('statusReset').textContent = res.headers.get('X-RateLimit-Reset') + 'с';
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
      hint: 'Сразу 10 запросов (вдвое больше лимита), затем «проба» каждые 2 секунды. Смотри, как каждый алгоритм возвращается к жизни после блокировки.',
      async run(c) {
        const n = Math.min(c.limit * 2, 30);
        for (let i = 0; i < n; i++) { await c.fire(); await c.sleep(30); }
        const t0 = Date.now();
        for (let k = 1; k * 2000 <= (c.windowSec + 3) * 1000; k++) {
          await c.sleepUntil(t0 + k * 2000);
          await c.fire();
        }
      },
      verdict: (lanes, { L, W }) => `Сразу после всплеска блокируются все. Дальше по-разному: Fixed Window и Sliding Window возвращают доступ целиком, когда истекает окно, а Token Bucket отдаёт его по одному запросу каждые <b>${fmtN(W / L)} с</b>.`,
    },
    steady: {
      title: 'Постоянная нагрузка',
      params: [5, 10],
      hint: 'Запрос каждую секунду в течение 20 секунд: вдвое чаще допустимого. Сравни «ритм» зелёных и красных точек на лентах.',
      async run(c) {
        const t0 = Date.now();
        for (let i = 0; i < 20; i++) { await c.sleepUntil(t0 + i * 1000); await c.fire(); }
      },
      verdict: (lanes, { L, W }) => {
        const n = (k) => (lanes[k] ? lanes[k].ok : null);
        const t = n('token');
        const f = n('fixed');
        const tokenNote = t !== null && f !== null && t > f
          ? ` Token Bucket принял больше (<b>${t}</b> против <b>${f}</b>): бакет стартует полным, это запас на всплеск, а потом он пропускает ровно в темпе пополнения (1 запрос каждые <b>${fmtN(W / L)} с</b>).`
          : ` Token Bucket после стартового запаса пропускает ровно в темпе пополнения: 1 запрос каждые <b>${fmtN(W / L)} с</b>.`;
        return `Fixed Window и Sliding Window пропускают пачкой: ${L} запросов подряд, затем пауза, пока не освободится окно. В этом сценарии они ведут себя почти одинаково, разницу между ними покажет «Граница окна».${tokenNote}`;
      },
    },
    boundary: {
      title: 'Граница окна',
      params: [5, 10],
      hint: 'Классический изъян Fixed Window: 5 запросов в самом конце окна и ещё 5 сразу после сброса. Sliding Window и Token Bucket на такое не поддаются.',
      async run(c) {
        await c.fire(); // первый запрос открывает окно
        const end = c.windowEnd() || (Date.now() + c.windowSec * 1000);
        await c.sleepUntil(end - 900);
        for (let i = 0; i < c.limit - 1; i++) { await c.fire(); await c.sleep(50); }
        await c.sleepUntil(end + 350);
        for (let i = 0; i < c.limit; i++) { await c.fire(); await c.sleep(50); }
      },
      verdict: (lanes, { L, W }) => {
        const f = lanes.fixed && lanes.fixed.peak();
        if (f && f.n > L) {
          return `<b>Fixed Window</b> пропустил <b>${f.n}</b> запросов за <b>${fmtS(f.ms)}</b>, хотя лимит ${L} на ${W} с: на стыке окон счётчик обнуляется. Sliding Window держит лимит в любом промежутке, а Token Bucket ограничен ёмкостью бакета и скоростью его пополнения.`;
        }
        if (f) return 'Fixed Window в этот раз не поймал стык окон (задержка сети сдвинула запросы). Запусти сценарий ещё раз.';
        return 'Сравни пики принятых запросов в подписях дорожек: они показывают, сколько запросов реально прошло за короткий промежуток.';
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
