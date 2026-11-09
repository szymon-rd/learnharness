/**
 * C++ code cells — the pure half (no I/O): the exercise contract, the cell
 * document, the test program, and the verdict read from the compiler's and
 * the tests' output.
 *
 * A cell is one C++ source file (cell.cpp) in up to three regions:
 *
 *   head      locked   (#includes, given types/helpers, comments)
 *   solution  the learner's (starts as the starter)
 *   tail      locked   (optional: more given code)
 *
 * The tutor's tests are C++ statement blocks using CHECK(cond),
 * CHECK_EQ(actual, expected) and CHECK_NEAR(actual, expected, eps)
 * (deploy/cpp/bridge/lh_test.hpp). Visible tests are shown read-only under
 * the cell and run on Check; hidden tests run only on Submit, so a solution
 * fitted to the shown cases fails. Each test runs in its own process, built
 * with AddressSanitizer and UBSan, with a time limit.
 *
 * A solution passes when it compiles and every test passes (no failed
 * check, no sanitizer report, no crash, within the time limit). The tutor
 * then judges whether it does what was asked (cpp_review) and may overrule
 * a pass. Warnings are shown, never failing.
 *
 * Line numbers are the cell document's (1-based), which the editor shows.
 */

export const CPP_EXERCISE_TOOL = "cpp_exercise";
export const CPP_REVIEW_TOOL = "cpp_review";
export const MAX_CPP_TESTS = 20;
export const MAX_CPP_SOLUTION_CHARS = 50_000;

export interface CppTest {
	/** Shown to the learner (and in failures), e.g. "empty vector". */
	name: string;
	/** C++ statements using CHECK / CHECK_EQ / CHECK_NEAR. */
	code: string;
	/** Hidden tests run only on Submit; the learner sees their name. */
	hidden?: boolean;
}

export interface CppExercise {
	question: string;
	head: string;
	starter?: string;
	tail?: string;
	tests: CppTest[];
}

export interface ResolvedCppExercise {
	question: string;
	head: string;
	starter: string;
	tail: string;
	tests: CppTest[];
}

const MAIN = /\bint\s+main\s*\(/;

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, "\n");
}

