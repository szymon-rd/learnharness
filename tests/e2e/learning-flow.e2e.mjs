#!/usr/bin/env node
/**
 * End-to-end test of the AI learning flow, driven through the PHONE UI
 * (Playwright's Pixel 7: 412×839, touch) against the real production
 * server with the scripted model (tests/e2e/scripted-model.mjs), plus a
 * quick desktop pass (1280×800).
 *
 *   npx next build                                   # once per app change
 *   node tests/e2e/learning-flow.e2e.mjs              # starts its own server
 *   node tests/e2e/learning-flow.e2e.mjs --url http://127.0.0.1:3300
 *        [--out <screenshot dir>] [--until <step id>] [--headed]
 *
 * Without --url it copies tests/fixtures/golden-data to a fresh temp dir
 * (the fixture itself is never touched) and starts tests/e2e/server.mjs on
 * a free port. With --url the server must be the scripted one on a fresh
 * copy of the fixture.
 *
 * Every step asserts the invariants (no page errors or unhandled
 * rejections, no horizontal page scroll, the step's key elements visible
 * and inside the viewport, nothing covering the composer) and saves a
 * screenshot. The output is a PASS/FAIL/SKIP list; any FAIL exits 1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "e2e")));
const UNTIL = option("--until");
const HEADED = args.includes("--headed");
fs.mkdirSync(OUT, { recursive: true });

// ─── server ──────────────────────────────────────────────────────────────────

async function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function startServer() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
	fs.cpSync(path.join(ROOT, "tests", "fixtures", "golden-data"), path.join(dir, "data"), { recursive: true });
	const port = await freePort();
	const env = { ...process.env };
	// Demos run in a real browser: Playwright's Chromium is the system
	// Chrome the demo-builder falls back to (src/agent/subagents/headless.ts).
	if (!env.CHROME_PATH) {
		try {
			const exe = chromium.executablePath();
			if (exe && fs.existsSync(exe)) env.CHROME_PATH = exe;
		} catch {
			/* no bundled Chromium — the demo job fails gracefully */
		}
	}
	const log = fs.createWriteStream(path.join(OUT, "server.log"));
	const child = spawn(process.execPath, [path.join(ROOT, "tests", "e2e", "server.mjs"), "--port", String(port), "--data", path.join(dir, "data")], {
		cwd: ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}); see ${path.join(OUT, "server.log")}`);
		try {
			const res = await fetch(url + "/api/settings");
			if (res.ok) return { url, dir, stop: () => child.kill("SIGTERM") };
		} catch {
			/* not up yet */
		}
		await sleep(500);
	}
	child.kill("SIGTERM");
	throw new Error("server did not come up in 90 s");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A TCP pass-through in front of the server, so the phone can LOSE its
 *  connection for real: Playwright's setOffline only fails NEW requests —
 *  an in-flight response stream keeps flowing — while a phone that drops
 *  off the network loses its open connections too. cut() resets every
 *  open socket and refuses new ones until restore(). */
async function startCutProxy(target) {
	const { hostname, port } = new URL(target);
	const pairs = new Set();
	let down = false;
	const server = net.createServer((client) => {
		if (down) {
			client.destroy();
			return;
		}
		const upstream = net.connect(Number(port), hostname);
		const pair = { client, upstream };
		pairs.add(pair);
		const kill = () => {
			client.destroy();
			upstream.destroy();
			pairs.delete(pair);
		};
		client.on("error", kill).on("close", kill);
		upstream.on("error", kill).on("close", kill);
		client.pipe(upstream).pipe(client);
	});
	const proxyPort = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
	return {
		url: `http://127.0.0.1:${proxyPort}`,
		cut() {
			down = true;
			for (const { client, upstream } of pairs) {
				client.resetAndDestroy?.() ?? client.destroy();
				upstream.destroy();
			}
			pairs.clear();
		},
		restore() {
			down = false;
		},
		close() {
			this.cut();
			server.close();
		},
	};
}

// ─── results + invariants ────────────────────────────────────────────────────

const results = [];
let stopped = false;

/** Console noise that is expected in this environment (no Deepgram key). */
const EXPECTED_CONSOLE = [/\/api\/stt\/token/, /status of 503/];

function watch(page, label) {
	const state = { label, errors: [], consoleErrors: [] };
	page.on("pageerror", (err) => state.errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		const text = msg.text();
		if (text.startsWith("E2E_UNHANDLED_REJECTION")) state.errors.push(text);
		else if (msg.type() === "error" && !EXPECTED_CONSOLE.some((re) => re.test(text) || re.test(msg.location()?.url ?? ""))) state.consoleErrors.push(text);
	});
	return state;
}

const REJECTION_PROBE = () => {
	window.addEventListener("unhandledrejection", (e) => {
		const r = e.reason;
		console.error(`E2E_UNHANDLED_REJECTION ${r && r.stack ? r.stack : String(r)}`);
	});
};

