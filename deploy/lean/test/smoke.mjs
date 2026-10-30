#!/usr/bin/env node
/**
 * End-to-end checks for the Lean service (run by .github/workflows/lean.yml).
 *
 *   node smoke.mjs check http://lean:3300
 *       /health, then /check on passing, failing and `sorry` proofs.
 *       Needs no packages (runs inside the app container too).
 *   node smoke.mjs lsp wss://localhost/lean/lsp
 *       A language-server round trip: diagnostics, goals, edits, refusals.
 *       Env: LH_COOKIE (pairing cookie value), LH_ORIGIN (Origin header).
 *       Needs `ws` (installed in ../bridge).
 */
import { createRequire } from "node:module";

const args = process.argv.slice(2).filter((a) => a !== "-");
const [mode, target] = args;

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}
function ok(message) {
	console.log(`✓ ${message}`);
}

async function check() {
	const health = await (await fetch(`${target}/health`)).json();
	if (!health.ok || !health.toolchain || !health.mathlib) fail(`health: ${JSON.stringify(health)}`);
	ok(`health: ${health.toolchain}, Mathlib ${health.mathlib}`);

	const run = async (name, source) => {
		const res = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
		if (res.status !== 200) fail(`${name}: HTTP ${res.status} ${await res.text()}`);
		const body = await res.json();
		console.log(`  ${name}: ${body.ms} ms, exit ${body.exitCode}, ${body.messages.map((m) => `[${m.severity} ${m.pos?.line}] ${m.data.split("\n")[0]}`).join(" | ")}`);
		return body;
	};
	const errors = (r) => r.messages.filter((m) => m.severity === "error");
	const axiomsLine = (r, name) => r.messages.find((m) => m.severity === "information" && m.data.includes(`'${name}'`) && m.data.includes("axioms"));

	const pass = await run(
		"pass",
		"import Mathlib\n\ntheorem lh_pass (x : ℝ) : 0 ≤ x ^ 2 := by\n  positivity\n\n#print axioms _root_.lh_pass\n",
	);
	if (pass.timedOut || errors(pass).length) fail("a correct Mathlib proof did not pass");
	if (pass.messages.some((m) => m.data.includes("sorry"))) fail("a correct proof reported sorry");
	const ax = axiomsLine(pass, "lh_pass");
	if (!ax || ax.data.includes("sorryAx")) fail("no axioms report for the correct proof");
	ok(`correct proof passes (${ax.data.trim()})`);

	const wrong = await run("fail", "import Mathlib\n\ntheorem lh_fail (x : ℝ) : x ≤ x ^ 2 := by\n  positivity\n\n#print axioms _root_.lh_fail\n");
	if (!errors(wrong).length) fail("a wrong proof reported no error");
	ok("wrong proof fails with an error");

	const holed = await run("sorry", "import Mathlib\n\ntheorem lh_sorry (n : ℕ) : n < n + 1 := by\n  sorry\n\n#print axioms _root_.lh_sorry\n");
	if (errors(holed).length) fail("sorry should be a warning, not an error");
	if (!holed.messages.some((m) => m.severity === "warning" && m.data.includes("sorry"))) fail("no sorry warning");
	if (!axiomsLine(holed, "lh_sorry")?.data.includes("sorryAx")) fail("sorryAx missing from the axioms report");
	ok("sorry is reported (warning + sorryAx)");

	const net = await run("network", '#eval do\n  let out ← IO.Process.output { cmd := "curl", args := #["-sS", "--max-time", "5", "https://github.com"] }\n  IO.println s!"exit {out.exitCode}"\n');
	const exit = net.messages.map((m) => m.data).join("\n").match(/exit (\d+)/);
	if (!exit || exit[1] === "0") fail(`Lean code reached the internet: ${JSON.stringify(net.messages)}`);
	ok(`no internet from Lean code (curl exit ${exit[1]})`);
}

