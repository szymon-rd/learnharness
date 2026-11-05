/**
 * The server side of TLA+ code cells (owner, 2026-11-05). The client sends
 * only the learner's solution; the server rebuilds the module from the
 * PERSISTED call (the exact locked head, tail and TLC model), runs the
 * tools, and stores its own verdict. A client can therefore not change what
 * is checked or claim a pass.
 *
 * The same lookup serves the editor's live parse and the Check button
 * (app/api/tla/*): they grade the same way but record nothing.
 */
import {
	checkTlaSolution,
	MAX_TLA_SOLUTION_CHARS,
	parseTlaSolution,
	TLA_EXERCISE_TOOL,
	tlaExerciseFromInput,
	tlaVerdictSummary,
	type ResolvedTlaExercise,
	type TlaChecker,
	type TlaVerdict,
} from "../core/tla-cell.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { stores } from "./stores.ts";
import { tlaChecker } from "./tla-service.ts";

export class TlaAnswerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** The exercise behind a persisted call: a tla_exercise, or a practice
 *  problem's `tla` block. */
export function tlaExerciseOfCall(messages: readonly LhMessage[], toolCallId: string): ResolvedTlaExercise | null {
	for (const m of messages) {
		const a = m as { role?: string; content?: unknown };
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const b of a.content as Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>) {
			if (b.type !== "toolCall" || b.id !== toolCallId) continue;
			if (b.name === TLA_EXERCISE_TOOL) return tlaExerciseFromInput(b.arguments);
			if (b.name === "problem" && b.arguments?.tla) return tlaExerciseFromInput(b.arguments.tla, String(b.arguments.statement ?? ""));
			return null;
		}
	}
	return null;
}

function referenceOf(input: unknown): string | undefined {
	const r = (input as { referenceSolution?: unknown } | null)?.referenceSolution;
	return typeof r === "string" ? r : undefined;
}

/** Run the tools on a solution of an exercise (full check or parse only). */
export async function runTlaCheck(
	exercise: ResolvedTlaExercise,
	solution: string,
	check: TlaChecker | null,
	mode: "check" | "parse",
): Promise<{ verdict: TlaVerdict; summary: string }> {
	if (solution.length > MAX_TLA_SOLUTION_CHARS) throw new TlaAnswerError("The solution is too long.", 400);
	if (!check) throw new TlaAnswerError("The TLA+ checker is not available on this server.", 503);
	let verdict: TlaVerdict;
	try {
		verdict = mode === "check" ? await checkTlaSolution(check, exercise, solution) : await parseTlaSolution(check, exercise, solution);
	} catch (err) {
		throw new TlaAnswerError(`The TLA+ checker could not run: ${(err as Error).message} Try again in a moment.`, 503);
	}
	return { verdict, summary: tlaVerdictSummary(verdict) };
}

/** Grade a practice submission against the problem's `tla` block. */
export async function gradeTlaSolution(
	exerciseInput: unknown,
	solution: string,
	check: TlaChecker | null,
): Promise<{ verdict: TlaVerdict; summary: string; referenceSolution?: string }> {
	const exercise = tlaExerciseFromInput(exerciseInput);
	if (!exercise) throw new TlaAnswerError("The code cell's exercise is malformed.", 400);
	const graded = await runTlaCheck(exercise, solution, check, "check");
	const reference = referenceOf(exerciseInput);
	return { ...graded, ...(reference !== undefined ? { referenceSolution: reference } : {}) };
}

/** The graded answer for the pending tla_exercise call `callInput`.
 *  Dismissals pass through untouched. */
export async function gradeTlaAnswer(callInput: unknown, answer: QuestionAnswerData, check: TlaChecker | null): Promise<QuestionAnswerData> {
	if (answer.dismissed) return answer;
	const input = callInput as { question?: unknown };
	if (typeof input?.question !== "string") throw new TlaAnswerError("The code cell's exercise is malformed.", 400);
	const solution = typeof answer.text === "string" ? answer.text : "";
	const { verdict, summary, referenceSolution } = await gradeTlaSolution(callInput, solution, check);
	return {
		kind: "tla",
		tool: TLA_EXERCISE_TOOL,
		questionText: input.question,
		dontKnow: false,
		answers: [],
		correct: verdict.passed,
		...(answer.thinking ? { thinking: answer.thinking } : {}),
		...(answer.readingThinking ? { readingThinking: answer.readingThinking } : {}),
		tla: { solution, verdict, summary, ...(referenceSolution !== undefined ? { referenceSolution } : {}) },
		answeredAt: new Date().toISOString(),
	};
}

/** The editor's live parse and the Check button (app/api/tla/check): run
 *  the tools on a solution of a persisted exercise; nothing is recorded. */
export async function tlaCellCheckResponse(body: unknown): Promise<Response> {
	const b = body as { chatId?: unknown; toolCallId?: unknown; solution?: unknown; mode?: unknown } | null;
	if (!b || typeof b.chatId !== "string" || typeof b.toolCallId !== "string" || typeof b.solution !== "string" || (b.mode !== "check" && b.mode !== "parse")) {
		return Response.json({ error: "Expected {chatId, toolCallId, solution, mode: \"check\" | \"parse\"}" }, { status: 400 });
	}
	const record = stores.chatStore.getChat(b.chatId);
	if (!record) return Response.json({ error: "Chat not found." }, { status: 404 });
	const exercise = tlaExerciseOfCall(record.messages, b.toolCallId);
	if (!exercise) return Response.json({ error: "No TLA+ exercise with that id in this chat." }, { status: 404 });
	try {
		return Response.json(await runTlaCheck(exercise, b.solution, tlaChecker(), b.mode));
	} catch (err) {
		if (err instanceof TlaAnswerError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
