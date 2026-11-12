# Run LearnHarness on your own server (VPS)

This puts the LearnHarness server on a Linux server you rent, so the Android app (or any phone browser) works from anywhere and no computer of yours has to be on. Caddy in front of it gets a free HTTPS certificate automatically, which also makes dictation work.

```
 Android app ──HTTPS──▶ Caddy (ports 80/443) ──▶ LearnHarness (phone server) ──▶ /data volume
                        on your VPS     │                                         sessions, graph, keys
                                        ├─/lean/lsp─▶ Lean + Mathlib (code cells, no internet)
                                        └─/rocq/lsp─▶ Rocq + Iris (code cells, no internet)
                                LearnHarness ──internal──▶ TLA+ tools: SANY, TLC, PlusCal (code cells, no internet)
                                LearnHarness ──internal──▶ C++: g++ with sanitizers (code cells, no internet)
```

Every page and API call needs the access code, which a device enters once.

## What you need

- A Linux VPS (Ubuntu or Debian), x86-64 or ARM, with **2 GB of RAM or more**, such as Hetzner, DigitalOcean or OVH. With Lean code cells (included by default), use **8 GB of RAM** (Hetzner CX33 or similar) and about **15 GB of free disk**: Lean with Mathlib needs about 1.5 GB of memory per open cell, and its image is several GB.
- Ports **80 and 443** open to the internet. Caddy uses port 80 to get the certificate.
- A hostname that points at the server. Either:
  - **No domain:** use `<server-ip>.sslip.io`, for example `203.0.113.7.sslip.io`. It works as is, with nothing to register.
  - **Your own domain:** create a DNS `A` record such as `lh.example.com` pointing to the server's IP.

## Deploy

On the server (over SSH):

```bash
# 1. Docker (skip if installed)
curl -fsSL https://get.docker.com | sh

# 2. The code (a private repo needs a GitHub token or deploy key to clone)
git clone https://github.com/szymon-rd/learnharness.git
cd learnharness

# 3. Settings: the hostname the phone will use
cd deploy
cp .env.example .env
nano .env                               # set LH_HOST, e.g. LH_HOST=203.0.113.7.sslip.io

# 4. Build and start (first build takes 5–10 minutes; 10–20 more for Lean + Mathlib)
docker compose up -d --build

# 5. The access code for your phone
docker compose exec learnharness cat /data/phone-access-code
```

Then:

1. Install the Android app: the `LearnHarness.apk` file from the **android-latest** GitHub release.
2. Open it and enter the server address `https://<LH_HOST>` and the access code.
3. In the app, open **Settings → Providers** and add your model API key. Keys are stored on the server, in the data volume.

To check it from a browser instead, open `https://<LH_HOST>`, enter the code, and LearnHarness loads.

## Deploy with GitHub Actions (alternative)

Instead of running the steps above on the server, the **Deploy to VPS** workflow (`.github/workflows/deploy-vps.yml`) can do it over SSH: it installs Docker if needed, copies the current commit to `/opt/learnharness`, writes `deploy/.env`, builds, starts, and checks the HTTPS address.

One-time setup:

1. Make an SSH key pair for deploys (`ssh-keygen -t ed25519 -N "" -f lh_deploy`) and add the public key to the server: `echo '<contents of lh_deploy.pub>' >> /root/.ssh/authorized_keys`.
2. In the repository on GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `VPS_HOST`: the server's IPv4 address.
   - `VPS_SSH_KEY`: the private key, as one line of base64 (`base64 -w0 lh_deploy`) or as the file's text.
   - `VPS_DOMAIN` (optional): your own hostname; without it the address is `<VPS_HOST>.sslip.io`.

Then **Actions → Deploy to VPS → Run workflow**, with the task:

| Task | What it does |
|---|---|
| `deploy` | copy this commit to the server, build, (re)start, check HTTPS |
| `status` | running containers, deployed commit, disk and memory |
| `logs` | last 200 log lines of the app and Caddy |
| `access-code` | print the phone access code in the run's log |

The data stays in the Docker volumes across deploys. Anyone who can run workflows in the repository can control the server through this key; remove the key line from `authorized_keys` to revoke it.

## Lean code cells

The `lean` service runs Lean 4 with Mathlib for code cells: Lean exercises the tutor can mix in with its checks when a session is about Lean. Turn them on in **Settings → Agent → Code cells: Mixed in** (Off by default). The tutor only uses them in sessions whose plan is marked as a Lean topic, and never two in a row unless you ask.

