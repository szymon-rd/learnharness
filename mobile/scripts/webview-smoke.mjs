// End-to-end smoke test of the Android app on an emulator (run by
// .github/workflows/android-apk.yml). Needs: a booted emulator on adb, the
// APK, and a phone server reachable from the emulator at 10.0.2.2.
//
//   node mobile/scripts/webview-smoke.mjs <apk> <server origin> <access code> <screenshot dir>
//
// Drives the app's real WebView over the DevTools protocol (Playwright's
// Android support) and checks: connect screen → pairing → LearnHarness
// pages; back button history; cold restart reconnects by itself; the error
// page for an unreachable server; outside links stay out of the app.
import { _android as android } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [apk, SERVER, CODE, shots = "smoke-shots"] = process.argv.slice(2);
if (!apk || !SERVER || !CODE) {
	console.error("usage: webview-smoke.mjs <apk> <server origin> <access code> [screenshot dir]");
	process.exit(2);
}
const PKG = "ai.learnharness.android";
const TEACH = "chat_mv27rrra_feff23b6";
const PRACTICE = "chat_mv293wv5_10656952";
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
/** Every main-frame navigation the test saw, across page re-attaches. */
const navigations = [];
let currentStep = "start";
const stepStarted = Date.now();
function step(name) {
	currentStep = name;
	console.log(`\n== ${name} (t+${Math.round((Date.now() - stepStarted) / 1000)}s)`);
}
// Watchdog: a hung DevTools call must fail the job, not stall it for the
// whole job timeout.
setTimeout(() => {
	console.log(`FAIL: smoke test timed out during "${currentStep}"`);
	process.exit(1);
}, 7 * 60_000).unref();
function check(ok, label, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [device] = await android.devices();
if (!device) throw new Error("no adb device");
console.log(`device: ${device.model()} (${device.serial()})`);
const shot = async (name) => {
	await device.screenshot({ path: path.join(shots, `${name}.png`) }).catch((e) => console.log(`screenshot ${name} failed: ${e.message}`));
};

await device.shell(`pm uninstall ${PKG}`).catch(() => {});
await device.installApk(fs.readFileSync(apk));
console.log((await device.shell(`dumpsys package ${PKG} | grep -E "versionName|versionCode|RECORD_AUDIO"`)).toString().trim());
const webViewVersion = (await device.shell("dumpsys webviewupdate | grep -i 'Current WebView package'")).toString().trim();
console.log(`WebView: ${webViewVersion}`);

async function launch() {
	await device.shell(`am force-stop ${PKG}`);
	await device.shell("logcat -c").catch(() => {});
	await device.shell(`am start -W -n ${PKG}/.MainActivity`);
	return attach();
}

/** The app's current WebView page. Re-attaches when Android replaced the
 * DevTools target (e.g. the activity was recreated). */
async function attach() {
	const webview = await device.webView({ pkg: PKG }, { timeout: 20_000 });
	let page = await webview.page();
	if (page.isClosed()) {
		// Same app process, new renderer: pick up the replacement target.
		const context = page.context();
		page = context.pages().find((p) => !p.isClosed()) ?? (await context.waitForEvent("page", { timeout: 15_000 }));
	}
	page.on("close", () => console.log("  (WebView page target closed)"));
	page.on("framenavigated", (f) => {
		if (f === page.mainFrame()) {
			navigations.push({ at: Date.now(), url: f.url() });
			console.log(`  (navigated: ${f.url()})`);
		}
	});
	return page;
}

/** The live page: Android swaps the WebView renderer (and its DevTools
 * target) on cross-origin navigations such as server ↔ connect screen. */
async function live() {
	if (!page || page.isClosed()) {
		await sleep(500);
		page = await attach();
	}
	return page;
}

/** Run a page action; if the target went away mid-action (renderer swap),
 * re-attach and retry, up to three times. */
async function withPage(label, fn) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(await live());
		} catch (err) {
			if (attempt >= 3 || !/closed|detached|Target|destroyed/i.test(String(err?.message))) throw err;
			console.log(`  (re-attaching during ${label}: ${String(err.message).split("\n")[0]})`);
			await sleep(1000);
			page = await attach();
		}
	}
}

