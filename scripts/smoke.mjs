#!/usr/bin/env node
/**
 * End-to-end smoke test for FlashTap.
 *
 * Spawns its own server on port 4599 with two tiny question sets, fast phase
 * timers, and a throwaway config file, then drives real socket.io clients
 * through: setup config, vote phase + vote switching + auto lock, a full
 * 2-question game from the winning set, reactions, reveal/scoring,
 * leaderboard, final, play-again revote, and a mid-question joiner.
 *
 *   npm run smoke
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode';
const SETS_DIR = `${TMP}/smoke-sets`;
const CFG_FILE = `${TMP}/smoke-config.json`;

mkdirSync(SETS_DIR, { recursive: true });
rmSync(CFG_FILE, { force: true });
function setFile(name, id, questions) {
  writeFileSync(
    path.join(SETS_DIR, `${name}.json`),
    JSON.stringify({ id, name, description: `${name} theme`, durationMs: 1500, shuffleQuestions: false, shuffleAnswers: false, questions })
  );
}
setFile('a', 'alpha', [
  { q: 'A1 first?', answers: ['A1-wrong', 'A1-right', 'A1-other'], correct: 1, round: 'Round A', fact: 'a fact one' },
  { q: 'A2 second?', answers: ['A2-right', 'A2-wrong'], correct: 0, round: 'Round A', fact: '' },
  { q: 'A3 third?', answers: ['A3-wrong', 'A3-right'], correct: 1, round: 'Round A', fact: '' },
]);
setFile('b', 'bravo', [
  { q: 'B1 first?', answers: ['B1-wrong', 'B1-right'], correct: 1, round: 'Round A', fact: '' },
  { q: 'B2 second?', answers: ['B2-right', 'B2-wrong'], correct: 0, round: 'Round A', fact: '' },
  { q: 'B3 third?', answers: ['B3-wrong', 'B3-right'], correct: 1, round: 'Round A', fact: '' },
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${label}${cond ? '' : `   [${extra}]`}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- server
const proc = spawn(
  process.execPath,
  [path.join(ROOT, 'server.js'), '--port', String(PORT), '--question-sets', SETS_DIR, '--config', CFG_FILE],
  { env: { ...process.env, REVEAL_MS: '700', LEADERBOARD_MS: '700' }, stdio: ['ignore', 'pipe', 'pipe'] }
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

// ---------------------------------------------------------------- helpers
function once(sock, ev, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const fn = (payload) => { clearTimeout(t); sock.off(ev, fn); resolve(payload); };
    const t = setTimeout(() => { sock.off(ev, fn); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    sock.on(ev, fn);
  });
}
function waitFor(sock, ev, pred, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const fn = (payload) => {
      if (!pred || pred(payload)) { clearTimeout(t); sock.off(ev, fn); resolve(payload); }
    };
    const t = setTimeout(() => { sock.off(ev, fn); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    sock.on(ev, fn);
  });
}
const connect = () => io(BASE, { transports: ['websocket'] });
async function answer(sock, index, delayMs) {
  await sleep(delayMs);
  const ackP = once(sock, 'player:answer_ack');
  sock.emit('player:answer', { index });
  return ackP;
}
const exp = (t) => Math.round(1000 * (1 - 0.5 * t / 1500)); // points for 1500ms questions

async function postConfig(body) {
  const r = await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------------------------------------------------------------- test
async function main() {
  const socks = [];
  try {
    if (!(await waitForServer())) throw new Error('server did not start');
    ok(true, 'server boots and answers /api/health');

    const health = await (await fetch(`${BASE}/api/health`)).json();
    ok(health.sets === 2, 'health reports 2 question sets', JSON.stringify(health));

    // ---- host registers, receives branding config
    const host = connect();
    socks.push(host);
    const hostCfgP = once(host, 'game:config');
    host.emit('host:register');
    const hostCfg = await hostCfgP;
    ok(typeof hostCfg.roundSize === 'number' && typeof hostCfg.themeColor === 'string', 'host receives default branding config');

    // ---- setup screen submit: venue + DJ + prizes
    const postCfg = await postConfig({
      hostName: 'DJ ' + 'X'.repeat(200),
      venueName: 'BEERBOX PUB & GRILL',
      branch: 'Testville',
      ticker: 'FLASH TEST NIGHT',
      prizes: { stage1: 'R100 tab', stage2: '2 beers', stage3: 'chips' },
      roundSize: 400,
    });
    ok(postCfg.hostName.length === 40, 'hostName trimmed to 40 chars', String(postCfg.hostName.length));
    ok(postCfg.venueName === 'BEERBOX PUB & GRILL' && postCfg.branch === 'Testville', 'venue + branch saved');
    ok(postCfg.prizes.stage1 === 'R100 tab' && postCfg.prizes.stage3 === 'chips', 'prizes saved');
    ok(postCfg.roundSize === 60, 'roundSize clamped to 60', String(postCfg.roundSize));
    let saved = {};
    try { saved = JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch {}
    ok(saved.venueName === 'BEERBOX PUB & GRILL', 'config persisted to disk');
    const cfg2 = await postConfig({ roundSize: 2 });
    ok(cfg2.roundSize === 2, 'roundSize set to 2 for a short test game');

    // ---- venues endpoint (used by the setup dropdown)
    const venues = await (await fetch(`${BASE}/api/venues`)).json();
    ok(Array.isArray(venues) && venues.length > 3 && !!venues[0].prizes?.stage3, 'venues list with prizes served');

    // ---- players join
    const players = {};
    for (const name of ['Alice', 'Bob', 'Carol']) {
      const s = connect();
      socks.push(s);
      const joinedP = once(s, 'player:joined');
      const phaseP = once(s, 'game:phase');
      s.emit('player:join', { name });
      const joined = await joinedP;
      const phase = await phaseP;
      players[name] = { sock: s, joined, phase };
      ok(joined.name === name && !!joined.avatar, `join: ${name} (avatar ${joined.avatar})`);
      ok(phase.phase === 'lobby', `join: ${name} receives lobby snapshot`);
    }

    // duplicate name is renamed
    const dup = connect();
    socks.push(dup);
    const dupJoinedP = once(dup, 'player:joined');
    const backTo3P = waitFor(host, 'host:players', (p) => p.players.length === 3);
    dup.emit('player:join', { name: 'alice' });
    const dupJoined = await dupJoinedP;
    ok(dupJoined.name === 'Alice 2', 'duplicate name gets a suffix', JSON.stringify(dupJoined));
    dup.disconnect();
    await backTo3P;
    ok(true, 'host sees 3 players after the duplicate disconnects');

    // ---- start → voting phase
    const voteSnapshots = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'voting'));
    const hostVoteP = waitFor(host, 'game:phase', (x) => x.phase === 'voting');
    host.emit('host:primary');
    const [votePays, hostVote] = await Promise.all([Promise.all(voteSnapshots), hostVoteP]);
    ok(votePays.every((v) => v.phase === 'voting'), 'lobby primary → voting for all players');
    ok(votePays[0].sets.length === 2 && votePays[0].yourVote === null, 'voting payload carries sets + no vote yet');
    ok(votePays[0].sets[0].count === 3 && votePays[0].totalPlayers === 3, 'set card lists question count + player total');
    ok(hostVote.sets.length === 2 && !('yourVote' in hostVote) === false, 'host receives voting snapshot too');

    // ---- vote: alice→alpha, bob→bravo, carol→bravo then switches to alpha
    await (async () => {
      const p = waitFor(players.Alice.sock, 'game:phase', (x) => x.phase === 'voting' && x.yourVote === 'alpha');
      players.Alice.sock.emit('player:vote', { setId: 'alpha' });
      await p;
      ok(true, 'alice voted alpha (yourVote confirmed)');
    })();
    await (async () => {
      const p = waitFor(players.Bob.sock, 'game:phase', (x) => x.phase === 'voting' && x.yourVote === 'bravo');
      players.Bob.sock.emit('player:vote', { setId: 'bravo' });
      await p;
      ok(true, 'bob voted bravo');
    })();

    const resultWaiters = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'vote_result'));
    const hostResultP = waitFor(host, 'game:phase', (x) => x.phase === 'vote_result');
    const carolFirst = waitFor(players.Carol.sock, 'game:phase', (x) => x.phase === 'voting' && x.yourVote === 'bravo');
    players.Carol.sock.emit('player:vote', { setId: 'bravo' });   // all voted → 900ms auto-lock armed
    await carolFirst;
    const carolSwitch = waitFor(players.Carol.sock, 'game:phase', (x) => x.phase === 'voting' && x.yourVote === 'alpha');
    players.Carol.sock.emit('player:vote', { setId: 'alpha' });   // switch inside the settle window
    await carolSwitch;
    ok(true, 'carol switched her vote before the lock');
    const [resA, resB, resC] = await Promise.all(resultWaiters);
    const hostResult = await hostResultP;
    ok(resA.counts.alpha === 2 && resA.counts.bravo === 1, 'final counts alpha=2 bravo=1', JSON.stringify(resA.counts));
    ok(resA.winnerId === 'alpha' && resB.winnerId === 'alpha' && hostResult.winnerId === 'alpha', 'vote_result: alpha wins');
    ok(resC.yourVote === 'alpha', 'vote_result: carol kept her switched vote');

    // ---- start game from the winning set (roundSize 2 → A1, A2)
    const { Alice, Bob, Carol } = players;
    const q1Waiters = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'question' && x.index === 0));
    const hq1P = waitFor(host, 'game:phase', (x) => x.phase === 'question');
    host.emit('host:primary');
    const [q1s, q1h] = await Promise.all([Promise.all(q1Waiters), hq1P]);
    const q1 = q1s[0];
    ok(q1.question === 'A1 first?', 'deck comes from the winning set (alpha q1)', q1.question);
    ok(q1.round === 'Round A', 'question payload carries the round label');
    ok(q1h.question === 'A1 first?' && q1h.answers.length === 3, 'host receives question payload');
    ok(q1.durationMs === 1500, 'question duration matches set config');
    ok(q1.correctIndex === undefined, 'correct answer is NOT leaked during the question');
    ok(q1.total === 2, 'total honors the roundSize of 2');

    // ---- answers: Alice correct + fast, Bob wrong, Carol correct + slower
    const live1P = waitFor(host, 'host:live', (l) => l.answered === 1 && l.total === 3);
    const aAck = await answer(Alice.sock, 1, 250);
    await live1P;
    ok(aAck.index === 1 && aAck.timeMs >= 200, `alice ack (${aAck.timeMs}ms)`);
    const bAck = await answer(Bob.sock, 0, 150);
    const cAck = await answer(Carol.sock, 1, 200);
    ok(!!bAck && !!cAck, 'bob + carol acks received');

    const revPs = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'reveal' && x.index === 0));

    // duplicate answer is ignored
    const leakP = once(Alice.sock, 'player:answer_ack', 900).then(() => true).catch(() => false);
    Alice.sock.emit('player:answer', { index: 2 });
    ok(!(await leakP), 'second answer from the same player ignored');

    // reaction throttling (350ms): rapid sends are dropped
    let reactCount = 0;
    const reactFn = () => reactCount++;
    host.on('host:reaction', reactFn);
    Carol.sock.emit('player:reaction', { emoji: 'love' });
    await sleep(60);
    Carol.sock.emit('player:reaction', { emoji: 'like' });
    Carol.sock.emit('player:reaction', { emoji: 'love' });
    await sleep(320);
    Carol.sock.emit('player:reaction', { emoji: 'like' });
    await sleep(200);
    host.off('host:reaction', reactFn);
    ok(reactCount >= 2 && reactCount <= 3, `reaction throttle (host saw ${reactCount} of 4)`);
    Carol.sock.emit('player:reaction', { emoji: 'nuke' });   // invalid emoji ignored
    Alice.sock.emit('player:answer', { index: 99 });           // invalid index ignored
    await sleep(150);

    // ---- reveal
    const [revA, revB, revC] = await Promise.all(revPs);
    ok(revA.correctIndex === 1, 'reveal: correctIndex === 1');
    ok(JSON.stringify(revA.distribution) === JSON.stringify([1, 2, 0]), 'reveal: distribution [1,2,0]', JSON.stringify(revA.distribution));
    ok(revA.fastest?.name === 'Alice', 'reveal: fastest is Alice');
    ok(revA.fastest.timeMs === aAck.timeMs, 'reveal: fastest time matches alice ack');
    ok(revA.question === 'A1 first?', 'reveal includes the question text (regression fix)');
    ok(revA.fact === 'a fact one', 'reveal includes the fun fact');
    ok(revA.you.correct === true && revA.you.points === exp(aAck.timeMs) && revA.you.rank === 1,
      'reveal: alice you-payload (correct, points, rank 1)');
    ok(revB.you.correct === false && revB.you.points === 0, 'reveal: bob wrong, 0 points');
    ok(revC.you.correct === true && revC.you.rank === 2, 'reveal: carol rank 2');

    // ---- leaderboard
    const lb1 = await waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'leaderboard');
    ok(lb1.board[0].name === 'Alice' && lb1.board[0].score === exp(aAck.timeMs), 'leaderboard: Alice first (speed points)');
    ok(lb1.board[1].name === 'Carol' && lb1.board[1].score === exp(cAck.timeMs), 'leaderboard: Carol second');
    ok(lb1.board[2].name === 'Bob' && lb1.board[2].score === 0, 'leaderboard: Bob zero');

    // ---- question 2 (still from alpha)
    const q2 = await waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'question' && x.index === 1);
    ok(q2.question === 'A2 second?', 'question 2 auto-starts from the winning set');
    const a2 = await answer(Alice.sock, 0, 250);
    const b2 = await answer(Bob.sock, 1, 120);
    const c2 = await answer(Carol.sock, 0, 260);
    const rev2P = waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'reveal' && x.index === 1);
    const lb2P = waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'leaderboard');
    await rev2P;
    const lb2 = await lb2P;
    ok(lb2.board[0].name === 'Alice' && lb2.board[0].score === exp(aAck.timeMs) + exp(a2.timeMs), 'cumulative score: Alice');
    ok(lb2.board[1].name === 'Carol' && lb2.board[1].score === exp(cAck.timeMs) + exp(c2.timeMs), 'cumulative score: Carol');
    ok(lb2.board[2].name === 'Bob' && lb2.board[2].score === 0, 'Bob still zero');

    // ---- final
    const finP = waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'final');
    host.emit('host:primary'); // leaderboard → final
    const fin = await finP;
    ok(fin.phase === 'final' && fin.board.length === 3, 'final phase with 3 players on the board');
    ok(fin.you?.rank === 1, "final: alice's you.rank === 1");

    // ---- play again → lobby → fresh vote, bravo unanimous
    const lobP = waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'lobby');
    host.emit('host:primary');
    const lob = await lobP;
    ok(lob.count === 3, 'play again: back to lobby, players kept');

    const vote2Waiters = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'voting'));
    host.emit('host:primary');
    await Promise.all(vote2Waiters);
    ok(true, 'play again → fresh voting phase');

    const results2 = Object.values(players).map((p) =>
      waitFor(p.sock, 'game:phase', (x) => x.phase === 'vote_result'));
    Alice.sock.emit('player:vote', { setId: 'bravo' });
    Bob.sock.emit('player:vote', { setId: 'bravo' });
    Carol.sock.emit('player:vote', { setId: 'bravo' });
    await Promise.all(results2);
    ok(true, 'revote: bravo unanimous');

    const freshP = waitFor(Alice.sock, 'game:phase', (x) => x.phase === 'question' && x.index === 0);
    host.emit('host:primary'); // start the bravo game
    const fresh = await freshP;
    ok(fresh.question === 'B1 first?', 'fresh game plays the newly voted set (bravo q1)');

    // ---- mid-question joiner gets a live snapshot
    const late = connect();
    socks.push(late);
    const lateJoinedP = once(late, 'player:joined');
    const latePhaseP = once(late, 'game:phase');
    late.emit('player:join', { name: 'Zoe' });
    await lateJoinedP;
    const latePhase = await latePhaseP;
    ok(latePhase.phase === 'question' && latePhase.remainingMs < latePhase.durationMs,
      'mid-question joiner receives live snapshot',
      JSON.stringify({ phase: latePhase.phase, remainingMs: latePhase.remainingMs }));

    ok(true, 'server survived the entire flow');
  } catch (err) {
    failures++;
    console.error(`  ✖ FATAL: ${err.message}`);
  } finally {
    for (const s of socks) s.disconnect();
    proc.kill('SIGTERM');
    await new Promise((r) => { proc.on('exit', r); setTimeout(r, 2000); });
    try { rmSync(SETS_DIR, { recursive: true, force: true }); } catch {}
  }

  console.log('');
  if (failures) {
    console.log(`✖ SMOKE FAILED — ${failures} assertion(s) failed\n`);
    console.log('--- server log tail ---');
    console.log(serverLog.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
  console.log('✔ SMOKE PASSED — all assertions green\n');
  process.exit(0);
}

main();