/** Layout invariants for the current page; returns problem strings. */
async function layoutProblems(page) {
	return page.evaluate(() => {
		const problems = [];
		const vw = window.innerWidth;
		const doc = document.scrollingElement || document.documentElement;
		if (doc.scrollWidth > vw + 1) problems.push(`horizontal page scroll: scrollWidth ${doc.scrollWidth} > viewport ${vw}`);
		// The bottom dock (composer / question dock / practice dock): nothing
		// from outside it may sit on top of it.
		const docks = ["[data-testid=composer]", "[data-testid=question-dock]", "[data-testid=practice-dock]"]
			.map((s) => document.querySelector(s))
			.filter((el) => el && el.getClientRects().length > 0);
		// The part of an element actually on screen: its box clipped by every
		// scrolling/clipping ancestor (a tall dock scrolls inside its shell).
		const visibleRect = (el) => {
			let { left, top, right, bottom } = el.getBoundingClientRect();
			for (let a = el.parentElement; a; a = a.parentElement) {
				const st = getComputedStyle(a);
				if (st.overflowX === "visible" && st.overflowY === "visible") continue;
				const c = a.getBoundingClientRect();
				left = Math.max(left, c.left);
				top = Math.max(top, c.top);
				right = Math.min(right, c.right);
				bottom = Math.min(bottom, c.bottom);
			}
			return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
		};
		// Always-visible controls (touch shows the copy/expand corners without
		// hover) must not sit on top of the text they belong to.
		const intersects = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
		for (const btn of document.querySelectorAll("[data-testid=md-copy],[data-testid=md-mermaid-expand]")) {
			if (Number(getComputedStyle(btn).opacity) < 0.5 || btn.getClientRects().length === 0) continue;
			const b = btn.getBoundingClientRect();
			if (b.bottom < 0 || b.top > window.innerHeight) continue;
			const block = btn.closest("[data-testid^=md-]:not([data-testid=md-copy])") ?? btn.parentElement?.parentElement;
			if (!block) continue;
			const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
			let covered = null;
			for (let n = walker.nextNode(); n && !covered; n = walker.nextNode()) {
				if (btn.contains(n) || !n.textContent.trim() || n.parentElement.closest(".katex-mathml")) continue;
				const range = document.createRange();
				range.selectNodeContents(n);
				const clip = visibleRect(n.parentElement);
				for (const r of range.getClientRects()) {
					const vis = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
					if (vis.right <= vis.left || vis.bottom <= vis.top) continue;
					if (intersects(vis, b)) {
						covered = n.textContent.trim().slice(0, 30);
						break;
					}
				}
			}
			if (covered) problems.push(`the ${btn.getAttribute("aria-label")} button covers "${covered}"`);
		}
		for (const dock of docks) {
			const r = visibleRect(dock);
			if (r.width === 0 || r.height === 0) continue;
			const full = dock.getBoundingClientRect();
			if (full.left < -1 || full.right > vw + 1) problems.push(`${dock.dataset.testid} sticks out of the viewport (${Math.round(full.left)}..${Math.round(full.right)})`);
			if (dock.closest("[aria-hidden=true],[inert]")) continue;
			// A modal surface (drawer, dialog) covers the dock on purpose.
			const modal = [...document.querySelectorAll("[aria-modal=true],[data-testid=sidebar-backdrop]")].some((m) => m.getClientRects().length > 0 && getComputedStyle(m).visibility !== "hidden" && Number(getComputedStyle(m).opacity) > 0);
			if (modal) continue;
			const ys = [r.top + Math.min(20, r.height / 2), r.top + r.height / 2, r.bottom - Math.min(12, r.height / 2)];
			const xs = [r.left + r.width * 0.15, r.left + r.width / 2, r.left + r.width * 0.85];
			for (const y of ys) {
				for (const x of xs) {
					if (y < 0 || y > window.innerHeight) continue;
					const hit = document.elementFromPoint(x, y);
					if (hit && !dock.contains(hit) && !hit.contains(dock)) {
						const shell = dock.closest("[data-dock-shell]") ?? dock.parentElement;
						if (shell && shell.contains(hit)) continue;
						const name = hit.getAttribute("data-testid") || hit.tagName.toLowerCase() + (hit.className && typeof hit.className === "string" ? "." + hit.className.split(" ").slice(0, 3).join(".") : "");
						problems.push(`${dock.dataset.testid} covered at (${Math.round(x)},${Math.round(y)}) by ${name}`);
						return problems;
					}
				}
			}
		}
		return problems;
	});
}

/** A locator must be visible and fully inside the viewport horizontally
 *  (and vertically on screen — the caller scrolls it into view first). */
async function assertInViewport(page, locator, name) {
	await locator.first().waitFor({ state: "visible", timeout: 15_000 });
	// No scrolling here: a check must not move the learner's position (the
	// dock's fold machine reads scroll position). Horizontal containment
	// holds for any element; vertical only for what is on screen anyway.
	const box = await locator.first().boundingBox();
	const vp = page.viewportSize();
	if (!box) throw new Error(`${name}: no bounding box`);
	if (box.x < -1 || box.x + box.width > vp.width + 1) throw new Error(`${name} is outside the viewport horizontally (${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${vp.width})`);
}

