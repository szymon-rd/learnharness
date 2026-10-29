#!/usr/bin/env node
/**
 * UI performance probe: page opening, home graph pan/zoom, session
 * scrolling, a streaming reply, and opening the sidebar and settings —
 * on a phone profile (Pixel 7, 4× CPU slowdown, mobile network) and a
 * desktop profile. Runs against the scripted-model server
 * (tests/e2e/server.mjs) on the production build.
 *
 *   npx next build
 *   node tests/perf/perf.mjs [--data <data dir>] [--out <dir>] [--profiles]
 *        [--only phone|desktop] [--url http://127.0.0.1:PORT]
 *
 * Without --url it copies the data dir (default tests/fixtures/golden-data)
 * to a temp dir and starts its own server. Prints one JSON summary; with
 * --profiles also saves CPU profiles (.cpuprofile, open in Chrome DevTools).
 * Build with LH_SOURCEMAPS=1 to read them by source file and function:
 *   node tests/perf/symbolicate.mjs test-results/perf/phone-stream.cpuprofile
 *
 * Numbers vary run to run by ~10–30% (headless Chrome, throttled CPU, no
 * GPU — canvas pan/zoom is raster-bound here and faster on a real phone);
 * compare runs, not single readings.
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
const flag = (name) => args.includes(name);
const DATA = path.resolve(option("--data", path.join(ROOT, "tests", "fixtures", "golden-data")));
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "perf")));
const SAVE_PROFILES = flag("--profiles");
const ONLY = option("--only");
fs.mkdirSync(OUT, { recursive: true });

const PROFILES = {
	phone: {
		context: { ...devices["Pixel 7"] },
		cpu: 4,
		network: { offline: false, latency: 70, downloadThroughput: (12 * 1024 * 1024) / 8, uploadThroughput: (4 * 1024 * 1024) / 8 },
	},
	desktop: {
		context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
		cpu: 1,
		network: { offline: false, latency: 30, downloadThroughput: (50 * 1024 * 1024) / 8, uploadThroughput: (20 * 1024 * 1024) / 8 },
	},
};

// ─── server ─────────────────────────────────────────────────────────────────

async function freePort() {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

async function startServer() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-perf-"));
	fs.cpSync(DATA, dir, { recursive: true });
	const port = await freePort();
	const child = spawn(process.execPath, [path.join(ROOT, "tests", "e2e", "server.mjs"), "--port", String(port), "--data", dir], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	child.stdout.on("data", (d) => (log += d));
	child.stderr.on("data", (d) => (log += d));
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(url + "/api/graph/status")).ok) return { url, child, dir };
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	child.kill();
	throw new Error("server did not start:\n" + log.slice(-2000));
}

// ─── in-page instrumentation ────────────────────────────────────────────────

const INSTRUMENT = () => {
	window.__perf = { longTasks: [], frames: [], recording: false };
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
		}).observe({ type: "longtask", buffered: true });
	} catch {}
	const tick = (t) => {
		if (window.__perf.recording) window.__perf.frames.push(t);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
};

async function startWindow(page) {
	await page.evaluate(() => {
		window.__perf.frames = [];
		window.__perf.windowStart = performance.now();
		window.__perf.recording = true;
	});
}

async function endWindow(page) {
	return page.evaluate(() => {
		const p = window.__perf;
		p.recording = false;
		const end = performance.now();
		const f = p.frames;
		const gaps = [];
		for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
		gaps.sort((a, b) => a - b);
		const pct = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] : 0);
		const seconds = (end - p.windowStart) / 1000;
		const long = p.longTasks.filter((t) => t.start >= p.windowStart && t.start <= end);
		return {
			seconds: +seconds.toFixed(2),
			fps: +(f.length / seconds).toFixed(1),
			p50FrameMs: +pct(0.5).toFixed(1),
			p95FrameMs: +pct(0.95).toFixed(1),
			worstFrameMs: +(gaps[gaps.length - 1] ?? 0).toFixed(1),
			framesOver50ms: gaps.filter((g) => g > 50).length,
			longTasks: long.length,
			longTaskMs: Math.round(long.reduce((s, t) => s + t.duration, 0)),
			blockingMs: Math.round(long.reduce((s, t) => s + Math.max(0, t.duration - 50), 0)),
		};
	});
}

// ─── CPU profiles ───────────────────────────────────────────────────────────

async function profileStart(cdp) {
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
	await cdp.send("Profiler.start");
}

async function profileStop(cdp, name) {
	const { profile } = await cdp.send("Profiler.stop");
	if (SAVE_PROFILES) fs.writeFileSync(path.join(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
	// Self time per function and per script.
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map();
	const dt = profile.timeDeltas;
	for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0));
	const fn = new Map();
	const script = new Map();
	for (const [id, us] of self) {
		const cf = byId.get(id).callFrame;
		const file = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, "") : `(${cf.functionName || "native"})`;
		const key = `${cf.functionName || "(anon)"} ${file}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`;
		fn.set(key, (fn.get(key) ?? 0) + us);
		script.set(file, (script.get(file) ?? 0) + us);
	}
	const top = (m, n) =>
		[...m.entries()]
			.filter(([k]) => !/^\((idle|program)\)/.test(k) && !k.startsWith("(idle)"))
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`);
	return { topFunctions: top(fn, 12), topScripts: top(script, 6) };
}

// ─── scenarios ──────────────────────────────────────────────────────────────

async function openPage(page, cdp, url, readySelector, name) {
	await cdp.send("Network.clearBrowserCache");
	await profileStart(cdp);
	const t0 = Date.now();
	await page.goto(url, { waitUntil: "commit" });
	await page.waitForSelector(readySelector, { state: "visible", timeout: 60_000 });
	const readyMs = Date.now() - t0;
	await page.waitForLoadState("networkidle").catch(() => {});
	const settledMs = Date.now() - t0;
	const prof = await profileStop(cdp, name);
	const nav = await page.evaluate(() => {
		const res = performance.getEntriesByType("resource");
		const js = res.filter((r) => /\.js(\?|$)/.test(r.name));
		const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
		const long = window.__perf.longTasks;
		return {
			fcpMs: fcp && Math.round(fcp),
			requests: res.length + 1,
			jsFiles: js.length,
			jsKB: Math.round(js.reduce((s, r) => s + (r.transferSize || r.encodedBodySize), 0) / 1024),
			jsDecodedKB: Math.round(js.reduce((s, r) => s + r.decodedBodySize, 0) / 1024),
			apiCalls: res.filter((r) => r.name.includes("/api/")).map((r) => `${r.name.replace(/^https?:\/\/[^/]+/, "")} ${Math.round(r.startTime)}→${Math.round(r.responseEnd)}ms`),
			longTaskMs: Math.round(long.reduce((s, t) => s + t.duration, 0)),
			blockingMs: Math.round(long.reduce((s, t) => s + Math.max(0, t.duration - 50), 0)),
		};
	});
	return { readyMs, settledMs, ...nav, ...prof };
}

/** A canvas point with nothing on top of it, and — when `wantNode` — one
 *  where the renderer shows the pointer cursor (a node), else one where
 *  it does not (empty space). Desktop only (hover needs a mouse). */
