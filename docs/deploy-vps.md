# Run LearnHarness on your own server (VPS)

This puts the LearnHarness server on a Linux server you rent, so the Android app (or any phone browser) works from anywhere and no computer of yours has to be on. Caddy in front of it gets a free HTTPS certificate automatically, which also makes dictation work.

```
 Android app ──HTTPS──▶ Caddy (ports 80/443) ──▶ LearnHarness (phone server) ──▶ /data volume
                        on your VPS                                              sessions, graph, keys
```

Every page and API call needs the access code, which a device enters once.

## What you need

- A Linux VPS (Ubuntu or Debian), x86-64 or ARM, with **2 GB of RAM or more**, such as Hetzner, DigitalOcean or OVH.
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
git checkout ccr-b09c2bac-6zjr2c        # the branch with the Android work, until it is merged

# 3. Settings: the hostname the phone will use
cd deploy
cp .env.example .env
nano .env                               # set LH_HOST, e.g. LH_HOST=203.0.113.7.sslip.io

# 4. Build and start (first build takes 5–10 minutes)
docker compose up -d --build

# 5. The access code for your phone
docker compose exec learnharness cat /data/phone-access-code
```

Then:

1. Install the Android app: the `LearnHarness.apk` file from the **android-latest** GitHub release.
2. Open it and enter the server address `https://<LH_HOST>` and the access code.
3. In the app, open **Settings → Providers** and add your model API key. Keys are stored on the server, in the data volume.

To check it from a browser instead, open `https://<LH_HOST>`, enter the code, and LearnHarness loads.

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
- **The build runs out of memory** on a 1 GB server. Add swap (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`) or use a bigger plan.
