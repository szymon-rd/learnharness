/**
 * Server-side checks for every language: the authoring problems of an
 * exercise, the reference check behind code_cell_verify, the graded
 * submission (question answers and practice submissions alike), and the
 * editor's live checks. The exercise always comes from a saved or posed
 * payload, never from the learner.
 */
import type { Language } from "../contract.ts";
import { checkLeanProof, leanExerciseProblems, resolveLeanExercise, verdictSummary, type LeanChecker, type ResolvedLeanExercise } from "../core/lean-cell.ts";
import { checkTlaSolution, MAX_TLA_SOLUTION_CHARS, parseTlaSolution, tlaExerciseFromInput, tlaExerciseProblems, tlaVerdictSummary, type ResolvedTlaExercise, type TlaChecker, type TlaVerdict } from "../core/tla-cell.ts";
import { checkCppSolution, cppExerciseFromInput, cppExerciseProblems, cppVerdictSummary, MAX_CPP_SOLUTION_CHARS, syntaxCheckCpp, type CppChecker, type CppVerdict, type ResolvedCppExercise } from "../core/cpp-cell.ts";
import { checkRocqProof, resolveRocqExercise, rocqExerciseProblems, rocqVerdictSummary, type ResolvedRocqExercise, type RocqChecker } from "../core/rocq-cell.ts";
import { leanChecker } from "./lean-service.ts";
import { tlaChecker } from "./tla-service.ts";
import { cppChecker } from "./cpp-service.ts";
import { rocqChecker } from "./rocq-service.ts";

type Env = Record<string, string | undefined>;
type Payload = Record<string, unknown>;

export interface Checkers {
	lean: LeanChecker | null;
	tla: TlaChecker | null;
	cpp: CppChecker | null;
	rocq: RocqChecker | null;
}

export function checkersFrom(env: Env = process.env): Checkers {
	return { lean: leanChecker(env), tla: tlaChecker(env), cpp: cppChecker(env), rocq: rocqChecker(env) };
}

/** What a graded submission records (the model and the cards read it). */
export interface GradeResult {
	passed: boolean;
	/** One line for the learner and the teacher. */
	summary: string;
	/** The language's full verdict (errors, trace, tests, …). */
	verdict: unknown;
	/** TLA+/C++ passes: the teacher still judges the solution. */
	review?: string;
}

const MAX_PROOF_CHARS = 50_000;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function lean(question: string, p: Payload): ResolvedLeanExercise {
	return resolveLeanExercise({ question, prelude: str(p.prelude), statement: str(p.statement) ?? "", starter: str(p.starter) });
}
function tla(question: string, p: Payload): ResolvedTlaExercise {
	const ex = tlaExerciseFromInput(p, question);
	if (!ex) throw new Error("The TLA+ exercise is malformed.");
	return ex;
}
function cpp(question: string, p: Payload): ResolvedCppExercise {
	const ex = cppExerciseFromInput(p, question);
	if (!ex) throw new Error("The C++ exercise is malformed.");
	return ex;
}
function rocq(question: string, p: Payload): ResolvedRocqExercise {
	return resolveRocqExercise({ question, prelude: str(p.prelude), statement: str(p.statement) ?? "", starter: str(p.starter) });
}

/** Authoring problems of an exercise (no checker run). Empty = well-formed. */
export function exerciseProblems(language: Language, question: string, payload: Payload): string[] {
	const q = question || "problem";
	switch (language) {
		case "lean":
			return leanExerciseProblems({ question: q, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter), referenceProof: str(payload.referenceProof) });
		case "tla":
			return tlaExerciseProblems({ ...payload, question: q } as never);
		case "cpp":
			return cppExerciseProblems({ ...payload, question: q } as never);
		case "rocq":
			return rocqExerciseProblems({ question: q, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter), referenceProof: str(payload.referenceProof) });
	}
}

function need<T>(checker: T | null, language: Language): T {
	if (!checker) throw new Error(`The ${language === "tla" ? "TLA+" : language === "cpp" ? "C++" : language === "lean" ? "Lean" : "Rocq"} checker is not available on this server.`);
	return checker;
}

function tlaLines(field: string, v: TlaVerdict): string[] {
	const out = [`${field} does not pass: ${tlaVerdictSummary(v)}`];
	for (const e of v.errors) out.push(`${e.line !== null ? `line ${e.line}` : "error"}: ${e.message}`);
	if (v.trace?.length) {
		out.push(`counterexample: ${v.trace.slice(0, 12).map((s) => `${s.index}: ${s.action}${s.vars.length ? ` (${s.vars.map((x) => `${x.name} = ${x.value}`).join(", ")})` : ""}`).join(" → ")}`);
	}
	return out;
}
function cppLines(field: string, v: CppVerdict): string[] {
	const out = [`${field} does not pass: ${cppVerdictSummary(v)}`];
	for (const e of v.errors) out.push(`${e.line !== null ? `line ${e.line}` : "error"}: ${e.message}`);
	for (const t of v.tests.filter((t) => !t.passed)) out.push(`test "${t.name}": ${t.message ?? t.outcome}`);
	return out;
}

