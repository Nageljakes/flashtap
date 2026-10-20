#!/usr/bin/env node
/**
 * ⚡ FlashTap — a self-hosted, local-network party quiz for DJs and event hosts.
 *
 * One machine (this one) hosts the game. Open /host on the big screen.
 * Players scan the QR code, join on their phones, vote for the question
 * set they want, then tap answers as fast as they can — the fastest
 * correct fingers score the most points. While the clock runs, players
 * can spam 👍 / ❤️ and the reactions fly across the host screen.
 *
 * The host clicks the FlashTap logo to open Setup: DJ/company name,
 * venue, branch, prizes (Beerbox venues prefilled from data/venues.json).
 *
 * Run:
 *   npm start
 *   npm start -- --port 3001 --ip 192.168.110.8
 *
 * Env overrides: PORT, HOST_IP, QUESTIONS_DIR, CONFIG_FILE, REVEAL_MS, LEADERBOARD_MS
 * Flags: --port --ip --question-sets --config --quiet
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- options
function argValue(flag, envName, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const env = process.env[envName];
  return env !== undefined ? env : fallback;
}

const PORT = Number.parseInt(argValue('--port', 'PORT', '3000'), 10);
const IP_OVERRIDE = argValue('--ip', 'HOST_IP', null);
const QUESTIONS_DIR = argValue('--question-sets', 'QUESTIONS_DIR', path.join(__dirname, 'question-sets'));
const CONFIG_FILE = argValue('--config', 'CONFIG_FILE', path.join(__dirname, 'game-config.json'));
const REVEAL_MS = Number.parseInt(argValue('--reveal-ms', 'REVEAL_MS', '6500'), 10);
const LEADERBOARD_MS = Number.parseInt(argValue('--leaderboard-ms', 'LEADERBOARD_MS', '9000'), 10);
const QUIET = process.argv.includes('--quiet') || process.env.QUIET === '1';

const ANSWER_GRACE_MS = 300;           // extra time after the clock for late taps
const REACTION_MIN_INTERVAL_MS = 350;  // per-player reaction throttle
const VOTE_SETTLE_MS = 900;            // wait after the last vote before auto-lock
const MAX_NAME_LEN = 16;
const DEFAULT_QUESTION_MS = 20000;
const AVATARS = ['🦊','🐼','🦁','🐸','🐙','🦄','🐵','🐯','🐨','🐷','🦉','🐺','🦇','🐝','🦖','🐳','🦋','🐞','🦜','🐬'];

// ---------------------------------------------------------------- helpers
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const clip = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- question sets
function loadSets(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error(`✖ Cannot read question-sets directory: ${dir}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`✖ No question sets found in ${dir}`);
    process.exit(1);
  }
  const sets = [];
  for (const f of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      console.error(`✖ ${f} is not valid JSON — ${err.message}`);
      process.exit(1);
    }
    const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q, i) => {
      const num = i + 1;
      const answers = Array.isArray(q.answers) ? q.answers.map(String) : null;
      if (typeof q?.q !== 'string' || !q.q.trim() || !answers || answers.length < 2) {
        console.error(`✖ ${f} question ${num}: needs "q" text and at least 2 "answers"`);
        process.exit(1);
      }
      const correct = Number.isInteger(q.correct) ? q.correct : 0;
      if (correct < 0 || correct >= answers.length) {
        console.error(`✖ ${f} question ${num}: "correct" must be an index into "answers"`);
        process.exit(1);
      }
      return {
        q: clip(q.q, 400),
        answers,
        correct,
        round: clip(q.round, 60),
        fact: clip(q.fact, 300),
      };
    });
    if (questions.length < 3) {
      console.error(`✖ ${f}: fewer than 3 questions`);
      process.exit(1);
    }
    sets.push({
      id: slugify(raw.id ?? f.replace(/\.json$/, '')),
      name: clip(raw.name ?? f, 80),
      badge: clip(raw.badge ?? '', 60),
      description: clip(raw.description ?? '', 140),
      durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : null,
      shuffleQuestions: raw.shuffleQuestions !== false,
      shuffleAnswers: raw.shuffleAnswers !== false,
      roundSize: Number.isFinite(raw.roundSize) ? raw.roundSize : null,
      questions,
    });
  }
  return sets;
}
const questionSets = loadSets(QUESTIONS_DIR);

// ---------------------------------------------------------------- host config (setup screen)
const DEFAULT_CONFIG = {
  hostName: '',
  venueName: '',
  shortName: '',
  branch: '',
  tagline: '',
  ticker: '',
  themeColor: '#ffd60a',
  prizes: { stage1: '', stage2: '', stage3: '' },
  roundSize: 10,
};
function sanitizeConfig(raw) {
  const prizes = raw?.prizes ?? {};
  let themeColor = String(raw?.themeColor ?? '');
  if (!/^#[0-9a-fA-F]{6}$/.test(themeColor)) themeColor = DEFAULT_CONFIG.themeColor;
  const roundSize = Math.max(1, Math.min(60, Number.parseInt(raw?.roundSize, 10) || DEFAULT_CONFIG.roundSize));
  return {
    hostName: clip(raw?.hostName, 40),
    venueName: clip(raw?.venueName, 60),
    shortName: clip(raw?.shortName, 30),
    branch: clip(raw?.branch, 40),
    tagline: clip(raw?.tagline, 90),
    ticker: clip(raw?.ticker, 240),
    themeColor,
    prizes: {
      stage1: clip(prizes.stage1, 120),
      stage2: clip(prizes.stage2, 120),
      stage3: clip(prizes.stage3, 120),
    },
    roundSize,
  };
}
function loadGameConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return sanitizeConfig({
      ...DEFAULT_CONFIG,
      ...parsed,
      prizes: { ...DEFAULT_CONFIG.prizes, ...(parsed?.prizes ?? {}) },
    });
  } catch {
    return sanitizeConfig(DEFAULT_CONFIG);
  }
}

// ---------------------------------------------------------------- network
// Pick the LAN address players should use. Physical NICs with private LAN
// IPs win; virtual bridges (libvirt, docker, calico, Tailscale, link-local)
// lose. Override with --ip / HOST_IP when the guess is wrong.
function networkCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}
function isPrivateLan(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31);
}
function looksVirtual(c) {
  if (/^(lo$|cali|calico|veth|virbr|docker|br-|dummy|tun|tap|tailscale|wg|zt|ztunnel|nordlynx|cni|flannel|kube|macvlan|mv-|mpqemubr|hassio)/i.test(c.name)) return true;
  if (c.ip.startsWith('169.254.')) return true; // link-local
  const o = c.ip.split('.').map(Number);
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT (Tailscale)
  if (c.ip.startsWith('192.168.122.') || c.ip.startsWith('192.168.123.')) return true; // libvirt
  return false;
}
function scoreCandidate(c) {
  let s = 0;
  if (looksVirtual(c)) s -= 100;
  // Phones live on the private LAN — a private-LAN address must always beat
  // CGNAT/Tailscale/link-local picks, even when the adapter has a virtual-ish
  // name (e.g. ICS bridges like "vEthernet (HomeAssistant LAN)" carry the
  // machine's real LAN IP). Bonus is larger than the virtual penalty so a
  // LAN IP on a virtual-named NIC still outranks a Tailscale IP.
  if (isPrivateLan(c.ip)) s += 120;
  if (/^(en[po]|eth|ether|wlan|wi-fi|wifi|wireless|local area|wl)/i.test(c.name)) s += 10;
  return s;
}
const candidates = networkCandidates().sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
const chosen = IP_OVERRIDE ? { name: 'override', ip: IP_OVERRIDE } : candidates[0];
if (!chosen) {
  console.error('✖ No usable network interface found. Pass one manually:  npm start -- --ip <your-lan-ip>');
  process.exit(1);
}
const JOIN_URL = `http://${chosen.ip}:${PORT}`;

// ---------------------------------------------------------------- game state
const game = {
  phase: 'lobby',           // lobby | voting | vote_result | question | reveal | leaderboard | final
  players: new Map(),       // socket.id -> player
  sets: questionSets,
  votes: new Map(),         // socket.id -> setId
  voteEndTimer: null,
  chosenSet: null,          // winning question set for this game
  deck: [],
  current: -1,
  questionStartAt: 0,
  durationMs: 0,
  answers: new Map(),       // socket.id -> { index, timeMs, correct }
  results: [],
  timer: null,
  branding: loadGameConfig(),
};

function clearTimer() {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}
function clearVoteEndTimer() {
  if (game.voteEndTimer) {
    clearTimeout(game.voteEndTimer);
    game.voteEndTimer = null;
  }
}
function hashName(s) {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
function makePlayer(id, name) {
  return { id, name, avatar: AVATARS[hashName(name) % AVATARS.length], score: 0, lastReactionAt: 0 };
}
function uniqueName(raw) {
  const existing = [...game.players.values()];
  const clash = existing.find((p) => p.name.toLowerCase() === raw.toLowerCase());
  if (!clash) return raw;
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  for (let n = 2; ; n++) {
    const cand = `${clash.name} ${n}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}
function pointsFor(timeMs) {
  const t = Math.min(Math.max(timeMs, 0), game.durationMs);
  return Math.round(1000 * (1 - 0.5 * (t / game.durationMs)));
}
function nameOf(id) {
  return game.players.get(id)?.name ?? 'Someone';
}
function connectedPlayers() {
  return [...game.players.values()];
}

// ---------------------------------------------------------------- deck building
// Take the winning set and build a deck: shuffle inside each round, then
// interleave rounds round-robin and cut to the configured number of
// questions, so one game samples variety across the whole set.
function buildDeck(set, roundSize) {
  const rounds = new Map();
  for (const q of set.questions) {
    const key = q.round || 'Round 1';
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key).push(q);
  }
  const roundArrs = [...rounds.values()];
  if (set.shuffleQuestions) for (const arr of roundArrs) shuffle(arr);

  const picked = [];
  const limit = Math.min(roundSize, set.questions.length);
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const arr of roundArrs) {
      if (arr.length) {
        picked.push(arr.shift());
        progress = true;
        if (picked.length >= limit) break;
      }
    }
  }
  return picked.map((q) => {
    const order = q.answers.map((text, i) => ({ text, correct: i === q.correct }));
    if (set.shuffleAnswers) shuffle(order);
    return {
      q: q.q,
      answers: order.map((o) => o.text),
      correctIndex: order.findIndex((o) => o.correct),
      durationMs: set.durationMs ?? DEFAULT_QUESTION_MS,
      round: q.round,
      fact: q.fact,
    };
  });
}

// ---------------------------------------------------------------- phases
function startVoting() {
  if (game.phase !== 'lobby') return;
  if (game.sets.length <= 1) {
    game.chosenSet = game.sets[0] ?? null;
    startGame();
    return;
  }
  clearVoteEndTimer();
  clearTimer();
  game.phase = 'voting';
  game.votes.clear();
  game.chosenSet = null;
  broadcastPhase();
}

function registerVote(socketId, setId) {
  if (game.phase !== 'voting' || !game.players.has(socketId)) return;
  if (!game.sets.some((s) => s.id === setId)) return;
  game.votes.set(socketId, setId);
  broadcastPhase();
  if (!game.voteEndTimer && game.votes.size >= game.players.size) {
    game.voteEndTimer = setTimeout(() => finalizeVoting(), VOTE_SETTLE_MS);
  }
}

function finalizeVoting() {
  if (game.phase !== 'voting') return;
  clearVoteEndTimer();
  const counts = {};
  for (const setId of game.votes.values()) counts[setId] = (counts[setId] ?? 0) + 1;
  let top = Object.entries(counts);
  if (top.length === 0) top = [];
  let winnerSet;
  if (top.length === 0) {
    winnerSet = game.sets[Math.floor(Math.random() * game.sets.length)]; // nobody voted: pick one
  } else {
    const best = Math.max(...top.map(([, n]) => n));
    const tied = top.filter(([, n]) => n === best).map(([id]) => id);
    const winnerId = tied.length === 1 ? tied[0] : tied[Math.floor(Math.random() * tied.length)];
    winnerSet = game.sets.find((s) => s.id === winnerId);
  }
  game.chosenSet = winnerSet;
  game.phase = 'vote_result';
  broadcastPhase();
}

function startGame() {
  if (game.phase !== 'vote_result' || game.players.size === 0) return;
  const set = game.chosenSet ?? game.sets[0];
  const roundSize = set.roundSize ?? game.branding.roundSize ?? 10;
  game.deck = buildDeck(set, roundSize);
  game.results = [];
  clearTimer();
  game.phase = 'question';
  game.current = -1;
  for (const p of game.players.values()) p.score = 0;
  startQuestion(0);
}

function startQuestion(i) {
  clearTimer();
  game.phase = 'question';
  game.current = i;
  game.answers.clear();
  const q = game.deck[i];
  game.durationMs = q.durationMs;
  game.questionStartAt = Date.now();
  broadcastPhase();
  emitLive();
  game.timer = setTimeout(endQuestion, game.durationMs + ANSWER_GRACE_MS);
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimer();
  const q = game.deck[game.current];
  const entries = [...game.answers.entries()].map(([id, a]) => ({ id, ...a }));
  const correctEntries = entries.filter((e) => e.correct).sort((a, b) => a.timeMs - b.timeMs);
  const ranking = correctEntries.map((e, i) => {
    const p = game.players.get(e.id);
    const pts = pointsFor(e.timeMs);
    if (p) p.score += pts;
    return {
      id: e.id,
      name: nameOf(e.id),
      avatar: p?.avatar ?? '🎮',
      timeMs: e.timeMs,
      points: pts,
      rank: i + 1,
    };
  });
  const distribution = q.answers.map((_, idx) => entries.filter((e) => e.index === idx).length);
  game.results[game.current] = {
    correctIndex: q.correctIndex,
    distribution,
    ranking,
    fastest: ranking[0]
      ? { name: ranking[0].name, avatar: ranking[0].avatar, timeMs: ranking[0].timeMs, points: ranking[0].points }
      : null,
    correctCount: correctEntries.length,
    answeredCount: entries.length,
  };
  game.phase = 'reveal';
  broadcastPhase();
  game.timer = setTimeout(showLeaderboard, REVEAL_MS);
}

function showLeaderboard() {
  clearTimer();
  game.phase = 'leaderboard';
  broadcastPhase();
  game.timer = setTimeout(nextQuestion, LEADERBOARD_MS);
}

function nextQuestion() {
  clearTimer();
  if (game.current + 1 < game.deck.length) {
    startQuestion(game.current + 1);
  } else {
    game.phase = 'final';
    broadcastPhase();
  }
}

function playAgain() {
  clearTimer();
  clearVoteEndTimer();
  game.phase = 'lobby';
  game.current = -1;
  game.answers.clear();
  game.results = [];
  game.votes.clear();
  game.chosenSet = null;
  for (const p of game.players.values()) p.score = 0;
  broadcastPhase();
  emitHostPlayers();
}

// The host screen has one contextual button + the Space key.
function hostPrimary() {
  switch (game.phase) {
    case 'lobby': startVoting(); break;
    case 'voting': finalizeVoting(); break;
    case 'vote_result':
      if (game.players.size > 0) startGame();
      else { clearVoteEndTimer(); playAgain(); }
      break;
    case 'question': endQuestion(); break;
    case 'reveal': showLeaderboard(); break;
    case 'leaderboard': nextQuestion(); break;
    case 'final': playAgain(); break;
  }
}

// ---------------------------------------------------------------- payloads
function setCards() {
  return game.sets.map((s) => {
    const rounds = new Set(s.questions.map((q) => q.round || 'Round 1'));
    return {
      id: s.id,
      name: s.name,
      badge: s.badge,
      description: s.description,
      count: s.questions.length,
      rounds: rounds.size,
      seconds: Math.round((s.durationMs ?? DEFAULT_QUESTION_MS) / 1000),
    };
  });
}
function voteCounts() {
  const counts = {};
  for (const setId of game.votes.values()) counts[setId] = (counts[setId] ?? 0) + 1;
  return counts;
}
function scoreboard() {
  const rows = connectedPlayers().map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function phasePayloadFor(socketId) {
  const base = {
    phase: game.phase,
    title: '⚡ FlashTap',
    index: game.current,
    total: game.deck.length,
    branding: game.branding,
  };
  if (game.phase === 'lobby') {
    return { ...base, count: game.players.size };
  }
  if (game.phase === 'voting' || game.phase === 'vote_result') {
    const common = {
      ...base,
      sets: setCards(),
      counts: voteCounts(),
      votedCount: game.votes.size,
      totalPlayers: game.players.size,
      yourVote: game.votes.get(socketId) ?? null,
    };
    if (game.phase === 'vote_result') common.winnerId = game.chosenSet?.id ?? null;
    return common;
  }
  if (game.phase === 'question') {
    const q = game.deck[game.current];
    const elapsed = Date.now() - game.questionStartAt;
    return {
      ...base,
      question: q.q,
      answers: q.answers,
      durationMs: game.durationMs,
      remainingMs: Math.max(0, game.durationMs - elapsed),
      round: q.round,
    };
  }
  if (game.phase === 'reveal') {
    const r = game.results[game.current];
    const q = game.deck[game.current];
    let you = { answered: false };
    const ans = game.answers.get(socketId);
    if (ans) {
      you = {
        answered: true,
        correct: ans.correct,
        timeMs: ans.timeMs,
        points: ans.correct ? pointsFor(ans.timeMs) : 0,
      };
      if (ans.correct) you.rank = r.ranking.findIndex((e) => e.id === socketId) + 1;
    }
    return {
      ...base,
      question: q.q,
      answers: q.answers,
      correctIndex: r.correctIndex,
      distribution: r.distribution,
      fastest: r.fastest,
      correctCount: r.correctCount,
      answeredCount: r.answeredCount,
      fact: q.fact,
      ranking: r.ranking.slice(0, 3),
      you,
    };
  }
  // leaderboard | final
  const rows = scoreboard();
  const meRow = rows.find((r) => r.id === socketId) ?? null;
  return {
    ...base,
    board: rows,
    you: meRow ? { rank: meRow.rank, score: meRow.score } : null,
  };
}

function broadcastPhase() {
  for (const [id, sock] of io.sockets.sockets) {
    sock.emit('game:phase', phasePayloadFor(id));
  }
}
function emitHostPlayers() {
  io.to('host').emit('host:players', {
    players: connectedPlayers().map((p) => ({ name: p.name, avatar: p.avatar, score: p.score })),
  });
}
function emitLive() {
  if (game.phase === 'question') {
    io.to('host').emit('host:live', { answered: game.answers.size, total: game.players.size });
  }
}

// ---------------------------------------------------------------- app + io
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------- sockets
io.on('connection', (socket) => {
  socket.on('host:register', () => {
    socket.join('host');
    socket.emit('game:config', game.branding);
    socket.emit('game:phase', phasePayloadFor(socket.id));
    emitHostPlayers();
  });

  socket.on('player:join', ({ name } = {}) => {
    if (typeof name !== 'string') return;
    const clean = clip(name, MAX_NAME_LEN);
    if (!clean) {
      socket.emit('player:join_error', { error: 'Please type a name first' });
      return;
    }
    let player = game.players.get(socket.id);
    if (!player) {
      player = makePlayer(socket.id, uniqueName(clean));
      game.players.set(socket.id, player);
      socket.emit('game:config', game.branding);
      emitHostPlayers();
      emitLive();
    } else if (clean.toLowerCase() !== player.name.toLowerCase()) {
      player.name = uniqueName(clean);
      emitHostPlayers();
    }
    socket.emit('player:joined', { name: player.name, avatar: player.avatar, score: player.score });
    socket.emit('game:phase', phasePayloadFor(socket.id));
  });

  socket.on('player:vote', ({ setId } = {}) => {
    if (typeof setId !== 'string') return;
    registerVote(socket.id, setId);
  });

  socket.on('player:answer', ({ index } = {}) => {
    if (game.phase !== 'question' || !game.players.has(socket.id)) return;
    const q = game.deck[game.current];
    if (!Number.isInteger(index) || index < 0 || index >= q.answers.length) return;
    if (game.answers.has(socket.id)) return; // first answer is locked in
    const timeMs = Math.min(Date.now() - game.questionStartAt, game.durationMs);
    game.answers.set(socket.id, { index, timeMs, correct: index === q.correctIndex });
    socket.emit('player:answer_ack', { index, timeMs });
    emitLive();
  });

  socket.on('player:reaction', ({ emoji } = {}) => {
    const player = game.players.get(socket.id);
    if (!player) return;
    if (emoji !== 'like' && emoji !== 'love') return;
    const now = Date.now();
    if (now - player.lastReactionAt < REACTION_MIN_INTERVAL_MS) return;
    player.lastReactionAt = now;
    io.to('host').emit('host:reaction', { emoji, name: player.name });
  });

  socket.on('host:primary', hostPrimary);

  socket.on('disconnect', () => {
    if (game.players.delete(socket.id)) {
      game.votes.delete(socket.id);
      emitHostPlayers();
      emitLive();
      if (game.phase === 'voting') broadcastPhase();
    }
  });
});

// ---------------------------------------------------------------- http routes
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.use(express.static(path.join(__dirname, 'public')));

const QR_DATA_URL = await QRCode.toDataURL(JOIN_URL, {
  margin: 2,
  width: 520,
  color: { dark: '#1b1035ff', light: '#ffffffff' },
});
app.get('/api/qr', (_req, res) => res.json({ url: JOIN_URL, qr: QR_DATA_URL }));
app.get('/api/config', (_req, res) => res.json(game.branding));
app.post('/api/config', express.json({ limit: '32kb' }), (req, res) => {
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    res.status(400).json({ error: 'body must be an object' });
    return;
  }
  const cfg = sanitizeConfig({ ...game.branding, ...req.body, prizes: { ...game.branding.prizes, ...(req.body.prizes ?? {}) } });
  game.branding = cfg;
  saveGameConfigFile(cfg);
  io.emit('game:config', cfg);   // both host screens and clients update live
  res.json(cfg);
});
let venuesCache = [];
try { venuesCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'venues.json'), 'utf8')); } catch {}
app.get('/api/venues', (_req, res) => res.json(venuesCache));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, phase: game.phase, players: game.players.size, sets: questionSets.length }));

function saveGameConfigFile(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error(`! could not save config file ${CONFIG_FILE}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- go
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`✖ Port ${PORT} is already in use. Try:  npm start -- --port ${PORT + 1}`);
    process.exit(1);
  }
  throw err;
});

if (!QUIET) {
  console.log(`\n⚡ FlashTap — party server\n`);
  console.log(`   Players scan / open  :  ${JOIN_URL}`);
  console.log(`   Host big screen      :  ${JOIN_URL}/host\n`);
  console.log(await QRCode.toString(JOIN_URL, { type: 'utf8', small: true }));
  if (candidates.length > 1) {
    console.log('   Other addresses on this machine:');
    for (const c of candidates) {
      if (!IP_OVERRIDE && c.ip === chosen.ip) continue;
      console.log(`     ${c.name.padEnd(16)} http://${c.ip}:${PORT}`);
    }
    console.log('');
  }
  if (IP_OVERRIDE) console.log('   (address forced via --ip / HOST_IP)');
  console.log(`   ${questionSets.length} question sets loaded · setup screen: click the FlashTap logo on /host`);
  console.log('   Ctrl+C to stop.\n');
} else {
  console.log(`FlashTap server listening on ${PORT} (${JOIN_URL})`);
}

server.listen(PORT);