async function canvasPoint(page, box, wantNode) {
	for (let gy = 0.15; gy <= 0.85; gy += 0.035) {
		for (let gx = 0.1; gx <= 0.9; gx += 0.035) {
			const x = box.x + box.width * gx;
			const y = box.y + box.height * gy;
			const onCanvas = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName === "CANVAS", [x, y]);
			if (!onCanvas) continue;
			await page.mouse.move(x, y);
			const isNode = await page.evaluate(() => document.querySelector("canvas").style.cursor === "pointer");
			if (isNode === wantNode) return { x, y };
		}
	}
	return null;
}

async function measured(page, cdp, name, fn) {
	await profileStart(cdp);
	await startWindow(page);
	await fn();
	await page.waitForTimeout(500);
	const frames = await endWindow(page);
	const prof = await profileStop(cdp, name);
	return { ...frames, ...prof };
}

async function graphInteraction(page, cdp, kind, name) {
	const canvas = page.locator("canvas").first();
	await canvas.waitFor({ state: "visible" });
	await page.waitForTimeout(8000); // let any load-time layout finish
	const box = await canvas.boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const path = (i, n) => {
		const a = (i / n) * Math.PI * 2;
		return { x: cx + Math.sin(a) * box.width * 0.25, y: cy + (1 - Math.cos(a)) * box.height * 0.15 };
	};
	const out = {};
	if (kind === "phone") {
		// One-finger pan (a finger never drags a node), then a pinch.
		out.pan = await measured(page, cdp, `${name}-pan`, async () => {
			const start = path(0, 120);
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y }] });
			for (let i = 1; i <= 120; i++) {
				const p = path(i, 120);
				await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x, y: p.y }] });
				await page.waitForTimeout(16);
			}
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		});
		out.pinch = await measured(page, cdp, `${name}-pinch`, async () => {
			for (const scale of [2.5, 0.4]) {
				await cdp.send("Input.synthesizePinchGesture", { x: Math.round(cx), y: Math.round(cy), scaleFactor: scale, relativeSpeed: 400, gestureSourceType: "touch" });
			}
		});
	} else {
		const empty = await canvasPoint(page, box, false);
		if (empty) {
			out.pan = await measured(page, cdp, `${name}-pan`, async () => {
				await page.mouse.move(empty.x, empty.y);
				await page.mouse.down();
				for (let i = 1; i <= 120; i++) {
					await page.mouse.move(empty.x + Math.sin((i / 120) * Math.PI * 2) * 200, empty.y + (1 - Math.cos((i / 120) * Math.PI * 2)) * 120);
					await page.waitForTimeout(16);
				}
				await page.mouse.up();
			});
		}
		out.wheelZoom = await measured(page, cdp, `${name}-zoom`, async () => {
			await page.mouse.move(cx, cy);
			for (let i = 0; i < 40; i++) {
				await page.mouse.wheel(0, i < 20 ? -60 : 60);
				await page.waitForTimeout(25);
			}
		});
		const node = await canvasPoint(page, box, true);
		if (node) {
			out.nodeDrag = await measured(page, cdp, `${name}-drag`, async () => {
				await page.mouse.move(node.x, node.y);
				await page.mouse.down();
				for (let i = 1; i <= 120; i++) {
					await page.mouse.move(node.x + Math.sin((i / 120) * Math.PI * 2) * 150, node.y + (1 - Math.cos((i / 120) * Math.PI * 2)) * 90);
					await page.waitForTimeout(16);
				}
				await page.mouse.up();
				await page.waitForTimeout(2500); // the release anneal
			});
		}
	}
	return out;
}

