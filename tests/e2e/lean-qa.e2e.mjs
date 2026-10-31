#!/usr/bin/env node
/**
 * Lean code cells, end to end, with REAL Lean + Mathlib (the deploy/lean
 * image) and the scripted model (tests/e2e/scripted-model.mjs — its Lean
 * scripts run when code cells are on and the topic mentions Lean). Drives
 * the phone UI (Pixel 7) through every state of a cell and saves a
 * screenshot per state; then a short desktop pass.
 *
 *   docker run -d --name qa-lean -p 127.0.0.1:3301:3300 learnharness-lean
 *   npx next build
 *   LH_LEAN_URL=http://127.0.0.1:3301 node tests/e2e/lean-qa.e2e.mjs [--out dir]
 *
 * LEAN_CONTAINER (default qa-lean) is stopped and started again for the
 * "Lean offline" states. Run by .github/workflows/lean.yml.
 */
import { execFileSync, spawn } from "node:child_process";
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
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "lean-qa")));
const LEAN_URL = process.env.LH_LEAN_URL;
const LEAN_CONTAINER = process.env.LEAN_CONTAINER ?? "qa-lean";
const LEAN_WAIT = 180_000; // the first Mathlib import in a fresh server
fs.mkdirSync(OUT, { recursive: true });
if (!LEAN_URL) {
	console.error("Set LH_LEAN_URL to the Lean service (e.g. http://127.0.0.1:3301).");
	process.exit(2);
}

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

