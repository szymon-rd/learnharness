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
	await device.shell(`am start -W -n ${PKG}/.MainActivity`);
	const webview = await device.webView({ pkg: PKG }, { timeout: 60_000 });
	return webview.page();
}

async function currentUrl(page) {
	return page.evaluate(() => location.href).catch(() => "(unavailable)");
}

async function waitForUrl(page, predicate, timeout = 30_000) {
	const start = Date.now();
	let url = "";
	while (Date.now() - start < timeout) {
		url = await currentUrl(page);
		if (predicate(url)) return url;
		await sleep(500);
	}
	return url;
}

try {
	// 1. First launch: the connect screen.
	let page = await launch();
	await page.waitForSelector("#form", { state: "visible", timeout: 30_000 });
	check((await currentUrl(page)).startsWith("https://localhost/"), "first launch shows the local connect screen", await currentUrl(page));
	await shot("01-connect");

	// 2. Validation, then connect + pair.
	await page.fill("#url", SERVER.replace(/^http:\/\//, ""));
	await page.fill("#code", "short");
	await page.click("button[type=submit]");
	check((await page.textContent("#error"))?.includes("access code"), "short code is rejected on the phone");
	await page.fill("#code", CODE.toLowerCase());
	await page.click("button[type=submit]");
	let url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, "pairing lands on the LearnHarness home page", url);
	await page.waitForSelector("textarea", { timeout: 30_000 }).catch(() => {});
	await sleep(2000);
	const home = await page.evaluate(() => ({
		composer: !!document.querySelector("textarea"),
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	check(home.composer, "home page rendered (composer present)");
	check(home.scrollWidth <= home.width, "no horizontal scroll on home", `${home.scrollWidth} vs ${home.width}`);
	await shot("02-home");

	// 3. Sessions load over the network (API behind the pairing cookie).
	await page.evaluate((id) => {
		location.href = `/chat/${id}`;
	}, TEACH);
	url = await waitForUrl(page, (u) => u.endsWith(`/chat/${TEACH}`));
	await sleep(4000);
	const apiStatus = await page.evaluate(() => fetch("/api/graph/status").then((r) => r.status));
	check(apiStatus === 200, "API calls carry the pairing cookie", String(apiStatus));
	const teach = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 4000), width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
	check(teach.text.includes("test session"), "teaching session renders");
	check(teach.scrollWidth <= teach.width, "no horizontal scroll in the teaching session", `${teach.scrollWidth} vs ${teach.width}`);
	await shot("03-teach");

	await page.evaluate((id) => {
		location.href = `/chat/${id}`;
	}, PRACTICE);
	await waitForUrl(page, (u) => u.endsWith(`/chat/${PRACTICE}`));
	await sleep(4000);
	check((await page.evaluate(() => document.body.innerText)).includes("PROBLEM"), "practice session renders");
	await shot("04-practice");

	// 4. Outside links open outside the app (the WebView stays put).
	const before = await currentUrl(page);
	await page.evaluate(() => {
		location.href = "https://example.com/";
	});
	await sleep(3000);
	check((await currentUrl(page)) === before, "outside link did not load inside the app", await currentUrl(page));
	await device.shell(`am start -W -n ${PKG}/.MainActivity`);
	await sleep(1500);

	// 5. Android back walks the history: practice → teach → home → connect screen.
	await device.shell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl(page)).endsWith(`/chat/${TEACH}`), "back: practice → teaching session", await currentUrl(page));
	await device.shell("input keyevent 4");
	await sleep(2000);
	check((await currentUrl(page)) === `${SERVER}/`, "back: teaching session → home", await currentUrl(page));
	await device.shell("input keyevent 4");
	await sleep(3000);
	url = await currentUrl(page);
	const formVisible = await page.isVisible("#form").catch(() => false);
	check(url.startsWith("https://localhost/") && formVisible, "back: home → connect screen with the form (no auto-reconnect loop)", url);
	check((await page.inputValue("#url").catch(() => "")) === SERVER, "connect screen keeps the saved server");
	await shot("05-back-to-connect");

	// 6. Cold restart: reconnects straight to the server.
	page = await launch();
	url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, "cold restart reconnects to the saved server", url);
	await shot("06-restart");

	// 7. Unreachable server → the app's error page, with a way back.
	await device.shell("input keyevent 4");
	await sleep(2000);
	await page.waitForSelector("#form", { state: "visible", timeout: 15_000 });
	const deadServer = SERVER.replace(/:(\d+)$/, ":3999");
	await page.fill("#url", deadServer);
	await page.fill("#code", CODE);
	await page.click("button[type=submit]");
	url = await waitForUrl(page, (u) => u.includes("error.html"), 20_000);
	check(url.includes("error.html"), "unreachable server shows the error page", url);
	await shot("07-error");
	await page.click("#change");
	await page.waitForSelector("#form", { state: "visible", timeout: 15_000 });
	await page.fill("#url", SERVER);
	await page.click("button[type=submit]");
	url = await waitForUrl(page, (u) => u === `${SERVER}/`);
	check(url === `${SERVER}/`, "change server from the error page", url);
} catch (err) {
	failures++;
	console.log(`FAIL: smoke test crashed — ${err?.stack ?? err}`);
	await shot("99-crash");
} finally {
	await device.close().catch(() => {});
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