let shotIndex = 0;
async function step(id, title, page, watcher, fn, { keys = [] } = {}) {
	if (stopped) {
		results.push({ id, title, status: "SKIP", note: `not run (--until ${UNTIL})` });
		return null;
	}
	const started = Date.now();
	let status = "PASS";
	let note = "";
	let value = null;
	try {
		value = await fn();
		if (value && value.skip) {
			status = "SKIP";
			note = value.skip;
		} else if (value && value.note) note = value.note;
	} catch (err) {
		status = "FAIL";
		note = err instanceof Error ? err.message.split("\n")[0] : String(err);
	}
	// Invariants, checked after every step (also after a failure: the
	// screenshot and the layout state are the evidence).
	if (page && !page.isClosed()) {
		await sleep(250);
		try {
			for (const [name, locator] of keys) await assertInViewport(page, locator, name);
		} catch (err) {
			if (status !== "FAIL") {
				status = "FAIL";
				note = err.message;
			}
		}
		const layout = await layoutProblems(page).catch((err) => [`layout check failed: ${err.message}`]);
		if (layout.length > 0 && status !== "FAIL") {
			status = "FAIL";
			note = layout.join("; ");
		}
		const shot = path.join(OUT, `${String(++shotIndex).padStart(2, "0")}-${id}.png`);
		await page.screenshot({ path: shot }).catch(() => {});
	}
	if (watcher && watcher.errors.length > 0) {
		if (status !== "FAIL") {
			status = "FAIL";
			note = watcher.errors.join(" | ").slice(0, 400);
		}
		watcher.errors.length = 0;
	}
	const ms = Date.now() - started;
	results.push({ id, title, status, note, ms });
	console.log(`${status.padEnd(4)} ${id} ${title}${note ? ` — ${note}` : ""} (${(ms / 1000).toFixed(1)} s)`);
	if (UNTIL && id === UNTIL) stopped = true;
	return value;
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

/** Wait until the session's turn is idle: the composer's button is "Send"
 *  (not "Stop") and no streaming indicator is left. */
async function waitIdle(page, timeout = 60_000) {
	await page.waitForFunction(
		() => {
			const stop = document.querySelector('[data-testid=composer] button[aria-label="Stop"]');
			return !stop;
		},
		null,
		{ timeout },
	);
}

async function tapText(page, text, opts = {}) {
	const loc = page.getByText(text, { exact: opts.exact ?? false }).first();
	await loc.waitFor({ state: "visible", timeout: opts.timeout ?? 30_000 });
	await loc.scrollIntoViewIfNeeded();
	await loc.tap();
}

/** Tap a native range input at a fraction of its width (touch). */
async function tapRange(page, locator, fraction) {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	await page.touchscreen.tap(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2);
}

/** The pending question's dock, expanded. A question can arrive as the
 *  collapsed bar — by design for teach checks (read first, then "Answer"),
 *  and for any question when the learner is scrolled up — so tap it open
 *  the way a learner would. */
async function questionDock(page, timeout = 60_000) {
	const dock = page.getByTestId("question-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (await bar.first().isVisible().catch(() => false)) {
		await assertInViewport(page, bar.first(), "question bar");
		await bar.first().tap();
	}
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

/** Answer the pending option question: tap the option, optionally set the
 *  confidence and type thinking, submit. */
async function answerOptions(page, { option, confidence, thinking, dontKnow = false }) {
	const dock = await questionDock(page);
	if (dontKnow) await dock.getByText("I don't know", { exact: true }).tap();
	else await dock.getByText(option, { exact: false }).first().tap();
	if (confidence !== undefined) {
		const slider = dock.getByTestId("confidence-slider");
		if (await slider.count()) {
			const value = dock.getByTestId("confidence-value");
			const before = await value.innerText();
			await tapRange(page, slider, confidence);
			const after = await value.innerText();
			if (after === before) throw new Error(`tapping the confidence slider at ${confidence * 100}% left it at ${before}`);
		}
	}
	if (thinking) {
		const field = dock.locator("textarea").first();
		await field.tap();
		await field.fill(thinking);
	}
	await dock.getByRole("button", { name: /submit/i }).tap();
	await dock.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
}

async function sendMessage(page, text) {
	const composer = page.getByTestId("composer");
	const field = composer.locator("textarea");
	await field.tap();
	await field.fill(text);
	await composer.getByRole("button", { name: "Send" }).tap();
}

// ─── the flow ────────────────────────────────────────────────────────────────

async function main() {
	const urlArg = option("--url");
	const server = urlArg ? null : await startServer();
	const base = urlArg ?? server.url;
	console.log(`server: ${base}${server ? ` (data ${server.dir})` : ""}\nscreenshots: ${OUT}\n`);
	const browser = await chromium.launch({ headless: !HEADED });
	const proxy = await startCutProxy(base);
	try {
		await phoneFlow(browser, proxy.url, proxy);
		if (!stopped) await desktopPass(browser, base);
	} finally {
		await browser.close().catch(() => {});
		proxy.close();
		server?.stop();
	}
	console.log("\n── results ──");
	for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(4)} ${r.title}${r.note ? ` — ${r.note}` : ""}`);
	const failed = results.filter((r) => r.status === "FAIL").length;
	console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`);
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
	// The scratch data dir is evidence on failure; on success it goes.
	if (server && failed === 0) fs.rmSync(server.dir, { recursive: true, force: true });
	else if (server) console.log(`server data kept for inspection: ${server.dir}`);
	process.exitCode = failed > 0 ? 1 : 0;
}

