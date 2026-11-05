/**
 * TLA+ code cells — the pure half (no I/O): the exercise contract, the cell
 * document the editor and the grader both build, the TLC model config, and
 * the verdict read from the tools' output.
 *
 * A cell is one TLA+ module in three regions (owner, 2026-11-05):
 *
 *   head      locked   (---- MODULE X ----, EXTENDS, CONSTANTS, VARIABLES,
 *                       given definitions; for PlusCal the algorithm's
 *                       opening lines)
 *   solution  the learner's (starts as the starter)
 *   tail      locked   (Spec, the invariants/properties TLC checks; for
 *                       PlusCal the algorithm's closing lines; ====)
 *
 * The TLC model (constants, INIT/NEXT or SPECIFICATION, INVARIANT,
 * PROPERTY, deadlock) is the teacher's, shown read-only under the cell.
 * Witnesses are states that must be reachable, so a spec that does nothing
 * cannot pass.
 *
 * A solution passes when the module translates (PlusCal) and parses, TLC
 * explores the whole state space with no violated invariant or property and
 * no deadlock (when the model checks it), and every witness is reachable.
 * The teacher then judges whether the solution does what was asked
 * (tla_review) and may overrule a pass.
 *
 * The service (deploy/tla/bridge) only runs the tools and returns their raw
 * output; everything here reads it. Line numbers are the cell document's
 * (1-based), which the editor shows.
 */

export const TLA_EXERCISE_TOOL = "tla_exercise";
export const TLA_REVIEW_TOOL = "tla_review";
export const DEFAULT_TLA_STARTER = "";
export const MAX_TLA_WITNESSES = 5;
export const MAX_TLA_SOLUTION_CHARS = 50_000;

/** The TLC model as the teacher sets it. */
export interface TlaModelConfig {
	/** CONSTANT name → value in .cfg syntax (`3`, `{p1, p2}`, a model value). */
	constants?: Record<string, string>;
	/** A temporal formula `Init /\ [][Next]_vars …` (use it with fairness
	 *  or PlusCal's Spec), or … */
	specification?: string;
	/** … the initial predicate and next-state relation. */
	init?: string;
	next?: string;
	invariants?: string[];
	properties?: string[];
	/** TLC's deadlock check. Default true (TLC's own default). */
	checkDeadlock?: boolean;
}

/** A state that must be reachable: TLC checks `~expression` as an
 *  invariant, and a violation means some reachable state satisfies it. */
export interface TlaWitness {
	label: string;
	expression: string;
}

export type TlaMode = "tla" | "pluscal";

/** The exercise as the teacher authors it (minus plan metadata). */
export interface TlaExercise {
	question: string;
	mode?: TlaMode;
	head: string;
	starter?: string;
	tail: string;
	config: TlaModelConfig;
	witnesses?: TlaWitness[];
}

export interface ResolvedTlaExercise {
	question: string;
	mode: TlaMode;
	head: string;
	starter: string;
	tail: string;
	config: TlaModelConfig;
	witnesses: TlaWitness[];
	moduleName: string;
}

const HEADER = /^\s*-{4,}\s*MODULE\s+([A-Za-z0-9_]+)\s*-{4,}\s*$/;
const END = /^\s*={4,}\s*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WITNESS_PREFIX = "LH_Witness_";
/** Modules TLC ships; an exercise module must not shadow one. */
const STANDARD_MODULES = new Set([
	"Naturals",
	"Integers",
	"Reals",
	"Sequences",
	"FiniteSets",
	"Bags",
	"TLC",
	"TLCExt",
	"RealTime",
	"Randomization",
	"Json",
	"Toolbox",
	"Apalache",
	"Model",
]);

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, "\n");
}

