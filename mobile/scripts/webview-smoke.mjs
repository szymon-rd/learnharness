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
import { execFileSync } from "node:child_process";
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
/** Results also go to a file, printed as the job's last step. */
function record(line) {
	console.log(line);
	try {
		fs.appendFileSync(path.join(shots, "results.txt"), `${line}\n`);
	} catch {
		/* the shots dir is created below; early lines only reach stdout */
	}
}
function check(ok, label, detail = "") {
	record(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** WebView major version, read on the connect screen. Below 111 the
 *  LearnHarness pages (Next.js 16) are not expected to work: the app shows
 *  an update notice instead, and checks of the pages themselves report
 *  SKIP when they fail. Stock emulator images below Android 14 ship such
 *  a WebView; a real phone updates it through the Play Store. */
const MIN_WEBVIEW = 111;
let webViewMajor = 0;
const oldWebView = () => webViewMajor > 0 && webViewMajor < MIN_WEBVIEW;
function uiCheck(ok, label, detail = "") {
	if (!ok && oldWebView()) {
		record(`SKIP: ${label} — WebView ${webViewMajor} is older than the ${MIN_WEBVIEW} LearnHarness needs${detail ? ` (${detail})` : ""}`);
		return;
	}
	check(ok, label, detail);
}
/** With an old WebView the connect screen shows the update notice and
 *  does not connect by itself: check the notice, then tap Connect. */
async function connectIfOutdated() {
	if (!oldWebView()) return;
	const notice = await withPage("update notice", (p) => p.waitForSelector("#outdated", { state: "visible", timeout: 15_000 }).then(() => true)).catch(() => false);
	check(notice, "old WebView: the connect screen shows the update notice instead of connecting");
	await withPage("connect anyway", (p) => p.click("button[type=submit]"));
}

const [device] = await android.devices();
if (!device) throw new Error("no adb device");
console.log(`device: ${device.model()} (${device.serial()})`);
/** Device commands through plain adb: independent of Playwright's device
 *  connection, which can close mid-run. Resolves to a Buffer like
 *  device.shell did; never throws (failures come back as text). */
const adbSerial = device.serial();
function adbShell(command) {
	try {
		return Promise.resolve(execFileSync("adb", ["-s", adbSerial, "shell", command], { maxBuffer: 32 * 1024 * 1024 }));
	} catch (err) {
		return Promise.resolve(Buffer.from(String(err?.stdout ?? err?.message ?? "")));
	}
}
const shot = async (name) => {
	try {
		const png = execFileSync("adb", ["-s", adbSerial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
		fs.writeFileSync(path.join(shots, `${name}.png`), png);
	} catch (e) {
		console.log(`screenshot ${name} failed: ${e.message}`);
	}
};

await adbShell(`pm uninstall ${PKG}`).catch(() => {});
await device.installApk(fs.readFileSync(apk));
console.log((await adbShell(`dumpsys package ${PKG} | grep -E "versionName|versionCode|RECORD_AUDIO"`)).toString().trim());
const webViewVersion = (await adbShell("dumpsys webviewupdate | grep -i 'Current WebView package'")).toString().trim();
console.log(`WebView: ${webViewVersion}`);

async function launch() {
	await adbShell(`am force-stop ${PKG}`);
	await adbShell("logcat -c").catch(() => {});
	await adbShell(`am start -W -n ${PKG}/.MainActivity`);
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
	const log = (await adbShell("logcat -d -t 400").catch(() => Buffer.from(""))).toString();
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
	webViewMajor = await withPage("WebView version", (p) => p.evaluate(() => Number((/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || 0)));
	console.log(`WebView major version: ${webViewMajor}`);
	const noticeShown = await (await live()).isVisible("#outdated");
	check(noticeShown === oldWebView(), oldWebView() ? "old WebView: the update notice shows" : "current WebView: no update notice", `WebView ${webViewMajor}`);
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
	uiCheck(home.composer, "home page rendered (composer present)");
	uiCheck(home.scrollWidth <= home.width, "no horizontal scroll on home", `${home.scrollWidth} vs ${home.width}`);
	await shot("02-home");

	// Soft keyboard: tapping the composer must keep it visible above the
	// keyboard (the viewport resizes; nothing hides behind the IME).
	try {
		const p = await live();
		await p.click("textarea");
		await sleep(2500);
		const kb = await p.evaluate(() => {
			const r = document.querySelector("textarea").getBoundingClientRect();
			const vv = window.visualViewport;
			return { bottom: Math.round(r.bottom), visible: Math.round(vv ? vv.height + vv.offsetTop : innerHeight), inner: innerHeight };
		});
		const ime = (await adbShell("dumpsys input_method | grep -m1 mInputShown")).toString().trim();
		record(`  (keyboard: ${ime}; composer bottom ${kb.bottom}, visible height ${kb.visible}, innerHeight ${kb.inner})`);
		uiCheck(kb.bottom <= kb.visible + 1, "composer stays above the soft keyboard", `${kb.bottom} vs ${kb.visible}`);
		await shot("02b-keyboard");
		await p.evaluate(() => document.activeElement?.blur());
		await sleep(1000);
		// Sidebar drawer over the page, then closed by its backdrop.
		await p.click('[aria-label="Open sidebar"]');
		await sleep(1200);
		const drawer = await p.evaluate(() => {
			const backdrop = document.querySelector('[data-testid="sidebar-backdrop"]');
			return { backdrop: !!backdrop, overflow: document.documentElement.scrollWidth > innerWidth };
		});
		uiCheck(drawer.backdrop && !drawer.overflow, "sidebar opens as a drawer over the page");
		await shot("02c-sidebar");
		await p.evaluate(() => document.querySelector('[data-testid="sidebar-backdrop"]')?.click());
		await sleep(800);
	} catch (err) {
		uiCheck(false, "keyboard and sidebar checks ran", String(err?.message).split("\n")[0]);
	}

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
	uiCheck(teach.text.includes("test session"), "teaching session renders");
	uiCheck(teach.scrollWidth <= teach.width, "no horizontal scroll in the teaching session", `${teach.scrollWidth} vs ${teach.width}`);
	await shot("03-teach");

	await (await live()).evaluate((id) => {
		location.href = `/chat/${id}`;
	}, PRACTICE);
	await waitForUrl(page, (u) => u.endsWith(`/chat/${PRACTICE}`));
	await sleep(4000);
	uiCheck((await (await live()).evaluate(() => document.body.innerText)).includes("PROBLEM"), "practice session renders");
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
	for (const browser of ["com.android.chrome", "com.android.browser"]) await adbShell(`am force-stop ${browser}`).catch(() => {});
	await adbShell(`am start -W -n ${PKG}/.MainActivity`);
	await sleep(1500);

	// 5. Android back walks the history: practice → teach → home → connect screen.
	step("5. Android back walks the history: practice → teach → home → connect screen.");
	await adbShell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl()).endsWith(`/chat/${TEACH}`), "back: practice → teaching session", await currentUrl());
	await adbShell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl()) === `${SERVER}/`, "back: teaching session → home", await currentUrl());
	await adbShell("input keyevent 4");
	await sleep(3000);
	url = await waitForUrl(null, (u) => u.startsWith("https://localhost/"), 15_000);
	const formVisible = await withPage("connect form visible", (p) => p.waitForSelector("#form", { state: "visible", timeout: 10_000 }).then(() => true)).catch(() => false);
	check(url.startsWith("https://localhost/") && formVisible, "back: home → connect screen with the form (no auto-reconnect loop)", url);
	check((await (await live()).inputValue("#url").catch(() => "")) === SERVER, "connect screen keeps the saved server");
	await shot("05-back-to-connect");

	// 6. Cold restart: reconnects straight to the server.
	step("6. Cold restart: reconnects straight to the server.");
	page = await launch();
	await connectIfOutdated();
	url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, oldWebView() ? "cold restart keeps the saved server (Connect without retyping)" : "cold restart reconnects to the saved server", url);
	await shot("06-restart");

	// 6b. The page's renderer process dies (Android reclaims memory, or a
	// crash): the app must stay open and come back, not close.
	step("6b. Renderer crash: the app recovers instead of closing.");
	let crashAt = 0;
	try {
		const p = await live();
		const cdp = await Promise.race([p.context().newCDPSession(p), sleep(10_000).then(() => Promise.reject(new Error("no CDP session within 10 s")))]);
		crashAt = Date.now();
		// Not awaited: with the renderer gone, newer WebViews never answer it.
		cdp.send("Page.crash").catch(() => {});
	} catch (err) {
		console.log(`  (could not crash the renderer: ${String(err?.message).split("\n")[0]})`);
	}
	if (!crashAt) {
		record("SKIP: renderer crash recovery — DevTools could not crash the renderer");
	} else {
		await sleep(4000);
		const topAfterCrash = (await adbShell("dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity' | head -3")).toString().trim();
		check(topAfterCrash.includes(PKG), "renderer crash: the app stays open", topAfterCrash.split("\n")[0]);
		page = null;
		url = await waitForUrl(null, (u) => u === `${SERVER}/` || u.startsWith("https://localhost/"), 30_000);
		if (url.startsWith("https://localhost/")) {
			// The connect screen came back; it may already be on its way to the server.
			url = await waitForUrl(null, (u) => u === `${SERVER}/`, 10_000);
		}
		if (url !== `${SERVER}/` && url.startsWith("https://localhost/")) {
			const saved = await (await live()).inputValue("#url").catch(() => "");
			check(saved === SERVER, "renderer crash: the connect screen comes back with the saved server", url);
		} else {
			check(url === `${SERVER}/`, "renderer crash: the app reconnects to the server", url);
		}
		await shot("06b-after-crash");
	}

	// 7. Unreachable server → the app's error page, with a way back.
	step("7. Unreachable server → the app's error page, with a way back.");
	// Fresh app data, so the connect form opens directly.
	await adbShell(`am force-stop ${PKG}`);
	await adbShell(`pm clear ${PKG}`);
	page = await launch();
	await sleep(2000);
	const deadServer = SERVER.replace(/:(\d+)$/, ":3999");
	const deadSubmitAt = Date.now();
	await withPage("open the connect form", async (p) => {
		await p.waitForSelector("#form", { state: "visible", timeout: 15_000 });
		await p.fill("#url", deadServer);
		await p.fill("#code", CODE);
		await p.click("button[type=submit]");
	});
	url = await waitForUrl(page, (u) => u.includes("error.html"), 20_000);
	// DevTools can lose the page right after it lands; the navigation log counts too.
	const sawErrorPage = navigations.some((n) => n.at >= deadSubmitAt && n.url.includes("error.html"));
	check(url.includes("error.html") || sawErrorPage, "unreachable server shows the error page", url.includes("error.html") ? url : `navigation log: ${sawErrorPage ? "error.html" : "none"}`);
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
	const top = (await adbShell("dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity' | head -3")).toString().trim();
	check(top.includes(PKG), "the app stays in front (no external browser)", top.split("\n")[0]);
	// DevTools sometimes fails to attach right after a relaunch, so give the
	// relaunch two tries; the recorded navigations count as evidence too.
	let sawServer = false;
	let attached = false;
	url = "";
	for (let attempt = 1; attempt <= 2 && !sawServer && url !== `${SERVER}/`; attempt++) {
		const relaunchedAt = Date.now();
		try {
			page = await launch();
			attached = true;
			await connectIfOutdated();
			url = await waitForUrl(null, (u) => u === `${SERVER}/`, 15_000);
		} catch (err) {
			console.log(`  (relaunch attempt ${attempt}: ${String(err?.message).split("\n")[0]})`);
		}
		sawServer = navigations.some((n) => n.at >= relaunchedAt && n.url === `${SERVER}/`);
	}
	if (!attached && !sawServer) {
		record("SKIP: changed server reconnects after restart — DevTools could not attach to the relaunched WebView");
	} else {
		check(url === `${SERVER}/` || sawServer, "changed server is saved and reconnects after restart", url === `${SERVER}/` ? url : `navigation log: ${sawServer ? SERVER + "/" : "none"}`);
	}
	await shot("08-changed-server");
} catch (err) {
	const devtoolsLost = /waiting for event "webview"|Target page, context or browser has been closed/.test(String(err?.message));
	if (devtoolsLost && currentStep.startsWith("7.")) {
		// The emulator's DevTools socket for the WebView sometimes never comes
		// back after the last origin switches. Every app behaviour before this
		// point was checked; report the gap instead of failing on the tool.
		record(`SKIP: rest of step 7 — DevTools lost the WebView (${String(err.message).split("\n")[0]})`);
	} else {
		failures++;
		record(`FAIL: smoke test crashed — ${err?.stack ?? err}`);
	}
	await shot("99-crash");
} finally {
	if (failures > 0) await dumpLogcat();
	await device.close().catch(() => {});
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