async function phoneFlow(browser, base, proxy) {
	const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
	await context.addInitScript(REJECTION_PROBE);
	const page = await context.newPage();
	const w = watch(page, "phone");
	const s = { context, page, w, base, proxy };

	await step("a1", "home renders; start a teaching session from the composer", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("textarea").first();
		await topic.waitFor({ state: "visible" });
		await assertInViewport(page, topic, "home composer");
		await assertInViewport(page, page.getByTestId("home-mode-switch"), "teach/practice switch");
		await topic.tap();
		await topic.fill("Teach me Bayes' rule");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.teachUrl = page.url();
	});

	await step("a2", "prober: tap an option, set confidence, type thinking, submit", page, w, async () => {
		const dock = await questionDock(page);
		await assertInViewport(page, dock, "question dock");
		await answerOptions(page, { option: "1/3", confidence: 0.9, thinking: "Even leaves 2, 4 and 6; one of three." });
		await page.getByTestId("answered-card").first().waitFor({ state: "visible", timeout: 30_000 });
	}, { keys: [["answered card", page.getByTestId("answered-card").first()]] });

	await step("a3", "prober ask: type an own answer into the free-text option", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("What do you want to be able to do").waitFor();
		const other = dock.getByTestId("other-option").locator("input");
		await other.tap();
		await other.fill("Read medical test results without fooling myself");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await page.getByText("Read medical test results without fooling myself").first().waitFor({ timeout: 30_000 });
	});

	await step("a4", "prober: answer \"I don't know\"", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("A test for a rare condition").waitFor();
		await answerOptions(page, { dontKnow: true });
	});

	await step("a5", "probe_done: the assessment card shows and the teacher takes over (plan)", page, w, async () => {
		await page.getByTestId("probe-done-card").first().waitFor({ state: "visible", timeout: 60_000 });
		await page.getByTestId("plan-chip").waitFor({ state: "visible", timeout: 60_000 });
	}, { keys: [["plan chip", page.getByTestId("plan-chip")]] });

	await step("b1", "queued steer: type while the teacher is working", page, w, async () => {
		// The handoff run keeps going after plan_init (explanation + jobs +
		// the predict quiz): a message sent now is queued as a steer.
		const stop = page.getByTestId("composer").getByRole("button", { name: "Stop" });
		await stop.waitFor({ state: "visible", timeout: 10_000 });
		await sendMessage(page, "Please use a medical example");
		const sawQueue = await page.getByTestId("queued-steers").waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
		await page.getByText("You said: “Please use a medical example”").first().waitFor({ timeout: 60_000 });
		if (!sawQueue) throw new Error("the steer never showed as queued while the turn was running");
	});

	await step("c1", "background jobs: dispatch cards in the lesson, running blobs in the sidebar's activity section", page, w, async () => {
		await page.getByTestId("dispatch-card").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		const section = page.getByTestId("activity-section");
		await section.waitFor({ state: "visible" });
		await assertInViewport(page, section, "activity section");
		const running = await section.getByRole("button", { name: /^End / }).count();
		await page.screenshot({ path: path.join(OUT, "activity-running.png") });
		await closeSidebar(page);
		if (running === 0) {
			// The jobs are fast with the scripted model; they may all be done.
			const settled = await page.getByTestId("dispatch-settled").count();
			if (settled < 3) throw new Error("no running job in the activity section and the jobs have not settled");
		}
	});

	await step("b2", "plan window: open, pinch to zoom, close", page, w, async () => {
		await page.getByTestId("plan-chip").tap();
		const popup = page.getByTestId("plan-popup");
		await popup.waitFor({ state: "visible" });
		await assertInViewport(page, popup.getByTestId("plan-popup-close"), "plan close button");
		await assertInViewport(page, popup.getByRole("button", { name: "Zoom in" }), "plan zoom-in button");
		const canvas = popup.locator(".origin-top-left").first();
		await canvas.waitFor({ state: "visible" });
		await sleep(500);
		const before = await canvas.evaluate((el) => el.style.transform);
		await pinch(page, popup.locator(".touch-none").first(), 2);
		await sleep(400);
		const after = await canvas.evaluate((el) => el.style.transform);
		if (scaleOf(after) <= scaleOf(before) * 1.2) throw new Error(`pinch did not zoom in (${before} → ${after})`);
		await page.screenshot({ path: path.join(OUT, "plan-pinched.png") });
		await popup.getByTestId("plan-popup-close").tap();
		await popup.waitFor({ state: "detached" });
	});

	await step("b3", "teach quiz (predict): tap an option, set confidence, submit", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("what can you say about").waitFor();
		await assertInViewport(page, dock.getByRole("button", { name: /submit/i }), "submit button");
		await answerOptions(page, { option: "Nothing yet", confidence: 0.75 });
		await page.getByText("Bayes' rule is the product rule read twice").first().waitFor({ timeout: 60_000 });
	});

	await step("b3m", "inline diagram, code, table, math: render; corners stay off the content when scrolled; expand the diagram, pinch, close", page, w, async () => {
		// The explanation finishes streaming (the check is posed) before the
		// diagram is touched — mid-stream re-renders replace its nodes.
		await page.getByTestId("teach-check-reveal").or(page.getByTestId("question-dock")).first().waitFor({ state: "visible", timeout: 60_000 });
		// (The turn-end canonical sync remounts the streamed message once —
		// let it land; locators re-resolve after it.)
		await sleep(1500);
		const diagram = page.getByTestId("md-mermaid").last();
		await diagram.locator("svg").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.getByTestId("md-code").last().waitFor({ state: "visible" });
		await assertInViewport(page, diagram, "inline diagram");
		// Wide equations and tables scroll sideways inside their blocks: at
		// the far end, their always-visible copy corners must still not sit
		// on the content.
		for (const sel of ["[data-testid=md-table] .overflow-x-auto", "[data-testid=md-math] .katex-display"]) {
			const scroller = page.locator(sel).last();
			await scroller.scrollIntoViewIfNeeded();
			await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
			await sleep(200);
			const problems = (await layoutProblems(page)).filter((p) => p.includes("button covers"));
			await scroller.evaluate((el) => (el.scrollLeft = 0));
			if (problems.length > 0) throw new Error(`scrolled ${sel}: ${problems.join("; ")}`);
		}
		await diagram.getByTestId("md-mermaid-expand").tap();
		const overlay = page.getByTestId("mermaid-overlay");
		await overlay.waitFor({ state: "visible" });
		await assertInViewport(page, overlay.getByTestId("mermaid-overlay-close"), "diagram close button");
		const canvas = overlay.locator(".origin-top-left").first();
		await canvas.waitFor({ state: "visible" });
		await sleep(500);
		const before = await canvas.evaluate((el) => el.style.transform);
		await pinch(page, overlay.locator(".touch-none").first(), 2);
		await sleep(400);
		const after = await canvas.evaluate((el) => el.style.transform);
		if (scaleOf(after) <= scaleOf(before) * 1.2) throw new Error(`pinch did not zoom the diagram (${before} → ${after})`);
		await page.screenshot({ path: path.join(OUT, "diagram-pinched.png") });
		await overlay.getByTestId("mermaid-overlay-close").tap();
		await overlay.waitFor({ state: "detached" });
	});

	await step("c2", "background jobs complete: the activity section empties; research brief and figure render", page, w, async () => {
		// All three jobs finish (the activity section empties).
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("activity-section").waitFor({ state: "visible" });
		await page.waitForFunction(() => !document.querySelector('[data-testid=activity-section] button[aria-label^="End "]'), null, { timeout: 60_000 });
		await closeSidebar(page);
		// Research lands as a quiet "complete" line that expands to the brief.
		const badge = page.getByTestId("research-complete-badge").first();
		await badge.waitFor({ state: "visible", timeout: 60_000 });
		await badge.locator("summary").tap();
		await page.getByTestId("research-brief-card").first().waitFor({ state: "visible" });
		const figure = page.getByTestId("visual-card").first();
		await figure.waitFor({ state: "visible", timeout: 60_000 });
		await figure.getByTestId("visual-svg").first().waitFor({ state: "visible" });
		await assertInViewport(page, figure, "figure card");
		// A job result reaches the lesson as a steer, and steers wait while a
		// question is open: a demo that finishes after the predict answer was
		// sent shows only once the check is answered (by design — noted).
		const record = await (await page.request.get(`/api/chats/${s.teachUrl.split("/").pop()}`)).json();
		const steers = record.messages.filter((m) => m.customType === "subagent-steer").map((m) => m.details?.kind);
		if (!steers.includes("demo")) return { note: "the demo finished while the check was open; its card is held until the answer (checked in c3)" };
	}, { keys: [["research brief card", page.getByTestId("research-brief-card").first()], ["composer area", page.getByTestId("teach-check-reveal").or(page.getByTestId("question-dock"))]] });

	await step("b4", "teach quiz (check): a wrong answer is graded", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("A disease has prior").waitFor();
		await answerOptions(page, { option: "0.90", confidence: 0.3 });
		await page.getByText("Not quite").first().waitFor({ timeout: 60_000 });
	});

	await step("c3", "the demo card renders and the demo runs inside it", page, w, async () => {
		const demo = page.getByTestId("demo-card").or(page.getByTestId("demo-card-failed")).first();
		if (!(await demo.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) {
			const record = await (await page.request.get(`/api/chats/${s.teachUrl.split("/").pop()}`)).json();
			const steers = record.messages.filter((m) => m.customType === "subagent-steer").map((m) => m.details?.kind);
			throw new Error(`the demo card never rendered (record steers: ${JSON.stringify(steers)})`);
		}
		await assertInViewport(page, demo, "demo card");
		if ((await page.getByTestId("demo-card-failed").count()) > 0) {
			const note = await page.getByTestId("demo-card-failed").first().innerText();
			// Only a missing browser is an environment limit; any other failure is a bug.
			if (!/Chrome|render engine/i.test(note)) throw new Error(`demo failed: ${note.slice(0, 200)}`);
			return { skip: `demo could not be verified without a browser: ${note.slice(0, 120)}` };
		}
		await page.getByTestId("demo-iframe").first().waitFor({ state: "visible" });
		const posterior = await page.frameLocator("[data-testid=demo-iframe]").first().locator("#out").innerText({ timeout: 15_000 });
		if (!/^0\.\d+$/.test(posterior)) throw new Error(`the demo did not run inside its card (posterior "${posterior}")`);
		await demo.evaluate((el) => el.scrollIntoView({ block: "start" }));
		await page.screenshot({ path: path.join(OUT, "demo-running.png") });
	});

	await step("b5", "ask: pick how to continue; the teacher concludes the plan", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("Wrap up with a summary").tap();
		await dock.getByRole("button", { name: /submit/i }).tap();
		await page.getByText("That completes the plan").first().waitFor({ timeout: 60_000 });
		await waitIdle(page);
	}, { keys: [["composer", page.getByTestId("composer")]] });

	await step("b6", "abort a streaming turn with the stop control", page, w, async () => {
		await sendMessage(page, "Explain it again in detail");
		const stop = page.getByTestId("composer").getByRole("button", { name: "Stop" });
		await stop.waitFor({ state: "visible", timeout: 10_000 });
		await page.getByText("The same idea, slowly and in detail").first().waitFor({ timeout: 20_000 });
		await sleep(1500);
		await stop.tap();
		await page.getByTestId("composer").getByRole("button", { name: "Send" }).waitFor({ timeout: 10_000 });
		// The view settles onto the server's persisted partial (the model
		// may have streamed a few more tokens before the abort landed);
		// after that nothing may keep arriving.
		await sleep(1500);
		const a = await mainText(page);
		await sleep(2500);
		const b = await mainText(page);
		if (b.length !== a.length) throw new Error(`the transcript changed after the abort (${a.length} → ${b.length}): ${diffSnippet(a, b)}`);
		if (countOf(b, "Step 14.") > 0) throw new Error("the aborted reply ran to completion");
	});

	await step("d1", "extraction: Extract from the session's ⋯ menu; the run completes", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByRole("button", { name: "Session actions: Teach me Bayes' rule" }).tap();
		const extract = page.getByTestId("ctx-extract");
		await extract.waitFor({ state: "visible" });
		await assertInViewport(page, extract, "Extract button");
		if (await extract.isEnabled()) await extract.tap();
		// The run shows in the activity section, then the graph grows.
		await waitForGraph(page.context(), (g) => g.nodes.some((n) => n.name === "Base-rate effect"), 90_000);
		await page.keyboard.press("Escape").catch(() => {});
		await closeSidebar(page);
	});

	await step("d2", "home: the graph shows the new node; tapping it opens the node card", page, w, async () => {
		await page.goto("/");
		const search = page.getByRole("textbox", { name: "Search nodes" });
		await search.waitFor({ state: "visible", timeout: 30_000 });
		await assertInViewport(page, search, "graph search");
		await search.tap();
		await search.fill("Base-rate effect");
		await page.keyboard.press("Enter").catch(() => {});
		await search.blur();
		await sleep(1500);
		// The search filter leaves one node on the canvas; find it with the
		// renderer's own hit test, then tap it like a finger would.
		const at = await findCanvasNode(page);
		if (!at) throw new Error("the filtered node is not on the canvas");
		await page.touchscreen.tap(at.x, at.y);
		const card = page.getByText("When a hypothesis is rare, even highly likely evidence").first();
		await card.waitFor({ state: "visible", timeout: 10_000 });
		await assertInViewport(page, card, "node card");
	});

	await step("e1", "practice: start Practice from the home toggle; a problem is posed", page, w, async () => {
		await page.goto("/");
		await page.getByTestId("home-mode-practice").tap();
		const topic = page.locator("form textarea").first();
		await topic.tap();
		await topic.fill("Practice conditional probability");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.practiceUrl = page.url();
		const dock = page.getByTestId("practice-dock");
		await dock.waitFor({ state: "visible", timeout: 60_000 });
		await dock.getByText("3 red and 2 blue").waitFor();
	}, { keys: [["practice dock", page.getByTestId("practice-dock")]] });

	await step("e2", "practice: answer in the thinking field; graded (conclude card)", page, w, async () => {
		const dock = page.getByTestId("practice-dock");
		const field = dock.locator("textarea");
		await field.tap();
		await field.fill("After a red, 2 red and 2 blue are left, so 2/4 = 1/2.");
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 60_000 });
		await page.getByText("Press **Next problem**").or(page.getByText("Press Next problem")).first().waitFor({ timeout: 60_000 });
	}, { keys: [["conclude card", page.getByTestId("conclude-card").first()]] });

	await step("e3", "practice: Next problem → a new problem; a wrong answer is graded", page, w, async () => {
		const next = page.getByTestId("next-problem-button");
		await next.waitFor({ state: "visible", timeout: 30_000 });
		await assertInViewport(page, next, "Next problem button");
		await next.tap();
		const dock = page.getByTestId("practice-dock");
		await dock.getByText("1% of emails are spam").waitFor({ timeout: 60_000 });
		const field = dock.locator("textarea");
		await field.tap();
		await field.fill("95% of flagged mails are spam.");
		await dock.getByTestId("practice-send").tap();
		await page.waitForFunction(() => document.querySelectorAll("[data-testid=conclude-card]").length >= 2, null, { timeout: 60_000 });
		await page.getByTestId("next-problem-button").waitFor({ state: "visible", timeout: 30_000 });
	});

	await step("e4", "practice: conclude the set", page, w, async () => {
		await sendMessage(page, "That's enough, wrap up");
		await page.getByText("That's the set: 2 problems worked").first().waitFor({ timeout: 60_000 });
		await waitIdle(page);
	}, { keys: [["composer", page.getByTestId("composer")]] });

	await step("g1", "settings: every section opens; the model pickers show the scripted models", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("settings-entry").tap();
		const dialog = page.getByTestId("settings-dialog");
		await dialog.waitFor({ state: "visible" });
		for (const id of ["keys", "agent", "appearance", "graph", "keyboard", "general"]) {
			await openSettingsSection(page, id);
			await page.screenshot({ path: path.join(OUT, `settings-${id}.png`) });
			const content = page.getByTestId("settings-content");
			await content.waitFor({ state: "visible" });
			if (id === "agent") {
				const text = await content.innerText();
				if (!/deepseek-v4\.1-flash/i.test(text) || !/qwen3\.8-max/i.test(text)) throw new Error("the model slots do not show the scripted models");
				// Open the strong slot's picker: the scripted models are listed.
				const trigger = page.getByTestId("slot-model-strong");
				await assertInViewport(page, trigger, "strong model picker");
				await trigger.tap();
				const search = page.getByTestId("model-search");
				const list = page.getByTestId("model-list");
				await list.waitFor({ state: "visible" });
				await assertInViewport(page, list, "model list");
				const listed = await list.innerText();
				await page.screenshot({ path: path.join(OUT, "settings-model-picker.png") });
				if (!/deepseek-v4\.1-flash/i.test(listed) || !/qwen3\.8-max/i.test(listed)) throw new Error(`the model picker does not list the scripted models: ${listed.slice(0, 200)}`);
				await trigger.tap();
				await search.waitFor({ state: "hidden", timeout: 5_000 });
				// Free-recall checks for the next session (the recall tool).
				await page.getByTestId("quiz-mechanics-free").tap();
				await sleep(800);
			}
		}
		await openSettingsSection(page, "agent");
		await closeSettings(page);
		const saved = await (await page.request.get("/api/settings")).json();
		if (saved.settings?.agent?.tools?.explain !== true) throw new Error("the quiz mechanics switch did not save");
	});

	await step("g2", "free recall: a recall question answered in text", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("form textarea").first();
		await topic.tap();
		await topic.fill("Quick conditioning check");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		const dock = await questionDock(page);
		await dock.getByText("what does it mean to").waitFor();
		const field = dock.locator("textarea").first();
		await field.tap();
		await field.fill("You keep only the outcomes where B happened and measure A inside them.");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await page.getByTestId("answered-card").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.getByText("Read against my committed answer").first().waitFor({ timeout: 60_000 });
		// Back to multiple choice for the rest of the run.
		await page.request.put("/api/settings/agent", { data: { ...(await (await page.request.get("/api/settings")).json()).settings.agent, tools: { explain: false } } });
	}, { keys: [["answered card", page.getByTestId("answered-card").first()]] });

	await step("f1", "sidebar: the new sessions are listed; rename one through the touch ⋯ menu", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		for (const title of ["Teach me Bayes' rule", "Practice conditional probability", "Quick conditioning check"]) {
			await page.getByRole("button", { name: `Session actions: ${title}` }).waitFor({ state: "visible" });
		}
		const more = page.getByRole("button", { name: "Session actions: Practice conditional probability" });
		await assertInViewport(page, more, "session ⋯ button");
		await more.tap();
		await page.getByTestId("ctx-rename").tap();
		const input = page.getByTestId("session-rename-input");
		await input.waitFor({ state: "visible" });
		await input.fill("Conditional probability drills");
		await input.press("Enter");
		await page.getByRole("button", { name: "Session actions: Conditional probability drills" }).waitFor({ state: "visible", timeout: 10_000 });
	});

	await step("f2", "sidebar: delete a session through the touch ⋯ menu", page, w, async () => {
		await page.getByRole("button", { name: "Session actions: Quick conditioning check" }).tap();
		await page.getByTestId("ctx-delete").tap();
		const dialog = page.getByTestId("delete-session-dialog");
		await dialog.waitFor({ state: "visible" });
		await assertInViewport(page, dialog.getByTestId("delete-confirm"), "delete confirm");
		await dialog.getByTestId("delete-confirm").tap();
		await dialog.waitFor({ state: "detached", timeout: 15_000 });
		await page.getByRole("button", { name: "Session actions: Quick conditioning check" }).waitFor({ state: "detached", timeout: 10_000 });
		await closeSidebar(page);
	});

	// ── (h) a turn must survive the phone's life: reload, offline, app switch ──

	await step("h1", "reload mid-turn: the UI reattaches and shows the full reply", page, w, async () => {
		await page.goto(s.teachUrl);
		await page.getByTestId("composer").waitFor({ state: "visible" });
		await waitIdle(page);
		const ask = "Go through it once more in detail";
		const before = await mainText(page);
		await sendMessage(page, ask);
		await waitForCount(page, LONG_HEAD, countOf(before, LONG_HEAD) + 1, 20_000);
		await page.reload();
		await page.getByTestId("composer").waitFor({ state: "visible" });
		return expectFullReply(page, before, ask, { allowReload: false });
	});

	await step("h2", "offline for 5 s mid-stream: the reply arrives in full once back online", page, w, async () => {
		return offlineDuring(page, proxy, "And once more in detail, please", 5_000);
	});

	await step("h3", "offline until the turn has finished on the server (12 s): the reply shows once back online", page, w, async () => {
		return offlineDuring(page, proxy, "Again in detail, slowly", 12_000);
	});

	await step("h4", "app switch (hidden + frozen 10 s) mid-turn: the reply is complete on return", page, w, async () => {
		const ask = "One last time in detail";
		const before = await mainText(page);
		await sendMessage(page, ask);
		await waitForCount(page, LONG_HEAD, countOf(before, LONG_HEAD) + 1, 20_000);
		await setHidden(page, true);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
		await sleep(10_000);
		await cdp.send("Page.setWebLifecycleState", { state: "active" });
		await cdp.detach();
		await setHidden(page, false);
		return expectFullReply(page, before, ask, { allowReload: true });
	});

	await context.close();
}