function trimBlankEdges(s: string): string {
	return normalizeNewlines(s).replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** The module name from the head's first line, or null. */
export function tlaModuleName(head: string): string | null {
	const first = trimBlankEdges(head).split("\n")[0] ?? "";
	return HEADER.exec(first)?.[1] ?? null;
}

/** Authoring problems with an exercise (returned to the teacher, who fixes
 *  and retries). Empty = well-formed. */
export function tlaExerciseProblems(ex: TlaExercise & { referenceSolution?: string }): string[] {
	const problems: string[] = [];
	if (!ex.question?.trim()) problems.push("question must describe the task.");
	const head = trimBlankEdges(ex.head ?? "");
	const tail = trimBlankEdges(ex.tail ?? "");
	const name = tlaModuleName(head);
	if (!name) problems.push("head must start with the module header `---- MODULE <Name> ----`.");
	else if (STANDARD_MODULES.has(name)) problems.push(`module name ${name} is a standard module; choose another.`);
	if (head.split("\n").slice(1).some((l) => END.test(l) || HEADER.test(l))) problems.push("head must not contain `====` or a second module header.");
	if (!tail) problems.push("tail must end with the closing `====` line.");
	else {
		const lines = tail.split("\n");
		if (!END.test(lines[lines.length - 1]!)) problems.push("tail must end with the closing `====` line.");
		if (lines.slice(0, -1).some((l) => END.test(l) || HEADER.test(l))) problems.push("tail must contain exactly one `====` line, at its end.");
	}
	const mode = ex.mode ?? "tla";
	if (mode === "pluscal") {
		if (!/--(?:fair\s+)?algorithm\b/.test(head)) problems.push("PlusCal: head must open the algorithm (`(* --algorithm Name` or `(* --fair algorithm Name`).");
		if (!/\*\)/.test(tail)) problems.push("PlusCal: tail must close the algorithm comment (`end algorithm; *)` or `} *)`).");
	}
	const c = ex.config ?? ({} as TlaModelConfig);
	const hasSpec = typeof c.specification === "string" && c.specification.trim() !== "";
	const hasInitNext = typeof c.init === "string" && c.init.trim() !== "" && typeof c.next === "string" && c.next.trim() !== "";
	if (hasSpec === hasInitNext) problems.push("config must give either `specification` or both `init` and `next`.");
	for (const n of [c.specification, c.init, c.next, ...(c.invariants ?? []), ...(c.properties ?? [])]) {
		if (n !== undefined && n.trim() !== "" && !IDENT.test(n.trim())) problems.push(`config name \`${n}\` must be the name of a definition in the module.`);
	}
	if (!(c.invariants?.length || c.properties?.length)) problems.push("config must check at least one invariant or property.");
	for (const [k, v] of Object.entries(c.constants ?? {})) {
		if (!IDENT.test(k)) problems.push(`constant \`${k}\` is not a valid name.`);
		if (typeof v !== "string" || !v.trim() || /\n/.test(v)) problems.push(`constant ${k} needs a one-line value.`);
	}
	const witnesses = ex.witnesses ?? [];
	if (witnesses.length > MAX_TLA_WITNESSES) problems.push(`at most ${MAX_TLA_WITNESSES} witnesses.`);
	for (const w of witnesses) {
		if (!w?.label?.trim()) problems.push("every witness needs a label.");
		if (!w?.expression?.trim() || /\n/.test(w.expression)) problems.push(`witness "${w?.label ?? ""}" needs a one-line state expression.`);
	}
	if (ex.referenceSolution !== undefined && !ex.referenceSolution.trim()) problems.push("referenceSolution must be the complete solution.");
	return problems;
}

export function resolveTlaExercise(ex: TlaExercise): ResolvedTlaExercise {
	const head = trimBlankEdges(ex.head);
	return {
		question: ex.question,
		mode: ex.mode ?? "tla",
		head,
		starter: normalizeNewlines(ex.starter ?? DEFAULT_TLA_STARTER).replace(/\s+$/, ""),
		tail: trimBlankEdges(ex.tail),
		config: ex.config,
		witnesses: (ex.witnesses ?? []).map((w) => ({ label: w.label.trim(), expression: w.expression.trim() })),
		moduleName: tlaModuleName(head) ?? "",
	};
}

/** Where the regions sit in the cell document (0-based lines). */
export interface TlaCellLayout {
	/** First line of the learner's solution. */
	solutionLine: number;
	/** First line of the locked tail. */
	tailLine: number;
}

function solutionText(solution: string): string {
	return normalizeNewlines(solution).replace(/\s+$/, "");
}

export function tlaCellLayout(ex: ResolvedTlaExercise, solution: string): TlaCellLayout {
	const solutionLine = ex.head.split("\n").length + 1; // + the blank separator
	return { solutionLine, tailLine: solutionLine + solutionText(solution).split("\n").length + 1 };
}

/** The text the editor shows and the tools check: head, blank line,
 *  solution, blank line, tail. */
