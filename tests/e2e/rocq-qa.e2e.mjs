#!/usr/bin/env node
/**
 * Rocq code cells, end to end, with REAL Rocq 9 + Iris (the deploy/rocq
 * image) and the scripted model (tests/e2e/scripted-model.mjs — its Rocq
 * scripts run when code cells are on and the topic mentions Rocq). Drives
 * the phone UI (Pixel 7) through the states of a cell — live coq-lsp errors
 * and goals, including the Iris proof mode — and saves a screenshot per
 * state; then a short desktop pass.
 *
 *   docker run -d --name qa-rocq -p 127.0.0.1:3601:3600 learnharness-rocq
 *   npx next build
 *   LH_ROCQ_URL=http://127.0.0.1:3601 node tests/e2e/rocq-qa.e2e.mjs [--out dir]
 *
 * ROCQ_CONTAINER (default qa-rocq) is stopped and started again for the
 * "Rocq offline" state (QA_NO_DOCKER=1 skips it). Run by
 * .github/workflows/rocq.yml.
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
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "rocq-qa")));
const ROCQ_URL = process.env.LH_ROCQ_URL;
const ROCQ_CONTAINER = process.env.ROCQ_CONTAINER ?? "qa-rocq";
const WAIT = 60_000;
fs.mkdirSync(OUT, { recursive: true });
if (!ROCQ_URL) {
	console.error("Set LH_ROCQ_URL to the Rocq service (e.g. http://127.0.0.1:3601).");
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rocq-qa-"));
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

/** The Rocq dock, expanded (a check can arrive as the collapsed bar). */
async function rocqDock(page, timeout = 90_000) {
	const dock = page.getByTestId("rocq-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (!(await dock.isVisible().catch(() => false))) await bar.first().tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

async function waitStatus(scope, status, timeout = WAIT) {
	await scope.locator(`[data-testid=rocq-status][data-status=${status}]`).waitFor({ state: "visible", timeout });
}

/** Replace the proof (from its first line, 1-based, to the end) through
 *  the editor, as one edit. */
async function setProof(scope, proofLine, text) {
	await scope.locator(".cm-content").evaluate(
		(el, { proofLine, text }) => {
			const view = el.cmTile?.root?.view ?? el.cmView?.view;
			if (!view) throw new Error("no editor view on .cm-content");
			const doc = view.state.doc;
			view.dispatch({ changes: { from: doc.line(proofLine).from, to: doc.length, insert: text }, userEvent: "input.type" });
		},
		{ proofLine, text },
	);
}

/** Put the cursor on the first line containing `text` (end of line). */
async function cursorOn(page, scope, text) {
	await scope.locator(".cm-line", { hasText: text }).first().tap();
	await page.keyboard.press("End");
}

/** The editor's document (not the screen: phones fold the head). */
async function editorText(scope) {
	return scope.locator(".cm-content").evaluate((el) => {
		const view = el.cmTile?.root?.view ?? el.cmView?.view;
		if (!view) throw new Error("no editor view on .cm-content");
		return view.state.doc.toString();
	});
}

/** The practice dock, expanded (it folds to its bar when the transcript grows). */
async function practiceDock(page) {
	const dock = page.getByTestId("practice-dock");
	const bar = page.getByTestId("practice-dock-bar");
	await dock.or(bar).first().waitFor({ state: "visible", timeout: 60_000 });
	if (await bar.isVisible().catch(() => false)) await bar.tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
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

async function waitHealthy(timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${ROCQ_URL}/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(500);
	}
	throw new Error("the Rocq service did not come back");
}

async function closeSidebar(page) {
	const backdrop = page.getByTestId("sidebar-backdrop");
	if (await backdrop.isVisible().catch(() => false)) {
		const vp = page.viewportSize();
		await page.touchscreen.tap(vp.width - 10, vp.height / 2);
		await backdrop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
	}
}

/** First proof line (1-based) of each exercise: prelude, blank, statement. */
const EX1 = 4;
const EX2 = 5;
const PROBLEM = 4;

// ─── the flow ───────────────────────────────────────────────────────────────

const IRIS_OK = 'Proof.\n  iIntros "[HP HQ]".\n  iFrame.\nQed.';
const IRIS_WRONG = 'Proof.\n  iIntros "[HP HQ]".\n  iExact "HP".\nQed.';

async function phone(browser, base) {
	const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	const s = {};

	await step("R00", "settings: Code cells is Off by default and offers Rocq; switch to Mixed in", page, w, async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("settings-entry").tap();
		await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
		await page.getByTestId("settings-nav-agent").tap();
		const row = page.getByTestId("code-cells-row");
		await row.waitFor({ state: "visible" });
		await row.scrollIntoViewIfNeeded();
		await page.getByText(/Rocq exercises among the checks/).waitFor({ timeout: 10_000 });
		if ((await page.getByTestId("code-cells-off").getAttribute("aria-checked")) !== "true") throw new Error("Code cells is not Off by default");
		await page.getByTestId("code-cells-mixed").tap();
		await page.waitForFunction(() => document.querySelector("[data-testid=code-cells-mixed]")?.getAttribute("aria-checked") === "true");
		await sleep(600);
		await snap(page, "settings-code-cells-rocq");
		await page.getByTestId("settings-close").tap();
		await closeSidebar(page);
	});

	await step("R01", "teaching session on Rocq: probe, then the plan is marked as a Rocq topic", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("textarea").first();
		await topic.tap();
		await topic.fill("Teach me Rocq and Iris");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.teachUrl = page.url();
		s.teachId = s.teachUrl.split("/").pop();
		await answerOption(page, { option: "1/3" });
		const dock = await questionDock(page);
		const other = dock.getByTestId("other-option").locator("input");
		await other.tap();
		await other.fill("Write Iris proofs on my own");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await answerOption(page, { dontKnow: true });
		await page.getByTestId("plan-chip").waitFor({ state: "visible", timeout: 60_000 });
		const record = await (await context.request.get(`/api/chats/${s.teachId}`)).json();
		if (record.tree?.codeCells !== "rocq") throw new Error(`the plan is not marked as a Rocq topic (${JSON.stringify(record.tree?.codeCells)})`);
	});

	await step("R02", "the Rocq exercise opens; coq-lsp checks the starter: incomplete (Admitted)", page, w, async () => {
		const dock = await rocqDock(page);
		await dock.getByTestId("rocq-cell").waitFor();
		await waitStatus(dock, "admitted");
		await sleep(300);
		await snap(page, "cell-admitted");
	});

	await step("R03", "the statement is locked: typing into it changes nothing", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		const before = await editorText(dock);
		await dock.locator(".cm-line", { hasText: "Lemma" }).first().tap();
		await page.keyboard.type("xyz");
		await page.keyboard.press("Backspace");
		if ((await editorText(dock)) !== before) throw new Error("the locked statement changed");
	});

	await step("R04", "a wrong tactic: Rocq's error is marked and explained; the goal shows", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		await setProof(dock, EX1, "Proof.\n  reflexivity.\nQed.");
		await waitStatus(dock, "errors");
		await dock.getByTestId("rocq-messages").getByText(/Unable to unify/).waitFor();
		await cursorOn(page, dock, "reflexivity");
		await page.keyboard.press("Home");
		await dock.getByTestId("rocq-goals").getByText(/a \+ b = b \+ a/).waitFor({ timeout: 30_000 });
		await sleep(300);
		await snap(page, "cell-error-goal");
	});

	await step("R05", "abbreviations: \\sep, \\wand, \\later become ∗, -∗, ▷; the Tab key indents", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		await cursorOn(page, dock, "Qed.");
		await page.keyboard.press("Enter");
		await page.keyboard.type("(* \\sep \\wand \\later  ", { delay: 25 });
		const typed = await editorText(dock);
		if (!/\(\* ∗ -∗ ▷ {2}/.test(typed)) throw new Error(`abbreviations not expanded: ${typed.split("\n").pop()}`);
		await dock.getByTestId("rocq-tab-key").tap();
		await page.keyboard.type("*)", { delay: 25 });
		await snap(page, "cell-abbreviations");
	});

	await step("R06", "lia passes live; submit: the server's verdict card and the tutor's reply", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		await setProof(dock, EX1, "Proof.\n  lia.\nQed.");
		await waitStatus(dock, "passes");
		await dock.getByTestId("thinking-chip").tap();
		await dock.locator("textarea").last().fill("lia handles linear arithmetic.");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=rocq]").first();
		await card.getByText("passes", { exact: true }).waitFor({ timeout: 90_000 });
		await page.getByText("Rocq accepts your proof").first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "answered-passes");
	});

	await step("R07", "a second code cell in a row is refused: the tutor mixes in a quiz", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("what does `P ∗ Q` assert").or(dock.getByText(/what does .*P ∗ Q.* assert/)).first().waitFor();
		await snap(page, "two-in-a-row-quiz-instead");
		await answerOption(page, { option: "disjoint parts" });
	});

	await step("R08", "Iris: the goals panel shows the proof mode context after iIntros", page, w, async () => {
		const dock = await rocqDock(page);
		await dock.getByText("separating conjunction").first().waitFor();
		await waitStatus(dock, "admitted");
		await setProof(dock, EX2, 'Proof.\n  iIntros "[HP HQ]".\n  admit.\nAdmitted.');
		await waitStatus(dock, "admitted");
		await cursorOn(page, dock, "admit.");
		await page.keyboard.press("Home");
		const goals = dock.getByTestId("rocq-goals");
		await goals.getByText(/"HP" : P/).waitFor({ timeout: 30_000 });
		await goals.getByText(/Q ∗ P/).first().waitFor();
		await sleep(300);
		await snap(page, "iris-goals");
	});

	await step("R09", "Rocq goes offline: the cell says so and offers Reconnect", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		if (process.env.QA_NO_DOCKER === "1") return { note: "skipped: no docker here" };
		docker("stop", "-t", "1", ROCQ_CONTAINER);
		await waitStatus(dock, "offline", 30_000);
		await dock.getByText("Reconnect").waitFor();
		await snap(page, "cell-offline");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		await sleep(4000);
		const body = await page.locator("body").innerText();
		if (body.includes('{"error"')) throw new Error("the error banner shows raw JSON");
		if (!(await page.getByTestId("rocq-dock").isVisible())) throw new Error("the exercise left the dock although Rocq could not check it");
		docker("start", ROCQ_CONTAINER);
		await waitHealthy();
		await waitWarm();
		await dock.getByText("Reconnect").tap();
		await waitStatus(dock, "admitted", 60_000);
	});

	await step("R10", "submit a wrong Iris proof: the card shows Rocq's error and the reference proof", page, w, async () => {
		const dock = page.getByTestId("rocq-dock");
		await setProof(dock, EX2, IRIS_WRONG);
		await waitStatus(dock, "errors");
		await dock.getByRole("button", { name: "Submit proof" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=rocq]").nth(1);
		await card.getByText("does not pass").waitFor({ timeout: 120_000 });
		await card.getByText("Show the reference proof").tap();
		await card.scrollIntoViewIfNeeded();
		await sleep(400);
		await snap(page, "answered-fails-reference");
		await page.getByText("## Summary").or(page.getByText("A Rocq proof is a script")).first().waitFor({ timeout: 60_000 });
	});

	await step("R11", "practice: a Rocq problem for material from the Rocq session", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByRole("button", { name: /Session actions: Teach me Rocq and Iris/ }).tap();
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
		if (!picks.length) throw new Error("no proposition from the Rocq session reached the graph");
		const created = await (await context.request.post("/api/chats", { data: { title: "Practice Rocq proofs", kind: "practice", graphContext: { propositions: picks.slice(0, 3) } } })).json();
		s.practiceUrl = `/chat/${created.id}`;
		await page.goto(s.practiceUrl);
		await sendMessage(page, "Practice Rocq proofs");
		const dock = await practiceDock(page);
		await dock.getByTestId("rocq-cell").waitFor();
		await waitStatus(dock, "admitted");
		await snap(page, "practice-rocq-problem");
	});

	await step("R12", "practice: an unfinished proof is graded by Rocq in the submission card", page, w, async () => {
		const dock = await practiceDock(page);
		await dock.getByTestId("practice-send").tap();
		const card = page.locator("[data-testid=lean-submission-card][data-prover=Rocq]").first();
		await card.getByText("does not pass").waitFor({ timeout: 90_000 });
		await page.getByText("Rocq still reports a problem").first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "practice-submission-fails");
	});

	await step("R13", "practice: the right proof passes and the problem concludes", page, w, async () => {
		const dock = await practiceDock(page);
		await setProof(dock, PROBLEM, "Proof.\n  lia.\nQed.");
		await waitStatus(dock, "passes");
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 90_000 });
		await snap(page, "practice-concluded");
	});

	await step("R14", "practice: a second code problem in a row is refused; a plain problem follows", page, w, async () => {
		await page.getByTestId("next-problem-button").tap();
		const dock = await practiceDock(page);
		await dock.getByText("3 red and 2 blue").waitFor({ timeout: 60_000 });
		if (await dock.getByTestId("rocq-cell").count()) throw new Error("the plain problem shows a Rocq cell");
	});

	await context.close();
	return s;
}