async function idleFrames(page, name, cdp, ms = 3000) {
	await profileStart(cdp);
	await startWindow(page);
	await page.waitForTimeout(ms);
	const frames = await endWindow(page);
	const prof = await profileStop(cdp, name);
	return { ...frames, cpuBusyTop: prof.topFunctions.slice(0, 5) };
}

async function scrollSession(page, cdp, kind, name) {
	await page.waitForTimeout(2000);
	const vp = page.viewportSize();
	await profileStart(cdp);
	await startWindow(page);
	// Scroll to the top, then back down, at finger/wheel speed.
	const source = kind === "phone" ? "touch" : "mouse";
	for (const dir of [1, -1]) {
		await cdp.send("Input.synthesizeScrollGesture", {
			x: Math.round(vp.width / 2),
			y: Math.round(vp.height / 2),
			yDistance: dir * 6000,
			speed: 2500,
			gestureSourceType: source,
			repeatCount: 1,
		});
	}
	const frames = await endWindow(page);
	const prof = await profileStop(cdp, name);
	return { ...frames, ...prof };
}

async function streamReply(page, cdp, name) {
	const composer = page.getByTestId("composer");
	const field = composer.locator("textarea");
	await field.click();
	await field.fill("Explain it again in detail");
	await profileStart(cdp);
	await startWindow(page);
	const t0 = Date.now();
	await composer.getByRole("button", { name: "Send" }).click();
	await composer.getByRole("button", { name: "Stop" }).waitFor({ state: "visible", timeout: 15_000 });
	await composer.getByRole("button", { name: "Stop" }).waitFor({ state: "hidden", timeout: 90_000 });
	const streamMs = Date.now() - t0;
	const frames = await endWindow(page);
	const prof = await profileStop(cdp, name);
	return { streamMs, ...frames, ...prof };
}

