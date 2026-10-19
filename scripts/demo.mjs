#!/usr/bin/env node
/**
 * FlashTap demo — drives a real game with socket.io clients and captures
 * screenshots of the host screen + phone client with headless Chromium.
 *
 *   npm run demo
 *
 * Screenshots land in ./screenshots/.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode';
const SETS_DIR = `${TMP}/demo-sets`;
const CFG_FILE = `${TMP}/demo-config.json`;

mkdirSync(OUT, { recursive: true });
mkdirSync(SETS_DIR, { recursive: true });
rmSync(CFG_FILE, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- demo sets
const SETS = [
  {
    file: 'pop-music',
    data: {
      id: 'pop-music',
      name: 'Pop Music',
      badge: 'Sing-along round',
      description: 'Chart toppers, one-hit wonders and local legends',
      durationMs: 12000,
      shuffleQuestions: false,
      shuffleAnswers: false,
      questions: [
        { q: "Which artist released the album 'Thriller'?", answers: ['Prince', 'Michael Jackson', 'Madonna', 'Stevie Wonder'], correct: 1, round: 'Round 1 · Pop Icons', fact: "It's still the best-selling album of all time." },
        { q: "Which SA artist is known for the hit 'Jerusalema'?", answers: ['Master KG', 'Kabza De Small', 'DJ Maphorisa', 'Black Coffee'], correct: 0, round: 'Round 2 · Local Hits', fact: 'The Jerusalema challenge went global in 2020.' },
        { q: 'How many strings does a standard guitar have?', answers: ['4', '5', '6', '8'], correct: 2, round: 'Round 2 · Local Hits', fact: '' },
      ],
    },
    answers: [1, 0, 2],
  },
  {
    file: 'geography',
    data: {
      id: 'geography',
      name: 'Geography',
      badge: 'Around the world',
      description: 'Rivers, capitals and places you should have visited',
      durationMs: 12000,
      shuffleQuestions: false,
      shuffleAnswers: false,
      questions: [
        { q: 'Which is the longest river in the world?', answers: ['Amazon', 'Nile', 'Yangtze', 'Mississippi'], correct: 1, round: 'Round 1 · Waterways', fact: 'The Nile is about 6,650 km long.' },
        { q: 'In which country is Cape Town?', answers: ['Kenya', 'Nigeria', 'South Africa', 'Ghana'], correct: 2, round: 'Round 2 · Capitals', fact: '' },
        { q: 'Which desert is the largest hot desert on Earth?', answers: ['Gobi', 'Sahara', 'Kalahari', 'Atacama'], correct: 1, round: 'Round 2 · Capitals', fact: '' },
      ],
    },
    answers: [1, 2, 1],
  },
  {
    file: 'science',
    data: {
      id: 'science',
      name: 'Science & Nature',
      badge: 'Nerd corner',
      description: 'Physics, biology and a bit of bar-science',
      durationMs: 12000,
      shuffleQuestions: false,
      shuffleAnswers: false,
      questions: [
        { q: 'What gas do plants absorb from the air?', answers: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], correct: 2, round: 'Round 1 · Biology', fact: 'Plants release oxygen while making food.' },
        { q: 'How many bones are in the adult human body?', answers: ['206', '186', '226', '246'], correct: 0, round: 'Round 2 · Bodies', fact: 'Babies start with about 270 bones.' },
        { q: 'Which planet has the most moons?', answers: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'], correct: 1, round: 'Round 2 · Bodies', fact: '' },
      ],
    },
    answers: [2, 0, 1],
  },
];
for (const s of SETS) writeFileSync(path.join(SETS_DIR, `${s.file}.json`), JSON.stringify(s.data, null, 2));
const chosen = SETS[0]; // pop-music wins the vote in this demo

// ---------------------------------------------------------------- server
const proc = spawn(
  process.execPath,
  [path.join(ROOT, 'server.js'), '--port', String(PORT), '--question-sets', SETS_DIR, '--config', CFG_FILE],
  { env: { ...process.env, REVEAL_MS: '9000', LEADERBOARD_MS: '9000' }, stdio: ['ignore', 'pipe', 'pipe'] }
);
let serverLog = '';
proc.stdout.on('data', (d) => { serverLog += d; });
proc.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

function once(sock, ev, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const fn = (p) => { clearTimeout(t); sock.off(ev, fn); resolve(p); };
    const t = setTimeout(() => { sock.off(ev, fn); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    sock.on(ev, fn);
  });
}
function waitFor(sock, ev, pred, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const fn = (p) => { if (!pred || pred(p)) { clearTimeout(t); sock.off(ev, fn); resolve(p); } };
    const t = setTimeout(() => { sock.off(ev, fn); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    sock.on(ev, fn);
  });
}

// ---------------------------------------------------------------- screenshots
const PY = path.join(process.env.HOME, '.venvs', 'browsing', 'bin', 'python');
const SHOT = path.join(ROOT, 'scripts', 'screenshot.py');
function shot(name, urlPath, waitMs = 1600, client = false) {
  const file = path.join(OUT, name);
  try {
    execFileSync(
      PY,
      [SHOT, `${BASE}${urlPath}`, file,
        '--wait', String(waitMs),
        '--width', client ? '420' : '1600',
        '--height', client ? '880' : '900'],
      { timeout: 90000, stdio: 'pipe' }
    );
    console.log(`  📸 ${name}`);
  } catch (err) {
    console.log(`  ⚠ screenshot ${name} failed: ${String(err.message).slice(0, 120)}`);
  }
}

async function player(name) {
  const sock = io(BASE, { transports: ['websocket'] });
  const joinedP = once(sock, 'player:joined');
  sock.emit('player:join', { name });
  const joined = await joinedP;
  return { sock, name: joined.name, avatar: joined.avatar };
}
async function vote(p, setId) {
  const p2 = waitFor(p.sock, 'game:phase', (x) => (x.phase === 'voting' && x.yourVote === setId) || x.phase === 'vote_result');
  p.sock.emit('player:vote', { setId });
  try { await p2; } catch {}
}

async function main() {
  if (!(await waitForServer())) throw new Error('server did not start');
  console.log('⚡ FlashTap demo running at', BASE);

  // ---- venue setup (as if saved from the setup screen)
  await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostName: 'TJ Entertainment',
      venueName: 'BEERBOX PUB & GRILL',
      shortName: 'Beerbox',
      branch: 'Midrand',
      tagline: 'Live Pub Entertainment & Craft Drafts',
      ticker: 'BEERBOX MIDRAND • 2-FOR-1 CRAFT DRAFTS UNTIL 8PM • R500 BAR TAB GRAND PRIZE • DELICIOUS BURGERS & CRISPY WINGS • ENJOY FLASHTAP NIGHT!',
      themeColor: '#F59E0B',
      prizes: {
        stage1: 'R500 Beerbox Bar Tab & Trophy',
        stage2: 'Pitcher of Beer & Snack Platter',
        stage3: 'Round of Shooters or Free Draft',
      },
      roundSize: 2,
    }),
  });

  const host = io(BASE, { transports: ['websocket'] });
  host.emit('host:register');

  // ---- join screen (branding visible)
  shot('01-client-join.png', '/', 1600, true);

  const hostReady = waitFor(host, 'host:players', (p) => p.players.length >= 3, 20000);
  const alice = await player('Alice');
  const bob = await player('Bob');
  const carol = await player('Carol');
  await hostReady;

  shot('02-host-lobby.png', '/host', 1800);
  shot('03-host-setup.png', '/host?setup=1', 2600);

  // ---- voting
  const votingP = waitFor(host, 'game:phase', (x) => x.phase === 'voting');
  host.emit('host:primary');
  await votingP;
  await vote(alice, 'pop-music');
  await vote(bob, 'geography');
  await sleep(200);

  shot('04-host-voting.png', '/host', 1600);
  shot('05-client-voting.png', '/?autojoin=Demo', 3400, true);

  // carol + demo are still to vote; demo's browser disconnects after the shot
  await sleep(500);
  await vote(carol, 'pop-music');
  let resultP = waitFor(host, 'game:phase', (x) => x.phase === 'vote_result', 4000).catch(() => null);
  let result = await resultP;
  if (!result) {
    // the auto-lock waits for everyone; if the screenshot browser is still
    // counted as a player, the host locks the vote manually
    const again = waitFor(host, 'game:phase', (x) => x.phase === 'vote_result', 6000);
    host.emit('host:primary');
    result = await again;
  }
  console.log('  🗳️ vote result: pop-music');

  shot('06-host-vote-result.png', '/host', 1500);

  // ---- round 1: question 1
  const q1P = waitFor(host, 'game:phase', (x) => x.phase === 'question' && x.index === 0);
  host.emit('host:primary');
  await q1P;
  const q1Start = Date.now();
  await sleep(2200);
  shot('07-host-question.png', '/host', 1600);
  shot('08-client-question.png', '/?autojoin=Demo', 3200, true);

  const correct1 = chosen.answers[0];
  const wrong1 = (correct1 + 1) % 4;
  alice.sock.emit('player:answer', { index: correct1 });        // fast + right
  bob.sock.emit('player:answer', { index: wrong1 });            // wrong
  await sleep(700);
  carol.sock.emit('player:answer', { index: correct1 });        // right + slower

  // cut the question clock short and go to the reveal
  const revealP = waitFor(host, 'game:phase', (x) => x.phase === 'reveal');
  await sleep(400);
  host.emit('host:primary');
  await revealP;
  await sleep(900);
  shot('09-host-reveal.png', '/host', 1700);

  const lbP = waitFor(host, 'game:phase', (x) => x.phase === 'leaderboard');
  host.emit('host:primary');
  await lbP;
  await sleep(500);
  shot('10-host-leaderboard.png', '/host', 1500);

  // ---- round 2
  const q2P = waitFor(host, 'game:phase', (x) => x.phase === 'question' && x.index === 1);
  host.emit('host:primary');
  await q2P;
  const correct2 = chosen.answers[1];
  const wrong2 = (correct2 + 2) % 4;
  await sleep(800);
  alice.sock.emit('player:answer', { index: correct2 });
  await sleep(500);
  carol.sock.emit('player:answer', { index: correct2 });
  bob.sock.emit('player:answer', { index: wrong2 });
  const reveal2P = waitFor(host, 'game:phase', (x) => x.phase === 'reveal');
  await sleep(500);
  host.emit('host:primary');
  await reveal2P;
  const lb2P = waitFor(host, 'game:phase', (x) => x.phase === 'leaderboard');
  host.emit('host:primary');
  await lb2P;
  const finP = waitFor(host, 'game:phase', (x) => x.phase === 'final');
  host.emit('host:primary');
  await finP;
  await sleep(1400);
  shot('11-host-final.png', '/host', 2000);

  console.log('\n✔ demo screenshots written to', OUT);
  host.disconnect();
  alice.sock.disconnect();
  bob.sock.disconnect();
  carol.sock.disconnect();
  proc.kill('SIGTERM');
  await new Promise((r) => { proc.on('exit', r); setTimeout(r, 1500); });
  try { rmSync(SETS_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error('✖ demo failed:', err.message);
  console.error(serverLog.split('\n').slice(-20).join('\n'));
  proc.kill('SIGTERM');
  process.exit(1);
});
