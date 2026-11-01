# Handover: what has been going on (read this first)

This file is the running context for an agent picking up work on this repo,
written at the end of a long cloud session (late Oct – 1 Nov 2026). The owner
is about to run an agent **on the VPS itself** to debug a live problem (see
"Open problem" below). `AGENTS.md` still applies: never guess a design
decision — ask the owner; plan first, get approval, then implement.

Owner preferences that held throughout:
- Professional, neutral tone. No emotional reassurance, no "great question".
- **Finished work goes to `main`** ("Put everything on main branch"): open a
  PR, wait for CI to be green, merge. Don't leave work on side branches.
- The owner mostly works from a phone. Keep messages short, outcome first.

## 1. Where the app runs

- **VPS:** Hetzner, 8 GB RAM / 4 vCPU (rescaled 1 Nov 2026). Login user
  `jaca`. Checkout at `~/Projects/learnharness` (the owner runs
  `sudo docker compose …` from `~/Projects/learnharness/deploy`). Domain **learnharness.computenode.io** (Cloudflare
  A record, DNS only, so Caddy gets Let's Encrypt directly).
- **Stack:** `deploy/docker-compose.yml` — `learnharness` (Next.js phone server,
  `scripts/phone-server.mjs`, port 3210, data in volume `learnharness-data` at
  `/data`), `caddy` (HTTPS, `deploy/Caddyfile`), and `lean` (code cells, see §4).
  `deploy/.env` holds `LH_HOST` (and `LEAN_TAG` when deployed by the workflow).
- **Access:** every page/API needs the pairing cookie; the code is in
  `/data/phone-access-code` (`sudo docker compose exec learnharness cat /data/phone-access-code`).
  Never commit it, `auth.json`, keys or `deploy/.env`.
- **Data:** the owner's desktop data was migrated into the volume earlier
  (from `/root/lh-import` via `docker compose cp`). It is live data — back it up
  before anything risky: `sudo docker compose exec learnharness tar czf - /data > backup.tgz`.
- **Deploying:** the owner deploys by hand on the server: `git pull && sudo docker compose up -d --build`
  in `deploy/`. `.github/workflows/deploy-vps.yml` (SSH deploy from Actions)
  exists but its secrets (`VPS_HOST`, `VPS_SSH_KEY`) were never set, so it has
  never run successfully — don't rely on it.
- **Android app:** thin WebView client (`mobile/`), APK from the
  `android-latest` release, built by `.github/workflows/android-apk.yml`
  (emulator smoke tests on API 30/34/35; the API 34 job occasionally fails at
  WebView re-attach and passes on one re-run).
- Docs: `docs/deploy-vps.md` (server), `docs/android.md`.

## 2. History of this session (oldest first)

1. Android thin client, VPS Docker/Caddy deployment, phone UI test report.
2. Deployment help for the Hetzner box, Cloudflare DNS record, data migration
   from the Windows desktop app (via WSL).
3. **Performance pass** (PR #2, merged): structural sharing of the transcript
   view (`src/core/view.ts` `stabilizeView`), memoized transcript rows
   (`components/chat.tsx`), stream render coalescing (`STREAM_RENDER_MS`),
   graph canvas blur/label caching (`components/graph-canvas.ts`), lazy
   mermaid. Perf probes in `tests/perf/`.
4. **Lean code cells** (PR #3, merged) — the owner is learning Lean and asked
   for the tutor to pose fill-in-the-proof cells. Decisions the owner made
   (do not change without asking):
   - Live Lean via the **language server** (not Jupyter/REPL), **with Mathlib**.
   - In **teaching and practice** sessions.
   - Statement **locked + checked**: prelude and theorem statement read-only,
     learner writes the proof (starts as `sorry`); the server re-checks the
     exact statement on submit.
   - Submit **any time**; the learner sees live whether it passes.
   - Settings: separate **"Code cells: Off | Mixed in"** switch (Off by
     default), independent of Quizzing (multiple choice / free recall).
   - Code cells only when the session is **about Lean** (the plan is marked
     `codeCells` by the tutor), never for maths/physics/logic without Lean, and
     **not two code cells in a row** unless the learner asks.
   - Practice: Lean problems allowed only when the practiced propositions came
     from a teaching session whose plan was marked as a Lean topic.
   - Grading strictness: **normal** (no errors, no sorry, standard axioms only;
     a proof crafted to fool `#print axioms` is out of scope).
5. **QA pass** (PR #4, merged) — the owner asked whether all flows were QA'd
   with screenshots. They weren't; a real-Lean QA run was added and it found
   and fixed: answered Lean cards not rendering, goal panel showing "No goals"
   on `sorry` lines, practice proof reset after submit, completion without
   types, raw JSON in the offline error, completion list staying open after
   Submit. Autocompletion and the phone-readable "Lean says" panel were added.
   Screenshot page: https://claude.ai/artifact/QM9jFZLJBePMTkyJmZtrfo

## 3. The "This operation was aborted" problem (solved 1 Nov 2026)

Debugged on the VPS. Two separate causes:
- **Every Lean check timed out (120 s).** Mathlib's compiled files are ~6 GB
  and must stay in memory; the server had 3.8 GB RAM and Lean a 3 GB cap, so
  `import Mathlib` re-read them from disk (~16 GB of reads per check). The
  owner rescaled the server to 8 GB / 4 vCPU and set `LEAN_MEM_LIMIT=6g` in
  `deploy/.env`; checks now take 7–12 s warm, ~70 s cold.
- **The abort itself came from the client** (`POST /api/activity/abort`)
  while the tutor waited on that check — most likely Stop or Enter on the
  empty composer (both abort without confirmation). pi-ai records an abort
  that happens before a request as `stopReason: "error"` (`api/lazy.js`), so
  `error` in the record does not rule out a user abort.

Follow-ups done: the Lean service warms Mathlib on start (`/health`
`warming`), the transcript shows "Lean server starting" while it does.
Server notes: the checkout is `~/Projects/learnharness` (not `~/learnharness`);
the owner added `jaca` to the `docker` group for agent debugging.

Still open (offered, not approved): Lean exercise cells appear before the
reference proof passes; a failed `lean_exercise` counts toward "not two in a
row"; code cells stay on when Lean is down; a confirmation for Stop.

## 4. Code cells: how it works (file map)

- **Lean service** `deploy/lean/`: `Dockerfile` (Node 24 + elan, Lean
  `v4.35.0`, Mathlib `v4.35.0` via `project/lakefile.toml`, `lake exe cache get`,
  `lake build Mathlib` at image time so the server never writes `.lake` at run
  time), `bridge/bridge.mjs`:
  - `WS /lean/lsp` — one `lake serve` per connection; documents must be
    `file:///cell/<name>.lean` (mapped into the project); allowlisted LSP
    methods; idle close (10 min); a new session replaces the oldest
    (`LEAN_MAX_SESSIONS`, default 1); `Origin` must match `LH_PUBLIC_URL`.
  - `POST /check {source}` — `lake env lean --json`, returns messages; queued,
    120 s per check. Internal only (Caddy doesn't route it).
  - `GET /health`.
  - Compose: internal network `lean` (no internet), non-root, caps dropped,
    `mem_limit ${LEAN_MEM_LIMIT:-3g}`. Image tag `learnharness-lean:${LEAN_TAG:-local}`.
  - Caddy routes `/lean/lsp` with `forward_auth` to `/api/lean/authorize`
    (the app's pairing check).
- **Core** `src/core/lean-cell.ts`: exercise validation, the cell document
  layout (prelude, blank, statement, proof) shared by editor and grader,
  `cellCheckSource` (+ `#print axioms _root_.<name>`), `gradeLeanCheck`
  (errors / sorry (both quote styles) / axioms ⊆ propext, Classical.choice,
  Quot.sound / report must be present). `src/core/lean-abbreviations.ts`.
- **Server**: `src/server/lean-service.ts` (HTTP checker from `LH_LEAN_URL`),
  `src/server/lean-answer.ts` (grades a submitted proof from the persisted
  call), `src/server/chat-handler.ts` (Lean grading for `answer` and practice
  `thinking` inputs; `codeCellsEnabled` gate; `leanSourcedPropositions` for
  practice), `app/api/lean/{authorize,status}`.
- **Agent**: `src/agent/tools/lean.ts` (`lean_exercise`: gates — plan marked
  `codeCells`, not twice in a row unless `learnerAsked`, reference proof must
  pass), `src/agent/tools/plan.ts` (`plan_init.codeCells`, only when the tool
  is armed), `src/agent/tools/practice.ts` (`problem.lean` block + gates).
  Settings: `agent.codeCells.enabled` (`src/core/settings*.ts`,
  `src/server/settings-body.ts`).
- **Client**: `components/lean/` — `lean-lsp.ts` (WebSocket LSP client: diagnostics,
  goals, completion + resolve), `lean-cell.tsx` (CodeMirror 6 editor, locked
  prefix, "Goal at cursor / on this line", "Lean says", status badge,
  `\to`-style abbreviations, phone symbol bar, autocompletion),
  `lean-dock.tsx` (question dock form), `lean-answered-card.tsx`;
  `components/practice-dock.tsx`, `components/practice-cards.tsx`;
  settings row in `components/settings/agent-section.tsx`.
- **Tests/CI**: `tests/lean-cell.test.ts`, `tests/lean-exercise-tool.test.ts`;
  `.github/workflows/lean.yml` — job "Lean + Mathlib in the Compose stack"
  (`deploy/lean/test/smoke.mjs`: pass/fail/sorry/no-internet, LSP through
  Caddy) and job "Code cells QA" (`tests/e2e/lean-qa.e2e.mjs`, scripted tutor
  in `tests/e2e/scripted-model.mjs`, real Lean, 20 steps, screenshots pushed
  to branch `qa/lean-screenshots`).
- Phone layout (1 Nov 2026, phone widths only): `components/phone-layout.ts`
  (`useIsPhone`, `useSoftKeyboardOpen`), `components/thinking-chip.tsx` (thinking
  fields fold to "Thinking · N words"; dictation fills them unseen), the slim
  row in `components/stats-bar.tsx` (`slim`: mic, notes, model; context/cost in
  the model menu), Tab key in the cell header instead of the symbol bar, and
  while editing a cell the task folds to one line and `import` lines hide
  (`LeanCell` `hidePrelude`, `TaskFold`). Layout changes on blur wait 400 ms so
  a tap on Submit is not moved under the finger.

## 5. Working notes

- Unit tests: `npm test` (one test, "main loader resolves Pi's import-only
  PUBLIC package exports…", fails only in sandboxed environments without
  network). Typecheck `npx tsc --noEmit -p .`, lint `npx eslint <files>`
  (the lint config enforces barrels: browser code imports only `@/src/core`,
  `app/` only `@/src/core` and `@/src/server`).
- E2E with the scripted model: `npx next build && node tests/e2e/learning-flow.e2e.mjs`.
  Lean QA: run a Lean container, then `LH_LEAN_URL=http://127.0.0.1:3301 node tests/e2e/lean-qa.e2e.mjs`.
- The Next.js version here differs from older docs; read `node_modules/next/dist/docs/` before Next-specific changes (see `AGENTS.md`).