export function tlaCellDocument(ex: ResolvedTlaExercise, solution: string): string {
	return `${ex.head}\n\n${solutionText(solution)}\n\n${ex.tail}\n`;
}

/** Problems with the learner's solution that end the check before the
 *  tools run: a `====` or module header would cut the locked tail off. */
export function tlaSolutionProblems(solution: string): string[] {
	const lines = normalizeNewlines(solution).split("\n");
	if (lines.some((l) => END.test(l))) return ["The solution must not contain a `====` line: it would end the module before the locked part."];
	if (lines.some((l) => HEADER.test(l))) return ["The solution must not start another module."];
	if (solution.length > MAX_TLA_SOLUTION_CHARS) return ["The solution is too long."];
	return [];
}

// ─── the TLC model config ───────────────────────────────────────────────

function cfgBase(c: TlaModelConfig): string[] {
	const lines: string[] = [];
	const constants = Object.entries(c.constants ?? {});
	if (constants.length) {
		lines.push("CONSTANTS");
		for (const [k, v] of constants) lines.push(`  ${k} = ${v.trim()}`);
	}
	if (c.specification?.trim()) lines.push(`SPECIFICATION ${c.specification.trim()}`);
	else {
		lines.push(`INIT ${c.init?.trim() ?? ""}`);
		lines.push(`NEXT ${c.next?.trim() ?? ""}`);
	}
	return lines;
}

/** The main model's .cfg — also what the learner sees under the cell. */
export function tlaConfigText(c: TlaModelConfig): string {
	const lines = cfgBase(c);
	for (const i of c.invariants ?? []) lines.push(`INVARIANT ${i.trim()}`);
	for (const p of c.properties ?? []) lines.push(`PROPERTY ${p.trim()}`);
	if (c.checkDeadlock === false) lines.push("CHECK_DEADLOCK FALSE");
	return `${lines.join("\n")}\n`;
}

/** One TLC run the service performs. */
export interface TlaRunRequest {
	id: string;
	cfg: string;
	appendDefs?: string;
}

/** The service request: the module, and the TLC runs (none = parse only). */
export interface TlaCheckRequest {
	module: string;
	pluscal: boolean;
	runs: TlaRunRequest[];
}

export function tlaMainRun(ex: ResolvedTlaExercise): TlaRunRequest {
	return { id: "main", cfg: tlaConfigText(ex.config) };
}

/** One run per witness: the witness is reachable iff TLC finds a state
 *  violating `~expression`. */
export function tlaWitnessRuns(ex: ResolvedTlaExercise): TlaRunRequest[] {
	return ex.witnesses.map((w, i) => {
		const name = `${WITNESS_PREFIX}${i + 1}`;
		return {
			id: `witness-${i + 1}`,
			cfg: `${[...cfgBase(ex.config), `INVARIANT ${name}`, "CHECK_DEADLOCK FALSE"].join("\n")}\n`,
			appendDefs: `${name} == ~(${w.expression})`,
		};
	});
}

// ─── reading the tools' output ──────────────────────────────────────────

/** One run's raw result from the service. */
export interface TlaRunResult {
	id: string;
	exitCode: number | null;
	timedOut: boolean;
	ms: number;
	output: string;
}

/** What the service returns for one request. */
export interface TlaCheckResult {
	ms: number;
	error?: string;
	moduleName?: string;
	translation?: { ok: boolean; timedOut?: boolean; output: string; module?: string };
	sany?: { ok: boolean; timedOut?: boolean; output: string };
	runs?: TlaRunResult[];
}

/** One message from TLC's `-tool` output. */
export interface TlcMessage {
	code: number;
	severity: number;
	text: string;
}

export function parseTlcMessages(output: string): TlcMessage[] {
	const out: TlcMessage[] = [];
	const re = /@!@!@STARTMSG (\d+):(\d+) @!@!@\n([\s\S]*?)@!@!@ENDMSG \1 @!@!@/g;
	for (let m = re.exec(output); m; m = re.exec(output)) out.push({ code: Number(m[1]), severity: Number(m[2]), text: m[3]!.replace(/\s+$/, "") });
	return out;
}

/** One state of a counterexample. */
export interface TlaTraceState {
	/** 1-based position in the behavior. */
	index: number;
	/** "Initial predicate", the action's name, "Stuttering", or "Back to state N". */
	action: string;
	kind: "state" | "stuttering" | "back";
	vars: { name: string; value: string }[];
}

