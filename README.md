# ⚡ FlashTap

A self-hosted, local-network party quiz for **DJs and event organisers**. One
computer hosts the game and shows a big QR code on the venue's screen. Players
scan with their phones, pick a name, **vote on which question set** to play,
then tap answers as fast as they can — fastest correct finger wins the points.
While the clock runs, players spam 👍 and ❤️ and the reactions fly across the
big screen.

Built by **Jaxtech** · [nageljakes.github.io/jaxtechweb](https://nageljakes.github.io/jaxtechweb/)

---

## How a night runs

1. **Set up** — on the host screen, click the ⚡ logo: enter your DJ / company
   name, pick a venue (with venue-prefilled prizes, from the built-in venue
   list or type your own), add a scrolling ticker, and set how many questions
   per game.
2. **Join** — every phone scans the QR (or types the URL shown), types a name
   and lands in the lobby.
3. **Vote** — the host taps *Start voting*; players pick the question set they
   want (Switching your vote is allowed until everyone has voted — the set
   with the most votes is locked in and announced on the big screen).
4. **Play** — questions run from the winning set, alternating between its
   rounds so every game samples the whole set. Fastest correct answer scores
   the most (500–1000 points per question), with per-question "fastest"
   banners and a 🥇 unusual podium + confetti finale where tonight's prizes are
   announced.
5. **Play again** — straight back to the lobby for a fresh vote.

## Quick start

```bash
npm install
npm start
```

* Players open: `http://<your-lan-ip>:3000` (a QR code is shown on the host screen and in the terminal)
* Host screen: `http://localhost:3000/host`

Flags: `--port 3001`, `--ip 192.168.x.x` (force the join address), env
`REVEAL_MS`, `LEADERBOARD_MS` to speed up a test round.

## Windows installer (for venue PCs)

`npm run build:win` builds a Windows `.exe` installer with
[electron-builder](https://www.electron.build) (NSIS target):

```bash
npm run build:win
# → dist/FlashTap Setup 1.0.0.exe
```

The installer puts **FlashTap** on the desktop; launching it starts the game
server and opens the host screen in an app window (F11 for fullscreen on a
TV). On first launch Windows may ask to allow network access — click **Allow**
so phones on the Wi-Fi can join. Question sets ship inside the app; the setup
screen config is stored per-user.

## Question sets

Sets live in `question-sets/*.json`:

```json
{
  "id": "pop-music",
  "name": "Pop Music",
  "badge": "Sing-along round",
  "description": "Chart toppers and one-hit wonders",
  "durationMs": 20000,
  "questions": [
    { "q": "Which artist released 'Thriller'?", "answers": ["Prince", "Michael Jackson", "Madonna", "Stevie Wonder"], "correct": 1, "round": "Round 1 · Pop Icons", "fact": "Still the best-selling album ever." }
  ]
}
```

* `correct` is the 0-based index into `answers`; `round` groups questions so
  one game interleaves all rounds of a set; `fact` is shown on the host
  screen during the reveal.
* Per-file extras: `durationMs`, `shuffleQuestions`, `shuffleAnswers`,
  `roundSize`.
* Ships with **11 sets / 540 questions**: a warm-up crowd-pleaser set plus the
  ten *Beerbox Pub Quiz* grand sets imported from
  [Nageljakes/quiznight](https://github.com/Nageljakes/quiznight) via
  `npm run import-quiznight -- /path/to/quizSets.json`.
* Drop your own `*.json` into `question-sets/` and restart — the voting screen
  picks them up automatically.

The venue list the setup screen offers lives in `data/venues.json`
(pubs, branches, taglines, tickers and prize ladders — seeded from the
[Nageljakes/bingo](https://github.com/Nageljakes/bingo) venue file).

## Development

```bash
npm run smoke   # end-to-end protocol test (63 assertions)
npm run demo    # drives a live game and writes screenshots/ (needs Playwright)
npm run icon    # regenerate build/icon.png + build/icon.ico (Windows shell)
npm run app     # open the Electron shell locally
```

Architecture: one Express server (`server.js`) serves the host and client
pages and speaks Socket.IO; the phone client (`public/js/client.js`) and big
screen (`public/js/host.js`) are plain JS. Timing is server-authoritative
(fastest = lowest server receipt time), answers stay hidden until the reveal,
and reactions are throttled server-side (350 ms per player).

Socket protocol: `host:register`, `host:primary`, `player:join`,
`player:vote`, `player:answer`, `player:reaction` → broadcasts
`game:phase`, `host:players`, `host:live`, `host:reaction`, `game:config`,
`player:joined`, `player:answer_ack`.

## Credits

Reserved for value B
