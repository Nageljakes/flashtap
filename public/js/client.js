/* ⚡ FlashTap — phone client */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&' + 'amp;', '<': '&' + 'lt;', '>': '&' + 'gt;', '"': '&' + 'quot;', "'": '&' + '#39;' })[c]);
  const SHAPES = ['▲', '◆', '●', '■'];
  const EMOJI = { like: '👍', love: '❤️' };

  const socket = io();
  const app = $('#app');
  const autojoinName = new URL(location.href).searchParams.get('autojoin');

  let me = null;               // { name, avatar }
  let pd = null;               // latest game:phase payload
  let cfg = null;              // branding { hostName, venueName, branch, ... }
  let answeredIndex = null;    // local lock for the current question
  let lastQuestionIndex = -1;
  const timer = { startAt: 0, duration: 0, raf: 0 };
  let lastReactionAt = 0;

  const saveName = (n) => { try { localStorage.setItem('ff_name', n); } catch {} };
  const savedName = () => { try { return localStorage.getItem('ff_name') ?? ''; } catch { return ''; } };

  fetch('/api/config').then((r) => r.json()).then((d) => {
    cfg = d;
    if (pd?.phase === 'lobby' || pd?.phase === 'final') render();
    if (!pd) render(); // refresh join screen branding
  }).catch(() => {});

  function join(name) {
    const clean = (name ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!clean) { toast('Please type a name first 🙂'); return; }
    socket.emit('player:join', { name: clean });
  }

  // ------------------------------------------------------------ socket events
  socket.on('connect', () => {
    if (me) socket.emit('player:join', { name: me.name });
    else if (autojoinName) join(autojoinName);
    else render();
  });

  socket.on('disconnect', () => { if (me) toast('Connection lost — reconnecting…'); });

  socket.on('game:config', (d) => {
    cfg = d;
    if (me === null || pd?.phase === 'lobby' || pd?.phase === 'final') render();
  });

  socket.on('player:joined', (p) => {
    const first = !me;
    me = p;
    saveName(me.name);
    if (first) toast(`You're in, ${me.name}! ${me.avatar}`);
    if (!pd) render();
  });

  socket.on('player:join_error', (e) => toast(e?.error ?? 'Could not join'));

  socket.on('game:phase', (payload) => {
    pd = payload;
    if (payload.phase === 'question' && payload.index !== lastQuestionIndex) {
      lastQuestionIndex = payload.index;
      answeredIndex = null;
    }
    if (payload.phase !== 'question') answeredIndex = null;
    render();
  });

  // ------------------------------------------------------------ countdown
  function stopTimer() {
    if (timer.raf) cancelAnimationFrame(timer.raf);
    timer.raf = 0;
  }
  function startTimer(payload) {
    stopTimer();
    timer.duration = payload.durationMs;
    timer.startAt = performance.now() - (payload.durationMs - (payload.remainingMs ?? payload.durationMs));
    const step = () => {
      const remain = Math.max(0, timer.duration - (performance.now() - timer.startAt));
      const fill = $('#timer-fill');
      if (fill) fill.style.width = `${timer.duration ? (remain / timer.duration) * 100 : 0}%`;
      const label = $('#timer-label');
      if (label) label.textContent = String(Math.ceil(remain / 1000));
      if (remain > 0) timer.raf = requestAnimationFrame(step);
    };
    step();
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const phase = pd?.phase ?? (me ? 'lobby' : socket.connected ? 'join' : 'connecting');
    stopTimer();
    switch (phase) {
      case 'join': app.innerHTML = viewJoin(); bindJoin(); break;
      case 'lobby': app.innerHTML = viewLobby(); break;
      case 'voting': app.innerHTML = viewVoting(); bindVoting(); break;
      case 'vote_result': app.innerHTML = viewVoteResult(); break;
      case 'question': app.innerHTML = viewQuestion(); bindQuestion(); startTimer(pd); break;
      case 'reveal': app.innerHTML = viewReveal(); break;
      case 'leaderboard': app.innerHTML = viewLeaderboard(); break;
      case 'final': app.innerHTML = viewFinal(); break;
      default: app.innerHTML = `<div class="center-screen"><div class="pulse">⚡</div><p>Connecting to the game host…</p></div>`;
    }
    renderReactionBar();
  }

  function brandLine() {
    if (!cfg) return '';
    const bits = [];
    if (cfg.hostName) bits.push(`DJ ${cfg.hostName}`);
    if (cfg.venueName) bits.push(cfg.venueName + (cfg.branch ? ` · ${cfg.branch}` : ''));
    return bits.join(' — ');
  }

  function viewJoin() {
    const line = brandLine();
    return `
      <div class="join-card">
        <div class="logo-big">⚡</div>
        <h1>FlashTap</h1>
        <p class="tagline">${line ? esc(line) : esc(cfg?.tagline || 'Scan · Join · Vote · Tap fastest!')}</p>
        <input id="name" maxlength="16" placeholder="Your name" autocomplete="off" autocapitalize="words" enterkeyhint="go" value="${esc(savedName())}">
        <button class="btn-primary" id="join-btn">Join the game</button>
      </div>`;
  }
  function bindJoin() {
    const input = $('#name');
    const go = () => join(input.value);
    $('#join-btn').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
  }

  function viewLobby() {
    const count = pd?.count ?? 1;
    return `
      <div class="center-screen lobby-me">
        <div class="big-avatar">${me?.avatar ?? '🎮'}</div>
        <h2>You're in, ${esc(me?.name ?? '')}!</h2>
        <div class="pulse">⚡</div>
        <p class="dim">Get ready to vote for the question set…</p>
        <p class="dim">${count} player${count === 1 ? '' : 's'} in the lobby</p>
      </div>`;
  }

  function viewVoting() {
    const p = pd;
    const voted = p.votedCount ?? 0;
    const total = p.totalPlayers ?? 0;
    const counts = p.counts ?? {};
    const cards = p.sets
      .map((s) => {
        const mine = p.yourVote === s.id;
        const count = counts[s.id] ?? 0;
        return `
        <button class="vote-card ${mine ? 'mine' : ''}" data-id="${esc(s.id)}">
          <div class="v-top"><span class="v-name">${esc(s.name)}</span>${mine ? '<span class="v-mark">✓ your pick</span>' : ''}</div>
          ${s.badge ? `<div class="v-badge">${esc(s.badge)}</div>` : ''}
          <div class="v-desc">${esc(s.description)}</div>
          <div class="v-meta"><span>${s.count} questions · ${s.rounds} round${s.rounds === 1 ? '' : 's'}</span><span class="v-count">${count} vote${count === 1 ? '' : 's'}</span></div>
        </button>`;
      })
      .join('');
    return `
      <div class="center-screen">
        <div class="logo-big">🗳️</div>
        <h2>Vote for the next set!</h2>
        <p class="dim">${voted} of ${total} voted${me ? ' — tap one, you can change your mind' : ''}</p>
        <div class="votes">${cards}</div>
      </div>`;
  }
  function bindVoting() {
    for (const card of document.querySelectorAll('.vote-card')) {
      card.addEventListener('click', () => {
        socket.emit('player:vote', { setId: card.dataset.id });
      });
    }
  }

  function viewVoteResult() {
    const p = pd;
    const winner = p.sets.find((s) => s.id === p.winnerId) ?? p.sets[0];
    const counts = p.counts ?? {};
    const rows = p.sets
      .slice()
      .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0))
      .map((s) => `<div class="board-row"><span class="rk">${s.id === p.winnerId ? '🏆' : ''}</span><span class="nm">${esc(s.name)}</span><span class="sc">${counts[s.id] ?? 0} vote${(counts[s.id] ?? 0) === 1 ? '' : 's'}</span></div>`)
      .join('');
    return `
      <div class="center-screen">
        <h2>The players chose…</h2>
        <div class="banner good">🏆 ${esc(winner?.name ?? '')}</div>
        <p class="dim">${winner?.description ? esc(winner.description) : ''} · ${winner?.count ?? 0} questions ready</p>
        <div class="board">${rows}</div>
        <p class="dim">The host is warming up the first question…</p>
      </div>`;
  }

  function viewQuestion() {
    const p = pd;
    const answers = p.answers
      .map((text, i) => `
        <button class="ans tile-${i % 4} ${answeredIndex === i ? 'picked' : ''} ${answeredIndex !== null && answeredIndex !== i ? 'dim' : ''}" data-i="${i}">
          <span class="shape">${SHAPES[i % 4]}</span>
          <span class="ans-text">${esc(text)}</span>
          ${answeredIndex === i ? '<span class="check">✓</span>' : ''}
        </button>`)
      .join('');
    return `
      <div class="q-head"><span class="pill">Question ${p.index + 1} of ${p.total}</span></div>
      ${p.round ? `<p class="dim center roundline">${esc(p.round)}</p>` : ''}
      <h2 class="q-text">${esc(p.question)}</h2>
      <div class="timer"><div id="timer-fill"></div></div>
      <p class="dim timer-line"><span id="timer-label">${Math.ceil((p.remainingMs ?? p.durationMs) / 1000)}</span>s left${answeredIndex !== null ? ' · locked in ⚡' : ''}</p>
      <div class="answers">${answers}</div>`;
  }
  function bindQuestion() {
    for (const btn of document.querySelectorAll('.ans')) {
      btn.addEventListener('click', () => {
        if (answeredIndex !== null || pd?.phase !== 'question') return;
        const i = Number(btn.dataset.i);
        if (!Number.isInteger(i)) return;
        answeredIndex = i;
        socket.emit('player:answer', { index: i });
        render();
      });
    }
  }

  function viewReveal() {
    const p = pd;
    const you = p.you ?? { answered: false };
    const correctText = `${SHAPES[p.correctIndex % 4]} ${esc(p.answers[p.correctIndex])}`;
    let banner;
    if (!you.answered) banner = `<div class="banner meh">😴 You didn't answer</div>`;
    else if (you.correct)
      banner = `<div class="banner good">✅ Correct! ${you.points} pts${you.rank ? ` · #${you.rank} fastest` : ''} · ${(you.timeMs / 1000).toFixed(2)}s</div>`;
    else banner = `<div class="banner bad">❌ Nope — it was ${correctText}</div>`;
    const fastest = p.fastest
      ? `<p class="dim center">⚡ Fastest: ${esc(p.fastest.name)} — ${(p.fastest.timeMs / 1000).toFixed(2)}s</p>`
      : `<p class="dim center">Nobody got it right 😬</p>`;
    return `
      <div class="q-head"><span class="pill">Question ${p.index + 1} of ${p.total}</span></div>
      <h2 class="q-text small">${esc(p.question)}</h2>
      <div class="correct-line">${correctText}</div>
      ${banner}
      ${fastest}
      ${p.fact ? `<p class="dim center factline">💡 ${esc(p.fact)}</p>` : ''}
      <p class="dim center">Next up: the scores…</p>`;
  }

  function medal(r) { return r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`; }
  function rowHtml(r, highlight) {
    return `
      <div class="board-row ${highlight ? 'me' : ''}">
        <span class="rk">${medal(r.rank)}</span><span class="av">${r.avatar}</span>
        <span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span>
      </div>`;
  }

  function viewLeaderboard() {
    const rows = pd.board ?? [];
    const mine = rows.find((r) => r.name === me?.name);
    const top = rows.slice(0, 5).map((r) => rowHtml(r, mine && r.name === mine.name)).join('');
    const mineBelow = mine && mine.rank > 5 ? rowHtml(mine, true) : '';
    const head = mine ? `<h2 class="score-head">${medal(mine.rank)} You're #${mine.rank} · ${mine.score} pts</h2>` : '';
    return `<div class="center-screen"><h2>Scoreboard</h2>${head}<div class="board">${top}${mineBelow}</div></div>`;
  }

  function prizesLine() {
    const p = cfg?.prizes ?? {};
    const bits = [
      p.stage1 ? `🥇 ${esc(p.stage1)}` : '',
      p.stage2 ? `🥈 ${esc(p.stage2)}` : '',
      p.stage3 ? `🥉 ${esc(p.stage3)}` : '',
    ].filter(Boolean);
    if (!bits.length) return '';
    return `<div class="prizes-line">${bits.join('<br>')}</div>`;
  }

  function viewFinal() {
    const rows = pd.board ?? [];
    const mine = rows.find((r) => r.name === me?.name) ?? (pd.you ? { rank: pd.you.rank, score: pd.you.score, avatar: me?.avatar ?? '🎮', name: me?.name ?? '' } : null);
    const list = rows.slice(0, 8).map((r) => rowHtml(r, mine && r.name === (mine.name ?? ''))).join('');
    const line = brandLine();
    return `
      <div class="center-screen">
        <h1>🏁 Final results</h1>
        ${mine ? `<h2 class="score-head">${medal(mine.rank)} You finished #${mine.rank} with ${mine.score} points</h2>` : ''}
        <div class="board">${list}</div>
        ${prizesLine()}
        ${line ? `<p class="dim">${esc(line)}</p>` : ''}
        <p class="dim">Thanks for playing! Waiting for the host…</p>
      </div>`;
  }

  // ------------------------------------------------------------ reactions
  function renderReactionBar() {
    let bar = $('#reaction-bar');
    if (!me) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'reaction-bar';
      bar.innerHTML = `
        <button data-emoji="like" aria-label="Send a like">👍</button>
        <button data-emoji="love" aria-label="Send a love">❤️</button>`;
      document.body.appendChild(bar);
      for (const b of bar.querySelectorAll('button')) {
        b.addEventListener('click', () => sendReaction(b.dataset.emoji));
      }
    }
  }
  function sendReaction(emoji) {
    const now = Date.now();
    if (now - lastReactionAt < 350) return;
    lastReactionAt = now;
    socket.emit('player:reaction', { emoji });
    miniFloat(EMOJI[emoji]);
  }
  function miniFloat(emoji) {
    const el = document.createElement('div');
    el.className = 'mini-float';
    el.textContent = emoji;
    el.style.left = `${20 + Math.random() * 60}%`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  // ------------------------------------------------------------ toasts + credit
  function toast(msg) {
    let wrap = $('#toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toasts';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.classList.add('gone'), 2600);
    setTimeout(() => t.remove(), 3200);
  }
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

  ensureCredit();
  render();
})();