const MAX_TRACE = 40;
const MAX_VALUE = 400;
const MAX_ERRORS = 5;
const MAX_MESSAGE = 800;

/** Split a printed state (`x = 1` or `/\ x = 1\n/\ y = 2`) into variables. */
export function parseTlaState(body: string): { name: string; value: string }[] {
	const text = body.replace(/\s+$/, "");
	if (!text.trim()) return [];
	const conjuncts = /^\s*\/\\ /.test(text) ? text.split(/\n(?=\s*\/\\ )/).map((c) => c.replace(/^\s*\/\\ /, "")) : [text];
	const vars: { name: string; value: string }[] = [];
	for (const c of conjuncts) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(c);
		if (!m) continue;
		const value = m[2]!.replace(/\n\s*/g, " ").trim();
		vars.push({ name: m[1]!, value: value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value });
	}
	return vars;
}

function actionName(label: string): string {
	// "<Next line 7, col 9 to line 7, col 27 of module Counter>" → "Next"
	const inner = label.replace(/^<|>$/g, "");
	const m = /^(.*?)\s+line \d+, col \d+ to line \d+, col \d+ of module \S+$/.exec(inner);
	return (m ? m[1]! : inner).trim();
}

export function parseTlaTrace(messages: readonly TlcMessage[]): TlaTraceState[] {
	const trace: TlaTraceState[] = [];
	for (const m of messages) {
		if (m.code !== 2217 && m.code !== 2218 && m.code !== 2122) continue;
		const [first, ...rest] = m.text.split("\n");
		const head = /^(\d+):\s*(.*)$/.exec(first ?? "");
		if (!head) continue;
		const index = Number(head[1]);
		const label = head[2]!.trim();
		if (m.code === 2218 || /^Stuttering$/i.test(label)) trace.push({ index, action: "Stuttering", kind: "stuttering", vars: [] });
		else if (m.code === 2122 || /^Back to state/i.test(label)) trace.push({ index, action: label.replace(/[<>]/g, ""), kind: "back", vars: [] });
		else trace.push({ index, action: actionName(label), kind: "state", vars: parseTlaState(rest.join("\n")) });
		if (trace.length >= MAX_TRACE) break;
	}
	return trace;
}

/** Maps a line of the checked (translated) module back to the cell
 *  document. Without PlusCal it is the identity. */
export interface LineMap {
	(line: number): { line: number; inTranslation: boolean };
}

const BEGIN_T = /^\s*\\\*\s*BEGIN TRANSLATION\b/;
const END_T = /^\s*\\\*\s*END TRANSLATION\b/;

/** Build the map from the document the learner saw to the module the
 *  translator wrote (it fills or adds the BEGIN/END TRANSLATION block). */
export function translationLineMap(document: string, translated: string | undefined): LineMap {
	if (!translated) return (line) => ({ line, inTranslation: false });
	const t = translated.split("\n");
	const d = document.split("\n");
	const tb = t.findIndex((l) => BEGIN_T.test(l));
	const te = t.findIndex((l, i) => i > tb && END_T.test(l));
	if (tb < 0 || te < 0) return (line) => ({ line, inTranslation: false });
	const db = d.findIndex((l) => BEGIN_T.test(l));
	const de = d.findIndex((l, i) => i > db && END_T.test(l));
	// 1-based lines. Lines after the block shift by the size difference.
	const shift = db >= 0 && de >= 0 ? te - tb - (de - db) : te - tb + 1;
	return (line) => {
		const i = line - 1;
		if (i < tb) return { line, inTranslation: false };
		if (i <= te) return { line: (db >= 0 ? db : tb) + 1, inTranslation: true };
		return { line: line - shift, inTranslation: false };
	};
}

/** Rewrite "line N, col M" mentions in a tool message to cell lines. */
function remapText(text: string, map: LineMap): string {
	return text.replace(/(?:at )?line (\d+), col(?:umn)? (\d+)/gi, (all, l: string, c: string) => {
		const r = map(Number(l));
		if (r.inTranslation) return "";
		return all.replace(/\d+/, String(r.line)).replace(/\d+$/, c);
	}).replace(/ {2,}/g, " ");
}

export interface TlaError {
	/** Cell document line (1-based), when the tool named one. */
	line: number | null;
	message: string;
	/** The error is inside the PlusCal translation (no learner line). */
	inTranslation?: boolean;
}