// ─── step helpers ────────────────────────────────────────────────────────────

async function closeSidebar(page) {
	const backdrop = page.getByTestId("sidebar-backdrop");
	if (await backdrop.isVisible().catch(() => false)) {
		const vp = page.viewportSize();
		await page.touchscreen.tap(vp.width - 10, vp.height / 2);
		await backdrop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
	}
}

async function openSettingsSection(page, id) {
	const nav = page.getByTestId(`settings-nav-${id}`);
	if (!(await nav.isVisible().catch(() => false))) {
		// Phone: the section list is one level up — go back to it.
		const back = page.getByRole("button", { name: /back/i }).first();
		if (await back.isVisible().catch(() => false)) await back.tap();
	}
	await nav.waitFor({ state: "visible", timeout: 10_000 });
	await nav.tap();
}

async function closeSettings(page) {
	const close = page.getByTestId("settings-close");
	await close.tap();
	await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 10_000 });
}

async function mainText(page) {
	return page.evaluate(() => (document.querySelector("main") ?? document.body).innerText);
}

/** Where two texts first differ, with a little context from each. */
function diffSnippet(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return `at ${i}: before ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} / after ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 100))}`;
}

function countOf(text, needle) {
	return text.split(needle).length - 1;
}

async function waitForCount(page, needle, count, timeout) {
	await page.waitForFunction(
		([n, c]) => ((document.querySelector("main") ?? document.body).innerText.split(n).length - 1) >= c,
		[needle, count],
		{ timeout },
	);
}

