#!/usr/bin/env node
/**
 * End-to-end checks for the Rocq service (run by .github/workflows/rocq.yml).
 *
 *   node smoke.mjs check http://rocq:3600
 *       /health, then /check: a passing proof, Admitted, an error, an Iris
 *       proof mode proof and a HeapLang Hoare triple. Needs no packages.
 *   node smoke.mjs lsp wss://localhost/rocq/lsp
 *       A coq-lsp round trip through Caddy: diagnostics, goals (Iris), an
 *       edit, a refused method. Env: LH_COOKIE, LH_ORIGIN. Needs `ws`
 *       (installed in ../bridge).
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
	if (!health.ok || !health.rocq || !health.iris || !health.coqLsp) fail(`health: ${JSON.stringify(health)}`);
	ok(`health: Rocq ${health.rocq}, Iris ${health.iris}, coq-lsp ${health.coqLsp}`);
	const run = async (name, source) => {
		const res = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
		if (res.status !== 200) fail(`${name}: HTTP ${res.status}`);
		const r = await res.json();
		console.log(`  ${name}: ${r.ms} ms, exit ${r.exitCode}: ${r.output.trim().split("\n")[0]}`);
		return r;
	};
	const pass = await run("pass", "From Stdlib Require Import Arith Lia.\n\nLemma s (a b : nat) : a + b = b + a.\nProof.\n  lia.\nQed.\n\nPrint Assumptions s.\n");
	if (pass.exitCode !== 0 || !/Closed under the global context/.test(pass.output)) fail("a correct proof did not pass");
	ok("a correct proof passes with no assumptions");
	const adm = await run("admitted", "Lemma s : False.\nProof.\nAdmitted.\n\nPrint Assumptions s.\n");
	if (!/Axioms:\ns : False/.test(adm.output)) fail("Admitted did not show in the assumptions");
	ok("Admitted shows as an assumption");
	const err = await run("error", "Lemma s (a : nat) : a = S a.\nProof.\n  reflexivity.\nQed.\n");
	if (err.exitCode === 0 || !/File "\.\/Check\.v", line 3, characters \d+-\d+:\nError/.test(err.output)) fail("the error was not reported with its line");
	ok("an error is reported with its line");
	const iris = await run(
		"iris",
		'From iris.proofmode Require Import proofmode.\nFrom iris.base_logic Require Import iprop.\n\nLemma s {Σ} (P Q : iProp Σ) : P ∗ Q ⊢ Q ∗ P.\nProof.\n  iIntros "[HP HQ]". iFrame.\nQed.\n\nPrint Assumptions s.\n',
	);
	if (iris.exitCode !== 0 || !/Closed under the global context/.test(iris.output)) fail("the Iris proof did not pass");
	ok("an Iris proof mode proof passes");
	const heap = await run(
		"heaplang",
		'From iris.heap_lang Require Import proofmode notation.\n\nLemma s `{!heapGS Σ} (l : loc) :\n  {{{ l ↦ #0 }}} #l <- #1 ;; ! #l {{{ RET #1; l ↦ #1 }}}.\nProof.\n  iIntros (Φ) "Hl HΦ". wp_store. wp_load. iApply "HΦ". done.\nQed.\n\nPrint Assumptions s.\n',
	);
	if (heap.exitCode !== 0) fail("the HeapLang proof did not pass");
	ok("a HeapLang Hoare triple passes");
}

async function lsp() {
	const require = createRequire(new URL("../bridge/package.json", import.meta.url));
	const WebSocket = require("ws");
	const ws = new WebSocket(target, { headers: { Cookie: `lh_remote=${process.env.LH_COOKIE ?? ""}`, Origin: process.env.LH_ORIGIN ?? "" } });
	let id = 1;
	const pending = new Map();
	const waiters = [];
	const request = (method, params) =>
		new Promise((resolve) => {
			const i = id++;
			pending.set(i, resolve);
			ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
		});
	const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	const waitFor = (pred, what, ms = 120_000) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
			waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
		});
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.id !== undefined && !m.method) {
			pending.get(m.id)?.(m);
			pending.delete(m.id);
			return;
		}
		if (m.id !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }));
		for (const w of [...waiters]) if (w.pred(m)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(m);
		}
	});
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
		ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
	}).catch((err) => fail(`connect: ${err.message}`));
	const uri = "file:///cell/Smoke.v";
	const text = 'From iris.proofmode Require Import proofmode.\nFrom iris.base_logic Require Import iprop.\n\nLemma s {Σ} (P Q : iProp Σ) : P ∗ Q ⊢ Q ∗ P.\nProof.\n  iIntros "[HP HQ]".\n  iFrame.\nQed.\n';
	// The cell's settings (components/rocq/rocq-lsp.ts): goals before the sentence at the cursor.
	await request("initialize", { processId: null, rootUri: null, capabilities: {}, initializationOptions: { eager_diagnostics: true, goal_after_tactic: false } });
	notify("initialized", {});
	const idle = () => waitFor((m) => m.method === "$/coq/serverStatus" && m.params?.status === "Idle", "the check to finish");
	notify("textDocument/didOpen", { textDocument: { uri, languageId: "coq", version: 1, text } });
	await idle().catch((err) => fail(err.message));
	ok("coq-lsp checked the Iris document");
	const goals = await request("proof/goals", { textDocument: { uri, version: 1 }, position: { line: 6, character: 2 }, pp_format: "Str" });
	const goal = goals.result?.goals?.goals?.[0]?.ty ?? "";
	if (!/"HP" : P[\s\S]*∗[\s\S]*Q ∗ P/.test(goal)) fail(`goals: ${JSON.stringify(goals).slice(0, 300)}`);
	ok("the goal shows the Iris context");
	const diag = waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params?.version === 2 && m.params.diagnostics.some((d) => d.severity === 1), "an error after the edit");
	notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: text.replace("iFrame.", "iExact \"HP\".") }] });
	await diag.catch((err) => fail(err.message));
	ok("an edit with a wrong tactic gets an error");
	const refused = await request("workspace/executeCommand", { command: "x" });
	if (!refused.error) fail("a method outside the allowlist was not refused");
	ok("methods outside the allowlist are refused");
	ws.close();
}

if (mode === "check") await check();
else if (mode === "lsp") await lsp();
else fail("usage: smoke.mjs check <url> | lsp <wss url>");
