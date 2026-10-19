/* ⚡ FlashTap — big-screen host */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&' + 'amp;', '<': '&' + 'lt;', '>': '&' + 'gt;', '"': '&' + 'quot;', "'": '&' + '#39;' })[c]);
  const SHAPES = ['▲', '◆', '●', '■'];
  const floatsEl = $('#floats');

  const socket = io();
  const app = $('#app');
  const wantSetup = new URL(location.href).searchParams.get('setup') === '1';

  let qrInfo = null;          // { url, qr } from /api/qr
  let venues = [];            // from /api/venues
  let players = [];           // lobby list from host:players
  let live = { answered: 0, total: 0 };
  let pd = null;              // latest game:phase payload
  let phase = 'connecting';
  let cfg = { hostName: '', venueName: '', branch: '', tagline: '', ticker: '', themeColor: '#ffd60a', prizes: { stage1: '', stage2: '', stage3: '' }, roundSize: 10 };
  let muted = false;
  try { muted = localStorage.getItem('ff_mute') === '1'; } catch {}
  const timer = { startAt: 0, duration: 0, raf: 0, lastTick: null };

  fetch('/api/qr').then((r) => r.json()).then((d) => { qrInfo = d; if (phase === 'lobby') render(); }).catch(() => {});
  const cfgReady = fetch('/api/config').then((r) => r.json()).then((d) => { cfg = d; applyTheme(); if (phase === 'lobby') render(); }).catch(() => {});
  const venuesReady = fetch('/api/venues').then((r) => r.json()).then((d) => {
    venues = Array.isArray(d) ? d : [];
    fillVenueSelect();
  }).catch(() => {});
  Promise.all([cfgReady, venuesReady]).then(() => { if (wantSetup) openSetup(); });

  socket.on('connect', () => socket.emit('host:register'));
  socket.on('game:config', (d) => { cfg = d; applyTheme(); if (phase === 'lobby') render(); });
  socket.on('game:phase', (p) => { pd = p; phase = p.phase; onPhaseEnter(p); render(); });
  socket.on('host:players', (d) => {
    players = d.players ?? [];
    if (phase === 'lobby') renderPlayers();
    else if (phase === 'vote_result') render();
  });
  socket.on('host:live', (d) => { live = d; updateLive(); });
  socket.on('host:reaction', spawnFloat);

  // ------------------------------------------------------------ theme + branding
  function applyTheme() {
    document.documentElement.style.setProperty('--venue', cfg.themeColor || '#ffd60a');
  }
  function hostedBy() {
    const bits = [];
    if (cfg.hostName) bits.push(`DJ ${cfg.hostName}`);
    if (cfg.venueName) bits.push(cfg.venueName + (cfg.branch ? ` · ${cfg.branch}` : ''));
    return bits.join(' — ');
  }
  function promoteLine() {
    return cfg.tagline || '';
  }

  // ------------------------------------------------------------ setup modal
  function ensureSetupModal() {
    if ($('#setup-modal')) return;
    const el = document.createElement('div');
    el.id = 'setup-modal';
    el.className = 'modal hidden';
    el.innerHTML = `
      <div class="modal-card pop">
        <div class="modal-head"><h2>⚙ FlashTap setup</h2><button id="cfg-close" class="x" aria-label="Close">✕</button></div>
        <div class="modal-body">
          <label>DJ / host / company name<input id="cfg-host" maxlength="40" placeholder="e.g. TJ Entertainment"></label>
          <label>Venue<select id="cfg-venue"></select></label>
          <div id="cfg-custom" class="hidden">
            <label>Venue name<input id="cfg-venue-name" maxlength="60" placeholder="Your venue's name"></label>
            <label>Branch / location<input id="cfg-branch" maxlength="40" placeholder="Suburb / branch"></label>
          </div>
          <label>Tagline<input id="cfg-tagline" maxlength="90" placeholder="Live Pub Entertainment"></label>
          <label>Scrolling ticker<input id="cfg-ticker" maxlength="240" placeholder="FLASHTAP NIGHT • 2-FOR-1 DRAFTS UNTIL 8PM • R500 BAR TAB PRIZE"></label>
          <div class="prize-row">
            <label>🥇 1st prize<input id="cfg-p1" maxlength="120" placeholder="R500 bar tab + trophy"></label>
            <label>🥈 2nd prize<input id="cfg-p2" maxlength="120" placeholder="Pitcher of beer + snacks"></label>
            <label>🥉 3rd prize<input id="cfg-p3" maxlength="120" placeholder="Round of shooters"></label>
          </div>
          <label>Questions per game (3–60)<input id="cfg-roundsize" type="number" min="3" max="60"></label>
          <p id="cfg-saved" class="saved hidden">Saved ✓ — the phones update live</p>
        </div>
        <div class="modal-actions">
          <button id="cfg-cancel" class="btn-ghost">Cancel</button>
          <button id="cfg-save" class="btn-primary">Save setup</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    fillVenueSelect();
    $('#cfg-close').addEventListener('click', closeSetup);
    $('#cfg-cancel').addEventListener('click', closeSetup);
    $('#setup-modal').addEventListener('click', (e) => { if (e.target.id === 'setup-modal') closeSetup(); });
    $('#cfg-venue').addEventListener('change', onVenueChange);
    $('#cfg-save').addEventListener('click', saveSetup);
  }
  function fillVenueSelect() {
    const sel = $('#cfg-venue');
    if (!sel) return;
    sel.innerHTML =
      `<option value="">— Custom venue (type it in) —</option>` +
      venues.map((v, i) => `<option value="${i}" data-idx="${i}">${esc(v.venueName)} — ${esc(v.branch)}</option>`).join('');
  }
  function onVenueChange() {
    const sel = $('#cfg-venue');
    const idx = sel.value;
    const isCustom = idx === '';
    $('#cfg-custom').classList.toggle('hidden', !isCustom);
    if (!isCustom) {
      const v = venues[Number(idx)] ?? {};
      $('#cfg-venue-name').value = v.venueName ?? '';
      $('#cfg-branch').value = v.branch ?? '';
      $('#cfg-branch').parentElement.classList.add('hidden');
      $('#cfg-tagline').value = v.tagline ?? '';
      $('#cfg-ticker').value = v.ticker ?? '';
      $('#cfg-p1').value = v.prizes?.stage1 ?? '';
      $('#cfg-p2').value = v.prizes?.stage2 ?? '';
      $('#cfg-p3').value = v.prizes?.stage3 ?? '';
      if (v.themeColor) document.documentElement.style.setProperty('--venue', v.themeColor);
    } else {
      $('#cfg-branch').parentElement.classList.remove('hidden');
    }
  }
  function openSetup() {
    ensureSetupModal();
    $('#cfg-host').value = cfg.hostName ?? '';
    $('#cfg-tagline').value = cfg.tagline ?? '';
    $('#cfg-ticker').value = cfg.ticker ?? '';
    $('#cfg-venue-name').value = cfg.venueName ?? '';
    $('#cfg-branch').value = cfg.branch ?? '';
    $('#cfg-p1').value = cfg.prizes?.stage1 ?? '';
    $('#cfg-p2').value = cfg.prizes?.stage2 ?? '';
    $('#cfg-p3').value = cfg.prizes?.stage3 ?? '';
    $('#cfg-roundsize').value = cfg.roundSize ?? 10;
    const match = venues.findIndex((v) => v.venueName === cfg.venueName);
    if (match >= 0) {
      $('#cfg-venue').value = String(match);
      $('#cfg-custom').classList.add('hidden');
      $('#cfg-branch').parentElement.classList.add('hidden');
    } else {
      $('#cfg-venue').value = '';
      $('#cfg-custom').classList.remove('hidden');
      $('#cfg-branch').parentElement.classList.remove('hidden');
    }
    $('#cfg-saved').classList.add('hidden');
    $('#setup-modal').classList.remove('hidden');
  }
  function closeSetup() {
    $('#setup-modal')?.classList.add('hidden');
  }
  function saveSetup() {
    const selected = $('#cfg-venue').value;
    const body = {
      hostName: $('#cfg-host').value,
      venueName: $('#cfg-venue-name').value,
      branch: $('#cfg-branch').value,
      tagline: $('#cfg-tagline').value,
      ticker: $('#cfg-ticker').value,
      prizes: {
        stage1: $('#cfg-p1').value,
        stage2: $('#cfg-p2').value,
        stage3: $('#cfg-p3').value,
      },
      roundSize: Number.parseInt($('#cfg-roundsize').value, 10) || 10,
    };
    if (selected !== '' && venues[Number(selected)]) {
      const v = venues[Number(selected)];
      body.shortName = v.shortName ?? '';
      if (v.themeColor) body.themeColor = v.themeColor;
    }
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then(() => {
        cfg = { ...cfg, ...body };
        $('#cfg-saved').classList.remove('hidden');
        setTimeout(closeSetup, 650);
      })
      .catch(() => alert('Could not save — check the console'));
  }

  // ------------------------------------------------------------ phase entry fx
  function onPhaseEnter(p) {
    if (p.phase === 'question') {
      startTimer(p);
      sfxStart();
    } else {
      stopTimer();
      if (p.phase === 'reveal') sfxReveal((p.correctCount ?? 0) > 0);
      if (p.phase === 'final') { sfxFinal(); confetti(7000); }
      if (p.phase === 'vote_result') sfxReveal(true);
    }
  }

  // ------------------------------------------------------------ countdown
  function stopTimer() {
    if (timer.raf) cancelAnimationFrame(timer.raf);
    timer.raf = 0;
    timer.lastTick = null;
  }
  function startTimer(p) {
    stopTimer();
    timer.duration = p.durationMs;
    timer.startAt = performance.now() - (p.durationMs - (p.remainingMs ?? p.durationMs));
    const step = () => {
      const remain = Math.max(0, timer.duration - (performance.now() - timer.startAt));
      const frac = timer.duration ? remain / timer.duration : 0;
      const ring = $('#timer-ring');
      if (ring) {
        const color = frac > 0.3 ? 'var(--venue, #ffd60a)' : '#ff5c7a';
        ring.style.background = `conic-gradient(${color} ${frac * 360}deg, rgba(255,255,255,0.09) 0deg)`;
        const num = $('#timer-num');
        if (num) num.textContent = String(Math.ceil(remain / 1000));
      }
      const sec = Math.ceil(remain / 1000);
      if (sec <= 3 && sec >= 1 && timer.lastTick !== sec) { timer.lastTick = sec; sfxTick(); }
      if (remain > 0) timer.raf = requestAnimationFrame(step);
    };
    step();
  }

  // ------------------------------------------------------------ rendering
  function render() {
    switch (phase) {
      case 'lobby': app.innerHTML = viewLobby(); bindLobby(); renderPlayers(); break;
      case 'voting': app.innerHTML = viewVoting(); break;
      case 'vote_result': app.innerHTML = viewVoteResult(); break;
      case 'question': app.innerHTML = viewQuestion(); updateLive(); break;
      case 'reveal': app.innerHTML = viewReveal(); break;
      case 'leaderboard': app.innerHTML = viewBoard(); break;
      case 'final': app.innerHTML = viewFinal(); break;
      default:
        app.innerHTML = `<div class="center-screen"><div class="pulse">⚡</div><p>Connecting…</p></div>`;
    }
    const btn = $('#primary');
    if (btn) {
      if (phase === 'lobby' && players.length === 0) btn.disabled = true;
      btn.addEventListener('click', () => socket.emit('host:primary'));
    }
  }

  function tickerHtml() {
    return cfg.ticker ? `<div class="ticker"><span style="animation-duration:${Math.max(14, Math.min(40, cfg.ticker.length / 8)).toFixed(0)}s">${esc(cfg.ticker)}&nbsp;&nbsp;&nbsp;&nbsp;${esc(cfg.ticker)}</span></div>` : '';
  }
  function prizesHtml() {
    const { stage1, stage2, stage3 } = cfg.prizes ?? {};
    if (!stage1 && !stage2 && !stage3) return '';
    return `<p class="prizes-line">🏆 ${stage1 ? `1st: ${esc(stage1)}` : ''}${stage2 ? ` &nbsp;·&nbsp; 2nd: ${esc(stage2)}` : ''}${stage3 ? ` &nbsp;·&nbsp; 3rd: ${esc(stage3)}` : ''}</p>`;
  }

  function viewLobby() {
    const qr = qrInfo ? `<img src="${qrInfo.qr}" alt="Join QR code">` : `<div class="qr-loading">Loading QR…</div>`;
    const hostLine = hostedBy();
    const promo = promoteLine();
    return `
      <section class="stage lobby">
        ${tickerHtml()}
        <h1 class="logo" id="logo-btn" title="Click to open setup">⚡ FlashTap</h1>
        <p class="tagline">${esc(promo || 'Scan · Join · Vote · Tap fastest!')}</p>
        ${hostLine ? `<p class="hostline">${esc(hostLine)}</p>` : ''}
        <button class="setup-btn" id="setup-open" title="Game setup — venue, prizes, DJ name">⚙ Setup</button>
        <div class="qr-card">
          ${qr}
          <div class="qr-info">
            <div class="join-url">${esc(qrInfo?.url ?? '')}</div>
            <p class="qr-hint">Scan with a phone camera to join</p>
          </div>
        </div>
        <h2 class="players-title">In the lobby: <span id="player-count">0</span></h2>
        <div id="chips" class="chips"></div>
        <button id="primary" class="btn-primary">Start voting</button>
        <p class="hint">Click the logo for setup · <b>Space</b> to start · players vote on a question set before round one</p>
      </section>`;
  }
  function bindLobby() {
    $('#setup-open')?.addEventListener('click', openSetup);
    $('#logo-btn')?.addEventListener('click', openSetup);
  }
  function renderPlayers() {
    const count = $('#player-count');
    const chips = $('#chips');
    if (!count || !chips) return;
    count.textContent = String(players.length);
    chips.innerHTML =
      players.map((p) => `<div class="chip pop"><span>${p.avatar}</span>${esc(p.name)}</div>`).join('') ||
      `<p class="dim">Waiting for the first player…</p>`;
    const btn = $('#primary');
    if (btn) btn.disabled = players.length === 0;
  }

  function viewVoting() {
    const counts = pd.counts ?? {};
    const maxC = Math.max(1, ...pd.sets.map((s) => counts[s.id] ?? 0));
    const cards = pd.sets
      .map((s, i) => {
        const count = counts[s.id] ?? 0;
        return `
        <div class="vote-tile" style="--w:${Math.round((count / maxC) * 100)}%">
          <div class="vt-name">${esc(s.name)}</div>
          ${s.badge ? `<div class="vt-badge">${esc(s.badge)}</div>` : ''}
          <div class="vt-desc">${esc(s.description)}</div>
          <div class="vt-meta">${s.count} questions · ${s.rounds} round${s.rounds === 1 ? '' : 's'}</div>
          <div class="vt-count">${count}</div>
        </div>`;
      })
      .join('');
    return `
      <section class="stage voting">
        <header class="q-header">
          <span class="pill">🗳️ Question set voting</span>
          <span class="pill" id="vote-progress">${pd.votedCount} / ${pd.totalPlayers} players voted</span>
        </header>
        <h1 class="q-text">Vote for the set you want to play!</h1>
        <div class="vote-grid">${cards}</div>
        <button id="primary" class="btn-primary">Lock in and play</button>
      </section>`;
  }

  function viewVoteResult() {
    const winner = pd.sets.find((s) => s.id === pd.winnerId) ?? pd.sets[0];
    const counts = pd.counts ?? {};
    const rows = pd.sets
      .slice()
      .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0))
      .map((s) => `<div class="mini-row ${s.id === pd.winnerId ? 'lead' : ''}">${esc(s.name)} — <b>${counts[s.id] ?? 0}</b> vote${(counts[s.id] ?? 0) === 1 ? '' : 's'}</div>`)
      .join('');
    return `
      <section class="stage vote-result">
        <h1 class="logo small">🗳️ The players chose…</h1>
        <div class="fastest-banner win pop">🏆 ${esc(winner?.name ?? 'Set')}</div>
        <p class="dim">${winner?.description ? esc(winner.description) + ' · ' : ''}${winner?.count ?? 0} questions on the menu</p>
        <div class="mini-rows">${rows}</div>
        ${players.length === 0
          ? `<p class="hostline">Nobody is in the lobby — players can still join!</p><button id="primary" class="btn-primary">Back to lobby</button>`
          : `<button id="primary" class="btn-primary">Start playing ${esc(winner?.name ?? '')}</button>`}
      </section>`;
  }

  function viewQuestion() {
    const p = pd;
    const tiles = p.answers
      .map((text, i) => `
        <div class="tile t-${i % 4}">
          <span class="shape">${SHAPES[i % 4]}</span>
          <span class="ans-text">${esc(text)}</span>
        </div>`)
      .join('');
    return `
      <section class="stage question">
        <header class="q-header">
          <span class="pill">Question ${p.index + 1} / ${p.total}</span>
          <span class="pill" id="live-pill">…</span>
          <div class="timer-ring" id="timer-ring"><span id="timer-num">–</span></div>
        </header>
        ${p.round ? `<p class="roundline">${esc(p.round)}</p>` : ''}
        <h1 class="q-text">${esc(p.question)}</h1>
        <div class="tiles">${tiles}</div>
        <button id="primary" class="btn-primary">Skip to reveal</button>
      </section>`;
  }
  function updateLive() {
    const el = $('#live-pill');
    if (el) el.textContent = `${live.answered} / ${live.total} answered`;
  }

  function viewReveal() {
    const p = pd;
    const tiles = p.answers
      .map((text, i) => `
        <div class="tile t-${i % 4} ${i === p.correctIndex ? 'correct' : 'dim'}">
          <span class="shape">${SHAPES[i % 4]}</span>
          <span class="ans-text">${esc(text)}</span>
          <span class="dist">${p.distribution[i]}${i === p.correctIndex ? ' ✓' : ''}</span>
        </div>`)
      .join('');
    const fastest = p.fastest
      ? `<div class="fastest-banner pop">⚡ Fastest: ${esc(p.fastest.name)} ${p.fastest.avatar} — ${(p.fastest.timeMs / 1000).toFixed(2)}s <span class="pts">+${p.fastest.points}</span></div>`
      : `<div class="fastest-banner none pop">Nobody got it right 😬</div>`;
    const rankList = (p.ranking ?? [])
      .slice(0, 3)
      .map((r) => `<span class="mini-row">#${r.rank} ${esc(r.name)} ${(r.timeMs / 1000).toFixed(2)}s</span>`)
      .join('');
    return `
      <section class="stage reveal">
        <header class="q-header"><span class="pill">Question ${p.index + 1} / ${p.total}</span></header>
        <h1 class="q-text">${esc(p.question)}</h1>
        ${fastest}
        <p class="dim">${p.correctCount} of ${p.answeredCount || live.total} correct ${rankList ? `· ${rankList}` : ''}</p>
        ${p.fact ? `<p class="fact">💡 ${esc(p.fact)}</p>` : ''}
        <div class="tiles">${tiles}</div>
        <button id="primary" class="btn-primary">Show scores</button>
      </section>`;
  }

  function medal(r) { return r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`; }
  function rowHtml(r) {
    const top = Math.max(1, pd?.board?.[0]?.score ?? 1);
    const w = Math.max(4, Math.round((r.score / top) * 100));
    return `
      <div class="board-row ${r.rank <= 3 ? 'top' : ''}" style="--w:${w}%">
        <span class="rk">${medal(r.rank)}</span><span class="av">${r.avatar}</span>
        <span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span>
      </div>`;
  }

  function viewBoard() {
    const rows = pd?.board ?? [];
    const label = pd && pd.index + 1 < pd.total ? 'Next question' : 'Final results';
    return `
      <section class="stage board">
        <h1 class="logo small">📊 Scoreboard</h1>
        <div class="board-list">${rows.map(rowHtml).join('')}</div>
        <button id="primary" class="btn-primary">${label}</button>
      </section>`;
  }

  function viewFinal() {
    const rows = pd?.board ?? [];
    const [g1, g2, g3] = rows;
    const step = (r, place) => `
      <div class="step h${place === 1 ? '1st' : place === 2 ? '2nd' : '3rd'}">
        ${place === 1 ? '<div class="crown">👑</div>' : ''}
        <div class="p-av">${r.avatar}</div>
        <div class="p-name">${esc(r.name)}</div>
        <div class="p-score">${r.score} pts</div>
        <div class="p-place">${medal(place)}</div>
      </div>`;
    return `
      <section class="stage final">
        <h1 class="logo">🏆 Final results</h1>
        <div class="podium">
          ${g2 ? step(g2, 2) : ''}
          ${g1 ? step(g1, 1) : ''}
          ${g3 ? step(g3, 3) : ''}
        </div>
        ${prizesHtml()}
        <div class="board-list small">${rows.map(rowHtml).join('')}</div>
        <button id="primary" class="btn-primary">Play again</button>
      </section>`;
  }

  // ------------------------------------------------------------ flying reactions
  function spawnFloat({ emoji, name }) {
    const el = document.createElement('div');
    el.className = 'float';
    el.textContent = emoji === 'love' ? '❤️' : '👍';
    el.style.setProperty('--x', `${4 + Math.random() * 88}vw`);
    el.style.setProperty('--drift', `${Math.round(Math.random() * 22 - 11)}vw`);
    el.style.setProperty('--dur', `${(2.3 + Math.random() * 1.7).toFixed(2)}s`);
    el.style.fontSize = `${34 + Math.random() * 30}px`;
    const label = document.createElement('span');
    label.textContent = name ?? '';
    el.appendChild(label);
    floatsEl.appendChild(el);
    while (floatsEl.children.length > 90) floatsEl.firstChild.remove();
    setTimeout(() => el.remove(), 4600);
  }

  // ------------------------------------------------------------ sound
  let actx = null;
  function tone(freq, at, dur, type = 'sine', vol = 0.12) {
    if (muted) return;
    try {
      actx = actx ?? new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + at;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch {}
  }
  const sfxStart = () => { tone(392, 0, 0.15); tone(523, 0.12, 0.15); tone(659, 0.24, 0.3, 'triangle', 0.14); };
  const sfxReveal = (correct) => {
    if (correct) { tone(523, 0, 0.12); tone(659, 0.1, 0.12); tone(784, 0.2, 0.35, 'triangle', 0.16); }
    else { tone(196, 0, 0.3, 'sawtooth', 0.06); tone(147, 0.15, 0.4, 'sawtooth', 0.06); }
  };
  const sfxTick = () => tone(1100, 0, 0.05, 'square', 0.04);
  const sfxFinal = () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.13, 0.3, 'triangle', 0.14));
  };

  const muteBtn = document.createElement('button');
  muteBtn.id = 'mute-btn';
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('ff_mute', muted ? '1' : '0'); } catch {}
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });
  muteBtn.textContent = muted ? '🔇' : '🔊';
  document.body.appendChild(muteBtn);

  // ------------------------------------------------------------ confetti
  function confetti(ms = 6000) {
    const cv = $('#confetti');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    cv.width = innerWidth;
    cv.height = innerHeight;
    const colors = ['#ffd60a', '#7c5cff', '#2ecc71', '#e21b3c', '#1368ce', '#ff8fab'];
    const parts = Array.from({ length: 220 }, () => ({
      x: Math.random() * cv.width,
      y: -20 - Math.random() * cv.height * 0.6,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      c: colors[(Math.random() * colors.length) | 0],
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      r: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4,
    }));
    const t0 = performance.now();
    (function draw() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, cv.width, cv.height);
    })();
  }

  // ------------------------------------------------------------ footer credit
  function ensureCredit() {
    if ($('#credit')) return;
    const a = document.createElement('a');
    a.id = 'credit';
    a.href = 'https://nageljakes.github.io/jaxtechweb/';
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '⚡ Built by <b>Jaxtech</b>';
    document.body.appendChild(a);
  }

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Escape') { closeSetup(); return; }
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      const modal = $('#setup-modal');
      if (modal && !modal.classList.contains('hidden')) return; // don't start mid-form
      const btn = $('#primary');
      if (btn && !btn.disabled) { e.preventDefault(); socket.emit('host:primary'); }
    }
  });

  ensureCredit();
  ensureSetupModal();
  render();
})();