async function desktop(browser, base, s) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	await step("D1", "desktop: the Rocq teaching session's cards", page, w, async () => {
		await page.goto(s.teachUrl);
		const card = page.locator("[data-testid=answered-card][data-kind=rocq]").nth(1);
		await card.waitFor({ timeout: 30_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "desktop-teach-cards");
	});
	await step("D2", "desktop: a live Rocq cell with the symbol bar (practice)", page, w, async () => {
		await page.goto(s.practiceUrl);
		const plain = await practiceDock(page);
		await plain.locator("textarea").fill("After a red, 2 of 4 are red: 1/2.");
		await plain.getByTestId("practice-send").click();
		await page.getByTestId("next-problem-button").waitFor({ timeout: 60_000 });
		await page.getByTestId("next-problem-button").click();
		const dock = await practiceDock(page);
		await dock.getByTestId("rocq-cell").waitFor({ timeout: 60_000 });
		await waitStatus(dock, "admitted");
		await dock.getByRole("toolbar", { name: "Rocq symbols" }).waitFor();
		await snap(page, "desktop-practice-cell");
	});
	await context.close();
}

/** A freshly started Rocq service loads Iris once (/health `warming`); wait
 *  for that so step timeouts measure the cell. */
async function waitWarm() {
	const started = Date.now();
	for (;;) {
		const health = await fetch(`${ROCQ_URL}/health`).then((r) => r.json()).catch(() => null);
		if (health && health.warming === false) return console.log(`Rocq warm (${health.warmup?.state}) after ${Math.round((Date.now() - started) / 1000)} s`);
		if (Date.now() - started > 300_000) throw new Error(`Rocq still warming after 5 minutes: ${JSON.stringify(health)}`);
		await sleep(1000);
	}
}

async function main() {
	await waitHealthy();
	await waitWarm();
	const server = await startServer();
	console.log(`server: ${server.url}\nRocq: ${ROCQ_URL}\nscreenshots: ${OUT}\n`);
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