- In the cell, the theorem statement is locked; you write the proof below it. Lean checks it live: errors are underlined, the goal at the cursor is shown, and the badge says when the proof passes. Type `\to`, `\forall`, `\N`… followed by a space for symbols (wider screens also have a symbol bar; phones have a Tab key in the cell's header).
- When you submit, the server checks your proof against the exact statement: no errors, no `sorry`, and only the standard axioms (no `native_decide`). The check catches mistakes; a proof written to fool it on purpose is out of scope.
- Lean runs in its own container with no internet access, as a normal user without extra privileges, with a memory cap (`LEAN_MEM_LIMIT`, default `3g`). Mathlib's compiled files are about 6 GB and must fit in memory: below that cap Lean re-reads them from disk on every check and checks time out. On an 8 GB server set `LEAN_MEM_LIMIT=6g` in `deploy/.env`. One language server runs at a time (`LEAN_MAX_SESSIONS`, default 1; set 2 on an 8 GB server for two open cells). Idle servers stop after 10 minutes.
- When the container starts it loads Mathlib once (about 20 s to a minute; `docker compose logs lean` shows "Mathlib warm"). Checks that arrive meanwhile wait for it, and the transcript says "Lean server starting".
- To leave Lean out on a small server: `docker compose up -d --build learnharness caddy tla cpp`. The setting then offers only TLA+ and C++.

## TLA+ code cells

The `tla` service runs the TLA+ tools (SANY, the TLC model checker and the PlusCal translator, from `tla2tools.jar`) for TLA+ exercises. The same **Code cells: Mixed in** setting turns them on. The tutor uses them only in sessions whose plan is marked as a TLA+ topic (a plan names one code-cell language: Lean or TLA+), and never two code cells in a row unless you ask. Practice sessions get TLA+ problems for material from TLA+ sessions.

- In the cell, the top of the module (header, `EXTENDS`, `CONSTANTS`, `VARIABLES`, given definitions) and the bottom (the properties TLC checks, `====`) are locked; you write the part between them. For PlusCal exercises you write (part of) the algorithm and the server translates it.
- While you type, the server parses the module with SANY (and translates PlusCal) and marks the errors. **Check** runs TLC on the model shown under the cell without submitting: you see whether it passes, or the violated invariant or property, the deadlock, or the evaluation error, with the counterexample as a list of states (changed variables highlighted).
- A submission passes when TLC explores the whole state space with no violated invariant or property, no deadlock (when the model checks it), and every "must be reachable" state is reached (so a spec that does nothing cannot pass). The tutor then judges whether the solution does what the task asked and can overrule a pass; the card shows its reason.
- The container has no internet access, runs as a normal user without extra privileges on a read-only filesystem, and has a memory cap (`TLA_MEM_LIMIT`, default `1g`; TLC's Java heap `TLA_TLC_HEAP`, default `640m`). TLC gets 60 s per check (`TLA_CHECK_TIMEOUT_SECONDS`) for the model and the witnesses together; exercises keep their models small. Caddy does not route it: only the app calls it.
- On an 8 GB server with Lean at `LEAN_MEM_LIMIT=6g`, the TLA+ container's 1 GB cap leaves little for the app; if the server swaps or a container is killed for memory, lower `TLA_MEM_LIMIT` to `768m` (and `TLA_TLC_HEAP` to `512m`).

## C++ code cells

The `cpp` service compiles and runs C++ exercises (g++ 14, C++20, with AddressSanitizer and UBSan). The same **Code cells: Mixed in** setting turns them on; the tutor uses them only in sessions whose plan is marked as a C++ topic, and never two code cells in a row unless you ask. Practice sessions get C++ problems for material from C++ sessions.

- In the cell, the top of the file (`#include`s, given code, the signature to implement) is locked; you write the part below it (some exercises also lock a part after yours).
- While you type, the server compiles the file and marks errors and warnings. The tutor's visible tests are listed under the cell; **Check** compiles and runs them without submitting. Hidden tests are listed by name only.
- A submission passes when it compiles and every test passes, hidden ones included: no failed check, no memory error or undefined behavior caught by the sanitizers, no crash, and each test within 5 s (`CPP_TEST_TIMEOUT_SECONDS`). Warnings never fail. The tutor then judges whether the solution does what the task asked and can overrule a pass.
- Learner code runs in this container: no internet, a normal user without extra privileges, a read-only filesystem except `/tmp`, a memory cap (`CPP_MEM_LIMIT`, default `1g`) and a process cap (a fork bomb stops at the limit and is cleaned up after the test). Malicious code can at worst crash the container, which restarts. Caddy does not route it: only the app calls it.

## Rocq code cells

The `rocq` service runs Rocq 9 with Iris and HeapLang for proof exercises, built like the Lean cells: the coq-lsp language server (through Caddy at `/rocq/lsp`, paired devices only) for live errors and goals, and one-shot checks for the app. The same **Code cells: Mixed in** setting turns them on; the tutor uses them only in sessions whose plan is marked as a Rocq topic (Rocq or Iris), and never two code cells in a row unless you ask. Practice sessions get Rocq problems for material from Rocq sessions.

- In the cell, the `Require` lines and the lemma statement are locked; you write the proof (`Proof. … Qed.`) below. The goals panel shows the goals at the cursor; in the Iris proof mode they include the spatial context (`"HP" : P`). Type `\sep`, `\wand`, `\later`, `\box`… followed by a space for `∗`, `-∗`, `▷`, `□` (wider screens also have a symbol bar; phones have a Tab key in the cell's header).
- When you submit, the server checks your proof against the exact statement: no error, not `Admitted`, and no axiom declared in the cell (the standard library's axioms such as `classic` are fine).
- The container has no internet access, runs as a normal user without extra privileges, and has a memory cap (`ROCQ_MEM_LIMIT`, default `1500m`); up to two language servers run at once (`ROCQ_MAX_SESSIONS`). On start it loads Iris once (about a second when the files are cached; `docker compose logs rocq` shows "Iris loaded").
- The image is large (about 8 GB: the OCaml toolchain, Rocq, coq-lsp and Iris built from source) and its first build takes 15–20 minutes.

## Day to day

| Task | Command (in `deploy/`) |
|---|---|
| Update to new code | `git pull && docker compose up -d --build` |
| See logs | `docker compose logs -f learnharness` |
| Restart | `docker compose restart learnharness` |
| New access code (signs out every device) | `docker compose exec learnharness rm /data/phone-access-code && docker compose restart learnharness`, then read it as in step 5 |
| Back up all data | `docker compose exec learnharness tar czf - /data > learnharness-backup.tgz` |
| Stop | `docker compose down` (data stays in the volume) |

## Bring your existing data (optional)

To start the server with the sessions, graph and keys from the desktop app:

1. On the computer, quit LearnHarness, then copy its data folder and key file to the server. On macOS:

   ```bash
   scp -r "$HOME/Library/Application Support/LearnHarness/data" "$HOME/Library/Application Support/LearnHarness/auth.json" you@server:~/lh-import/
   ```

   (Linux: `~/.config/LearnHarness`. Windows: `%APPDATA%\LearnHarness`.)

2. On the server, in `deploy/`:

   ```bash
   docker compose cp ~/lh-import/data/. learnharness:/data/data/
   docker compose cp ~/lh-import/auth.json learnharness:/data/auth.json
   docker compose restart learnharness
   ```

From then on the server copy and the desktop copy are separate. They do not sync.

## Security notes

- The access code has 100 random bits and is checked on every request. The pairing cookie lasts 400 days. A new code signs every device out.
- Only Caddy is exposed. The app's own port (3210) is not published.
- Your model API keys live on the server (`/data/auth.json` in the volume). Anyone with root on the server can read them.
- Optionally restrict the firewall to SSH, HTTP and HTTPS: `ufw allow 22,80,443/tcp && ufw enable`.

## Troubleshooting

- **The certificate fails or the browser shows a TLS error.** Check that `LH_HOST` resolves to this server (`ping <LH_HOST>`) and that ports 80 and 443 are open. Then look at `docker compose logs caddy`.
- **"This device is not paired"** in API errors means the browser lost the cookie. Open `https://<LH_HOST>/pair` and enter the code again.
- **A code cell says "Lean offline"** or the badge never leaves "Starting Lean…": check `docker compose ps lean` and `docker compose logs lean`. If every check times out after 120 s, Lean's memory cap is below Mathlib's size (see above). If the container was killed for memory, raise `LEAN_MEM_LIMIT` in `deploy/.env` (and the server's RAM).
- **A TLA+ cell says "Checker offline"**: check `docker compose ps tla` and `docker compose logs tla`. "TLC ran out of time" means the model's state space is too large for the time budget.
- **A C++ cell says "Checker offline"**: check `docker compose ps cpp` and `docker compose logs cpp`.
- **A Rocq cell says "Rocq offline"**: check `docker compose ps rocq` and `docker compose logs rocq` (`ROCQ_DEBUG=1` in the service's environment logs every language-server message).
- **The build runs out of memory** on a 1 GB server. Add swap (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`) or use a bigger plan.
