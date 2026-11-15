/**
 * Read-only lookups in a saved session (ctx.learning.getSession). The saved
 * record is read defensively: any shape we do not recognize counts as "not
 * ours", never as an error.
 */
import { PLUGIN_ID, PROBLEM_TOOL, QUESTION_TOOL, LANGUAGES, isLanguage, type Language } from "../contract.ts";

/** The host's own question tools (src/core/pending.ts QUESTION_TOOLS). */
const NATIVE_QUESTION_TOOLS = new Set(["quiz", "probe", "ask_user_question", "explain", "recall"]);
const OUR_QUESTION_TOOLS = new Set<string>(LANGUAGES.map((l) => QUESTION_TOOL[l]));
const OUR_PROBLEM_TOOLS = new Set<string>(LANGUAGES.map((l) => PROBLEM_TOOL[l]));

interface ToolResultLike {
	role: "toolResult";
	toolName?: unknown;
	details?: unknown;
}

function messagesOf(record: unknown): readonly unknown[] {
	const messages = (record as { messages?: unknown } | null)?.messages;
	return Array.isArray(messages) ? messages : [];
}

function toolResults(record: unknown): ToolResultLike[] {
	return messagesOf(record).filter((m): m is ToolResultLike => (m as { role?: unknown } | null)?.role === "toolResult");
}

function detailsKind(result: ToolResultLike): unknown {
	return (result.details as { kind?: unknown } | null | undefined)?.kind;
}

/** Was the newest answered/dismissed question in this session one of our
 *  code cells? (The question being posed has no result yet.) */
export function previousQuestionWasCodeCell(record: unknown): boolean {
	const results = toolResults(record);
	for (let i = results.length - 1; i >= 0; i--) {
		const r = results[i]!;
		const name = typeof r.toolName === "string" ? r.toolName : "";
		if (OUR_QUESTION_TOOLS.has(name)) return true;
		const kind = detailsKind(r);
		if (NATIVE_QUESTION_TOOLS.has(name) || kind === "plugin-question" || kind === "plugin-question-cancelled") return false;
	}
	return false;
}

/** Was the newest problem posed in this session one of our code problems? */
export function previousProblemWasCodeCell(record: unknown): boolean {
	const results = toolResults(record);
	for (let i = results.length - 1; i >= 0; i--) {
		const r = results[i]!;
		const name = typeof r.toolName === "string" ? r.toolName : "";
		if (OUR_PROBLEM_TOOLS.has(name)) return true;
		if (name === "problem" || (r.details as { pluginProblem?: unknown } | null | undefined)?.pluginProblem) return false;
	}
	return false;
}

export interface AnsweredCodeCell {
	questionId: string;
	language: Language;
	passed: boolean;
}

/** The newest answered code-cell question (teaching), if any. */
export function latestAnsweredCodeCell(record: unknown): AnsweredCodeCell | null {
	const results = toolResults(record);
	for (let i = results.length - 1; i >= 0; i--) {
		const d = results[i]!.details as { kind?: unknown; pluginId?: unknown; typeId?: unknown; questionId?: unknown; grading?: { result?: { passed?: unknown } } } | null | undefined;
		if (d?.kind !== "plugin-question" || d.pluginId !== PLUGIN_ID || !isLanguage(d.typeId) || typeof d.questionId !== "string") continue;
		return { questionId: d.questionId, language: d.typeId, passed: d.grading?.result?.passed === true };
	}
	return null;
}

/** The saved payload of a posed code cell: a teaching question (by question
 *  id) or a practice problem (by problem id). Null when not found. */
export function savedExercise(record: unknown, id: string): { language: Language; question: string; payload: Record<string, unknown> } | null {
	for (const m of messagesOf(record)) {
		const message = m as { role?: unknown; lhQuestions?: unknown; details?: unknown };
		if (message.role === "assistant" && message.lhQuestions && typeof message.lhQuestions === "object") {
			for (const entry of Object.values(message.lhQuestions as Record<string, unknown>)) {
				const s = entry as { questionId?: unknown; pluginId?: unknown; typeId?: unknown; input?: { question?: unknown; payload?: unknown } } | null;
				if (s?.questionId === id && s.pluginId === PLUGIN_ID && isLanguage(s.typeId) && s.input?.payload && typeof s.input.payload === "object") {
					return { language: s.typeId, question: typeof s.input.question === "string" ? s.input.question : "", payload: s.input.payload as Record<string, unknown> };
				}
			}
		}
		if (message.role === "toolResult") {
			const p = (message.details as { pluginProblem?: { problemId?: unknown; pluginId?: unknown; typeId?: unknown; input?: { statement?: unknown; payload?: unknown } } } | null | undefined)?.pluginProblem;
			if (p?.problemId === id && p.pluginId === PLUGIN_ID && isLanguage(p.typeId) && p.input?.payload && typeof p.input.payload === "object") {
				return { language: p.typeId, question: typeof p.input.statement === "string" ? p.input.statement : "", payload: p.input.payload as Record<string, unknown> };
			}
		}
	}
	return null;
}
