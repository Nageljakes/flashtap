#!/usr/bin/env node
/**
 * Import question sets from the quiznight repo (github.com/Nageljakes/quiznight).
 *
 * usage: npm run import-quiznight -- /path/to/quiznight/quizSets.json
 *
 * Flattens every set's rounds into one questions list per set, maps the
 * "A) 7 points" style answers to option indexes, and writes one JSON file
 * per set into ./question-sets/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'question-sets');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('usage: node scripts/import-quiznight.mjs /path/to/quiznight/quizSets.json');
  process.exit(1);
}

const clean = (s) => str(s).replace(/^\s*[A-Da-d][).:\-]\s*/, '').trim();
const str = (v) => String(v ?? '');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const quizSets = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });

let imported = 0;
let skipped = 0;
for (const set of quizSets) {
  const questions = [];
  for (const round of set.rounds ?? []) {
    const roundLabel = str(round.title).replace(/:\s*/, ' · ');
    for (const rq of round.questions ?? []) {
      const answers = (rq.options ?? []).map(clean);
      const correctText = clean(rq.a);
      const correct = answers.indexOf(correctText);
      if (correct === -1) {
        console.warn(`  ! skipped: no option matches "${correctText}" in "${clean(rq.q).slice(0, 60)}"`);
        skipped++;
        continue;
      }
      questions.push({
        q: clean(rq.q),
        answers,
        correct,
        round: roundLabel || 'Round 1',
        fact: str(rq.notes).trim(),
      });
    }
  }
  const num = String(set.setId).padStart(2, '0');
  file: {
    const out = {
      id: slug(set.setName || `set-${num}`),
      name: str(set.setName),
      badge: str(set.badge),
      description: str(set.theme),
      questions,
    };
    const file = path.join(OUT_DIR, `${num}-set-${num}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    imported += questions.length;
    console.log(`✔ ${path.basename(file)} — ${questions.length} questions — ${out.name}`);
  }
}

console.log(`\ndone: ${imported} questions imported, ${skipped} skipped, from ${quizSets.length} sets`);