async function dumpLogcat() {
	const log = (await device.shell("logcat -d -t 400").catch(() => Buffer.from(""))).toString();
	const lines = log.split("\n").filter((l) => /Capacitor|chromium|AndroidRuntime|ActivityTaskManager|ActivityManager.*learnharness|cr_|WebView|FATAL/i.test(l));
	console.log("---- logcat (filtered, last 80) ----");
	console.log(lines.slice(-80).join("\n"));
	console.log("------------------------------------");
}

async function currentUrl() {
	for (let i = 0; i < 3; i++) {
		try {
			return await (await live()).evaluate(() => location.href);
		} catch {
			await sleep(700);
		}
	}
	return "(unavailable)";
}

async function waitForUrl(_unused, predicate, timeout = 30_000) {
	const start = Date.now();
	let url = "";
	while (Date.now() - start < timeout) {
		url = await currentUrl();
		if (predicate(url)) return url;
		await sleep(500);
	}
	return url;
}

let page;
try {
	// 1. First launch: the connect screen.
	step("1. First launch: the connect screen.");
	page = await launch();
	await (await live()).waitForSelector("#form", { state: "visible", timeout: 30_000 });
	check((await currentUrl()).startsWith("https://localhost/"), "first launch shows the local connect screen", await currentUrl());
	await shot("01-connect");

	// 2. Validation, then connect + pair.
	step("2. Validation, then connect + pair.");
	await sleep(3000); // let the first load settle
	await withPage("fill form", async (p) => {
		await p.waitForSelector("#form", { state: "visible", timeout: 30_000 });
		await p.fill("#url", SERVER.replace(/^http:\/\//, ""));
		await p.fill("#code", "short");
		await p.click("button[type=submit]");
	});
	check((await (await live()).textContent("#error"))?.includes("access code"), "short code is rejected on the phone");
	await (await live()).fill("#code", CODE.toLowerCase());
	await (await live()).click("button[type=submit]");
	let url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, "pairing lands on the LearnHarness home page", url);
	await (await live()).waitForSelector("textarea", { timeout: 30_000 }).catch(() => {});
	await sleep(2000);
	const home = await (await live()).evaluate(() => ({
		composer: !!document.querySelector("textarea"),
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	check(home.composer, "home page rendered (composer present)");
	check(home.scrollWidth <= home.width, "no horizontal scroll on home", `${home.scrollWidth} vs ${home.width}`);
	await shot("02-home");

	// 3. Sessions load over the network (API behind the pairing cookie).
	step("3. Sessions load over the network (API behind the pairing cookie).");
	await (await live()).evaluate((id) => {
		location.href = `/chat/${id}`;
	}, TEACH);
	url = await waitForUrl(page, (u) => u.endsWith(`/chat/${TEACH}`));
	await sleep(4000);
	const apiStatus = await (await live()).evaluate(() => fetch("/api/graph/status").then((r) => r.status));
	check(apiStatus === 200, "API calls carry the pairing cookie", String(apiStatus));
	const teach = await (await live()).evaluate(() => ({ text: document.body.innerText.slice(0, 4000), width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
	check(teach.text.includes("test session"), "teaching session renders");
	check(teach.scrollWidth <= teach.width, "no horizontal scroll in the teaching session", `${teach.scrollWidth} vs ${teach.width}`);
	await shot("03-teach");

	await (await live()).evaluate((id) => {
		location.href = `/chat/${id}`;
	}, PRACTICE);
	await waitForUrl(page, (u) => u.endsWith(`/chat/${PRACTICE}`));
	await sleep(4000);
	check((await (await live()).evaluate(() => document.body.innerText)).includes("PROBLEM"), "practice session renders");
	await shot("04-practice");

	// 4. Outside links open outside the app (the WebView stays put).
	step("4. Outside links open outside the app (the WebView stays put).");
	const before = await currentUrl();
	await (await live()).evaluate(() => {
		location.href = "https://example.com/";
	});
	await sleep(3000);
	check((await currentUrl()) === before, "outside link did not load inside the app", await currentUrl());
	// Close the browser the link opened: its first-run screen can otherwise
	// pop up over the app much later and confuse the foreground checks.
	for (const browser of ["com.android.chrome", "com.android.browser"]) await device.shell(`am force-stop ${browser}`).catch(() => {});
	await device.shell(`am start -W -n ${PKG}/.MainActivity`);
	await sleep(1500);

	// 5. Android back walks the history: practice → teach → home → connect screen.
	step("5. Android back walks the history: practice → teach → home → connect screen.");
	await device.shell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl()).endsWith(`/chat/${TEACH}`), "back: practice → teaching session", await currentUrl());
	await device.shell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl()) === `${SERVER}/`, "back: teaching session → home", await currentUrl());
	await device.shell("input keyevent 4");
	await sleep(3000);
	url = await waitForUrl(null, (u) => u.startsWith("https://localhost/"), 15_000);
	const formVisible = await withPage("connect form visible", (p) => p.waitForSelector("#form", { state: "visible", timeout: 10_000 }).then(() => true)).catch(() => false);
	check(url.startsWith("https://localhost/") && formVisible, "back: home → connect screen with the form (no auto-reconnect loop)", url);
	check((await (await live()).inputValue("#url").catch(() => "")) === SERVER, "connect screen keeps the saved server");
	await shot("05-back-to-connect");

	// 6. Cold restart: reconnects straight to the server.
	step("6. Cold restart: reconnects straight to the server.");
	page = await launch();
	url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, "cold restart reconnects to the saved server", url);
	await shot("06-restart");

	// 7. Unreachable server → the app's error page, with a way back.
	step("7. Unreachable server → the app's error page, with a way back.");
	// Fresh app data, so the connect form opens directly.
	await device.shell(`am force-stop ${PKG}`);
	await device.shell(`pm clear ${PKG}`);
	page = await launch();
	await sleep(2000);
	const deadServer = SERVER.replace(/:(\d+)$/, ":3999");
	await withPage("open the connect form", async (p) => {
		await p.waitForSelector("#form", { state: "visible", timeout: 15_000 });
		await p.fill("#url", deadServer);
		await p.fill("#code", CODE);
		await p.click("button[type=submit]");
	});
	url = await waitForUrl(page, (u) => u.includes("error.html"), 20_000);
	check(url.includes("error.html"), "unreachable server shows the error page", url);
	await shot("07-error");
	await withPage("change server", async (p) => {
		await p.click("#change");
	});
	await sleep(1500);
	const reconnectAt = Date.now();
	await withPage("reconnect", async (p) => {
		await p.waitForSelector("#form", { state: "visible", timeout: 15_000 });
		await p.fill("#url", SERVER);
		await p.click("button[type=submit]");
	});
	// The page switches origin here, which can leave DevTools without a page
	// to re-attach to; check from the outside instead.
	await sleep(5000);
	const loadedInApp = navigations.some((n) => n.at >= reconnectAt && n.url.startsWith(`${SERVER}/`));
	check(loadedInApp, "the server loads inside the app's WebView after changing it");
	const top = (await device.shell("dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity' | head -3")).toString().trim();
	check(top.includes(PKG), "the app stays in front (no external browser)", top.split("\n")[0]);
	const relaunchedAt = Date.now();
	page = await launch();
	url = await waitForUrl(null, (u) => u === `${SERVER}/`, 15_000);
	// DevTools can lose the page right after a relaunch; the recorded
	// navigations still show where the app went.
	const sawServer = navigations.some((n) => n.at >= relaunchedAt && n.url === `${SERVER}/`);
	check(url === `${SERVER}/` || sawServer, "changed server is saved and reconnects after restart", url === `${SERVER}/` ? url : `navigation log: ${sawServer ? SERVER + "/" : "none"}`);
	await shot("08-changed-server");
} catch (err) {
	failures++;
	console.log(`FAIL: smoke test crashed — ${err?.stack ?? err}`);
	await shot("99-crash");
} finally {
	if (failures > 0) await dumpLogcat();
	await device.close().catch(() => {});
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
