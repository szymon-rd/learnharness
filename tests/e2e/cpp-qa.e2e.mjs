#!/usr/bin/env node
/**
 * C++ code cells, end to end, with the REAL compiler (the deploy/cpp image)
 * and the scripted model (tests/e2e/scripted-model.mjs — its C++ scripts run
 * when code cells are on and the topic mentions C++). Drives the phone UI
 * (Pixel 7) through the states of a cell and saves a screenshot per state;
 * then a short desktop pass.
 *
 *   docker run -d --name qa-cpp -p 127.0.0.1:3501:3500 --tmpfs /tmp:exec learnharness-cpp
 *   npx next build
 *   LH_CPP_URL=http://127.0.0.1:3501 node tests/e2e/cpp-qa.e2e.mjs [--out dir]
 *
 * CPP_CONTAINER (default qa-cpp) is stopped and started again for the
 * "checker offline" state (QA_NO_DOCKER=1 skips it). Run by
 * .github/workflows/cpp.yml.
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
const OUT = path.resolve(option("--out", path.join(ROOT, "test-results", "cpp-qa")));
const CPP_URL = process.env.LH_CPP_URL;
const CPP_CONTAINER = process.env.CPP_CONTAINER ?? "qa-cpp";
const WAIT = 60_000;
fs.mkdirSync(OUT, { recursive: true });
if (!CPP_URL) {
	console.error("Set LH_CPP_URL to the C++ service (e.g. http://127.0.0.1:3501).");
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cpp-qa-"));
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

/** The C++ dock, expanded (a check can arrive as the collapsed bar). */
async function cppDock(page, timeout = 90_000) {
	const dock = page.getByTestId("cpp-dock");
	const bar = page.getByTestId("question-dock-bar").or(page.getByTestId("teach-check-reveal"));
	await dock.or(bar).first().waitFor({ state: "visible", timeout });
	if (!(await dock.isVisible().catch(() => false))) await bar.first().tap();
	await dock.waitFor({ state: "visible", timeout: 10_000 });
	return dock;
}

