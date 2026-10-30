/**
 * Lean code cells — the pure half (no I/O): the exercise contract, the cell
 * document both the editor and the grader build, and the verdict.
 *
 * A cell is one Lean file in three regions:
 *
 *   prelude      locked   (imports / opens; "import Mathlib" by default)
 *   statement    locked   (one theorem or lemma, ending in `:= by`)
 *   proof        the learner's (starts as the starter, "  sorry")
 *
 * The editor shows cellDocument(); the server grades cellCheckSource(),
 * which is the same text plus a trailing `#print axioms` for the theorem,
 * so every line number the learner saw is the line number Lean reports.
 *
 * The verdict is the server's (src/server/lean-service.ts runs Lean): a
 * proof passes when Lean reports no errors, no `sorry`, and the theorem
 * depends only on the standard axioms. The check targets honest mistakes;
 * a proof crafted to fool it (e.g. redefining `#print`) is out of scope —
 * the learner only fools himself (owner, 2026-10-30).
 */

export const LEAN_EXERCISE_TOOL = "lean_exercise";
export const DEFAULT_LEAN_PRELUDE = "import Mathlib";
export const DEFAULT_LEAN_STARTER = "  sorry";

/** The axioms ordinary mathematics uses. Anything else — sorryAx, a custom
 *  axiom, Lean.ofReduceBool (native_decide) — fails the check. */
export const ALLOWED_AXIOMS: readonly string[] = ["propext", "Classical.choice", "Quot.sound"];

/** The exercise as the teacher authors it (the tool input, minus the
 *  plan/position metadata the tool validates separately). */
export interface LeanExercise {
	/** Markdown task text shown above the cell. */
	question: string;
	/** Locked lines before the statement. Default: import Mathlib. */
	prelude?: string;
	/** Locked: one `theorem`/`lemma` ending in `:= by`. */
	statement: string;
	/** The proof the learner starts from. Default: "  sorry". */
	starter?: string;
}

/** The pieces after defaults, as the cell shows them. */
export interface ResolvedLeanExercise {
	question: string;
	prelude: string;
	statement: string;
	starter: string;
	/** The declared name (as written; resolved against no namespace). */
	theoremName: string;
}

