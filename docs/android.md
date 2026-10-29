# LearnHarness on Android

The Android app is a window onto a LearnHarness server. The server does the work: agent turns, the knowledge graph, your API keys and data all live there. The phone shows the same interface, adapted to a small touch screen.

The server can run in one of two places:

- **Your own VPS (recommended):** works from anywhere, with HTTPS (so dictation works), and no computer has to stay on. Set it up with [docs/deploy-vps.md](deploy-vps.md), then skip to step 2 below and use `https://<your host>` as the server address.
- **Your computer:** `npm run phone`, as in step 1 below. The computer has to be on, awake and reachable while you use the phone.

```
 Android app (WebView)  ──HTTPS / Wi-Fi──▶  LearnHarness server (VPS or your computer)
   connect screen                            your sessions, graph and keys
```

## 1. Start the phone server on your computer

Needs Node.js 22.19 or newer and this repository checked out.

```bash
npm install          # first time only
npm run phone        # builds on first run (a few minutes), then serves
```

It prints something like:

```
 Access code:  K7Q2-M9XD-...

 Server address for the Android app:
   http://192.168.1.20:3210      (same Wi-Fi)
```

- **Which data it uses.** If the LearnHarness desktop app has data on this computer, the phone server uses that data and those API keys, so the phone sees your existing graph and sessions. **Quit the desktop app first.** The script refuses to start while it runs, and you must not open the desktop app while the phone server runs, because both would write the same files. To use the repository's `data/` folder instead (what `npm run dev` uses), run `npm run phone -- --repo-data`.
- **Keep the computer awake.** On macOS: `caffeinate -i npm run phone`.
- **After pulling new code** it rebuilds by itself. To force a rebuild, run `npm run phone -- --build`.
- **Other options:** `--port 4000`, `--new-code` (makes a new access code and signs out every paired device).

## 2. Install the app

On the phone, open the repository's GitHub **Releases** page and download `LearnHarness.apk` from the **android-latest** release. Android asks you to allow installs from your browser; allow it once. Newer builds from the same release install over the old one and keep your settings.

The app runs on Android 7 or newer, but the LearnHarness pages need **Android System WebView 111 or newer** (released in 2023). Phones with the Play Store update it automatically. If yours has an older one, the connect screen says so and links to its Play Store page.

## 3. Connect

Open the app, type the **server address** and **access code** the script printed, and tap **Connect**. The app remembers both and reconnects by itself on later launches.

- **Android back** goes back through the pages. From the home page it returns to the connect screen, where you can change the server.
- If the computer is off or asleep, the app shows a **Can't load LearnHarness** page with **Try again** and **Change server** buttons.
- Links to other sites (research sources, provider consoles) open in your phone's browser.

You can also use a phone browser without the app: open the server address and enter the access code.

## Dictation and use away from home: Tailscale

Android only allows the microphone on secure (HTTPS) connections. The plain `http://192.168…` address works for everything except dictation, and only on your home Wi-Fi. [Tailscale](https://tailscale.com) (free for personal use) fixes both:

1. Install Tailscale on the computer and the phone, signed in to the same account.
2. In the Tailscale admin console, under DNS, turn on **MagicDNS** and **HTTPS certificates**.
3. On the computer, while `npm run phone` runs: `tailscale serve --bg 3210`
4. In the app, use **Change server** and enter the `https://<computer>.<tailnet>.ts.net` address that command prints, with the same access code.

This also encrypts the traffic between phone and computer. Plain `http://` on Wi-Fi is not encrypted.

## Security

- Every page and API request needs the pairing cookie. A device gets it only by entering the access code, which has 100 random bits. The code is stored in `phone-access-code` next to the data folder, readable only by your user. `--new-code` revokes every paired device.
- The server listens on all network interfaces of the computer. Don't run it on networks you don't trust. Use Tailscale instead of opening the port to the internet.
- API keys never leave the computer; the phone only sees pages.

## Known limits

- **Downloads** (the "download demo / figure" buttons) may do nothing inside the app. Use a phone browser or the desktop for those.
- **Subscription sign-in** (ChatGPT and other plan connections) was not tested from the phone. Use API keys, or set up the connection on the computer.
- The app needs the computer. A fully standalone phone app would have to run the Node server on the phone itself, which is not done.

## Building the APK yourself

GitHub Actions (`.github/workflows/android-apk.yml`) builds the APK on every push that touches `mobile/`, runs a smoke test on an Android emulator against a phone server with sample data, and updates the **android-latest** release.

To build locally, install Android Studio (or the Android SDK plus JDK 21), then:

```bash
cd mobile
npm ci
npm run apk     # → android/app/build/outputs/apk/release/app-release.apk
```

The APK is signed with `mobile/android/app/sideload.keystore`, a key committed to the repository so that every build installs over the previous one. It keeps updates working but proves nothing about who built the APK. For your own key, replace that file and the passwords in `mobile/android/app/build.gradle`.

How the app is put together:

- `mobile/www/`: the connect screen and the error page, bundled into the app.
- `mobile/android/app/src/main/java/ai/learnharness/android/`: `MainActivity` (back button) and `ServerLinkPlugin` (keeps the paired server inside the app, sends other links to the browser).
- Server side: `scripts/phone-server.mjs`, the pairing gate in `proxy.ts` and `src/server/remote-access.ts`, and the `/pair` page in `app/pair/route.ts`.