const LONG_HEAD = "The same idea, slowly and in detail";
const LONG_TAIL = "Step 14.";

/** Send a long-reply request; once it streams, drop off the network (the
 *  browser goes offline AND every open connection is reset), come back
 *  after `ms`. The note says what the client saw while offline. */
async function offlineDuring(page, proxy, ask, ms) {
	const before = await mainText(page);
	await sendMessage(page, ask);
	await waitForCount(page, LONG_HEAD, countOf(before, LONG_HEAD) + 1, 20_000);
	const failed = [];
	const onFailed = (req) => failed.push(new URL(req.url()).pathname);
	page.on("requestfailed", onFailed);
	const steps = async () => countOf(await mainText(page), "Step ");
	const atOff = await steps();
	await page.context().setOffline(true);
	proxy.cut();
	await sleep(ms);
	const atOn = await steps();
	const banner = /connection dropped/i.test(await mainText(page));
	proxy.restore();
	await page.context().setOffline(false);
	page.off("requestfailed", onFailed);
	const result = await expectFullReply(page, before, ask, { allowReload: true });
	const grew = `${atOn > atOff ? "the reply kept growing" : "the reply froze"} while offline${banner ? ", with the connection-dropped banner" : ""}`;
	return { note: `${result.note}; ${grew}; failed requests while offline: ${[...new Set(failed)].join(", ") || "none"}` };
}