function clip(s: string): string {
	const t = s.trim();
	return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE)}…` : t;
}

/** Errors from `pcal.trans` ("Unrecoverable error: -- … line N, column M."). */
export function parseTranslationErrors(output: string): TlaError[] {
	const at = output.indexOf("Unrecoverable error:");
	const body = at >= 0 ? output.slice(at + "Unrecoverable error:".length) : output;
	const pos = /line (\d+), column (\d+)/.exec(body);
	const message = body.replace(/^\s*--\s*/, "").replace(/\s*line \d+, column \d+\.?\s*$/m, "").trim();
	return [{ line: pos ? Number(pos[1]) : null, message: clip(message || output) }];
}

/** Errors from SANY: parse errors ("Encountered … at line L, column C"),
 *  lexical errors, and semantic errors ("line L, col C to … of module M"
 *  followed by the message). */
export function parseSanyErrors(output: string, moduleName: string, map: LineMap): TlaError[] {
	const errors: TlaError[] = [];
	const push = (line: number | null, message: string) => {
		if (errors.length >= MAX_ERRORS) return;
		if (line === null) return void errors.push({ line: null, message: clip(message) });
		const r = map(line);
		const text = remapText(message, map);
		errors.push(r.inTranslation ? { line: r.line, message: clip(`In the PlusCal translation of your algorithm: ${text}`), inTranslation: true } : { line: r.line, message: clip(text) });
	};
	const parse = /\*\*\*Parse Error\*\*\*\s*\n([^\n]*)/.exec(output);
	if (parse) {
		const pos = /at line (\d+), column (\d+)/.exec(parse[1]!);
		push(pos ? Number(pos[1]) : null, parse[1]!.trim());
	}
	const lexical = /Lexical error at line (\d+), column (\d+)\.([^\n]*)/.exec(output);
	if (lexical) push(Number(lexical[1]), `Lexical error at line ${lexical[1]}, column ${lexical[2]}.${lexical[3]}`.trim());
	const semantic = output.indexOf("Semantic errors:");
	if (semantic >= 0) {
		const re = /line (\d+), col (\d+) to line \d+, col \d+ of module (\S+)\s*\n\s*\n([\s\S]*?)(?=\n\s*\n\s*line \d+, col \d+ to line|\n\s*\n\s*\n|$)/g;
		const text = output.slice(semantic);
		for (let m = re.exec(text); m; m = re.exec(text)) {
			if (m[3] !== moduleName) continue;
			push(Number(m[1]), m[4]!.trim());
		}
	}
	if (!errors.length) {
		// Unknown shape: show the end of SANY's output.
		const lines = output.trim().split("\n").filter((l) => l.trim() && !/^\*+ SANY|^Parsing file|^Semantic processing/.test(l));
		push(null, lines.slice(-6).join("\n") || "SANY could not parse the module.");
	}
	return errors;
}

export type TlaVerdictReason =
	| "passed"
	| "solution"
	| "translation"
	| "parse"
	| "invariant"
	| "property"
	| "deadlock"
	| "tlc-error"
	| "witness-unreachable"
	| "timeout"
	| "unavailable";

export interface TlaVerdict {
	passed: boolean;
	reason: TlaVerdictReason;
	errors: TlaError[];
	/** The violated invariant (reason "invariant"). */
	violated?: string;
	/** The counterexample (invariant, property, deadlock, some TLC errors). */
	trace?: TlaTraceState[];
	/** Labels of witnesses TLC could not reach. */
	unreachable?: string[];
	/** Distinct states TLC found in the main model. */
	distinctStates?: number;
	ms: number;
}

/** Grade the main TLC run. */
function gradeMainRun(run: TlaRunResult | undefined, map: LineMap, ms: number): TlaVerdict {
	if (!run || run.timedOut) return { passed: false, reason: "timeout", errors: [], ms };
	const messages = parseTlcMessages(run.output);
	const trace = parseTlaTrace(messages);
	const states = messages.find((m) => m.code === 2199)?.text;
	const distinct = states ? Number(/(\d+) distinct states? found/.exec(states)?.[1] ?? NaN) : NaN;
	const base = { ms, ...(Number.isFinite(distinct) ? { distinctStates: distinct } : {}) };
	const withTrace = trace.length ? { trace } : {};
	const inv = messages.find((m) => m.code === 2110 || m.code === 2107);
	if (inv) {
		const name = /Invariant (\S+) is violated/.exec(inv.text)?.[1];
		return { passed: false, reason: "invariant", errors: [], ...(name ? { violated: name } : {}), ...withTrace, ...base };
	}
	if (messages.some((m) => m.code === 2114)) return { passed: false, reason: "deadlock", errors: [], ...withTrace, ...base };
	if (messages.some((m) => m.code === 2116)) return { passed: false, reason: "property", errors: [], ...withTrace, ...base };
	const failures = messages.filter((m) => m.severity === 1 && m.code !== 2121 && m.code !== 2264);
	if (failures.length || !messages.some((m) => m.code === 2193)) {
		const errors = failures.slice(0, MAX_ERRORS).map((m) => {
			const line = /line (\d+), col/i.exec(m.text);
			const r = line ? map(Number(line[1])) : null;
			return { line: r && !r.inTranslation ? r.line : null, message: clip(remapText(m.text, map)), ...(r?.inTranslation ? { inTranslation: true } : {}) };
		});
		if (!errors.length) {
			const tail = run.output.replace(/@!@!@(?:START|END)MSG[^@]*@!@!@/g, "").trim().split("\n").slice(-6).join("\n");
			errors.push({ line: null, message: clip(tail || `TLC stopped (exit ${run.exitCode}).`) });
		}
		return { passed: false, reason: "tlc-error", errors, ...withTrace, ...base };
	}
	return { passed: true, reason: "passed", errors: [], ...base };
}

/** An error inside the PlusCal translation names no line the learner
 *  wrote; when it quotes an identifier (`totl'), point at the first line
 *  of the document that uses it. */