async function timeTo(page, action, readySelector) {
	const t0 = Date.now();
	await action();
	await page.waitForSelector(readySelector, { state: "visible", timeout: 30_000 });
	return Date.now() - t0;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function run(kind, base, teachId) {
	const prof = PROFILES[kind];
	const browser = await chromium.launch();
	const context = await browser.newContext({ ...prof.context, colorScheme: "dark" });
	await context.addInitScript(INSTRUMENT);
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
	await cdp.send("Network.emulateNetworkConditions", prof.network);
	const r = {};

	r.openHome = await openPage(page, cdp, base + "/", "canvas", `${kind}-open-home`);
	// The first seconds after opening: any load-time layout animation.
	r.homeAfterOpen = await idleFrames(page, `${kind}-home-after-open`, cdp, 6000);
	r.graph = await graphInteraction(page, cdp, kind, `${kind}-graph`);
	r.homeIdle = await idleFrames(page, `${kind}-home-idle`, cdp);

	r.openSession = await openPage(page, cdp, `${base}/chat/${teachId}`, "[data-testid=composer]", `${kind}-open-session`);
	r.sessionIdle = await idleFrames(page, `${kind}-session-idle`, cdp);
	r.scroll = await scrollSession(page, cdp, kind, `${kind}-scroll`);

	// Sidebar and settings (navigation within the app).
	const sidebarOpen = await page.getByRole("button", { name: "Open sidebar" }).isVisible().catch(() => false);
	if (sidebarOpen) {
		r.openSidebarMs = await timeTo(page, () => page.getByRole("button", { name: "Open sidebar" }).click(), "[data-testid=settings-entry]");
	}
	r.openSettingsMs = await timeTo(page, () => page.getByTestId("settings-entry").click(), "[data-testid=settings-dialog]");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
	if (await page.getByTestId("settings-dialog").isVisible().catch(() => false)) await page.goto(`${base}/chat/${teachId}`);
	await page.waitForSelector("[data-testid=composer]");

	r.stream = await streamReply(page, cdp, `${kind}-stream`);
	r.scrollAfterStream = await scrollSession(page, cdp, kind, `${kind}-scroll-2`);
	await browser.close();
	return r;
}

async function main() {
	const urlArg = option("--url");
	const server = urlArg ? null : await startServer();
	const base = urlArg ?? server.url;
	const chats = fs.readdirSync(path.join(server?.dir ?? DATA, "chats")).filter((f) => f.endsWith(".json"));
	// The longest teaching session.
	const teach = chats
		.map((f) => ({ f, d: JSON.parse(fs.readFileSync(path.join(server?.dir ?? DATA, "chats", f), "utf8")) }))
		.filter(({ d }) => (d.settings?.mode ?? "teach") !== "practice")
		.sort((a, b) => b.d.messages.length - a.d.messages.length)[0];
	const teachId = teach.d.id;
	const results = { data: DATA, session: { id: teachId, messages: teach.d.messages.length } };
	try {
		for (const kind of ["phone", "desktop"]) {
			if (ONLY && ONLY !== kind) continue;
			results[kind] = await run(kind, base, teachId);
		}
	} finally {
		server?.child.kill();
	}
	const text = JSON.stringify(results, null, 2);
	fs.writeFileSync(path.join(OUT, "perf.json"), text);
	console.log(text);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