/** After a disruption: the long reply must show in full (its last
 *  paragraph) exactly once, the learner's message exactly once, and the
 *  composer must be idle — live, or (when allowed) after one reload. A
 *  reply that only shows after a manual reload is a FAIL for a phone (the
 *  note says so); a reply that never shows is a FAIL either way. */
async function expectFullReply(page, before, ask, { allowReload }) {
	const want = countOf(before, LONG_TAIL) + 1;
	const live = await waitForCount(page, LONG_TAIL, want, 40_000).then(() => true, () => false);
	if (!live) {
		await page.screenshot({ path: path.join(OUT, `stuck-${Date.now()}.png`) });
		if (!allowReload) throw new Error("the reply never completed after the reload (stuck)");
		await page.reload();
		await page.getByTestId("composer").waitFor({ state: "visible" });
		const recovered = await waitForCount(page, LONG_TAIL, want, 30_000).then(() => true, () => false);
		if (!recovered) throw new Error("the reply is lost even after a manual reload");
	}
	await waitIdle(page, 30_000);
	const after = await mainText(page);
	if (countOf(after, LONG_TAIL) !== want) throw new Error(`duplicated reply: "${LONG_TAIL}" appears ${countOf(after, LONG_TAIL)}× (want ${want})`);
	if (countOf(after, LONG_HEAD) !== countOf(before, LONG_HEAD) + 1) throw new Error(`duplicated or missing reply (${countOf(after, LONG_HEAD)} headings)`);
	if (countOf(after, ask) !== 1) throw new Error(`the learner's message shows ${countOf(after, ask)}×`);
	if (/connection dropped|Something went wrong/i.test(after)) throw new Error("the reply is complete but the error banner is still up");
	if (!live) throw new Error("the live UI stayed stuck; the full reply showed only after a manual reload");
	return { note: "live, without a reload" };
}