function trimBlankEdges(s: string): string {
	return normalizeNewlines(s).replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** Authoring problems with an exercise (returned to the tutor, who fixes and
 *  retries). Empty = well-formed. */
export function cppExerciseProblems(ex: CppExercise & { referenceSolution?: string }): string[] {
	const problems: string[] = [];
	if (!ex.question?.trim()) problems.push("question must describe the task.");
	if (!trimBlankEdges(ex.head ?? "")) problems.push("head must hold at least the #includes the solution needs (it is locked).");
	for (const [field, text] of [["head", ex.head], ["tail", ex.tail], ["starter", ex.starter]] as const) {
		if (text && MAIN.test(text)) problems.push(`${field} must not define main(): the tests provide it.`);
		if (text && /@@LH_/.test(text)) problems.push(`${field} must not contain @@LH_ (the test markers).`);
	}
	const tests = Array.isArray(ex.tests) ? ex.tests : [];
	if (tests.length === 0) problems.push("tests must hold at least one test.");
	if (tests.length > MAX_CPP_TESTS) problems.push(`at most ${MAX_CPP_TESTS} tests.`);
	if (tests.length && tests.every((t) => t?.hidden === true)) problems.push("at least one test must be visible (Check runs the visible tests).");
	const names = new Set<string>();
	for (const t of tests) {
		if (!t?.name?.trim()) problems.push("every test needs a name.");
		else if (names.has(t.name.trim())) problems.push(`test names must be unique ("${t.name}").`);
		else names.add(t.name.trim());
		if (!t?.code?.trim()) problems.push(`test "${t?.name ?? ""}" needs code (CHECK / CHECK_EQ / CHECK_NEAR statements).`);
		else if (/@@LH_/.test(t.code)) problems.push(`test "${t.name}" must not contain @@LH_.`);
	}
	if (ex.referenceSolution !== undefined && !ex.referenceSolution.trim()) problems.push("referenceSolution must be the complete solution.");
	return problems;
}

export function resolveCppExercise(ex: CppExercise): ResolvedCppExercise {
	return {
		question: ex.question,
		head: trimBlankEdges(ex.head),
		starter: normalizeNewlines(ex.starter ?? "").replace(/\s+$/, ""),
		tail: trimBlankEdges(ex.tail ?? ""),
		tests: ex.tests.map((t) => ({ name: t.name.trim(), code: normalizeNewlines(t.code).replace(/\s+$/, ""), ...(t.hidden ? { hidden: true } : {}) })),
	};
}

function solutionText(solution: string): string {
	return normalizeNewlines(solution).replace(/\s+$/, "");
}

/** The text the editor shows and the compiler checks: head, blank line,
 *  solution, and (when there is one) blank line, tail. */
export function cppCellDocument(ex: ResolvedCppExercise, solution: string): string {
	return `${ex.head}\n\n${solutionText(solution)}\n${ex.tail ? `\n${ex.tail}\n` : ""}`;
}

/** Where the regions sit in the cell document (0-based lines). */
export function cppCellLayout(ex: ResolvedCppExercise, solution: string): { solutionLine: number; tailLine: number | null } {
	const solutionLine = ex.head.split("\n").length + 1;
	return { solutionLine, tailLine: ex.tail ? solutionLine + solutionText(solution).split("\n").length + 1 : null };
}

/** Problems that end the check before compiling. */
export function cppSolutionProblems(solution: string): string[] {
	if (solution.length > MAX_CPP_SOLUTION_CHARS) return ["The solution is too long."];
	if (MAIN.test(solution)) return ["The solution must not define main(): the tests provide it."];
	return [];
}

/** The test program: the harness, the cell, one function per test (each
 *  labelled so diagnostics name the test), and a main that runs the test
 *  given on the command line and prints the pass marker with `nonce` (a
 *  per-check secret, so the learner's code cannot print a pass). */
export function cppTestSource(ex: ResolvedCppExercise, nonce: string): string {
	const fns = ex.tests.map((t, i) => `static void lh_test_${i + 1}() {\n#line 1 "test ${i + 1}"\n${t.code}\n}\n`).join("");
	const cases = ex.tests.map((_, i) => `    case ${i + 1}: lh_test_${i + 1}(); break;\n`).join("");
	return (
		`#include "lh_test.hpp"\n#include "cell.cpp"\n${fns}#line 1 "harness"\n` +
		`int main(int argc, char** argv) {\n  int n = argc > 1 ? std::atoi(argv[1]) : 0;\n  switch (n) {\n${cases}    default: return 2;\n  }\n` +
		`  std::cout << "\\n@@LH_PASS ${nonce}" << std::endl;\n  return 0;\n}\n`
	);
}

// ─── reading the tools' output ──────────────────────────────────────────

/** One GCC JSON diagnostic (the parts read here). */
export interface GccDiagnostic {
	kind: string;
	message: string;
	locations?: { caret?: { file?: string; line?: number; column?: number } }[];
	children?: GccDiagnostic[];
}

export interface CppRunResult {
	test: number;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	ms: number;
	stdout: string;
	stderr: string;
}

/** What the service returns for one request. */
export interface CppCheckResult {
	ms: number;
	error?: string;
	compile?: { ok: boolean; timedOut?: boolean; diagnostics: GccDiagnostic[]; other?: string };
	runs?: CppRunResult[];
}

/** The service request: the cell, and the test program with the tests to
 *  run (no tests = a syntax check). */
export interface CppCheckRequest {
	cell: string;
	tests?: string;
	runs?: number[];
}

export interface CppDiagnostic {
	/** Cell line (1-based), when the diagnostic is in the cell. */
	line: number | null;
	message: string;
	/** Where it is: the cell, a test (its name), or elsewhere (a header). */
	where: "cell" | "test" | "other";
	test?: string;
}

export type CppTestOutcome = "passed" | "check" | "sanitizer" | "crash" | "timeout" | "exit";

export interface CppTestResult {
	name: string;
	hidden: boolean;
	passed: boolean;
	outcome: CppTestOutcome;
	/** The failed check, sanitizer report, … (one short paragraph). */
	message?: string;
	/** The cell line the failure points at, when known. */
	line?: number;
	/** What the learner's code printed (capped). */
	output?: string;
	ms: number;
}

export type CppVerdictReason = "passed" | "solution" | "compile" | "tests" | "timeout";

export interface CppVerdict {
	passed: boolean;
	reason: CppVerdictReason;
	errors: CppDiagnostic[];
	warnings: CppDiagnostic[];
	/** Per test, in order (only the tests that were run). */
	tests: CppTestResult[];
	/** "visible" for Check (hidden tests not run), "all" for Submit. */
	scope: "visible" | "all" | "none";
	ms: number;
}

const MAX_DIAGNOSTICS = 6;
const MAX_MESSAGE = 900;
const MAX_OUTPUT = 1500;

function clip(s: string, max = MAX_MESSAGE): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Map GCC diagnostics of one kind to cell lines and test names. */
export function cppDiagnostics(diags: readonly GccDiagnostic[], kind: "error" | "warning", ex: ResolvedCppExercise): CppDiagnostic[] {
	const out: CppDiagnostic[] = [];
	for (const d of diags) {
		const isKind = kind === "error" ? d.kind === "error" || d.kind === "fatal error" : d.kind === "warning";
		if (!isKind) continue;
		const at = d.locations?.[0]?.caret;
		const file = at?.file ?? "";
		const notes = (d.children ?? [])
			.filter((c) => c.kind === "note")
			.slice(0, 2)
			.map((c) => `note: ${c.message}`);
		const message = clip([d.message, ...notes].join("\n"));
		const test = /^test (\d+)$/.exec(file);
		if (file === "cell.cpp" || file.endsWith("/cell.cpp")) out.push({ line: at?.line ?? null, message, where: "cell" });
		else if (test) {
			const t = ex.tests[Number(test[1]) - 1];
			out.push({ line: null, message: `In test "${t?.name ?? test[1]}"${t?.hidden ? " (hidden)" : `, line ${at?.line ?? "?"}`}: ${message}`, where: "test", test: t?.name });
		} else out.push({ line: null, message: file ? `${file.replace(/^.*\//, "")}:${at?.line ?? ""}: ${message}` : message, where: "other" });
		if (out.length >= MAX_DIAGNOSTICS) break;
	}
	return out;
}

/** The cell line in a sanitizer report: the first "cell.cpp:N". */
function cellLineIn(text: string): number | undefined {
	const m = /cell\.cpp:(\d+)/.exec(text);
	return m ? Number(m[1]) : undefined;
}

/** Strip temporary folders and addresses from a sanitizer report. */
function tidyReport(text: string): string {
	return text
		.replace(/\/tmp\/cpp-[A-Za-z0-9]+\//g, "")
		.replace(/ on address 0x[0-9a-f]+ at pc 0x[0-9a-f]+ bp 0x[0-9a-f]+ sp 0x[0-9a-f]+/g, "")
		.replace(/ at 0x[0-9a-f]+ thread T\d+/g, "");
}

/** Grade one test run. */
export function cppTestResult(test: CppTest, run: CppRunResult | undefined, nonce: string): CppTestResult {
	const base = { name: test.name, hidden: test.hidden === true, ms: run?.ms ?? 0 };
	if (!run) return { ...base, passed: false, outcome: "timeout", message: "Not run: the time budget for the tests ran out." };
	const printed = run.stdout.replace(/\n?@@LH_PASS [^\n]*\n?/g, "").replace(/\n?@@LH_FAIL\n[\s\S]*?\n@@LH_END\n?/g, "").trim();
	const output = printed ? { output: clip(printed, MAX_OUTPUT) } : {};
	if (run.timedOut) return { ...base, passed: false, outcome: "timeout", message: "The test did not finish within the time limit (an endless loop?).", ...output };
	if (run.exitCode === 0 && run.stdout.includes(`@@LH_PASS ${nonce}`)) return { ...base, passed: true, outcome: "passed", ...output };
	const fail = /@@LH_FAIL\n([\s\S]*?)\n@@LH_END/.exec(run.stdout);
	if (fail) return { ...base, passed: false, outcome: "check", message: clip(fail[1]!), ...output };
	const report = tidyReport(run.stderr);
	const asan = /ERROR: AddressSanitizer: [^\n]*/.exec(report);
	if (asan) {
		const line = cellLineIn(report);
		const access = /\n((?:READ|WRITE) of size \d+[^\n]*)/.exec(report)?.[1];
		return { ...base, passed: false, outcome: "sanitizer", message: clip([asan[0].replace(/^ERROR: /, ""), access].filter(Boolean).join("\n")), ...(line ? { line } : {}), ...output };
	}
	const ubsan = /([^\s:]+):(\d+):\d+: runtime error: [^\n]*/.exec(report);
	if (ubsan) {
		const inCell = ubsan[1]!.endsWith("cell.cpp");
		return { ...base, passed: false, outcome: "sanitizer", message: clip(`UndefinedBehaviorSanitizer: ${ubsan[0].replace(/^[^\s:]+:\d+:\d+: runtime error: /, "")}`), ...(inCell ? { line: Number(ubsan[2]) } : {}), ...output };
	}
	if (run.signal) return { ...base, passed: false, outcome: "crash", message: `The test crashed (${run.signal}).`, ...output };
	return {
		...base,
		passed: false,
		outcome: "exit",
		message: run.exitCode === 0 ? "The program ended before the test finished (exit called in the solution?)." : `The program exited with status ${run.exitCode} before the test finished.`,
		...output,
	};
}

/** Grade a compile-and-run (or syntax-only) result. */
export function gradeCppCheck(
	ex: ResolvedCppExercise,
	result: CppCheckResult,
	options: { scope: "visible" | "all" | "none"; nonce: string },
): CppVerdict {
	const ms = result.ms;
	const empty = { errors: [] as CppDiagnostic[], warnings: [] as CppDiagnostic[], tests: [] as CppTestResult[], scope: options.scope, ms };
	if (result.error) return { ...empty, passed: false, reason: "compile", errors: [{ line: null, message: clip(result.error), where: "other" }] };
	if (!result.compile) return { ...empty, passed: false, reason: "compile", errors: [{ line: null, message: "The code was not compiled.", where: "other" }] };
	const warnings = cppDiagnostics(result.compile.diagnostics, "warning", ex).filter((w) => w.where === "cell");
	if (result.compile.timedOut) return { ...empty, warnings, passed: false, reason: "timeout", errors: [{ line: null, message: "Compiling took too long.", where: "other" }] };
	if (!result.compile.ok) {
		const errors = cppDiagnostics(result.compile.diagnostics, "error", ex);
		if (!errors.length) errors.push({ line: null, message: clip(result.compile.other || "The compiler failed."), where: "other" });
		return { ...empty, warnings, passed: false, reason: "compile", errors };
	}
	if (options.scope === "none") return { ...empty, warnings, passed: true, reason: "passed" };
	const indices = testIndices(ex, options.scope);
	const tests = indices.map((i) => cppTestResult(ex.tests[i - 1]!, result.runs?.find((r) => r.test === i), options.nonce));
	const passed = tests.length > 0 && tests.every((t) => t.passed);
	return { ...empty, warnings, tests, passed, reason: passed ? "passed" : "tests" };
}

/** The 1-based numbers of the tests a scope runs. */
export function testIndices(ex: ResolvedCppExercise, scope: "visible" | "all"): number[] {
	return ex.tests.flatMap((t, i) => (scope === "all" || !t.hidden ? [i + 1] : []));
}

/** One line for the learner and the tutor. */
export function cppVerdictSummary(v: CppVerdict): string {
	switch (v.reason) {
		case "passed": {
			if (v.scope === "none") return v.warnings.length ? `It compiles (${v.warnings.length === 1 ? "1 warning" : `${v.warnings.length} warnings`}).` : "It compiles.";
			const n = v.tests.length;
			return v.scope === "visible" ? `All ${n} visible ${n === 1 ? "test passes" : "tests pass"}; hidden tests run on Submit.` : `All ${n} ${n === 1 ? "test passes" : "tests pass"}.`;
		}
		case "solution":
			return v.errors[0]?.message ?? "The solution cannot be checked.";
		case "compile":
			return `The code does not compile (${v.errors.length === 1 ? "1 error" : `${v.errors.length} errors`}).`;
		case "tests": {
			const failed = v.tests.filter((t) => !t.passed).length;
			return `${failed} of ${v.tests.length} ${v.tests.length === 1 ? "test fails" : "tests fail"}.`;
		}
		case "timeout":
			return "Compiling took too long.";
	}
}

/** The checking port the agent and server layers share (the service over
 *  HTTP, src/server/cpp-service.ts). Throws when it cannot be reached. */
export type CppChecker = (request: CppCheckRequest) => Promise<CppCheckResult>;

/** A fresh secret for one check's pass marker. */
export type NonceSource = () => string;

const defaultNonce: NonceSource = () => {
	const bytes = new Uint8Array(12);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Compile and run the tests of a scope ("visible" for Check, "all" for
 *  Submit and the reference check). */
export async function checkCppSolution(
	check: CppChecker,
	ex: ResolvedCppExercise,
	solution: string,
	scope: "visible" | "all",
	nonce: NonceSource = defaultNonce,
): Promise<CppVerdict> {
	const problems = cppSolutionProblems(solution);
	if (problems.length) return { passed: false, reason: "solution", errors: problems.map((message) => ({ line: null, message, where: "cell" })), warnings: [], tests: [], scope, ms: 0 };
	const secret = nonce();
	const runs = testIndices(ex, scope);
	const result = await check({ cell: cppCellDocument(ex, solution), tests: cppTestSource(ex, secret), runs });
	return gradeCppCheck(ex, result, { scope, nonce: secret });
}

/** Syntax and type check only (the editor's live errors and warnings). */
export async function syntaxCheckCpp(check: CppChecker, ex: ResolvedCppExercise, solution: string): Promise<CppVerdict> {
	const problems = cppSolutionProblems(solution);
	if (problems.length) return { passed: false, reason: "solution", errors: problems.map((message) => ({ line: null, message, where: "cell" })), warnings: [], tests: [], scope: "none", ms: 0 };
	return gradeCppCheck(ex, await check({ cell: cppCellDocument(ex, solution) }), { scope: "none", nonce: "" });
}

/** Read an exercise from a persisted call input (cpp_exercise, or a
 *  practice problem's `cpp` block); null when malformed. */
export function cppExerciseFromInput(input: unknown, question = ""): ResolvedCppExercise | null {
	const i = input as Partial<CppExercise> | null;
	if (!i || typeof i.head !== "string" || !Array.isArray(i.tests)) return null;
	const tests = i.tests.filter((t): t is CppTest => !!t && typeof t.name === "string" && typeof t.code === "string");
	if (!tests.length) return null;
	return resolveCppExercise({
		question: typeof i.question === "string" ? i.question : question,
		head: i.head,
		starter: typeof i.starter === "string" ? i.starter : undefined,
		tail: typeof i.tail === "string" ? i.tail : undefined,
		tests,
	});
}

/** The model's view of a C++ answer (the exercise answer and a practice
 *  submission share it). The tutor sees hidden tests' failures in full. */
export function cppAnswerForModel(solution: string, v: CppVerdict, summary: string, context: "exercise" | "practice"): Record<string, unknown> {
	const out: Record<string, unknown> = { solution, verdict: summary };
	if (v.errors.length) out.errors = v.errors.map((e) => ({ ...(e.line !== null ? { line: e.line } : {}), message: e.message }));
	if (v.warnings.length) out.warnings = v.warnings.map((w) => `${w.line !== null ? `line ${w.line}: ` : ""}${w.message}`);
	const failed = v.tests.filter((t) => !t.passed);
	if (failed.length) {
		out.failedTests = failed.map((t) => ({ name: t.name, ...(t.hidden ? { hidden: true } : {}), outcome: t.outcome, ...(t.message ? { message: t.message } : {}), ...(t.line ? { line: t.line } : {}), ...(t.output ? { output: t.output } : {}) }));
	}
	if (v.passed) {
		out.review =
			context === "exercise"
				? "All tests pass. Judge whether this solution does what the task asked (not only whether it passes the tests, e.g. no special-casing of test inputs); record your judgment with cpp_review before replying."
				: "All tests pass. Judge whether this solution does what the problem asked, not only whether it passes the tests, before you count it as solved.";
	}
	return out;
}
