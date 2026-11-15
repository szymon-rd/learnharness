#!/usr/bin/env node
/**
 * End-to-end check of the code-cells plugin: the production server with the
 * scripted model (server.mjs) and a stub Lean checker, driven in Chromium.
 * Practice "Lean": the tutor verifies and poses a Lean problem; the learner
 * finishes the proof in the plugin's cell and submits; the submission card
 * shows Lean's verdict and the tutor concludes.
 *
 *   npm run build && node tests/e2e/code-cells.e2e.mjs [--out dir] [--headed]
 *
 * Needs playwright (npm install --no-save playwright-core) and its Chromium.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, "test-results", "code-cells-e2e"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Lean, stubbed: `sorry` fails, any other proof passes. */
async function startStubLean() {
	const port = await freePort();
	const server = http.createServer((req, res) => {
		if (req.url === "/health") return void res.end(JSON.stringify({ toolchain: "stub", mathlib: "stub", warming: false }));
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const { source } = JSON.parse(body || "{}");
			const lines = String(source).split("\n");
			const report = lines.findIndex((l) => l.startsWith("#print axioms")) + 1;
			const sorry = /\bsorry\b/.test(source);
			const messages = sorry
				? [{ severity: "warning", pos: { line: report - 2, column: 0 }, data: "declaration uses 'sorry'" }, { severity: "information", pos: { line: report, column: 0 }, data: "'x' depends on axioms: [sorryAx]" }]
				: [{ severity: "information", pos: { line: report, column: 0 }, data: "'x' depends on axioms: [propext]" }];
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ exitCode: 0, timedOut: false, ms: 5, messages }));
		});
	});
	await new Promise((r) => server.listen(port, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

async function startServer(leanUrl) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-code-cells-e2e-"));
	fs.cpSync(path.join(ROOT, "tests", "fixtures", "golden-data"), path.join(dir, "data"), { recursive: true });
	const port = await freePort();
	const log = fs.createWriteStream(path.join(OUT, "server.log"));
	const child = spawn(process.execPath, [path.join(ROOT, "tests", "e2e", "server.mjs"), "--port", String(port), "--data", path.join(dir, "data")], {
		cwd: ROOT,
		env: { ...process.env, LH_LEAN_URL: leanUrl },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}); see ${OUT}/server.log`);
		try {
			if ((await fetch(url + "/api/settings")).ok) return { url, stop: () => child.kill("SIGTERM") };
		} catch {
			/* not up yet */
		}
		await sleep(500);
	}
	child.kill("SIGTERM");
	throw new Error("server did not come up in 90 s");
}

const lean = await startStubLean();
const server = await startServer(lean.url);
const browser = await chromium.launch({ headless: !args.includes("--headed") });
let failed = false;
try {
	const enable = await fetch(`${server.url}/api/plugins/code-cells`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
	if (!enable.ok) throw new Error(`enabling the plugin: HTTP ${enable.status} ${await enable.text()}`);

	const page = await browser.newPage({ baseURL: server.url, viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await page.getByTestId("home-mode-practice").click();
	await page.locator("[data-file-path-input]").first().click();
	await page.keyboard.type("Practice Lean");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });

	const dock = page.getByTestId("practice-dock");
	await dock.waitFor({ state: "visible", timeout: 60_000 });
	await dock.getByText("Prove that 1 + 1 = 2.").first().waitFor({ timeout: 30_000 });
	const editor = dock.locator(".cm-content");
	await editor.waitFor({ timeout: 30_000 });
	await page.screenshot({ path: path.join(OUT, "1-posed.png") });
	console.log("ok  the tutor verified and posed a Lean problem; the plugin's cell is in the dock");

	// Replace the starter's `sorry` (the last line) with a proof.
	await dock.locator(".cm-line").last().click();
	await page.keyboard.press("End");
	for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
	await page.keyboard.type("norm_num");
	if (!(await editor.innerText()).includes("norm_num")) throw new Error("typing into the cell failed");
	await dock.getByRole("button", { name: /^Submit/ }).click();

	await page.getByText("Lean accepts the proof.").first().waitFor({ timeout: 60_000 });
	await page.getByTestId("conclude-card").first().waitFor({ timeout: 60_000 });
	await page.screenshot({ path: path.join(OUT, "2-submitted.png"), fullPage: true });
	console.log("ok  the submission was graded by Lean (stub) and shown; the tutor concluded");
	if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
} catch (error) {
	failed = true;
	console.error("FAIL", error);
	const pages = browser.contexts().flatMap((c) => c.pages());
	if (pages[0]) await pages[0].screenshot({ path: path.join(OUT, "failure.png"), fullPage: true }).catch(() => {});
} finally {
	await browser.close();
	server.stop();
	lean.stop();
}
process.exit(failed ? 1 : 0);
