/**
 * Rocq code cells — the pure half (no I/O), built like Lean's
 * (core/lean-cell.ts): the exercise contract, the cell document the editor
 * and the grader both build, and the verdict.
 *
 * A cell is one Rocq file in three regions:
 *
 *   prelude    locked   (Require/Import lines; Iris and HeapLang available)
 *   statement  locked   (one Lemma/Theorem/… ending in ".")
 *   proof      the learner's (starts as "Proof.\nAdmitted.")
 *
 * The server grades cellCheckSource(): the same text plus a trailing
 * `Print Assumptions <name>.`, so every line the learner saw is the line
 * Rocq reports. A proof passes when Rocq reports no error, the lemma is not
 * Admitted, and it depends only on axioms from the libraries (the standard
 * library's logical axioms, Iris, std++), never on one declared in the cell
 * (owner, 2026-11-12: "the same as Lean"). A proof crafted to fool the check
 * is out of scope, as for Lean.
 */

export const ROCQ_EXERCISE_TOOL = "rocq_exercise";
export const DEFAULT_ROCQ_PRELUDE = "From Stdlib Require Import Arith Lia.";
export const DEFAULT_ROCQ_STARTER = "Proof.\nAdmitted.";

export interface RocqExercise {
	question: string;
	prelude?: string;
	statement: string;
	starter?: string;
}

export interface ResolvedRocqExercise {
	question: string;
	prelude: string;
	statement: string;
	starter: string;
	lemmaName: string;
}

const DECL = /^\s*(?:#\[[^\]]*\]\s*)?(?:(?:Local|Global|Polymorphic|Monomorphic|Program)\s+)*(Lemma|Theorem|Fact|Remark|Corollary|Proposition|Property|Example)\s+([A-Za-z_][A-Za-z0-9_']*)/;

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, "\n");
}

/** The declared lemma name, or null. */
export function statementLemmaName(statement: string): string | null {
	const m = DECL.exec(normalizeNewlines(statement));
	return m ? m[2]! : null;
}

/** Strip comments (nested) so keyword checks ignore them. */
function withoutComments(s: string): string {
	let out = "";
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		if (s.startsWith("(*", i)) {
			depth++;
			i++;
		} else if (depth > 0 && s.startsWith("*)", i)) {
			depth--;
			i++;
		} else if (depth === 0) out += s[i];
	}
	return out;
}

/** Authoring problems with an exercise. Empty = well-formed. */
export function rocqExerciseProblems(ex: RocqExercise & { referenceProof?: string }): string[] {
	const problems: string[] = [];
	if (!ex.question?.trim()) problems.push("question must describe the task.");
	const statement = normalizeNewlines(ex.statement ?? "").trim();
	if (!statement) problems.push("statement must be one Lemma or Theorem ending in a period.");
	else {
		if (!statementLemmaName(statement)) problems.push("statement must start with `Lemma <name>` or `Theorem <name>` (a fresh name; Goal cannot be checked).");
		if (!/\.\s*$/.test(withoutComments(statement))) problems.push("statement must end with a period; the learner writes `Proof. … Qed.` below it.");
		if (/\b(Proof|Qed|Admitted|admit)\b/.test(withoutComments(statement))) problems.push("statement must not contain Proof, Qed, Admitted or admit.");
	}
	const prelude = withoutComments(normalizeNewlines(ex.prelude ?? DEFAULT_ROCQ_PRELUDE));
	if (/^\s*(Section|Module)\b/m.test(prelude)) problems.push("prelude must not open a Section or Module (the lemma is checked at the top level); put binders such as `{!heapGS Σ}` in the statement.");
	if (/\b(Axiom|Parameter|Admitted|admit|Hypothesis|Variable|Conjecture)\b/.test(prelude)) problems.push("prelude must not declare axioms or use Admitted.");
	if (ex.referenceProof !== undefined) {
		const proof = withoutComments(ex.referenceProof);
		if (!proof.trim()) problems.push("referenceProof must be a complete proof (Proof. … Qed.).");
		else if (/\b(admit|Admitted)\b/.test(proof)) problems.push("referenceProof must not use admit or Admitted.");
	}
	return problems;
}

export function resolveRocqExercise(ex: RocqExercise): ResolvedRocqExercise {
	const statement = normalizeNewlines(ex.statement).trim();
	return {
		question: ex.question,
		prelude: normalizeNewlines(ex.prelude ?? DEFAULT_ROCQ_PRELUDE).replace(/\s+$/, ""),
		statement,
		starter: normalizeNewlines(ex.starter ?? DEFAULT_ROCQ_STARTER).replace(/\s+$/, "") || DEFAULT_ROCQ_STARTER,
		lemmaName: statementLemmaName(statement) ?? "",
	};
}

/** Where the regions sit in the cell document (0-based lines). */
export function rocqCellLayout(ex: ResolvedRocqExercise): { statementLine: number; proofLine: number } {
	const preludeLines = ex.prelude ? ex.prelude.split("\n").length + 1 : 0;
	return { statementLine: preludeLines, proofLine: preludeLines + ex.statement.split("\n").length };
}

/** The text the editor shows: prelude, blank line, statement, proof. */
export function rocqCellDocument(ex: ResolvedRocqExercise, proof: string): string {
	const head = ex.prelude ? `${ex.prelude}\n\n` : "";
	return `${head}${ex.statement}\n${normalizeNewlines(proof).replace(/\s+$/, "")}\n`;
}

/** The text the server checks: the cell plus the assumptions report. */
export function rocqCheckSource(ex: ResolvedRocqExercise, proof: string): { source: string; reportLine: number } {
	const doc = rocqCellDocument(ex, proof);
	return { source: `${doc}\nPrint Assumptions ${ex.lemmaName}.\n`, reportLine: doc.split("\n").length + 1 };
}

