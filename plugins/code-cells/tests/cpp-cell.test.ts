/**
 * C++ code cells, the pure half (owner, 2026-11-09): the exercise checks,
 * the cell document, the test program, and the verdict read from real g++
 * and test output (tests/fixtures/cpp, captured from the deploy/cpp
 * service; .github/workflows/cpp.yml runs the service itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	checkCppSolution,
	cppAnswerForModel,
	cppCellDocument,
	cppCellLayout,
	cppExerciseProblems,
	cppSolutionProblems,
	cppTestResult,
	cppTestSource,
	cppVerdictSummary,
	gradeCppCheck,
	resolveCppExercise,
	testIndices,
	type CppCheckResult,
	type CppExercise,
	type CppVerdict,
} from "../src/core/cpp-cell.ts";

interface Fixture {
	exercise: CppExercise;
	solution: string;
	mode: "syntax" | "all";
	nonce: string;
	result: CppCheckResult;
}

function fixture(name: string): Fixture {
	return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cpp", `${name}.json`), "utf8")) as Fixture;
}

function grade(name: string): CppVerdict {
	const f = fixture(name);
	return gradeCppCheck(resolveCppExercise(f.exercise), f.result, { scope: f.mode === "syntax" ? "none" : "all", nonce: f.nonce });
}

const exercise = fixture("sum-pass").exercise;

test("a well-formed exercise has no problems; a broken one says what to fix", () => {
	assert.deepEqual(cppExerciseProblems({ ...exercise, referenceSolution: "int sum(const std::vector<int>&) { return 0; }" }), []);
	const broken = cppExerciseProblems({
		question: "",
		head: "",
		tail: "int main() { return 0; }",
		tests: [
			{ name: "a", code: "CHECK(true);", hidden: true },
			{ name: "a", code: "" },
		],
	});
	assert.ok(broken.some((p) => /question/.test(p)));
	assert.ok(broken.some((p) => /#includes/.test(p)));
	assert.ok(broken.some((p) => /tail must not define main/.test(p)));
	assert.ok(broken.some((p) => /unique/.test(p)));
	assert.ok(broken.some((p) => /needs code/.test(p)));
	assert.ok(cppExerciseProblems({ ...exercise, tests: [{ name: "x", code: "CHECK(1);", hidden: true }] }).some((p) => /at least one test must be visible/.test(p)));
});

test("the cell document and the test program", () => {
	const ex = resolveCppExercise(exercise);
	const solution = "int sum(const std::vector<int>& v) { return 0; }";
	const doc = cppCellDocument(ex, solution);
	assert.equal(doc, `${ex.head}\n\n${solution}\n`);
	assert.deepEqual(cppCellLayout(ex, solution), { solutionLine: 4, tailLine: null });
	const withTail = resolveCppExercise({ ...exercise, tail: "// end" });
	assert.equal(cppCellDocument(withTail, "x"), `${ex.head}\n\nx\n\n// end\n`);
	const program = cppTestSource(ex, "secret");
	assert.match(program, /^#include "lh_test.hpp"\n#include "cell.cpp"\n/);
	assert.match(program, /static void lh_test_3\(\) \{\n#line 1 "test 3"\nCHECK_EQ\(sum\(\{-5, 5, -1\}\), -1\);\n\}/);
	assert.match(program, /@@LH_PASS secret/);
	assert.deepEqual(testIndices(ex, "visible"), [1, 2]);
	assert.deepEqual(testIndices(ex, "all"), [1, 2, 3]);
	assert.equal(cppSolutionProblems("int main() {}").length, 1);
});

test("every test passes", () => {
	const v = grade("sum-pass");
	assert.equal(v.passed, true);
	assert.equal(v.tests.length, 3);
	assert.equal(cppVerdictSummary(v), "All 3 tests pass.");
});

test("a solution fitted to the visible tests fails the hidden one", () => {
	const v = grade("sum-fitted");
	assert.equal(v.reason, "tests");
	const failed = v.tests.filter((t) => !t.passed);
	assert.equal(failed.length, 1);
	assert.equal(failed[0]!.name, "negatives");
	assert.equal(failed[0]!.hidden, true);
	assert.equal(failed[0]!.outcome, "check");
	assert.match(failed[0]!.message!, /got: {6}6\n {2}expected: -1/);
	assert.equal(cppVerdictSummary(v), "1 of 3 tests fail.");
});

test("AddressSanitizer: an out-of-bounds read points at the learner's line", () => {
	const v = grade("sum-out-of-bounds");
	const first = v.tests[0]!;
	assert.equal(first.outcome, "sanitizer");
	assert.match(first.message!, /AddressSanitizer: (heap|container)-buffer-overflow/);
	assert.equal(first.line, 7);
});

test("UBSan: signed overflow is reported at the learner's line", () => {
	const v = grade("sum-overflow");
	const failed = v.tests.find((t) => !t.passed)!;
	assert.equal(failed.outcome, "sanitizer");
	assert.match(failed.message!, /signed integer overflow/);
	assert.equal(failed.line, 8);
});

test("compile errors: in the cell (with lines) and in a test (with its name)", () => {
	const syntax = grade("sum-compile-error");
	assert.equal(syntax.reason, "compile");
	assert.ok(syntax.errors.every((e) => e.where === "cell" && e.line !== null));
	const wrong = grade("sum-wrong-name");
	assert.equal(wrong.reason, "compile");
	assert.match(wrong.errors[0]!.message, /^In test "three numbers", line 1: 'sum' was not declared in this scope/);
	assert.match(wrong.errors[2]!.message, /^In test "negatives" \(hidden\): /);
	assert.ok(wrong.warnings.some((w) => /unused parameter/.test(w.message)));
});

test("the live check reports warnings without failing", () => {
	const v = grade("sum-syntax-warning");
	assert.equal(v.passed, true);
	assert.equal(v.scope, "none");
	assert.deepEqual(
		v.warnings.map((w) => [w.line, w.message]),
		[
			[6, "unused variable 'unused'"],
			[5, "unused parameter 'v'"],
		],
	);
	assert.equal(cppVerdictSummary(v), "It compiles (2 warnings).");
});

test("a run passes only with the check's own nonce; timeouts and early exits fail", () => {
	const t = { name: "t", code: "CHECK(true);" };
	const run = (over: object) => ({ test: 1, exitCode: 0, signal: null, timedOut: false, ms: 1, stdout: "", stderr: "", ...over });
	assert.equal(cppTestResult(t, run({ stdout: "\n@@LH_PASS right\n" }), "right").passed, true);
	assert.equal(cppTestResult(t, run({ stdout: "\n@@LH_PASS forged\n" }), "right").outcome, "exit");
	assert.equal(cppTestResult(t, run({ timedOut: true, exitCode: null, signal: "SIGKILL" }), "right").outcome, "timeout");
	assert.equal(cppTestResult(t, run({ exitCode: null, signal: "SIGSEGV" }), "right").outcome, "crash");
	const printed = cppTestResult(t, run({ exitCode: 1, stdout: "hello\n@@LH_FAIL\nCHECK(x) is false\n@@LH_END\n" }), "right");
	assert.equal(printed.outcome, "check");
	assert.equal(printed.output, "hello");
});

test("checkCppSolution runs the scope's tests with a fresh nonce", async () => {
	const ex = resolveCppExercise(exercise);
	const pass = fixture("sum-pass");
	let request: { runs?: number[]; tests?: string } = {};
	const visible = await checkCppSolution(
		async (req) => {
			request = req;
			return { ...pass.result, runs: pass.result.runs!.map((r) => ({ ...r, stdout: r.stdout.replace("fixturenonce", "n1") })) };
		},
		ex,
		pass.solution,
		"visible",
		() => "n1",
	);
	assert.deepEqual(request.runs, [1, 2]);
	assert.match(request.tests!, /@@LH_PASS n1/);
	assert.equal(visible.passed, true);
	assert.equal(cppVerdictSummary(visible), "All 2 visible tests pass; hidden tests run on Submit.");
});

test("the model sees hidden failures in full and is asked to review a pass", () => {
	const fitted = grade("sum-fitted");
	const view = cppAnswerForModel("…", fitted, cppVerdictSummary(fitted), "exercise");
	assert.deepEqual((view.failedTests as { name: string; hidden?: boolean }[]).map((t) => [t.name, t.hidden]), [["negatives", true]]);
	assert.equal(view.review, undefined);
	const pass = grade("sum-pass");
	assert.match(String(cppAnswerForModel("…", pass, "", "exercise").review), /cpp_review/);
});
