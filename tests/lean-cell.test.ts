import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cellCheckSource,
	cellDocument,
	cellLayout,
	gradeLeanCheck,
	leanExerciseProblems,
	parseAxiomsReport,
	resolveLeanExercise,
	statementTheoremName,
	verdictSummary,
	type LeanCheckResult,
	type LeanMessage,
} from "../src/core/lean-cell.ts";

const ex = resolveLeanExercise({
	question: "Prove that squares are non-negative.",
	statement: "theorem sq_nonneg' (x : ℝ) :\n    0 ≤ x ^ 2 := by",
});
const proof = "  positivity";
const { source, axiomsLine } = cellCheckSource(ex, proof);
const lines = source.split("\n");

const result = (messages: LeanMessage[], extra: Partial<LeanCheckResult> = {}): LeanCheckResult => ({
	exitCode: 0,
	timedOut: false,
	ms: 1200,
	messages,
	...extra,
});
const report = (text: string): LeanMessage => ({ severity: "information", pos: { line: axiomsLine, column: 0 }, data: text });

test("statementTheoremName reads theorem and lemma names with attributes and modifiers", () => {
	assert.equal(statementTheoremName("theorem foo (n : ℕ) : n = n := by"), "foo");
	assert.equal(statementTheoremName("@[simp] protected lemma Nat.bar : True := by"), "Nat.bar");
	assert.equal(statementTheoremName("theorem baz: True := by"), "baz");
	assert.equal(statementTheoremName("example : True := by"), null);
});

test("leanExerciseProblems catches malformed exercises", () => {
	assert.deepEqual(leanExerciseProblems({ question: "q", statement: "theorem t : True := by", referenceProof: "  trivial" }), []);
	const bad = leanExerciseProblems({ question: " ", statement: "example : True := by trivial", prelude: "import Mathlib\nnamespace X", referenceProof: "  sorry" });
	assert.equal(bad.length, 5, bad.join("\n"));
});

test("the cell document and the check source line up", () => {
	assert.equal(ex.prelude, "import Mathlib");
	assert.equal(ex.starter, "  sorry");
	assert.equal(ex.theoremName, "sq_nonneg'");
	const layout = cellLayout(ex);
	const doc = cellDocument(ex, proof).split("\n");
	assert.equal(doc[layout.statementLine], "theorem sq_nonneg' (x : ℝ) :");
	assert.equal(doc[layout.proofLine], "  positivity");
	assert.ok(source.startsWith(cellDocument(ex, proof)));
	assert.equal(lines[axiomsLine - 1], "#print axioms _root_.sq_nonneg'");
});

test("parseAxiomsReport handles both report shapes", () => {
	assert.deepEqual(parseAxiomsReport("'t' depends on axioms: [propext, Classical.choice, Quot.sound]"), ["propext", "Classical.choice", "Quot.sound"]);
	assert.deepEqual(parseAxiomsReport("'t' does not depend on any axioms"), []);
	assert.equal(parseAxiomsReport("something else"), null);
});

test("a clean proof with standard axioms passes", () => {
	const v = gradeLeanCheck(ex, proof, result([report("'sq_nonneg'' depends on axioms: [propext, Classical.choice, Quot.sound]")]));
	assert.equal(v.passed, true);
	assert.equal(v.reason, "passed");
	assert.equal(verdictSummary(v), "Lean accepts the proof.");
});

test("errors fail, with lines relative to the proof", () => {
	const proofLine1 = cellLayout(ex).proofLine + 1; // Lean's 1-based line of the proof's first line
	const v = gradeLeanCheck(ex, proof, result([{ severity: "error", pos: { line: proofLine1, column: 2 }, data: "linarith failed" }]));
	assert.equal(v.passed, false);
	assert.equal(v.reason, "errors");
	assert.deepEqual(v.errors, [{ line: 1, message: "linarith failed" }]);
});

test("sorry, extra axioms, a missing report and timeouts fail", () => {
	assert.equal(gradeLeanCheck(ex, proof, result([{ severity: "warning", pos: { line: 3, column: 8 }, data: "declaration uses 'sorry'" }, report("'x' depends on axioms: [sorryAx]")])).reason, "sorry");
	// Lean 4.35 quotes with backticks; the warning alone is enough.
	assert.equal(gradeLeanCheck(ex, proof, result([{ severity: "warning", pos: { line: 3, column: 8 }, data: "declaration uses `sorry`" }, report("'x' does not depend on any axioms")])).reason, "sorry");
	const native = gradeLeanCheck(ex, proof, result([report("'x' depends on axioms: [propext, Lean.ofReduceBool]")]));
	assert.equal(native.reason, "axioms");
	assert.deepEqual(native.disallowedAxioms, ["Lean.ofReduceBool"]);
	assert.match(verdictSummary(native), /native_decide/);
	assert.equal(gradeLeanCheck(ex, proof, result([])).reason, "no-report");
	// A report on another line (e.g. printed from inside the proof) does not count.
	assert.equal(gradeLeanCheck(ex, proof, result([{ ...report("'x' does not depend on any axioms"), pos: { line: 2, column: 0 } }])).reason, "no-report");
	assert.equal(gradeLeanCheck(ex, proof, result([], { timedOut: true })).reason, "timeout");
});