function locateInSource(errors: TlaError[], document: string): TlaError[] {
	const lines = document.split("\n");
	return errors.map((e) => {
		if (!e.inTranslation) return e;
		const ident = /`([A-Za-z_][A-Za-z0-9_]*)'/.exec(e.message)?.[1];
		if (!ident) return e;
		const re = new RegExp(`(^|[^A-Za-z0-9_])${ident}([^A-Za-z0-9_]|$)`);
		const at = lines.findIndex((l) => re.test(l));
		return at >= 0 ? { line: at + 1, message: e.message.replace(/^In the PlusCal translation of your algorithm: /, "") } : e;
	});
}

/** Grade a parse-and-check result (translation, SANY, main run). */
export function gradeTlaCheck(ex: ResolvedTlaExercise, solution: string, result: TlaCheckResult, parseOnly = false): TlaVerdict {
	const ms = result.ms;
	if (result.error) return { passed: false, reason: "tlc-error", errors: [{ line: null, message: clip(result.error) }], ms };
	const doc = tlaCellDocument(ex, solution);
	if (result.translation && !result.translation.ok) {
		if (result.translation.timedOut) return { passed: false, reason: "timeout", errors: [], ms };
		return { passed: false, reason: "translation", errors: parseTranslationErrors(result.translation.output), ms };
	}
	const map = translationLineMap(doc, result.translation?.module);
	if (!result.sany) return { passed: false, reason: "tlc-error", errors: [{ line: null, message: "The module was not parsed." }], ms };
	if (!result.sany.ok) {
		if (result.sany.timedOut) return { passed: false, reason: "timeout", errors: [], ms };
		return { passed: false, reason: "parse", errors: locateInSource(parseSanyErrors(result.sany.output, ex.moduleName, map), doc), ms };
	}
	if (parseOnly) return { passed: true, reason: "passed", errors: [], ms };
	return gradeMainRun(result.runs?.find((r) => r.id === "main"), map, ms);
}

/** Grade the witness runs: a witness is reached when TLC reports its
 *  invariant violated. */
export function gradeTlaWitnesses(ex: ResolvedTlaExercise, base: TlaVerdict, result: TlaCheckResult): TlaVerdict {
	const ms = base.ms + result.ms;
	const unreachable: string[] = [];
	for (let i = 0; i < ex.witnesses.length; i++) {
		const run = result.runs?.find((r) => r.id === `witness-${i + 1}`);
		if (!run || run.timedOut) return { ...base, passed: false, reason: "timeout", ms };
		const messages = parseTlcMessages(run.output);
		const reached = messages.some((m) => (m.code === 2110 || m.code === 2107) && m.text.includes(`${WITNESS_PREFIX}${i + 1}`));
		if (reached) continue;
		if (messages.some((m) => m.code === 2193)) unreachable.push(ex.witnesses[i]!.label);
		else {
			const failure = messages.find((m) => m.severity === 1);
			return {
				...base,
				passed: false,
				reason: "tlc-error",
				errors: [{ line: null, message: clip(`While checking "${ex.witnesses[i]!.label}": ${failure?.text ?? `TLC stopped (exit ${run.exitCode}).`}`) }],
				ms,
			};
		}
	}
	if (unreachable.length) return { ...base, passed: false, reason: "witness-unreachable", unreachable, ms };
	return { ...base, ms };
}

/** One line for the learner and the teacher. */
export function tlaVerdictSummary(v: TlaVerdict): string {
	switch (v.reason) {
		case "passed":
			return `TLC finds no error${v.distinctStates !== undefined ? ` (${v.distinctStates} distinct states)` : ""}.`;
		case "solution":
			return v.errors[0]?.message ?? "The solution cannot be checked.";
		case "translation":
			return "The PlusCal translator reports an error.";
		case "parse":
			return `SANY reports ${v.errors.length === 1 ? "an error" : `${v.errors.length} errors`}.`;
		case "invariant":
			return `Invariant ${v.violated ?? ""} is violated.`.replace("  ", " ");
		case "property":
			return "A temporal property is violated.";
		case "deadlock":
			return "TLC reached a deadlock.";
		case "tlc-error":
			return "TLC stopped with an error.";
		case "witness-unreachable":
			return `Not reachable: ${(v.unreachable ?? []).join("; ")}.`;
		case "timeout":
			return "TLC ran out of time (the state space may be too large).";
		case "unavailable":
			return "The TLA+ checker is unavailable.";
	}
}

/** The checking port the agent and server layers share (the service over
 *  HTTP, src/server/tla-service.ts). Throws when it cannot be reached. */
export type TlaChecker = (request: TlaCheckRequest) => Promise<TlaCheckResult>;

/** Check one solution: translate, parse, the main model, then the
 *  witnesses (only when the main model passes). */
export async function checkTlaSolution(check: TlaChecker, ex: ResolvedTlaExercise, solution: string): Promise<TlaVerdict> {
	const problems = tlaSolutionProblems(solution);
	if (problems.length) return { passed: false, reason: "solution", errors: problems.map((message) => ({ line: null, message })), ms: 0 };
	const source = tlaCellDocument(ex, solution);
	const pluscal = ex.mode === "pluscal";
	const main = gradeTlaCheck(ex, solution, await check({ module: source, pluscal, runs: [tlaMainRun(ex)] }));
	if (!main.passed || ex.witnesses.length === 0) return main;
	return gradeTlaWitnesses(ex, main, await check({ module: source, pluscal, runs: tlaWitnessRuns(ex) }));
}

/** Translate and parse only (the editor's live errors). */
export async function parseTlaSolution(check: TlaChecker, ex: ResolvedTlaExercise, solution: string): Promise<TlaVerdict> {
	const problems = tlaSolutionProblems(solution);
	if (problems.length) return { passed: false, reason: "solution", errors: problems.map((message) => ({ line: null, message })), ms: 0 };
	const result = await check({ module: tlaCellDocument(ex, solution), pluscal: ex.mode === "pluscal", runs: [] });
	return gradeTlaCheck(ex, solution, result, true);
}

/** Read an exercise from a persisted call input (tla_exercise, or a
 *  practice problem's `tla` block); null when malformed. */
export function tlaExerciseFromInput(input: unknown, question = ""): ResolvedTlaExercise | null {
	const i = input as Partial<TlaExercise> | null;
	if (!i || typeof i.head !== "string" || typeof i.tail !== "string" || !i.config || typeof i.config !== "object") return null;
	return resolveTlaExercise({
		question: typeof i.question === "string" ? i.question : question,
		mode: i.mode === "pluscal" ? "pluscal" : "tla",
		head: i.head,
		starter: typeof i.starter === "string" ? i.starter : undefined,
		tail: i.tail,
		config: i.config,
		witnesses: Array.isArray(i.witnesses) ? i.witnesses.filter((w) => w && typeof w.label === "string" && typeof w.expression === "string") : [],
	});
}