async function setHidden(page, hidden) {
	await page.evaluate((h) => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event(h ? "pagehide" : "pageshow"));
	}, hidden);
}

/** Where on screen a (search-filtered) graph node sits: sweep synthetic
 *  mouse pointermoves over the canvas and read the renderer's hover cursor
 *  (its pickAt — the same hit test a tap uses). Skips the floating chrome
 *  (header, bottom dock). */
async function findCanvasNode(page) {
	return page.evaluate(() => {
		const canvas = document.querySelector("main canvas");
		if (!canvas) return null;
		const r = canvas.getBoundingClientRect();
		const top = r.top + 70;
		const bottom = Math.min(r.bottom, window.innerHeight) - 220;
		for (let y = top; y < bottom; y += 6) {
			for (let x = r.left + 6; x < r.right - 6; x += 6) {
				canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerType: "mouse", bubbles: true }));
				if (canvas.style.cursor === "pointer") {
					canvas.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));
					return { x, y };
				}
			}
		}
		return null;
	});
}

/** Poll the graph API (a fresh request context, not the page). */
async function waitForGraph(context, predicate, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const res = await context.request.get("/api/graph");
		if (res.ok()) {
			const body = await res.json();
			const g = body.snapshot ?? body.graph ?? body;
			if (g?.nodes && predicate(g)) return g;
		}
		await sleep(1000);
	}
	throw new Error("the graph never showed the extracted node");
}

/** Two-finger pinch on an element via CDP touch events (Chromium). */
async function pinch(page, locator, factor) {
	const box = await locator.boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const cdp = await page.context().newCDPSession(page);
	const pts = (d) => [
		{ x: cx - d, y: cy, id: 1 },
		{ x: cx + d, y: cy, id: 2 },
	];
	const start = 40;
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(start) });
	const steps = 8;
	for (let i = 1; i <= steps; i++) {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(start + ((start * factor - start) * i) / steps) });
		await sleep(30);
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await cdp.detach();
}

function scaleOf(transform) {
	const m = /scale\(([\d.]+)\)/.exec(transform ?? "");
	return m ? Number(m[1]) : 1;
}

/** The quick desktop pass (1280×800, mouse): nothing the phone work
 *  touched may have broken the wide layout. */
async function desktopPass(browser, base) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
	await context.addInitScript(REJECTION_PROBE);
	const page = await context.newPage();
	const w = watch(page, "desktop");
	const sessions = await (await context.request.get("/api/chats")).json();
	const list = sessions.chats ?? sessions;
	const teach = list.find((c) => c.title === "Teach me Bayes' rule");
	const practice = list.find((c) => c.title === "Conditional probability drills");

	await step("D1", "desktop: home graph, composer and sidebar toggle", page, w, async () => {
		await page.goto("/");
		await page.getByRole("textbox", { name: "Search nodes" }).waitFor({ state: "visible", timeout: 30_000 });
		await page.locator("main canvas").first().waitFor({ state: "visible" });
	}, { keys: [["home composer", page.locator("form textarea").first()], ["teach/practice switch", page.getByTestId("home-mode-switch")]] });

	await step("D2", "desktop: the teaching session — transcript, cards, plan window", page, w, async () => {
		if (!teach) throw new Error("the teaching session is missing from /api/chats");
		await page.goto(`/chat/${teach.id}`);
		await page.getByTestId("composer").waitFor({ state: "visible" });
		await page.getByTestId("visual-card").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.getByTestId("plan-chip").click();
		await page.getByTestId("plan-popup").waitFor({ state: "visible" });
		await page.getByRole("button", { name: "Zoom in" }).click();
		await page.screenshot({ path: path.join(OUT, "desktop-plan.png") });
		await page.getByTestId("plan-popup-close").click();
	}, { keys: [["composer", page.getByTestId("composer")], ["plan chip", page.getByTestId("plan-chip")]] });

	await step("D3", "desktop: the practice session", page, w, async () => {
		if (!practice) throw new Error("the renamed practice session is missing from /api/chats");
		await page.goto(`/chat/${practice.id}`);
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 30_000 });
	}, { keys: [["composer", page.getByTestId("composer")]] });

	await step("D4", "desktop: settings dialog", page, w, async () => {
		await page.keyboard.press("Escape");
		const entry = page.getByTestId("settings-entry");
		if (!(await entry.isVisible().catch(() => false))) await page.getByRole("button", { name: "Open sidebar" }).click();
		await entry.click();
		await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
		await page.getByTestId("settings-nav-agent").click();
		await page.getByTestId("settings-content").getByText(/deepseek-v4\.1-flash/).first().waitFor();
		await page.getByTestId("settings-close").click();
	});
	await context.close();
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