const DECL = /^\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable)\s+)*(theorem|lemma)\s+([^\s:({[⦃]+)/;

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, "\n");
}

/** The declared theorem name, or null when the statement does not start
 *  with a theorem/lemma declaration. */
export function statementTheoremName(statement: string): string | null {
	const m = DECL.exec(normalizeNewlines(statement));
	return m ? m[2]! : null;
}

/** Authoring problems with an exercise (the tool returns them to the
 *  teacher, who fixes and retries). Empty = well-formed. */
export function leanExerciseProblems(ex: LeanExercise & { referenceProof?: string }): string[] {
	const problems: string[] = [];
	if (!ex.question?.trim()) problems.push("question must describe the task.");
	const statement = normalizeNewlines(ex.statement ?? "").trim();
	if (!statement) problems.push("statement must be one theorem or lemma ending in `:= by`.");
	else {
		if (!statementTheoremName(statement)) {
			problems.push("statement must start with `theorem <name>` or `lemma <name>` (use a fresh name; `example` cannot be checked).");
		}
		if (!/:=\s*by$/.test(statement)) problems.push("statement must end with `:= by` — the learner writes the tactic proof below it.");
		if (/\bsorry\b/.test(statement)) problems.push("statement must not contain sorry.");
	}
	const prelude = normalizeNewlines(ex.prelude ?? DEFAULT_LEAN_PRELUDE);
	if (/^\s*namespace\b/m.test(prelude)) {
		problems.push("prelude must not open a namespace (the check looks the theorem up from the root); use `open` instead.");
	}
	if (/\bsorry\b/.test(prelude)) problems.push("prelude must not contain sorry.");
	if (ex.referenceProof !== undefined) {
		if (!ex.referenceProof.trim()) problems.push("referenceProof must be a complete tactic proof.");
		else if (/\b(sorry|admit)\b/.test(ex.referenceProof)) problems.push("referenceProof must not use sorry or admit.");
	}
	return problems;
}

export function resolveLeanExercise(ex: LeanExercise): ResolvedLeanExercise {
	const statement = normalizeNewlines(ex.statement).trim();
	return {
		question: ex.question,
		prelude: normalizeNewlines(ex.prelude ?? DEFAULT_LEAN_PRELUDE).replace(/\s+$/, ""),
		statement,
		starter: normalizeNewlines(ex.starter ?? DEFAULT_LEAN_STARTER).replace(/\s+$/, "") || DEFAULT_LEAN_STARTER,
		theoremName: statementTheoremName(statement) ?? "",
	};
}

/** Where the regions sit in the cell document (0-based lines). */
export interface CellLayout {
	/** First line of the statement. */
	statementLine: number;
	/** First line of the learner's proof. */
	proofLine: number;
}

export function cellLayout(ex: ResolvedLeanExercise): CellLayout {
	const preludeLines = ex.prelude ? ex.prelude.split("\n").length + 1 : 0; // + the blank separator
	const statementLine = preludeLines;
	return { statementLine, proofLine: statementLine + ex.statement.split("\n").length };
}

/** The text the editor shows: prelude, blank line, statement, proof. */
export function cellDocument(ex: ResolvedLeanExercise, proof: string): string {
	const head = ex.prelude ? `${ex.prelude}\n\n` : "";
	return `${head}${ex.statement}\n${normalizeNewlines(proof).replace(/\s+$/, "")}\n`;
}

/** The text the server checks: the cell document plus the axioms report.
 *  `axiomsLine` is the report's 1-based line (Lean's numbering). */
export function cellCheckSource(ex: ResolvedLeanExercise, proof: string): { source: string; axiomsLine: number } {
	const doc = cellDocument(ex, proof);
	const source = `${doc}\n#print axioms _root_.${ex.theoremName}\n`;
	return { source, axiomsLine: doc.split("\n").length + 1 };
}

// ─── the verdict ────────────────────────────────────────────────────────

/** One message from `lean --json` (1-based line, 0-based column). */
export interface LeanMessage {
	severity: "error" | "warning" | "information" | string;
	pos?: { line: number; column: number } | null;
	endPos?: { line: number; column: number } | null;
	data: string;
}

/** What the Lean service returns for one check. */
export interface LeanCheckResult {
	exitCode: number | null;
	timedOut: boolean;
	ms: number;
	messages: LeanMessage[];
	output?: string;
}

export type LeanVerdictReason = "passed" | "errors" | "sorry" | "axioms" | "timeout" | "no-report";

export interface LeanVerdict {
	passed: boolean;
	reason: LeanVerdictReason;
	/** Errors, with lines relative to the proof (1 = the proof's first
	 *  line; 0 or less = in the locked part above it). */
	errors: { line: number; message: string }[];
	/** The theorem's axioms, when Lean reported them. */
	axioms?: string[];
	/** Axioms outside ALLOWED_AXIOMS. */
	disallowedAxioms?: string[];
	ms: number;
}

const MAX_ERRORS = 5;
const MAX_MESSAGE = 600;

/** Parse "'x' depends on axioms: [a, b]" / "'x' does not depend on any axioms". */
export function parseAxiomsReport(text: string): string[] | null {
	if (/does not depend on any axioms/.test(text)) return [];
	const m = /depends on axioms:\s*\[([^\]]*)\]/.exec(text);
	if (!m) return null;
	return m[1]!
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Grade one check of cellCheckSource(ex, proof). Pure. */
export function gradeLeanCheck(ex: ResolvedLeanExercise, proof: string, result: LeanCheckResult): LeanVerdict {
	const { proofLine } = cellLayout(ex);
	const { axiomsLine } = cellCheckSource(ex, proof);
	const errors = result.messages
		.filter((m) => m.severity === "error")
		.slice(0, MAX_ERRORS)
		.map((m) => ({ line: (m.pos?.line ?? 0) - proofLine, message: m.data.trim().slice(0, MAX_MESSAGE) }));
	const base = { errors, ms: result.ms };
	if (result.timedOut) return { passed: false, reason: "timeout", ...base };
	if (errors.length) return { passed: false, reason: "errors", ...base };
	const report = result.messages.find((m) => m.severity === "information" && m.pos?.line === axiomsLine);
	const axioms = report ? parseAxiomsReport(report.data) : null;
	const usesSorry =
		result.messages.some((m) => m.severity === "warning" && /declaration uses 'sorry'/.test(m.data)) ||
		(axioms?.includes("sorryAx") ?? false);
	if (usesSorry) return { passed: false, reason: "sorry", ...base, ...(axioms ? { axioms } : {}) };
	// No report means Lean never reached the end of the file (e.g. `#exit`).
	if (!axioms) return { passed: false, reason: "no-report", ...base };
	const disallowed = axioms.filter((a) => !ALLOWED_AXIOMS.includes(a));
	if (disallowed.length) return { passed: false, reason: "axioms", ...base, axioms, disallowedAxioms: disallowed };
	return { passed: true, reason: "passed", ...base, axioms };
}

/** One line for the learner and the teacher. */
export function verdictSummary(v: LeanVerdict): string {
	switch (v.reason) {
		case "passed":
			return "Lean accepts the proof.";
		case "errors":
			return `Lean reports ${v.errors.length === 1 ? "an error" : `${v.errors.length} errors`}.`;
		case "sorry":
			return "The proof still contains sorry.";
		case "axioms":
			return `The proof relies on ${v.disallowedAxioms!.join(", ")}${v.disallowedAxioms!.includes("Lean.ofReduceBool") ? " (native_decide)" : ""}, which the check does not accept.`;
		case "timeout":
			return "Lean ran out of time checking the proof.";
		case "no-report":
			return "Lean stopped before reaching the end of the cell.";
	}
}

/** The checking port the agent and server layers share: run Lean on one
 *  source file (src/server/lean-service.ts implements it over HTTP). Throws
 *  when Lean cannot be reached. */
export type LeanChecker = (source: string) => Promise<LeanCheckResult>;

/** Check one proof of one exercise and grade it. */
export async function checkLeanProof(check: LeanChecker, ex: ResolvedLeanExercise, proof: string): Promise<LeanVerdict> {
	return gradeLeanCheck(ex, proof, await check(cellCheckSource(ex, proof).source));
}