/** Run the reference through the checker. Empty = it passes. Throws when
 *  the checker cannot be reached. */
export async function referenceProblems(language: Language, payload: Payload, checkers: Checkers): Promise<string[]> {
	switch (language) {
		case "lean": {
			const v = await checkLeanProof(need(checkers.lean, language), lean("", payload), str(payload.referenceProof) ?? "");
			return v.passed ? [] : [`referenceProof does not pass: ${verdictSummary(v)}`, ...v.errors.map((e) => `${e.line > 0 ? `proof line ${e.line}` : "statement/prelude"}: ${e.message}`)];
		}
		case "tla": {
			const v = await checkTlaSolution(need(checkers.tla, language), tla("", payload), str(payload.referenceSolution) ?? "");
			return v.passed ? [] : tlaLines("referenceSolution", v);
		}
		case "cpp": {
			const v = await checkCppSolution(need(checkers.cpp, language), cpp("", payload), str(payload.referenceSolution) ?? "", "all");
			return v.passed ? [] : cppLines("referenceSolution", v);
		}
		case "rocq": {
			const v = await checkRocqProof(need(checkers.rocq, language), rocq("", payload), str(payload.referenceProof) ?? "");
			return v.passed ? [] : [`referenceProof does not pass: ${rocqVerdictSummary(v)}`, ...v.errors.map((e) => `${e.line > 0 ? `proof line ${e.line}` : "statement/prelude"}: ${e.message}`)];
		}
	}
}

/** Grade the learner's code against the saved exercise. `context` picks the
 *  teacher's follow-up for a TLA+/C++ pass. */
export async function gradeSubmission(
	language: Language,
	question: string,
	payload: Payload,
	code: string,
	checkers: Checkers,
	context: "exercise" | "practice",
): Promise<GradeResult> {
	if (code.length > (language === "tla" ? MAX_TLA_SOLUTION_CHARS : language === "cpp" ? MAX_CPP_SOLUTION_CHARS : MAX_PROOF_CHARS)) {
		throw new Error("The submission is too long.");
	}
	const judge = (what: string) =>
		context === "exercise"
			? `${what} Judge whether this solution does what the task asked, not only whether it passes the checks; record your judgment with code_cell_review before replying.`
			: `${what} Judge whether this solution does what the problem asked, not only whether it passes the checks, before you count it as solved.`;
	switch (language) {
		case "lean": {
			const v = await checkLeanProof(need(checkers.lean, language), lean(question, payload), code);
			return { passed: v.passed, summary: verdictSummary(v), verdict: v };
		}
		case "tla": {
			const v = await checkTlaSolution(need(checkers.tla, language), tla(question, payload), code);
			return { passed: v.passed, summary: tlaVerdictSummary(v), verdict: v, ...(v.passed ? { review: judge("TLC passes.") } : {}) };
		}
		case "cpp": {
			const v = await checkCppSolution(need(checkers.cpp, language), cpp(question, payload), code, "all");
			return { passed: v.passed, summary: cppVerdictSummary(v), verdict: v, ...(v.passed ? { review: judge("All tests pass.") } : {}) };
		}
		case "rocq": {
			const v = await checkRocqProof(need(checkers.rocq, language), rocq(question, payload), code);
			return { passed: v.passed, summary: rocqVerdictSummary(v), verdict: v };
		}
	}
}

/** The editor's live checks (nothing is recorded): TLA+ "parse" (live
 *  errors) and "check" (the Check button); C++ "syntax" and "check"
 *  (visible tests). */
export async function liveCheck(
	language: "tla" | "cpp",
	payload: Payload,
	code: string,
	mode: string,
	checkers: Checkers,
): Promise<{ verdict: unknown; summary: string }> {
	if (language === "tla") {
		if (code.length > MAX_TLA_SOLUTION_CHARS) throw new Error("The solution is too long.");
		const ex = tla("", payload);
		const v = mode === "check" ? await checkTlaSolution(need(checkers.tla, language), ex, code) : await parseTlaSolution(need(checkers.tla, language), ex, code);
		return { verdict: v, summary: tlaVerdictSummary(v) };
	}
	if (code.length > MAX_CPP_SOLUTION_CHARS) throw new Error("The solution is too long.");
	const ex = cpp("", payload);
	const v = mode === "check" ? await checkCppSolution(need(checkers.cpp, language), ex, code, "visible") : await syntaxCheckCpp(need(checkers.cpp, language), ex, code);
	return { verdict: v, summary: cppVerdictSummary(v) };
}
