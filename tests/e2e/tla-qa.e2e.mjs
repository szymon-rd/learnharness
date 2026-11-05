#!/usr/bin/env node
/**
 * TLA+ code cells, end to end, with the REAL TLA+ tools (the deploy/tla
 * image) and the scripted model (tests/e2e/scripted-model.mjs — its TLA+
 * scripts run when code cells are on and the topic mentions TLA+). Drives
 * the phone UI (Pixel 7) through the states of a cell and saves a
 * screenshot per state; then a short desktop pass.
 *
 *   docker run -d --name qa-tla -p 127.0.0.1:3401:3400 learnharness-tla
 *   npx next build
 *   LH_TLA_URL=http://127.0.0.1:3401 node tests/e2e/tla-qa.e2e.mjs [--out dir]
 *
 * TLA_CONTAINER (default qa-tla) is stopped and started again for the
 * "checker offline" state (QA_NO_DOCKER=1 skips it). Run by
 * .github/workflows/tla.yml.
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
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "tla-qa")));
const TLA_URL = process.env.LH_TLA_URL;
const TLA_CONTAINER = process.env.TLA_CONTAINER ?? "qa-tla";
const WAIT = 60_000;
fs.mkdirSync(OUT, { recursive: true });
if (!TLA_URL) {
	console.error("Set LH_TLA_URL to the TLA+ service (e.g. http://127.0.0.1:3401).");
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tla-qa-"));
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

/** The TLA+ dock, expanded (a check can arrive as the collapsed bar). */
async function tlaDock(page, timeout = 90_000) {
	const dock = page.getByTestId("tla-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (!(await dock.isVisible().catch(() => false))) await bar.first().tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

async function waitStatus(scope, status, timeout = WAIT) {
	await scope.locator(`[data-testid=tla-status][data-status=${status}]`).waitFor({ state: "visible", timeout });
}

/** Replace the editable part (between the head's `headLines` and the
 *  tail's `tailLines`) through the editor, as one edit. */
async function setSolution(scope, { headLines, tailLines }, text) {
	await scope.locator(".cm-content").evaluate(
		(el, { headLines, tailLines, text }) => {
			const view = el.cmTile?.root?.view ?? el.cmView?.view;
			if (!view) throw new Error("no editor view on .cm-content");
			const doc = view.state.doc;
			const from = doc.line(headLines + 2).from;
			const to = doc.line(doc.lines - tailLines - 1).to;
			view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.type" });
		},
		{ headLines, tailLines, text },
	);
}

/** The editor's document (not the screen: phones fold the head). */
async function editorText(scope) {
	return scope.locator(".cm-content").evaluate((el) => {
		const view = el.cmTile?.root?.view ?? el.cmView?.view;
		if (!view) throw new Error("no editor view on .cm-content");
		return view.state.doc.toString();
	});
}

async function runCheck(scope, timeout = 90_000) {
	await scope.getByTestId("tla-check-button").tap();
	await scope.getByTestId("tla-check-button").getByText("Check", { exact: true }).waitFor({ timeout });
	return scope.getByTestId("tla-check").getByTestId("tla-verdict");
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
			if ((await fetch(`${TLA_URL}/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(500);
	}
	throw new Error("the TLA+ service did not come back");
}

async function closeSidebar(page) {
	const backdrop = page.getByTestId("sidebar-backdrop");
	if (await backdrop.isVisible().catch(() => false)) {
		const vp = page.viewportSize();
		await page.touchscreen.tap(vp.width - 10, vp.height / 2);
		await backdrop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
	}
}

const EX1 = { headLines: 4, tailLines: 2 };
const EX2 = { headLines: 6, tailLines: 5 };
const PROBLEM = { headLines: 4, tailLines: 2 };

// ─── the flow ───────────────────────────────────────────────────────────────

async function phone(browser, base) {
	const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	const s = {};

	await step("T00", "settings: Code cells is Off by default and offers TLA+; switch to Mixed in", page, w, async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("settings-entry").tap();
		await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
		await page.getByTestId("settings-nav-agent").tap();
		const row = page.getByTestId("code-cells-row");
		await row.waitFor({ state: "visible" });
		await row.scrollIntoViewIfNeeded();
		await page.getByText(/TLA\+ exercises among the checks/).waitFor({ timeout: 10_000 });
		if ((await page.getByTestId("code-cells-off").getAttribute("aria-checked")) !== "true") throw new Error("Code cells is not Off by default");
		await page.getByTestId("code-cells-mixed").tap();
		await page.waitForFunction(() => document.querySelector("[data-testid=code-cells-mixed]")?.getAttribute("aria-checked") === "true");
		await sleep(600);
		await snap(page, "settings-code-cells-tla");
		await page.getByTestId("settings-close").tap();
		await closeSidebar(page);
	});

	await step("T01", "teaching session on TLA+: probe, then the plan is marked as a TLA+ topic", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("textarea").first();
		await topic.tap();
		await topic.fill("Teach me to write specs in TLA+");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.teachUrl = page.url();
		s.teachId = s.teachUrl.split("/").pop();
		await answerOption(page, { option: "1/3" });
		const dock = await questionDock(page);
		const other = dock.getByTestId("other-option").locator("input");
		await other.tap();
		await other.fill("Write and model check specs on my own");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await answerOption(page, { dontKnow: true });
		await page.getByTestId("plan-chip").waitFor({ state: "visible", timeout: 60_000 });
		const record = await (await context.request.get(`/api/chats/${s.teachId}`)).json();
		if (record.tree?.codeCells !== "tla") throw new Error(`the plan is not marked as a TLA+ topic (${JSON.stringify(record.tree?.codeCells)})`);
	});

	await step("T02", "the TLA+ exercise opens in the dock; the starter parses (live SANY)", page, w, async () => {
		const dock = await tlaDock(page);
		await dock.getByTestId("tla-cell").waitFor();
		await waitStatus(dock, "parses");
		await sleep(300);
		await snap(page, "cell-parses");
	});

	await step("T03", "the head is locked: typing into it changes nothing", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		const before = await editorText(dock);
		await dock.locator(".cm-line", { hasText: "VARIABLE x" }).first().tap();
		await page.keyboard.type("yz");
		await page.keyboard.press("Backspace");
		if ((await editorText(dock)) !== before) throw new Error("the locked head changed");
	});

	await step("T04", "typing an unfinished expression: SANY's error is marked and explained", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await dock.locator(".cm-line", { hasText: "Next ==" }).first().tap();
		await page.keyboard.press("End");
		await page.keyboard.type(" +", { delay: 40 });
		await waitStatus(dock, "errors");
		// SANY notices the unfinished `+` where the next definition starts.
		await dock.getByTestId("tla-messages").getByText(/Encountered "Beginning of definition"/).waitFor();
		await dock.locator(".cm-lint-marker-error").first().waitFor();
		await sleep(400);
		await snap(page, "cell-parse-error");
	});

	await step("T05", "Check on the starter: TLC shows the violated invariant and the counterexample", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX1, "Init == x = 0\nNext == x' = x + 1");
		await waitStatus(dock, "parses");
		const verdict = await runCheck(dock);
		await verdict.getByText("Invariant TypeOK is violated.").waitFor();
		await verdict.getByTestId("tla-trace").getByText("Initial predicate").waitFor();
		await dock.getByTestId("tla-trace").scrollIntoViewIfNeeded();
		await sleep(300);
		await snap(page, "check-invariant-trace");
	});

	await step("T06", "a spec that never moves passes the invariant but not the witness", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX1, "Init == x = 0\nNext == UNCHANGED x");
		await waitStatus(dock, "parses");
		const verdict = await runCheck(dock);
		await verdict.getByText(/Never reached: x reaches N/).waitFor();
		await dock.getByTestId("tla-check").scrollIntoViewIfNeeded();
		await snap(page, "check-witness-unreachable");
	});

	await step("T07", "autocompletion offers keywords and the module's names", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX1, "Init == x = 0\nNext == x < N /\\ x' = x + 1\nFoo == Typ");
		await dock.locator(".cm-line", { hasText: "Foo ==" }).first().tap();
		await page.keyboard.press("End");
		await page.keyboard.type("e", { delay: 40 });
		const popup = page.locator(".cm-tooltip-autocomplete");
		await popup.waitFor({ state: "visible", timeout: 10_000 });
		await popup.locator("li").filter({ hasText: "TypeOK" }).first().waitFor();
		await snap(page, "cell-autocomplete");
		// Esc closes the list and nothing else (not the "Dismiss this question?" dialog).
		await page.keyboard.press("Escape");
		await popup.waitFor({ state: "hidden", timeout: 5_000 });
		await sleep(300);
		if (await page.getByText("Dismiss this question?").isVisible().catch(() => false)) throw new Error("Esc in the editor opened the dismiss dialog");
	});

	await step("T08", "the fixed spec: Check passes; the TLC model is shown read-only", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX1, "Init == x = 0\nNext == x < N /\\ x' = x + 1");
		await waitStatus(dock, "parses");
		const verdict = await runCheck(dock);
		await verdict.getByText(/TLC finds no error/).waitFor();
		await dock.getByTestId("tla-config").locator("summary").tap();
		await dock.getByTestId("tla-config").getByText("INVARIANT TypeOK").waitFor();
		await dock.getByTestId("tla-config").scrollIntoViewIfNeeded();
		await snap(page, "check-passes-config");
	});

	await step("T09", "submit: TLC's verdict card, the tutor's review, then its reply", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await dock.getByTestId("thinking-chip").tap();
		await dock.locator("textarea").last().fill("Bounded Next by N so TypeOK holds.");
		await dock.getByRole("button", { name: "Submit" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=tla]").first();
		await card.getByText("passes", { exact: true }).waitFor({ timeout: 90_000 });
		await card.locator("[data-testid=tla-review][data-accepted=true]").waitFor({ timeout: 60_000 });
		await page.getByText("TLC finds no error, and it does what was asked").first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "answered-passes-reviewed");
	});

	await step("T10", "a second code cell in a row is refused: the tutor mixes in a quiz", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("What does TLC report").waitFor();
		await snap(page, "two-in-a-row-quiz-instead");
		await answerOption(page, { option: "A behavior that reaches" });
	});

	await step("T11", "PlusCal exercise: while editing, the task and the locked head fold to one line", page, w, async () => {
		const dock = await tlaDock(page);
		await dock.getByText("critical section").first().waitFor();
		await waitStatus(dock, "parses");
		await dock.locator(".cm-line", { hasText: "skip;" }).first().tap();
		await dock.getByTestId("tla-head-fold").waitFor({ timeout: 10_000 });
		await dock.getByTestId("task-fold").waitFor();
		await sleep(300);
		await snap(page, "pluscal-folded");
		await dock.getByTestId("tla-head-fold").tap();
		await dock.locator(".cm-line", { hasText: "algorithm QaMutex" }).first().waitFor();
	});

	await step("T12", "a PlusCal syntax error comes from the translator, at the learner's line", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX2, "  start;\n    skip;");
		await waitStatus(dock, "errors");
		await dock.getByTestId("tla-messages").getByText(/Expected ":=" but found ";"/).waitFor();
		await snap(page, "pluscal-translator-error");
	});

	await step("T13", "the checker goes offline: the cell says so; Submit keeps the exercise", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		if (process.env.QA_NO_DOCKER === "1") return { note: "skipped: no docker here" };
		docker("stop", "-t", "1", TLA_CONTAINER);
		await setSolution(dock, EX2, "  start:\n    skip;");
		await waitStatus(dock, "offline", 30_000);
		await dock.getByRole("button", { name: "Retry" }).waitFor();
		await snap(page, "cell-offline");
		await dock.getByRole("button", { name: "Submit" }).tap();
		await sleep(4000);
		const body = await page.locator("body").innerText();
		if (body.includes('{"error"')) throw new Error("the error banner shows raw JSON");
		if (!(await page.getByTestId("tla-dock").isVisible())) throw new Error("the exercise left the dock although TLC could not check it");
		await snap(page, "submit-while-offline");
		docker("start", TLA_CONTAINER);
		await waitHealthy();
		await dock.getByRole("button", { name: "Retry" }).tap();
		await waitStatus(dock, "parses");
	});

	await step("T14", "a solution that passes TLC but does nothing: the tutor overrules the pass", page, w, async () => {
		const dock = page.getByTestId("tla-dock");
		await setSolution(dock, EX2, "  start:\n    skip;");
		await waitStatus(dock, "parses");
		await dock.getByRole("button", { name: "Submit" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=tla]").nth(1);
		await card.locator("[data-testid=tla-review][data-accepted=false]").waitFor({ timeout: 120_000 });
		await card.getByText("does not pass").waitFor();
		await card.getByText("TLC finds no error").waitFor();
		await card.getByText("Show the reference solution").tap();
		await page.getByText("## Summary").or(page.getByText("Passing the checks is not the same")).first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await sleep(300);
		await snap(page, "answered-overruled");
	});

	await step("T15", "practice: a TLA+ problem for material from the TLA+ session", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByRole("button", { name: /Session actions: Teach me to write specs in TLA\+/ }).tap();
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
		if (!picks.length) throw new Error("no proposition from the TLA+ session reached the graph");
		const created = await (await context.request.post("/api/chats", { data: { title: "Practice TLA+ specs", kind: "practice", graphContext: { propositions: picks.slice(0, 3) } } })).json();
		s.practiceUrl = `/chat/${created.id}`;
		await page.goto(s.practiceUrl);
		await sendMessage(page, "Practice TLA+ specs");
		const dock = page.getByTestId("practice-dock");
		await dock.waitFor({ state: "visible", timeout: 60_000 });
		await dock.getByTestId("tla-cell").waitFor();
		await waitStatus(dock, "parses");
		await snap(page, "practice-tla-problem");
	});

	await step("T16", "practice: the starter is graded by TLC in the submission card (counterexample)", page, w, async () => {
		const dock = await practiceDock(page);
		await dock.getByTestId("practice-send").tap();
		const card = page.getByTestId("tla-submission-card").first();
		await card.getByText("does not pass").waitFor({ timeout: 90_000 });
		await card.getByTestId("tla-trace").waitFor();
		await page.getByText("TLC still finds a problem").first().waitFor({ timeout: 60_000 });
		if (!(await editorText(dock)).includes("x' = x - 1")) throw new Error("the solution was reset after submitting");
		await card.scrollIntoViewIfNeeded();
		await snap(page, "practice-submission-fails");
	});

	await step("T17", "practice: the fixed spec passes and the problem concludes", page, w, async () => {
		const dock = await practiceDock(page);
		await setSolution(dock, PROBLEM, "Init == x = N\nNext == x' = x - 1 \\* edited");
		// Folding the dock away (scrolling the transcript up) and back keeps the learner's text.
		await page.getByTestId("tla-submission-card").first().scrollIntoViewIfNeeded();
		await page.mouse.wheel(0, -800);
		await sleep(600);
		const folded = await page.getByTestId("practice-dock-bar").isVisible().catch(() => false);
		await practiceDock(page);
		if (!(await editorText(dock)).includes("\\* edited")) throw new Error("the edited solution was lost when the dock folded");
		await setSolution(dock, PROBLEM, "Init == x = N\nNext == x > 0 /\\ x' = x - 1");
		await waitStatus(dock, "parses");
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 90_000 });
		await snap(page, "practice-concluded");
		return { note: folded ? "the dock folded and kept the text" : "the dock did not fold on scroll here" };
	});

	await step("T18", "practice: a second code problem in a row is refused; a plain problem follows", page, w, async () => {
		await page.getByTestId("next-problem-button").tap();
		const dock = await practiceDock(page);
		await dock.getByText("3 red and 2 blue").waitFor({ timeout: 60_000 });
		if (await dock.getByTestId("tla-cell").count()) throw new Error("the plain problem shows a TLA+ cell");
		await snap(page, "practice-plain-after-tla");
	});

	await context.close();
	return s;
}

async function desktop(browser, base, s) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	await step("D1", "desktop: the TLA+ teaching session's cards", page, w, async () => {
		await page.goto(s.teachUrl);
		const card = page.locator("[data-testid=answered-card][data-kind=tla]").nth(1);
		await card.waitFor({ timeout: 30_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "desktop-teach-cards");
	});
	await step("D2", "desktop: a live TLA+ cell with a counterexample (practice)", page, w, async () => {
		await page.goto(s.practiceUrl);
		const plain = await practiceDock(page);
		await plain.locator("textarea").fill("After a red, 2 of 4 are red: 1/2.");
		await plain.getByTestId("practice-send").click();
		await page.getByTestId("next-problem-button").waitFor({ timeout: 60_000 });
		await page.getByTestId("next-problem-button").click();
		const dock = await practiceDock(page);
		await dock.getByTestId("tla-cell").waitFor({ timeout: 60_000 });
		await waitStatus(dock, "parses");
		await dock.getByTestId("tla-check-button").click();
		await dock.getByTestId("tla-trace").waitFor({ timeout: 90_000 });
		await snap(page, "desktop-practice-cell");
	});
	await context.close();
}

async function main() {
	await waitHealthy();
	const server = await startServer();
	console.log(`server: ${server.url}\nTLA+: ${TLA_URL}\nscreenshots: ${OUT}\n`);
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
