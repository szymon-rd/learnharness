#!/usr/bin/env node
/**
 * Phone server: run LearnHarness on this computer so the Android app (or a
 * phone browser) can use it over the network. See docs/android.md.
 *
 *   npm run phone                 build if needed, then serve
 *   npm run phone -- --build      force a fresh production build first
 *                                 (it also rebuilds by itself after the checkout changes)
 *   npm run phone -- --port 4000  listen on another port (default 3210)
 *   npm run phone -- --new-code   replace the access code (unpairs every device)
 *   npm run phone -- --repo-data  use the repo's data/ + auth.json (dev data)
 *                                 instead of the desktop app's data
 *
 * Data: by default the server uses the desktop app's own data and keys
 * (so the phone sees the same graph, sessions and API keys). Only one
 * process may write that data at a time, so the script refuses to start
 * while the desktop app is running — and the desktop app must stay closed
 * while this server runs.
 *
 * Security: the server listens on every network interface. Every page and
 * API request needs the pairing cookie, which a device gets once by
 * entering the access code (LH_REMOTE_ACCESS_CODE, stored in
 * phone-access-code next to the data, mode 0600).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(option("--port", process.env.PORT ?? "3210"));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`Invalid port: ${PORT}`);

function fail(message) {
	console.error(`\n✗ ${message}\n`);
	process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) fail(`Node ${process.versions.node} is too old. LearnHarness needs Node 22.19 or newer.`);

/** Where the desktop app keeps its data (Electron userData for "LearnHarness"). */
function desktopUserData() {
	const home = os.homedir();
	if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "LearnHarness");
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "LearnHarness");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "LearnHarness");
}

/** Electron's single-instance lock: on macOS/Linux a SingletonLock symlink
 * in userData pointing at "<hostname>-<pid>". A live pid on this host means
 * the desktop app is running. */
function desktopAppRunning(userData) {
	try {
		const target = fs.readlinkSync(path.join(userData, "SingletonLock"));
		const dash = target.lastIndexOf("-");
		const host = target.slice(0, dash);
		const pid = Number(target.slice(dash + 1));
		if (host !== os.hostname() || !Number.isInteger(pid)) return false;
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM"; // the process exists but belongs to someone else
	}
}

let dataDir;
let authFile;
let codeFile;
const userData = desktopUserData();
if (process.env.LH_DATA_DIR) {
	dataDir = path.resolve(process.env.LH_DATA_DIR);
	authFile = path.resolve(process.env.LH_AUTH_FILE ?? path.join(dataDir, "..", "auth.json"));
	codeFile = path.join(dataDir, "..", "phone-access-code");
} else if (!flag("--repo-data") && fs.existsSync(path.join(userData, "data"))) {
	if (desktopAppRunning(userData)) {
		fail(
			"The LearnHarness desktop app is running. Quit it first: both would write the same data.\n" +
				`  (If it is not running, delete the stale lock: ${path.join(userData, "SingletonLock")})`,
		);
	}
	dataDir = path.join(userData, "data");
	authFile = path.join(userData, "auth.json");
	codeFile = path.join(userData, "phone-access-code");
} else {
	dataDir = path.join(ROOT, "data");
	authFile = path.join(ROOT, "auth.json");
	codeFile = path.join(ROOT, "phone-access-code");
}

// Crockford base32 without I, L, O, U: easy to read aloud and type.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newCode() {
	let raw = "";
	for (let i = 0; i < 20; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
	return raw.match(/.{4}/g).join("-"); // 100 bits
}

let code = !flag("--new-code") && fs.existsSync(codeFile) ? fs.readFileSync(codeFile, "utf8").trim() : "";
if (code.replace(/-/g, "").length < 16) {
	code = newCode();
	fs.mkdirSync(path.dirname(codeFile), { recursive: true });
	fs.writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
}

const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
if (!fs.existsSync(nextBin)) fail("Dependencies are missing. Run `npm install` first.");

// Rebuild when there is no build yet, or the checkout moved since the last
// one (e.g. after `git pull`), so the phone never runs stale code.
const BUILT_AT = path.join(ROOT, ".next", "phone-build-head");
const head = (() => {
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : "";
})();
const builtHead = fs.existsSync(BUILT_AT) ? fs.readFileSync(BUILT_AT, "utf8").trim() : "";
const stale = head !== "" && builtHead !== head;
if (flag("--build") || !fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) || stale) {
	console.log("Building LearnHarness (takes a few minutes)…");
	const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
	if (build.status !== 0) fail("The build failed (see above).");
	if (head) fs.writeFileSync(BUILT_AT, `${head}\n`);
}

function addresses() {
	const lan = [];
	const tailnet = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list ?? []) {
			if (a.family !== "IPv4" || a.internal) continue;
			const [p, q] = a.address.split(".").map(Number);
			if (p === 100 && q >= 64 && q <= 127) tailnet.push(a.address);
			else lan.push(a.address);
		}
	}
	return { lan, tailnet };
}

const server = spawn(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", String(PORT)], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		NODE_ENV: "production",
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
		LH_REMOTE_ACCESS_CODE: code,
	},
});

let announced = false;
function announce() {
	const { lan, tailnet } = addresses();
	const line = "─".repeat(60);
	console.log(`\n${line}\n LearnHarness phone server is running\n${line}`);
	console.log(` Access code:  ${code}\n`);
	console.log(" Server address for the Android app:");
	for (const ip of lan) console.log(`   http://${ip}:${PORT}      (same Wi-Fi)`);
	for (const ip of tailnet) console.log(`   http://${ip}:${PORT}      (Tailscale)`);
	if (lan.length === 0 && tailnet.length === 0) console.log(`   http://<this computer's IP>:${PORT}`);
	console.log("\n Dictation needs HTTPS. With Tailscale, run:");
	console.log(`   tailscale serve --bg ${PORT}`);
	console.log("   and use the https://<machine>.<tailnet>.ts.net address it prints.");
	console.log(`\n Data: ${dataDir}`);
	console.log(" Keep the desktop app closed while this runs. Ctrl+C to stop.");
	console.log(`${line}\n`);
}
// `next start` warns about output: "standalone" (set for the desktop
// build); it serves this repo checkout fine, so hide that one line.
const quiet = (chunk) =>
	chunk
		.toString()
		.split("\n")
		.filter((l) => !l.includes('does not work with "output: standalone"'))
		.join("\n");
server.stderr.on("data", (chunk) => process.stderr.write(quiet(chunk)));
server.stdout.on("data", (chunk) => {
	const text = quiet(chunk);
	process.stdout.write(text);
	if (!announced && /\bReady\b/.test(text)) {
		announced = true;
		announce();
	}
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (status) => process.exit(status ?? 0));