async function lsp() {
	const require = createRequire(new URL("../bridge/package.json", import.meta.url));
	const WebSocket = require("ws");
	const headers = {};
	if (process.env.LH_COOKIE) headers.Cookie = `lh_remote=${process.env.LH_COOKIE}`;
	if (process.env.LH_ORIGIN) headers.Origin = process.env.LH_ORIGIN;

	// Refused without the pairing cookie (Caddy's forward_auth).
	if (process.env.LH_COOKIE) {
		const code = await new Promise((resolve) => {
			const bare = new WebSocket(target, { headers: { Origin: headers.Origin ?? "" } });
			bare.on("unexpected-response", (_req, res) => resolve(res.statusCode));
			bare.on("open", () => resolve("open"));
			bare.on("error", () => {});
		});
		if (code !== 401) fail(`an unpaired WebSocket got ${code}, expected 401`);
		ok("unpaired connection refused (401)");
	}

	const ws = new WebSocket(target, { headers });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
		ws.on("error", reject);
	}).catch((err) => fail(`connect: ${err.message}`));
	ok("connected");

	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	const diagnostics = new Map();
	let progressDone = false;
	ws.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		if (msg.id !== undefined && !msg.method) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		} else if (msg.id !== undefined && msg.method) {
			ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
		} else if (msg.method === "textDocument/publishDiagnostics") {
			diagnostics.set(msg.params.uri, msg.params);
		} else if (msg.method === "$/lean/fileProgress") {
			progressDone = msg.params.processing.length === 0;
		}
		for (const l of listeners) l();
	});
	let finished = false;
	ws.on("close", (code, reason) => {
		if (!finished) fail(`closed early: ${code} ${reason}`);
	});
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	const until = (what, predicate, ms) =>
		new Promise((resolve) => {
			if (predicate()) return resolve();
			const timer = setTimeout(() => fail(`timed out waiting for ${what}`), ms);
			const l = () => {
				if (predicate()) {
					clearTimeout(timer);
					listeners.delete(l);
					resolve();
				}
			};
			listeners.add(l);
		});

	const init = await request("initialize", { processId: null, rootUri: null, capabilities: {} });
	if (!init.result?.capabilities) fail(`initialize: ${JSON.stringify(init)}`);
	notify("initialized", {});
	ok(`initialized (${init.result.serverInfo?.name ?? "Lean"} ${init.result.serverInfo?.version ?? ""})`);

	const uri = "file:///cell/Smoke.lean";
	const text = (proof) => `import Mathlib\n\ntheorem lh_goal (a b : ℕ) (h : a ≤ b) : a < b + 1 := by\n  ${proof}\n`;
	const started = Date.now();
	notify("textDocument/didOpen", { textDocument: { uri, languageId: "lean4", version: 1, text: text("sorry") } });
	const sorryWarning = () => diagnostics.get(uri)?.diagnostics.some((d) => d.message.includes("sorry"));
	await until("the sorry warning", () => progressDone && sorryWarning(), 5 * 60_000);
	ok(`elaborated with Mathlib in ${Math.round((Date.now() - started) / 1000)} s; diagnostics use the cell URI`);

	const goal = await request("$/lean/plainGoal", { textDocument: { uri }, position: { line: 3, character: 2 } });
	const goals = goal.result?.goals ?? [];
	if (!goals.some((g) => g.includes("⊢ a < b + 1") && g.includes("h : a ≤ b"))) fail(`goal: ${JSON.stringify(goal)}`);
	ok(`goal at the cursor: ${goals[0].replace(/\n/g, " ⏎ ")}`);

	progressDone = false;
	notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: text("omega") }] });
	await until("a clean file after the edit", () => progressDone && diagnostics.get(uri)?.diagnostics.every((d) => d.severity !== 1 && !d.message.includes("sorry")), 2 * 60_000);
	ok("edit re-checked: the proof is complete");

	const outside = await request("textDocument/hover", { textDocument: { uri: "file:///etc/passwd" }, position: { line: 0, character: 0 } });
	if (outside.error?.code !== -32601) fail(`a document outside the cell folder was not refused: ${JSON.stringify(outside)}`);
	const command = await request("workspace/executeCommand", { command: "x", arguments: [] });
	if (command.error?.code !== -32601) fail(`an unlisted method was not refused: ${JSON.stringify(command)}`);
	ok("other documents and methods are refused");

	finished = true;
	ws.close();
}

if (mode === "check") await check();
else if (mode === "lsp") await lsp();
else fail("usage: smoke.mjs check <http base> | lsp <ws url>");
process.exit(0);
