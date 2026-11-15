/**
 * Rocq code cells, the pure half (owner, 2026-11-12, like Lean's): the
 * exercise checks, the cell document, and the verdict read from real
 * `rocq compile` output (tests/fixtures/rocq, captured from the deploy/rocq
 * service with Rocq 9 + Iris; .github/workflows/rocq.yml runs it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	axiomFromCell,
	gradeRocqCheck,
	parseAssumptions,
	parseRocqMessages,
	resolveRocqExercise,
	rocqCellDocument,
	rocqCellLayout,
	rocqCheckSource,
	rocqExerciseProblems,
	rocqVerdictSummary,
	statementLemmaName,
	type RocqCheckResult,
	type RocqExercise,
	type RocqVerdict,
} from "../src/core/rocq-cell.ts";
import { expandAbbreviationBefore } from "../src/core/lean-abbreviations.ts";
import { ROCQ_ABBREVIATIONS } from "../src/core/rocq-abbreviations.ts";

function fixture(name: string): { exercise: RocqExercise; proof: string; result: RocqCheckResult } {
	return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "rocq", `${name}.json`), "utf8"));
}

function grade(name: string): RocqVerdict {
	const f = fixture(name);
	return gradeRocqCheck(resolveRocqExercise(f.exercise), f.proof, f.result);
}

test("exercise checks", () => {
	const ok = { question: "q", statement: "Lemma t (a : nat) : a = a.", referenceProof: "Proof. reflexivity. Qed." };
	assert.deepEqual(rocqExerciseProblems(ok), []);
	assert.equal(statementLemmaName("Theorem foo' : True."), "foo'");
	assert.ok(rocqExerciseProblems({ ...ok, statement: "Goal True." }).some((p) => /Lemma <name>/.test(p)));
	assert.ok(rocqExerciseProblems({ ...ok, statement: "Lemma t : True" }).some((p) => /period/.test(p)));
	assert.ok(rocqExerciseProblems({ ...ok, statement: "Lemma t : True. Proof." }).some((p) => /must not contain Proof/.test(p)));
	assert.ok(rocqExerciseProblems({ ...ok, prelude: "Section s." }).some((p) => /Section or Module/.test(p)));
	assert.ok(rocqExerciseProblems({ ...ok, prelude: "Axiom x : False." }).some((p) => /axioms/.test(p)));
	assert.ok(rocqExerciseProblems({ ...ok, referenceProof: "Proof. admit. Admitted." }).some((p) => /admit/.test(p)));
	// A comment that mentions Proof is fine.
	assert.deepEqual(rocqExerciseProblems({ ...ok, statement: "Lemma t (* no Proof here *) : True." }), []);
});

test("the cell document and the check source keep the learner's lines", () => {
	const ex = resolveRocqExercise({ question: "q", statement: "Lemma t (a : nat) :\n  a = a." });
	assert.equal(ex.prelude, "From Stdlib Require Import Arith Lia.");
	assert.equal(ex.starter, "Proof.\nAdmitted.");
	const doc = rocqCellDocument(ex, "Proof.\n  reflexivity.\nQed.");
	assert.equal(doc, "From Stdlib Require Import Arith Lia.\n\nLemma t (a : nat) :\n  a = a.\nProof.\n  reflexivity.\nQed.\n");
	assert.deepEqual(rocqCellLayout(ex), { statementLine: 2, proofLine: 4 });
	const { source, reportLine } = rocqCheckSource(ex, "Proof.\n  reflexivity.\nQed.");
	assert.equal(source.split("\n")[reportLine - 1], "Print Assumptions t.");
});

test("a complete proof passes", () => {
	const v = grade("nat-pass");
	assert.equal(v.passed, true);
	assert.deepEqual(v.axioms, []);
	assert.equal(rocqVerdictSummary(v), "Rocq accepts the proof.");
});

test("Admitted and admit + Qed do not pass", () => {
	assert.equal(grade("nat-admitted").reason, "admitted");
	const admitQed = grade("nat-admit-qed");
	assert.equal(admitQed.reason, "errors");
	assert.match(admitQed.errors[0]!.message, /incomplete proof/);
	assert.equal(admitQed.errors[0]!.line, 3, "Qed is the proof's third line");
});

test("an error points at the proof line", () => {
	const v = grade("nat-error");
	assert.equal(v.reason, "errors");
	assert.equal(v.errors[0]!.line, 2);
	assert.match(v.errors[0]!.message, /Unable to unify "b \+ a" with "a \+ b"/);
});

test("an axiom declared in the cell fails; library axioms pass", () => {
	const cheat = grade("nat-axiom");
	assert.equal(cheat.reason, "axioms");
	assert.deepEqual(cheat.disallowedAxioms, ["cheat"]);
	const classic = grade("classic-pass");
	assert.equal(classic.passed, true);
	assert.deepEqual(classic.axioms, ["classic"]);
	assert.equal(axiomFromCell("classic", "Proof. apply classic. Qed."), false);
	assert.equal(axiomFromCell("cheat", "Proof.\nAxiom cheat : False.\nexact cheat. Qed."), true);
});

test("Iris: a proof mode proof passes; an error shows the Iris context", () => {
	assert.equal(grade("iris-pass").passed, true);
	const err = grade("iris-error");
	assert.equal(err.reason, "errors");
	assert.equal(err.errors[0]!.line, 3);
});

test("output parsing", () => {
	assert.deepEqual(parseAssumptions("Axioms:\nclassic : forall P : Prop, P \\/ ~ P\nfunext : forall A B,\n  A = B\n"), ["classic", "funext"]);
	assert.equal(parseAssumptions("nothing"), null);
	assert.deepEqual(parseRocqMessages('File "./Check.v", line 5, characters 2-13:\nError: boom\nsecond line\n\n'), [{ severity: "error", line: 5, message: "boom\nsecond line" }]);
});

test("Iris input abbreviations", () => {
	assert.deepEqual(expandAbbreviationBefore("P \\sep", ROCQ_ABBREVIATIONS), { from: 2, insert: "∗" });
	assert.deepEqual(expandAbbreviationBefore("\\wand", ROCQ_ABBREVIATIONS), { from: 0, insert: "-∗" });
	assert.equal(expandAbbreviationBefore("A /\\", ROCQ_ABBREVIATIONS), null, "ASCII conjunction stays");
});