// ─── the verdict ────────────────────────────────────────────────────────

/** What the Rocq service returns for one check. */
export interface RocqCheckResult {
	exitCode: number | null;
	timedOut: boolean;
	ms: number;
	output: string;
}

export interface RocqMessage {
	severity: "error" | "warning";
	/** 1-based line in the checked file. */
	line: number;
	message: string;
}

export type RocqVerdictReason = "passed" | "errors" | "admitted" | "axioms" | "timeout" | "no-report";

export interface RocqVerdict {
	passed: boolean;
	reason: RocqVerdictReason;
	/** Errors, with lines relative to the proof (1 = the proof's first line;
	 *  0 or less = in the locked part above it). */
	errors: { line: number; message: string }[];
	/** The lemma's axioms, when Rocq reported them. */
	axioms?: string[];
	/** Axioms the check does not accept (declared in the cell). */
	disallowedAxioms?: string[];
	ms: number;
}

const MAX_ERRORS = 5;
const MAX_MESSAGE = 800;

/** Rocq's located messages: `File "./Check.v", line N, characters a-b:`
 *  followed by `Error:` / `Warning:` and the text. */
export function parseRocqMessages(output: string): RocqMessage[] {
	const out: RocqMessage[] = [];
	const re = /File "[^"]*", line (\d+), characters \d+-\d+:\n(Error|Warning)(?::\s*|\s*\n)([\s\S]*?)(?=\nFile "[^"]*", line \d+|\n(?:Axioms:|Closed under the global context)|\s*$)/g;
	for (let m = re.exec(output); m; m = re.exec(output)) {
		out.push({ severity: m[2] === "Error" ? "error" : "warning", line: Number(m[1]), message: m[3]!.trim() });
	}
	return out;
}

/** The axioms from the `Print Assumptions` report: [] when closed, null
 *  when there is no report. */
export function parseAssumptions(output: string): string[] | null {
	if (/Closed under the global context/.test(output)) return [];
	const at = output.search(/^Axioms:\s*$/m);
	if (at < 0) return null;
	const names: string[] = [];
	for (const line of output.slice(at).split("\n").slice(1)) {
		const m = /^([^\s:][^\s:]*) :/.exec(line);
		if (m) names.push(m[1]!);
	}
	return names;
}

/** An axiom the learner declared in the proof region (`Axiom cheat : …`,
 *  `Parameter`, `Hypothesis`, …). Library axioms (`classic`,
 *  `functional_extensionality_dep`, …) are accepted: Print Assumptions shows
 *  them bare too, so the test is whether the proof declares the name. */
export function axiomFromCell(name: string, proof: string): boolean {
	const text = withoutComments(proof);
	if (!/\b(Axioms?|Parameters?|Conjecture|Hypothes[ei]s|Variables?)\b/.test(text)) return false;
	const bare = name.replace(/^.*\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w'])${bare}($|[^\\w'])`).test(text);
}

/** Grade one check of rocqCheckSource(ex, proof). Pure. */
export function gradeRocqCheck(ex: ResolvedRocqExercise, proof: string, result: RocqCheckResult): RocqVerdict {
	const { proofLine } = rocqCellLayout(ex);
	const messages = parseRocqMessages(result.output);
	const errors = messages
		.filter((m) => m.severity === "error")
		.slice(0, MAX_ERRORS)
		.map((m) => ({ line: m.line - proofLine, message: m.message.length > MAX_MESSAGE ? `${m.message.slice(0, MAX_MESSAGE)}…` : m.message }));
	const base = { errors, ms: result.ms };
	if (result.timedOut) return { passed: false, reason: "timeout", ...base };
	if (errors.length || (result.exitCode !== 0 && result.exitCode !== null)) {
		if (!errors.length) errors.push({ line: 0, message: result.output.trim().split("\n").slice(-6).join("\n") || `Rocq exited with status ${result.exitCode}.` });
		return { passed: false, reason: "errors", ...base };
	}
	const axioms = parseAssumptions(result.output);
	if (!axioms) return { passed: false, reason: "no-report", ...base };
	if (axioms.some((a) => a === ex.lemmaName || a.endsWith(`.${ex.lemmaName}`))) return { passed: false, reason: "admitted", ...base, axioms };
	const disallowed = axioms.filter((a) => axiomFromCell(a, proof));
	if (disallowed.length) return { passed: false, reason: "axioms", ...base, axioms, disallowedAxioms: disallowed };
	return { passed: true, reason: "passed", ...base, axioms };
}

export function rocqVerdictSummary(v: RocqVerdict): string {
	switch (v.reason) {
		case "passed":
			return "Rocq accepts the proof.";
		case "errors":
			return `Rocq reports ${v.errors.length === 1 ? "an error" : `${v.errors.length} errors`}.`;
		case "admitted":
			return "The proof is not finished (Admitted).";
		case "axioms":
			return `The proof relies on ${v.disallowedAxioms!.join(", ")}, an axiom declared in the cell, which the check does not accept.`;
		case "timeout":
			return "Rocq ran out of time checking the proof.";
		case "no-report":
			return "Rocq stopped before reaching the end of the cell.";
	}
}

/** The checking port: run Rocq on one file (src/server/rocq-service.ts).
 *  Throws when Rocq cannot be reached. */
export type RocqChecker = (source: string) => Promise<RocqCheckResult>;

export async function checkRocqProof(check: RocqChecker, ex: ResolvedRocqExercise, proof: string): Promise<RocqVerdict> {
	return gradeRocqCheck(ex, proof, await check(rocqCheckSource(ex, proof).source));
}
