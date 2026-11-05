/**
 * TLA+ code cells, the pure half (owner, 2026-11-05): the exercise checks,
 * the cell document, the TLC model config, and the verdict read from real
 * SANY / TLC / PlusCal output (tests/fixtures/tla, captured from the
 * deploy/tla service; .github/workflows/tla.yml runs the service itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	checkTlaSolution,
	gradeTlaCheck,
	gradeTlaWitnesses,
	parseTlaState,
	resolveTlaExercise,
	tlaCellDocument,
	tlaCellLayout,
	tlaConfigText,
	tlaExerciseProblems,
	tlaSolutionProblems,
	tlaVerdictSummary,
	tlaWitnessRuns,
	translationLineMap,
	type TlaCheckResult,
	type TlaExercise,
	type TlaVerdict,
} from "../src/core/tla-cell.ts";

interface Fixture {
	exercise: TlaExercise;
	solution: string;
	kind: "main" | "witness" | "parse";
	result: TlaCheckResult;
}

function fixture(name: string): Fixture {
	return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "tla", `${name}.json`), "utf8")) as Fixture;
}

function grade(name: string): TlaVerdict {
	const f = fixture(name);
	return gradeTlaCheck(resolveTlaExercise(f.exercise), f.solution, f.result, f.kind === "parse");
}

const counter: TlaExercise = fixture("counter-pass").exercise;

test("a well-formed exercise has no problems; a broken one says what to fix", () => {
	assert.deepEqual(tlaExerciseProblems({ ...counter, referenceSolution: "Init == x = 0" }), []);
	const broken = tlaExerciseProblems({
		question: "",
		head: "MODULE X",
		tail: "Spec == TRUE",
		config: { init: "Init", invariants: [] },
		witnesses: [{ label: "", expression: "x = 1\nx = 2" }],
	});
	assert.ok(broken.some((p) => /question/.test(p)));
	assert.ok(broken.some((p) => /module header/.test(p)));
	assert.ok(broken.some((p) => /closing `====`/.test(p)));
	assert.ok(broken.some((p) => /specification` or both `init` and `next`/.test(p)));
	assert.ok(broken.some((p) => /at least one invariant/.test(p)));
	assert.ok(broken.some((p) => /label/.test(p)));
	assert.ok(broken.some((p) => /one-line state expression/.test(p)));
	assert.ok(tlaExerciseProblems({ ...counter, head: "---- MODULE Naturals ----" }).some((p) => /standard module/.test(p)));
	assert.ok(tlaExerciseProblems({ ...counter, mode: "pluscal" }).some((p) => /open the algorithm/.test(p)));
});

test("the cell document puts the solution between head and tail", () => {
	const ex = resolveTlaExercise(counter);
	const solution = "Init == x = 0\nNext == x' = x + 1";
	const doc = tlaCellDocument(ex, solution);
	assert.equal(doc, `${ex.head}\n\n${solution}\n\n${ex.tail}\n`);
	const lines = doc.split("\n");
	const layout = tlaCellLayout(ex, solution);
	assert.equal(lines[layout.solutionLine], "Init == x = 0");
	assert.equal(lines[layout.tailLine], ex.tail.split("\n")[0]);
	assert.equal(ex.moduleName, "Counter");
});

test("a solution that would cut the locked tail off is refused before any tool runs", async () => {
	assert.equal(tlaSolutionProblems("Init == TRUE\n====").length, 1);
	assert.equal(tlaSolutionProblems("---- MODULE Other ----").length, 1);
	let called = false;
	const v = await checkTlaSolution(
		async () => {
			called = true;
			return { ms: 0 };
		},
		resolveTlaExercise(counter),
		"Mutex == TRUE\n====",
	);
	assert.equal(called, false);
	assert.equal(v.reason, "solution");
});

test("the config the learner sees, and one witness run per witness", () => {
	const ex = resolveTlaExercise(counter);
	assert.equal(tlaConfigText(ex.config), "CONSTANTS\n  N = 3\nINIT Init\nNEXT Next\nINVARIANT TypeOK\nCHECK_DEADLOCK FALSE\n");
	const runs = tlaWitnessRuns(ex);
	assert.equal(runs.length, 2);
	assert.match(runs[0]!.cfg, /INVARIANT LH_Witness_1\nCHECK_DEADLOCK FALSE\n$/);
	assert.equal(runs[0]!.appendDefs, "LH_Witness_1 == ~(x = N)");
	assert.equal(tlaConfigText({ specification: "Spec", properties: ["Live"] }), "SPECIFICATION Spec\nPROPERTY Live\n");
});

test("TLC passes: no error, the whole state space explored", () => {
	const v = grade("counter-pass");
	assert.equal(v.passed, true);
	assert.equal(v.distinctStates, 4);
	assert.equal(tlaVerdictSummary(v), "TLC finds no error (4 distinct states).");
});

test("an invariant violation names the invariant and carries the counterexample", () => {
	const v = grade("counter-invariant");
	assert.equal(v.reason, "invariant");
	assert.equal(v.violated, "TypeOK");
	assert.deepEqual(
		v.trace!.map((s) => `${s.index}:${s.action}:${s.vars.map((x) => `${x.name}=${x.value}`).join(",")}`),
		["1:Initial predicate:x=0", "2:Next:x=1", "3:Next:x=2", "4:Next:x=3", "5:Next:x=4"],
	);
	assert.equal(tlaVerdictSummary(v), "Invariant TypeOK is violated.");
});

test("deadlock and temporal-property violations", () => {
	const dead = grade("counter-deadlock");
	assert.equal(dead.reason, "deadlock");
	assert.ok(dead.trace!.length > 0);
	const prop = grade("counter-property");
	assert.equal(prop.reason, "property");
	assert.ok(prop.trace!.some((s) => s.kind === "stuttering"));
});

test("SANY parse and semantic errors point at the learner's line", () => {
	const parse = grade("counter-parse");
	assert.equal(parse.reason, "parse");
	assert.equal(parse.errors[0]!.line, 7);
	assert.match(parse.errors[0]!.message, /Encountered/);
	const semantic = grade("counter-semantic");
	assert.deepEqual(semantic.errors, [{ line: 7, message: "Unknown operator: `y'." }]);
});

test("a TLC evaluation error is reported with its message", () => {
	const v = grade("counter-eval-error");
	assert.equal(v.reason, "tlc-error");
	assert.match(v.errors[0]!.message, /is in the integer interval 0\.\.3/);
});

test("witnesses: one reached, one never reached", () => {
	const f = fixture("counter-witnesses-one-unreachable");
	const ex = resolveTlaExercise(f.exercise);
	const base: TlaVerdict = { passed: true, reason: "passed", errors: [], ms: 10 };
	const v = gradeTlaWitnesses(ex, base, f.result);
	assert.equal(v.reason, "witness-unreachable");
	assert.deepEqual(v.unreachable, ["x reaches N"]);
	assert.equal(tlaVerdictSummary(v), "Not reachable: x reaches N.");
});

test("PlusCal: the race is found; translator and translation errors map to the learner's lines", () => {
	const race = grade("inc-race");
	assert.equal(race.reason, "invariant");
	assert.equal(race.violated, "Correct");
	assert.deepEqual(race.trace![0]!.vars.map((v) => v.name).sort(), ["pc", "tmp", "total"]);
	const translation = grade("inc-translation");
	assert.equal(translation.reason, "translation");
	assert.equal(translation.errors[0]!.line, 10);
	assert.match(translation.errors[0]!.message, /Expected ":=" but found ";"/);
	// An unknown name inside the translation points at the line that uses it.
	const semantic = grade("inc-semantic");
	assert.deepEqual(semantic.errors, [{ line: 11, message: "Unknown operator: `totl'." }]);
});

test("translationLineMap: lines after the translation shift back", () => {
	const doc = "a\nb\n\\* BEGIN TRANSLATION\n\\* END TRANSLATION\nc\n";
	const translated = "a\nb\n\\* BEGIN TRANSLATION\nX\nY\nZ\n\\* END TRANSLATION\nc\n";
	const map = translationLineMap(doc, translated);
	assert.deepEqual(map(2), { line: 2, inTranslation: false });
	assert.deepEqual(map(5), { line: 3, inTranslation: true });
	assert.deepEqual(map(8), { line: 5, inTranslation: false });
	// Without markers in the document, the translator inserted the block.
	const inserted = translationLineMap("a\nb\nc\n", "a\n\\* BEGIN TRANSLATION\nX\n\\* END TRANSLATION\nb\nc\n");
	assert.deepEqual(inserted(5), { line: 2, inTranslation: false });
});

test("printed states split into variables", () => {
	assert.deepEqual(parseTlaState("x = 1"), [{ name: "x", value: "1" }]);
	assert.deepEqual(parseTlaState('/\\ pc = <<"a", "b">>\n/\\ r = [a |-> 1,\n      b |-> 2]'), [
		{ name: "pc", value: '<<"a", "b">>' },
		{ name: "r", value: "[a |-> 1, b |-> 2]" },
	]);
});

test("checkTlaSolution runs the witnesses only after the main model passes", async () => {
	const pass = fixture("counter-pass");
	const witnesses = fixture("counter-witnesses-one-unreachable");
	const requests: string[][] = [];
	const verdict = await checkTlaSolution(
		async (req) => {
			requests.push(req.runs.map((r) => r.id));
			return req.runs[0]!.id === "main" ? pass.result : witnesses.result;
		},
		resolveTlaExercise(counter),
		pass.solution,
	);
	assert.deepEqual(requests, [["main"], ["witness-1", "witness-2"]]);
	assert.equal(verdict.reason, "witness-unreachable");
	const failing = fixture("counter-invariant");
	const calls: number[] = [];
	await checkTlaSolution(async () => (calls.push(1), failing.result), resolveTlaExercise(counter), failing.solution);
	assert.equal(calls.length, 1);
});