async function startServer() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lean-qa-"));
	fs.cpSync(path.join(ROOT, "tests", "fixtures", "golden-data"), path.join(dir, "data"), { recursive: true });
	const port = await freePort();
	const log = fs.createWriteStream(path.join(OUT, "server.log"));
	const child = spawn(process.execPath, [path.join(ROOT, "tests", "e2e", "server.mjs"), "--port", String(port), "--data", path.join(dir, "data")], {
		cwd: ROOT,
		env: { ...process.env, LH_E2E_TRACE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}); see server.log`);
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

// ─── results ────────────────────────────────────────────────────────────────

const results = [];
let shot = 0;

function watch(page) {
	const state = { errors: [] };
	page.on("pageerror", (err) => state.errors.push(`pageerror: ${err.message}`));
	return state;
}

async function snap(page, name) {
	const file = path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
	await page.screenshot({ path: file }).catch(() => {});
	return path.basename(file);
}

async function step(id, title, page, w, fn) {
	const started = Date.now();
	let status = "PASS";
	let note = "";
	try {
		const r = await fn();
		if (r?.note) note = r.note;
	} catch (err) {
		status = "FAIL";
		note = (err instanceof Error ? err.message : String(err)).split("\n")[0];
		await snap(page, `${id}-FAILED`);
	}
	if (w.errors.length) {
		if (status === "PASS") {
			status = "FAIL";
			note = w.errors.join(" | ").slice(0, 300);
		}
		w.errors.length = 0;
	}
	const ms = Date.now() - started;
	results.push({ id, title, status, note, ms });
	console.log(`${status.padEnd(4)} ${id} ${title}${note ? ` — ${note}` : ""} (${(ms / 1000).toFixed(1)} s)`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function questionDock(page, timeout = 60_000) {
	const dock = page.getByTestId("question-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (await bar.first().isVisible().catch(() => false)) await bar.first().tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

async function answerOption(page, { option, dontKnow = false }) {
	const dock = await questionDock(page);
	if (dontKnow) await dock.getByText("I don't know", { exact: true }).tap();
	else await dock.getByText(option, { exact: false }).first().tap();
	await dock.getByRole("button", { name: /submit/i }).tap();
	await dock.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
}

/** The Lean dock, expanded (a check can arrive as the collapsed bar). */
async function leanDock(page, timeout = 60_000) {
	const dock = page.getByTestId("lean-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (!(await dock.isVisible().catch(() => false))) await bar.first().tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

async function waitStatus(scope, status, timeout = LEAN_WAIT) {
	await scope.locator(`[data-testid=lean-status][data-status=${status}]`).waitFor({ state: "visible", timeout });
}

/** Replace the proof (the cell's last line) by typing, like a learner. */
async function typeProof(page, scope, text) {
	const lines = scope.locator(".cm-line");
	const last = lines.last();
	await last.tap();
	await page.keyboard.press("End");
	const old = await last.innerText();
	for (let i = 0; i < old.length; i++) await page.keyboard.press("Backspace");
	await page.keyboard.type(text, { delay: 25 });
}

async function editorText(scope) {
	return scope.locator(".cm-content").innerText();
}

async function sendMessage(page, text) {
	const composer = page.getByTestId("composer");
	const field = composer.locator("textarea");
	await field.tap();
	await field.fill(text);
	await composer.getByRole("button", { name: "Send" }).tap();
}

function docker(...cmd) {
	return execFileSync("docker", cmd, { encoding: "utf8" }).trim();
}

async function waitLeanHealthy(timeout = 120_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${LEAN_URL}/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(1000);
	}
	throw new Error("Lean did not come back");
}

async function closeSidebar(page) {
	const backdrop = page.getByTestId("sidebar-backdrop");
	if (await backdrop.isVisible().catch(() => false)) {
		const vp = page.viewportSize();
		await page.touchscreen.tap(vp.width - 10, vp.height / 2);
		await backdrop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
	}
}

// ─── the flow ───────────────────────────────────────────────────────────────

async function phone(browser, base) {
	const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	const s = {};

	await step("L00", "settings: Code cells is Off by default; switch to Mixed in", page, w, async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("settings-entry").tap();
		await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
		await page.getByTestId("settings-nav-agent").tap();
		const row = page.getByTestId("code-cells-row");
		await row.waitFor({ state: "visible" });
		await row.scrollIntoViewIfNeeded();
		await page.getByText(/Lean exercises among the checks/).waitFor({ timeout: 10_000 });
		if ((await page.getByTestId("code-cells-off").getAttribute("aria-checked")) !== "true") throw new Error("Code cells is not Off by default");
		await snap(page, "settings-code-cells-off");
		await page.getByTestId("code-cells-mixed").tap();
		await page.waitForFunction(() => document.querySelector("[data-testid=code-cells-mixed]")?.getAttribute("aria-checked") === "true");
		await sleep(600);
		await snap(page, "settings-code-cells-mixed");
		const settings = await (await context.request.get("/api/settings")).json();
		if (JSON.stringify(settings).indexOf('"codeCells":{"enabled":true}') < 0) throw new Error("the setting was not saved");
		await page.getByTestId("settings-close").tap();
		await closeSidebar(page);
	});

	await step("L01", "teaching session on Lean: probe, then the plan is marked as a Lean topic", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("textarea").first();
		await topic.tap();
		await topic.fill("Teach me to prove things in Lean");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.teachUrl = page.url();
		s.teachId = s.teachUrl.split("/").pop();
		await answerOption(page, { option: "1/3" });
		const dock = await questionDock(page);
		const other = dock.getByTestId("other-option").locator("input");
		await other.tap();
		await other.fill("Write proofs in Lean on my own");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await answerOption(page, { dontKnow: true });
		await page.getByTestId("plan-chip").waitFor({ state: "visible", timeout: 60_000 });
		const record = await (await context.request.get(`/api/chats/${s.teachId}`)).json();
		if (record.tree?.codeCells !== true) throw new Error("the plan is not marked as a Lean topic");
	});

	await step("L02", "the Lean exercise opens in the dock; Lean starts (status badge)", page, w, async () => {
		const dock = await leanDock(page);
		await dock.getByTestId("lean-cell").waitFor();
		await snap(page, "cell-starting");
	});

	await step("L03", "Lean loads Mathlib: the starter proof is incomplete (sorry) and the goal shows", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await waitStatus(dock, "sorry");
		const last = dock.locator(".cm-line").last();
		await last.tap();
		await page.keyboard.press("End");
		await page.keyboard.press("Home"); // before `sorry`: the goal it would close
		const panel = dock.getByTestId("lean-goals");
		await panel.getByText("⊢ a + b = b + a").waitFor({ timeout: 30_000 }).catch(async () => {
			throw new Error(`goal panel shows: ${JSON.stringify(await panel.innerText())}`);
		});
		await sleep(500);
		await snap(page, "cell-sorry-goal");
	});

	await step("L04", "the statement is locked: typing into it changes nothing", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		const before = await editorText(dock);
		await dock.locator(".cm-line").nth(2).tap();
		await page.keyboard.type("xyz");
		await page.keyboard.press("Backspace");
		if ((await editorText(dock)) !== before) throw new Error("the locked statement changed");
		await snap(page, "cell-locked-statement");
	});

	await step("L05", "syntax error: an unfinished term is underlined and explained", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await typeProof(page, dock, "  exact (");
		await waitStatus(dock, "errors", 60_000);
		await dock.getByTestId("lean-messages").waitFor();
		await sleep(400);
		await snap(page, "cell-syntax-error");
		await dock.locator(".cm-lintRange-error").first().hover().catch(() => {});
		await sleep(800);
		await snap(page, "cell-syntax-error-tooltip");
	});

	await step("L06", "tactic error: rfl fails with Lean's message", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await typeProof(page, dock, "  rfl");
		await waitStatus(dock, "errors", 60_000);
		await sleep(400);
		await snap(page, "cell-tactic-error");
	});

	await step("L07", "autocompletion: typing a library name offers Lean's completions", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await typeProof(page, dock, "  exact Nat.add_co");
		const popup = page.locator(".cm-tooltip-autocomplete");
		await popup.waitFor({ state: "visible", timeout: 60_000 });
		const option = popup.locator("li").filter({ hasText: /^(Nat\.)?add_comm(\b|$)/ }).first();
		await option.waitFor({ timeout: 30_000 });
		// The highlighted name's type, fetched from Lean on demand.
		await page.locator(".cm-completionInfo").getByText(/add_comm.*:/).waitFor({ timeout: 20_000 });
		await sleep(300);
		await snap(page, "cell-autocomplete");
		await option.tap();
		await popup.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
		await page.keyboard.type(" a b", { delay: 25 });
		const text = await editorText(dock);
		if (!text.includes("exact Nat.add_comm a b")) throw new Error(`completion did not insert the name: ${text.split("\n").pop()}`);
		await waitStatus(dock, "passes", 60_000);
		await dock.getByTestId("lean-goals").getByText("No goals").waitFor({ timeout: 30_000 });
		await sleep(400);
		await snap(page, "cell-passes-after-completion");
	});

	await step("L08", "abbreviations: \\to, \\forall, \\N become →, ∀, ℕ; the symbol bar inserts too", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("  -- \\forall n \\in \\N, n \\to ", { delay: 25 });
		await dock.getByRole("toolbar", { name: "Lean symbols" }).getByRole("button", { name: "⟨", exact: true }).tap();
		const text = await editorText(dock);
		if (!/-- ∀ n ∈ ℕ, n → ⟨/.test(text)) throw new Error(`abbreviations not expanded: ${text.split("\n").pop()}`);
		await waitStatus(dock, "passes", 60_000);
		await snap(page, "cell-abbreviations");
	});

	await step("L09", "submit a passing proof: the server's verdict card, then the tutor reacts", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await dock.locator("textarea").tap();
		await dock.locator("textarea").fill("Found Nat.add_comm through completion.");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=lean]").first();
		await card.getByText("passes", { exact: true }).waitFor({ timeout: 90_000 });
		await page.getByText("Lean accepts your proof").first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "answered-passes");
	});

	await step("L10", "a second code cell in a row is refused: the tutor mixes in a quiz", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("decision procedure").waitFor();
		await snap(page, "two-in-a-row-quiz-instead");
		await answerOption(page, { option: "omega" });
	});

	await step("L11", "Mathlib exercise: a wrong tactic shows Lean's error", page, w, async () => {
		const dock = await leanDock(page);
		await dock.getByText("square of a real number").waitFor();
		await waitStatus(dock, "sorry");
		await typeProof(page, dock, "  linarith");
		await waitStatus(dock, "errors", 90_000);
		await sleep(400);
		await snap(page, "mathlib-error");
	});

	await step("L12", "Lean goes offline: the cell says so and offers Reconnect", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		if (process.env.QA_NO_DOCKER === "1") return { note: "skipped: no docker here" };
		docker("stop", "-t", "1", LEAN_CONTAINER);
		await waitStatus(dock, "offline", 30_000);
		await dock.getByText("Reconnect").waitFor();
		await snap(page, "cell-offline");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		await sleep(4000);
		await snap(page, "submit-while-offline");
		const body = await page.locator("body").innerText();
		if (body.includes('{"error"')) throw new Error("the error banner shows raw JSON");
		if (!(await page.getByTestId("lean-dock").isVisible())) throw new Error("the exercise left the dock although Lean could not check it");
		docker("start", LEAN_CONTAINER);
		await waitLeanHealthy();
		await page.getByTestId("lean-dock").getByText("Reconnect").tap();
		await waitStatus(page.getByTestId("lean-dock"), "errors", LEAN_WAIT);
		await snap(page, "cell-reconnected");
	});

	await step("L13", "submit a failing proof: the card shows Lean's errors and the reference proof", page, w, async () => {
		const dock = page.getByTestId("lean-dock");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=lean]").nth(1);
		await card.getByText("does not pass").waitFor({ timeout: 120_000 });
		await card.getByText("Show the reference proof").tap();
		await card.scrollIntoViewIfNeeded();
		await sleep(400);
		await snap(page, "answered-fails-reference");
		await page.getByText("## Summary").or(page.getByText("A proof is a term")).first().waitFor({ timeout: 60_000 });
	});

	await step("L14", "practice: a Lean problem for material from the Lean session", page, w, async () => {
		// The session's propositions (extraction, as the ⋯ menu does it).
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByRole("button", { name: /Session actions: Teach me to prove things in Lean/ }).tap();
		const extract = page.getByTestId("ctx-extract");
		await extract.waitFor({ state: "visible" });
		if (await extract.isEnabled()) await extract.tap();
		await page.keyboard.press("Escape").catch(() => {});
		await closeSidebar(page);
		let picks = [];
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline && picks.length === 0) {
			const g = await (await context.request.get("/api/graph")).json();
			const graph = g.snapshot ?? g.graph ?? g;
			picks = (graph.nodes ?? []).filter((n) => JSON.stringify(n).includes(s.teachId)).map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
			if (!picks.length) await sleep(1500);
		}
		if (!picks.length) throw new Error("no proposition from the Lean session reached the graph");
		const created = await (await context.request.post("/api/chats", { data: { title: "Practice Lean proofs", kind: "practice", graphContext: { propositions: picks.slice(0, 3) } } })).json();
		s.practiceUrl = `/chat/${created.id}`;
		await page.goto(s.practiceUrl);
		await sendMessage(page, "Practice Lean proofs");
		const dock = page.getByTestId("practice-dock");
		await dock.waitFor({ state: "visible", timeout: 60_000 });
		await dock.getByTestId("lean-cell").waitFor();
		await waitStatus(dock, "sorry");
		await snap(page, "practice-lean-problem");
	});

	await step("L15", "practice: a wrong proof is graded by Lean in the submission card", page, w, async () => {
		const dock = page.getByTestId("practice-dock");
		await typeProof(page, dock, "  exact rfl");
		await waitStatus(dock, "errors", 60_000);
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("lean-submission-card").first().getByText("does not pass").waitFor({ timeout: 90_000 });
		await page.getByText("Lean still reports an error").first().waitFor({ timeout: 60_000 });
		if (!(await editorText(dock)).includes("exact rfl")) throw new Error("the proof was reset after submitting");
		if (await page.locator(".cm-tooltip-autocomplete").isVisible().catch(() => false)) throw new Error("the completion list stayed open after submitting");
		await snap(page, "practice-submission-fails");
	});

	await step("L16", "practice: the right proof passes and the problem concludes", page, w, async () => {
		const dock = page.getByTestId("practice-dock");
		await typeProof(page, dock, "  omega");
		await waitStatus(dock, "passes", 60_000);
		await snap(page, "practice-passes-live");
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 90_000 });
		await snap(page, "practice-concluded");
	});

	await step("L17", "practice: a second Lean problem in a row is refused; a plain problem follows", page, w, async () => {
		await page.getByTestId("next-problem-button").tap();
		const dock = page.getByTestId("practice-dock");
		await dock.getByText("3 red and 2 blue").waitFor({ timeout: 60_000 });
		if (await dock.getByTestId("lean-cell").count()) throw new Error("the plain problem shows a Lean cell");
		await snap(page, "practice-plain-after-lean");
	});

	await context.close();
	return s;
}

async function desktop(browser, base, s) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	await step("D1", "desktop: the Lean teaching session's cards", page, w, async () => {
		await page.goto(s.teachUrl);
		await page.locator("[data-testid=answered-card][data-kind=lean]").first().waitFor({ timeout: 30_000 });
		await page.locator("[data-testid=answered-card][data-kind=lean]").first().scrollIntoViewIfNeeded();
		await snap(page, "desktop-teach-cards");
	});
	await step("D2", "desktop: a live Lean cell (practice, Mathlib-free problem)", page, w, async () => {
		await page.goto(s.practiceUrl);
		const plain = page.getByTestId("practice-dock");
		await plain.locator("textarea").fill("After a red, 2 of 4 are red: 1/2.");
		await plain.getByTestId("practice-send").click();
		await page.getByTestId("next-problem-button").waitFor({ timeout: 60_000 });
		await page.getByTestId("next-problem-button").click();
		const dock = page.getByTestId("practice-dock");
		await dock.getByTestId("lean-cell").waitFor({ timeout: 60_000 });
		await waitStatus(dock, "sorry");
		await snap(page, "desktop-practice-cell");
	});
	await context.close();
}

async function main() {
	const server = await startServer();
	console.log(`server: ${server.url}\nLean: ${LEAN_URL}\nscreenshots: ${OUT}\n`);
	const browser = await chromium.launch();
	try {
		const s = await phone(browser, server.url);
		if (s.teachUrl && s.practiceUrl) await desktop(browser, server.url, s);
	} finally {
		await browser.close().catch(() => {});
		server.stop();
	}
	const failed = results.filter((r) => r.status === "FAIL").length;
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
	console.log(`\n${results.length - failed} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
}

await main();