async function waitStatus(scope, status, timeout = WAIT) {
	await scope.locator(`[data-testid=cpp-status][data-status=${status}]`).waitFor({ state: "visible", timeout });
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
			// Without a tail the editable part runs to the end.
			const to = tailLines === 0 ? doc.length : doc.line(doc.lines - tailLines - 1).to;
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
	await scope.getByTestId("cpp-check-button").tap();
	await scope.getByTestId("cpp-check-button").getByText("Check", { exact: true }).waitFor({ timeout });
	return scope.getByTestId("cpp-check").getByTestId("cpp-verdict");
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
			if ((await fetch(`${CPP_URL}/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(500);
	}
	throw new Error("the C++ service did not come back");
}

async function closeSidebar(page) {
	const backdrop = page.getByTestId("sidebar-backdrop");
	if (await backdrop.isVisible().catch(() => false)) {
		const vp = page.viewportSize();
		await page.touchscreen.tap(vp.width - 10, vp.height / 2);
		await backdrop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
	}
}

const EX1 = { headLines: 3, tailLines: 0 };
const EX2 = { headLines: 3, tailLines: 0 };
const PROBLEM = { headLines: 3, tailLines: 0 };

// ─── the flow ───────────────────────────────────────────────────────────────

const STARTER = "int sum(const std::vector<int>& v) {\n  int s = 0;\n  for (std::size_t i = 0; i <= v.size(); i++) s += v[i];\n  return s;\n}";
const FITTED = "int sum(const std::vector<int>& v) {\n  return v.empty() ? 0 : 6;\n}";

async function phone(browser, base) {
	const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	const s = {};

	await step("C00", "settings: Code cells is Off by default and offers C++; switch to Mixed in", page, w, async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByTestId("settings-entry").tap();
		await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
		await page.getByTestId("settings-nav-agent").tap();
		const row = page.getByTestId("code-cells-row");
		await row.waitFor({ state: "visible" });
		await row.scrollIntoViewIfNeeded();
		await page.getByText(/C\+\+ exercises among the checks/).waitFor({ timeout: 10_000 });
		if ((await page.getByTestId("code-cells-off").getAttribute("aria-checked")) !== "true") throw new Error("Code cells is not Off by default");
		await page.getByTestId("code-cells-mixed").tap();
		await page.waitForFunction(() => document.querySelector("[data-testid=code-cells-mixed]")?.getAttribute("aria-checked") === "true");
		await sleep(600);
		await snap(page, "settings-code-cells-cpp");
		await page.getByTestId("settings-close").tap();
		await closeSidebar(page);
	});

	await step("C01", "teaching session on C++: probe, then the plan is marked as a C++ topic", page, w, async () => {
		await page.goto("/");
		const topic = page.locator("textarea").first();
		await topic.tap();
		await topic.fill("Teach me to write C++");
		await page.getByRole("button", { name: "Start session" }).tap();
		await page.waitForURL(/\/chat\/chat_/, { timeout: 20_000 });
		s.teachUrl = page.url();
		s.teachId = s.teachUrl.split("/").pop();
		await answerOption(page, { option: "1/3" });
		const dock = await questionDock(page);
		const other = dock.getByTestId("other-option").locator("input");
		await other.tap();
		await other.fill("Write correct C++ on my own");
		await dock.getByRole("button", { name: /submit/i }).tap();
		await answerOption(page, { dontKnow: true });
		await page.getByTestId("plan-chip").waitFor({ state: "visible", timeout: 60_000 });
		const record = await (await context.request.get(`/api/chats/${s.teachId}`)).json();
		if (record.tree?.codeCells !== "cpp") throw new Error(`the plan is not marked as a C++ topic (${JSON.stringify(record.tree?.codeCells)})`);
	});

	await step("C02", "the C++ exercise opens in the dock; the starter compiles (live check)", page, w, async () => {
		const dock = await cppDock(page);
		await dock.getByTestId("cpp-cell").waitFor();
		await waitStatus(dock, "compiles");
		await sleep(300);
		await snap(page, "cell-compiles");
	});

	await step("C03", "the head is locked: typing into it changes nothing", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		const before = await editorText(dock);
		await dock.locator(".cm-line", { hasText: "#include" }).first().tap();
		await page.keyboard.type("yz");
		await page.keyboard.press("Backspace");
		if ((await editorText(dock)) !== before) throw new Error("the locked head changed");
	});

	await step("C04", "typing an unfinished expression: the compiler's error is marked at its line", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await dock.locator(".cm-line", { hasText: "return s;" }).first().tap();
		await page.keyboard.press("End");
		await page.keyboard.press("Backspace");
		await page.keyboard.type(" +", { delay: 40 });
		await waitStatus(dock, "errors");
		await dock.getByTestId("cpp-messages").getByText(/line \d+: expected/).first().waitFor();
		await dock.locator(".cm-lint-marker-error").first().waitFor();
		await sleep(300);
		await snap(page, "cell-compile-error");
	});

	await step("C05", "Check on the starter: AddressSanitizer catches the off-by-one at the learner's line", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await setSolution(dock, EX1, STARTER);
		await waitStatus(dock, "compiles");
		const verdict = await runCheck(dock);
		await verdict.getByText("2 of 2 tests fail.").waitFor();
		await verdict.getByText(/line 7: AddressSanitizer: (heap|container)-buffer-overflow/).waitFor();
		await dock.getByTestId("cpp-check").scrollIntoViewIfNeeded();
		await sleep(300);
		await snap(page, "check-asan");
	});

	await step("C06", "warnings show without failing", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await setSolution(dock, EX1, "int sum(const std::vector<int>& v) {\n  int unused;\n  return 0;\n}");
		await waitStatus(dock, "compiles");
		await dock.getByTestId("cpp-warnings").getByText(/unused variable 'unused'/).waitFor();
		await dock.getByTestId("cpp-messages").scrollIntoViewIfNeeded();
		await snap(page, "cell-warnings");
	});

	await step("C07", "autocompletion offers std names; Esc closes it and nothing else", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await setSolution(dock, EX1, "int sum(const std::vector<int>& v) {\n  std::vector<int> w;\n  w.push\n  return 0;\n}");
		await dock.locator(".cm-line", { hasText: "w.push" }).first().tap();
		await page.keyboard.press("End");
		await page.keyboard.type("_", { delay: 40 });
		const popup = page.locator(".cm-tooltip-autocomplete");
		await popup.waitFor({ state: "visible", timeout: 10_000 });
		await popup.locator("li").filter({ hasText: "push_back" }).first().waitFor();
		await snap(page, "cell-autocomplete");
		await page.keyboard.press("Escape");
		await popup.waitFor({ state: "hidden", timeout: 5_000 });
		await sleep(300);
		if (await page.getByText("Dismiss this question?").isVisible().catch(() => false)) throw new Error("Esc in the editor opened the dismiss dialog");
	});

	await step("C08", "a fitted solution passes the visible tests on Check; the hidden test is listed by name", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await setSolution(dock, EX1, FITTED);
		await waitStatus(dock, "compiles");
		const verdict = await runCheck(dock);
		await verdict.getByText("All 2 visible tests pass; hidden tests run on Submit.").waitFor();
		await dock.getByTestId("cpp-tests-panel").locator("summary").tap();
		await dock.getByTestId("cpp-tests-panel").getByText(/Hidden \(run on Submit\): negatives/).waitFor();
		await dock.getByTestId("cpp-tests-panel").scrollIntoViewIfNeeded();
		await snap(page, "check-visible-pass-tests-panel");
	});

	await step("C09", "submit: the hidden test catches the fitted solution", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await dock.getByTestId("thinking-chip").tap();
		await dock.locator("textarea").last().fill("Returned the sums the tests expect.");
		await dock.getByRole("button", { name: "Submit" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=cpp]").first();
		await card.getByText("does not pass").waitFor({ timeout: 90_000 });
		await card.locator("[data-testid=cpp-tests] li[data-passed=false]").filter({ hasText: "negatives" }).waitFor();
		await page.getByText(/a hidden test failed: negatives/).first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "answered-hidden-fails");
	});

	await step("C10", "a second code cell in a row is refused: the tutor mixes in a quiz", page, w, async () => {
		const dock = await questionDock(page);
		await dock.getByText("which index is out of bounds").waitFor();
		await snap(page, "two-in-a-row-quiz-instead");
		await answerOption(page, { option: "v.size()" });
	});

	await step("C11", "the strings exercise: while editing, the task and the locked head fold", page, w, async () => {
		const dock = await cppDock(page);
		await dock.getByText("with your own loop").first().waitFor();
		await waitStatus(dock, "compiles");
		await dock.locator(".cm-line", { hasText: "return s;" }).first().tap();
		await dock.getByTestId("cpp-head-fold").waitFor({ timeout: 10_000 });
		await dock.getByTestId("task-fold").waitFor();
		await sleep(300);
		await snap(page, "cell-folded");
		await dock.getByTestId("cpp-head-fold").tap();
		await dock.locator(".cm-line", { hasText: "#include <string>" }).first().waitFor();
	});

	await step("C12", "the checker goes offline: the cell says so; Submit keeps the exercise", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		if (process.env.QA_NO_DOCKER === "1") return { note: "skipped: no docker here" };
		docker("stop", "-t", "1", CPP_CONTAINER);
		await setSolution(dock, EX2, "std::string reversed(const std::string& s) {\n  return s;\n}");
		await waitStatus(dock, "offline", 30_000);
		await dock.getByRole("button", { name: "Retry" }).waitFor();
		await snap(page, "cell-offline");
		await dock.getByRole("button", { name: "Submit" }).tap();
		await sleep(4000);
		const body = await page.locator("body").innerText();
		if (body.includes('{"error"')) throw new Error("the error banner shows raw JSON");
		if (!(await page.getByTestId("cpp-dock").isVisible())) throw new Error("the exercise left the dock although the code could not be checked");
		docker("start", CPP_CONTAINER);
		await waitHealthy();
		await dock.getByRole("button", { name: "Retry" }).tap();
		await waitStatus(dock, "compiles");
	});

	await step("C13", "the tests pass but the task said not to use std::reverse: the tutor overrules", page, w, async () => {
		const dock = page.getByTestId("cpp-dock");
		await setSolution(dock, EX2, "#include <algorithm>\nstd::string reversed(const std::string& s) {\n  std::string out = s;\n  std::reverse(out.begin(), out.end());\n  return out;\n}");
		await waitStatus(dock, "compiles");
		await dock.getByRole("button", { name: "Submit" }).tap();
		const card = page.locator("[data-testid=answered-card][data-kind=cpp]").nth(1);
		await card.locator("[data-testid=cpp-review][data-accepted=false]").waitFor({ timeout: 120_000 });
		await card.getByText("does not pass").waitFor();
		await card.getByText("All 3 tests pass.").waitFor();
		await card.getByText("Show the reference solution").tap();
		await page.getByText("## Summary").or(page.getByText("Passing the tests is not the same")).first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await sleep(300);
		await snap(page, "answered-overruled");
	});

	await step("C14", "practice: a C++ problem for material from the C++ session", page, w, async () => {
		await page.getByRole("button", { name: "Open sidebar" }).tap();
		await page.getByRole("button", { name: /Session actions: Teach me to write C\+\+/ }).tap();
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
		if (!picks.length) throw new Error("no proposition from the C++ session reached the graph");
		const created = await (await context.request.post("/api/chats", { data: { title: "Practice C++ code", kind: "practice", graphContext: { propositions: picks.slice(0, 3) } } })).json();
		s.practiceUrl = `/chat/${created.id}`;
		await page.goto(s.practiceUrl);
		await sendMessage(page, "Practice C++ code");
		const dock = await practiceDock(page);
		await dock.getByTestId("cpp-cell").waitFor();
		await waitStatus(dock, "compiles");
		await snap(page, "practice-cpp-problem");
	});

	await step("C15", "practice: the starter fails the hidden test in the submission card", page, w, async () => {
		const dock = await practiceDock(page);
		await dock.getByTestId("practice-send").tap();
		const card = page.getByTestId("cpp-submission-card").first();
		await card.getByText("does not pass").waitFor({ timeout: 90_000 });
		await card.locator("[data-testid=cpp-tests] li[data-passed=false]").filter({ hasText: "all negative" }).waitFor();
		await page.getByText("A test still fails").first().waitFor({ timeout: 60_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "practice-submission-fails");
	});

	await step("C16", "practice: the fixed code passes and the problem concludes", page, w, async () => {
		const dock = await practiceDock(page);
		await setSolution(dock, PROBLEM, "int largest(const std::vector<int>& v) {\n  int m = v[0];\n  for (int x : v) if (x > m) m = x;\n  return m;\n}");
		await waitStatus(dock, "compiles");
		await dock.getByTestId("practice-send").tap();
		await page.getByTestId("conclude-card").first().waitFor({ state: "visible", timeout: 90_000 });
		await snap(page, "practice-concluded");
	});

	await step("C17", "practice: a second code problem in a row is refused; a plain problem follows", page, w, async () => {
		await page.getByTestId("next-problem-button").tap();
		const dock = await practiceDock(page);
		await dock.getByText("3 red and 2 blue").waitFor({ timeout: 60_000 });
		if (await dock.getByTestId("cpp-cell").count()) throw new Error("the plain problem shows a C++ cell");
		await snap(page, "practice-plain-after-cpp");
	});

	await context.close();
	return s;
}

async function desktop(browser, base, s) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
	const page = await context.newPage();
	const w = watch(page);
	await step("D1", "desktop: the C++ teaching session's cards", page, w, async () => {
		await page.goto(s.teachUrl);
		const card = page.locator("[data-testid=answered-card][data-kind=cpp]").nth(1);
		await card.waitFor({ timeout: 30_000 });
		await card.scrollIntoViewIfNeeded();
		await snap(page, "desktop-teach-cards");
	});
	await step("D2", "desktop: a live C++ cell with a failing visible test (practice)", page, w, async () => {
		await page.goto(s.practiceUrl);
		const plain = await practiceDock(page);
		await plain.locator("textarea").fill("After a red, 2 of 4 are red: 1/2.");
		await plain.getByTestId("practice-send").click();
		await page.getByTestId("next-problem-button").waitFor({ timeout: 60_000 });
		await page.getByTestId("next-problem-button").click();
		const dock = await practiceDock(page);
		await dock.getByTestId("cpp-cell").waitFor({ timeout: 60_000 });
		await waitStatus(dock, "compiles");
		await dock.getByTestId("cpp-check-button").click();
		await dock.getByTestId("cpp-check").getByTestId("cpp-verdict").waitFor({ timeout: 90_000 });
		await snap(page, "desktop-practice-cell");
	});
	await context.close();
}

async function main() {
	await waitHealthy();
	const server = await startServer();
	console.log(`server: ${server.url}\nC++: ${CPP_URL}\nscreenshots: ${OUT}\n`);
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
