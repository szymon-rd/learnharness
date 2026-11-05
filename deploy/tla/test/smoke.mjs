#!/usr/bin/env node
/**
 * End-to-end checks for the TLA+ service (run by .github/workflows/tla.yml).
 *
 *   node smoke.mjs http://tla:3400
 *       /health, then /check on: a passing model, an invariant violation
 *       with its trace, a deadlock, a parse error, a witness run, PlusCal
 *       (a race TLC finds, and a translator error). Needs no packages, so it
 *       runs inside the app container (the only one on the "tla" network).
 */
const target = process.argv.slice(2).find((a) => a !== "-");

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}
function ok(message) {
	console.log(`✓ ${message}`);
}

const counter = (next, extra = "") =>
	`---- MODULE Counter ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLE x\n\nInit == x = 0\nNext == ${next}\n\nTypeOK == x \\in 0..N\n${extra}====\n`;
const cfg = (more = "") => `CONSTANTS\n  N = 3\nINIT Init\nNEXT Next\nINVARIANT TypeOK\n${more}`;

async function run(name, body) {
	const res = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (res.status !== 200) fail(`${name}: HTTP ${res.status} ${await res.text()}`);
	const r = await res.json();
	console.log(`  ${name}: ${r.ms} ms, translation ${r.translation?.ok ?? "-"}, sany ${r.sany?.ok}, runs ${(r.runs ?? []).map((x) => `${x.id}:exit ${x.exitCode}${x.timedOut ? " (timed out)" : ""}`).join(", ") || "-"}`);
	return r;
}
const has = (r, id, code) => (r.runs ?? []).find((x) => x.id === id)?.output.includes(`@!@!@STARTMSG ${code}:`);

const health = await (await fetch(`${target}/health`)).json();
if (!health.ok || !health.tools) fail(`health: ${JSON.stringify(health)}`);
ok(`health: tla2tools ${health.tools}`);

const pass = await run("pass", { module: counter("x < N /\\ x' = x + 1"), runs: [{ id: "main", cfg: cfg("CHECK_DEADLOCK FALSE\n") }] });
if (!pass.sany?.ok || !has(pass, "main", 2193)) fail("a correct model did not pass");
ok("a correct model passes");

const inv = await run("invariant", { module: counter("x' = x + 1"), runs: [{ id: "main", cfg: cfg("CHECK_DEADLOCK FALSE\n") }] });
if (!has(inv, "main", 2110) || !has(inv, "main", 2217)) fail("an invariant violation was not reported with a trace");
ok("an invariant violation comes with its trace");

const dead = await run("deadlock", { module: counter("x < N /\\ x' = x + 1"), runs: [{ id: "main", cfg: cfg() }] });
if (!has(dead, "main", 2114)) fail("a deadlock was not reported");
ok("a deadlock is reported");

const parse = await run("parse error", { module: counter("x' = x +") });
if (parse.sany?.ok !== false || !/Parse Error/.test(parse.sany.output) || parse.runs) fail("a parse error was not reported");
ok("a parse error stops before TLC");

const witness = await run("witnesses", {
	module: counter("x < N /\\ x' = x + 1"),
	runs: [
		{ id: "witness-1", cfg: cfg("INVARIANT LH_Witness_1\nCHECK_DEADLOCK FALSE\n").replace("INVARIANT TypeOK\n", ""), appendDefs: "LH_Witness_1 == ~(x = N)" },
		{ id: "witness-2", cfg: cfg("INVARIANT LH_Witness_2\nCHECK_DEADLOCK FALSE\n").replace("INVARIANT TypeOK\n", ""), appendDefs: "LH_Witness_2 == ~(x = 7)" },
	],
});
if (!has(witness, "witness-1", 2110) || !has(witness, "witness-2", 2193)) fail("witness runs: a reachable state must violate, an unreachable one must pass");
ok("a reachable witness is found, an unreachable one is not");

const pluscal = (body) =>
	`---- MODULE Inc ----\nEXTENDS Naturals\nCONSTANT N\n(* --algorithm Inc\nvariables total = 0;\nprocess worker \\in 1..N\nvariables tmp = 0;\nbegin\n${body}\nend process;\nend algorithm; *)\n\nDone == \\A p \\in 1..N : pc[p] = "Done"\nCorrect == Done => total = N\n====\n`;
const pcCfg = "CONSTANTS\n  N = 2\nSPECIFICATION Spec\nINVARIANT Correct\n";
const race = await run("PlusCal race", { module: pluscal("  Read:\n    tmp := total;\n  Write:\n    total := tmp + 1;"), pluscal: true, runs: [{ id: "main", cfg: pcCfg }] });
if (!race.translation?.ok || !race.translation.module?.includes("\\* BEGIN TRANSLATION") || !has(race, "main", 2110)) fail("the PlusCal race was not found");
ok("PlusCal translates and TLC finds the race");

const bad = await run("PlusCal translator error", { module: pluscal("  Inc;\n    total := total + 1;"), pluscal: true });
if (bad.translation?.ok !== false || !/Unrecoverable error/.test(bad.translation.output)) fail("a PlusCal syntax error was not reported");
ok("a PlusCal syntax error is reported by the translator");

const big = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ module: 5 }) });
if (big.status !== 400) fail(`malformed request: HTTP ${big.status}`);
ok("malformed requests are refused");
