/**
 * The server side of C++ code cells (owner, 2026-11-09). The client sends
 * only the learner's solution; the server rebuilds the cell from the
 * PERSISTED call (the exact locked head/tail and the tutor's tests, hidden
 * ones included), compiles and runs it, and stores its own verdict. A client
 * can therefore not change what is tested or claim a pass.
 *
 * The same lookup serves the editor's live syntax check and the Check button
 * (app/api/cpp/check): Check runs the visible tests only; nothing is
 * recorded.
 */
import {
	checkCppSolution,
	CPP_EXERCISE_TOOL,
	cppExerciseFromInput,
	cppVerdictSummary,
	MAX_CPP_SOLUTION_CHARS,
	syntaxCheckCpp,
	type CppChecker,
	type CppVerdict,
	type ResolvedCppExercise,
} from "../core/cpp-cell.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { stores } from "./stores.ts";
import { cppChecker } from "./cpp-service.ts";

export class CppAnswerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** The exercise behind a persisted call: a cpp_exercise, or a practice
 *  problem's `cpp` block. */
export function cppExerciseOfCall(messages: readonly LhMessage[], toolCallId: string): ResolvedCppExercise | null {
	for (const m of messages) {
		const a = m as { role?: string; content?: unknown };
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const b of a.content as Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>) {
			if (b.type !== "toolCall" || b.id !== toolCallId) continue;
			if (b.name === CPP_EXERCISE_TOOL) return cppExerciseFromInput(b.arguments);
			if (b.name === "problem" && b.arguments?.cpp) return cppExerciseFromInput(b.arguments.cpp, String(b.arguments.statement ?? ""));
			return null;
		}
	}
	return null;
}

function referenceOf(input: unknown): string | undefined {
	const r = (input as { referenceSolution?: unknown } | null)?.referenceSolution;
	return typeof r === "string" ? r : undefined;
}

/** Run the tools on a solution: "syntax" (live), "check" (visible tests),
 *  or "submit" (every test). */
export async function runCppCheck(
	exercise: ResolvedCppExercise,
	solution: string,
	check: CppChecker | null,
	mode: "syntax" | "check" | "submit",
): Promise<{ verdict: CppVerdict; summary: string }> {
	if (solution.length > MAX_CPP_SOLUTION_CHARS) throw new CppAnswerError("The solution is too long.", 400);
	if (!check) throw new CppAnswerError("The C++ checker is not available on this server.", 503);
	let verdict: CppVerdict;
	try {
		verdict = mode === "syntax" ? await syntaxCheckCpp(check, exercise, solution) : await checkCppSolution(check, exercise, solution, mode === "check" ? "visible" : "all");
	} catch (err) {
		throw new CppAnswerError(`The C++ checker could not run: ${(err as Error).message} Try again in a moment.`, 503);
	}
	return { verdict, summary: cppVerdictSummary(verdict) };
}

/** Grade a submission (every test) against an exercise input. */
export async function gradeCppSolution(
	exerciseInput: unknown,
	solution: string,
	check: CppChecker | null,
): Promise<{ verdict: CppVerdict; summary: string; referenceSolution?: string }> {
	const exercise = cppExerciseFromInput(exerciseInput);
	if (!exercise) throw new CppAnswerError("The code cell's exercise is malformed.", 400);
	const graded = await runCppCheck(exercise, solution, check, "submit");
	const reference = referenceOf(exerciseInput);
	return { ...graded, ...(reference !== undefined ? { referenceSolution: reference } : {}) };
}

/** The graded answer for the pending cpp_exercise call `callInput`.
 *  Dismissals pass through untouched. */
export async function gradeCppAnswer(callInput: unknown, answer: QuestionAnswerData, check: CppChecker | null): Promise<QuestionAnswerData> {
	if (answer.dismissed) return answer;
	const input = callInput as { question?: unknown };
	if (typeof input?.question !== "string") throw new CppAnswerError("The code cell's exercise is malformed.", 400);
	const solution = typeof answer.text === "string" ? answer.text : "";
	const { verdict, summary, referenceSolution } = await gradeCppSolution(callInput, solution, check);
	return {
		kind: "cpp",
		tool: CPP_EXERCISE_TOOL,
		questionText: input.question,
		dontKnow: false,
		answers: [],
		correct: verdict.passed,
		...(answer.thinking ? { thinking: answer.thinking } : {}),
		...(answer.readingThinking ? { readingThinking: answer.readingThinking } : {}),
		cpp: { solution, verdict, summary, ...(referenceSolution !== undefined ? { referenceSolution } : {}) },
		answeredAt: new Date().toISOString(),
	};
}

/** The editor's live check and the Check button (app/api/cpp/check). */
export async function cppCellCheckResponse(body: unknown): Promise<Response> {
	const b = body as { chatId?: unknown; toolCallId?: unknown; solution?: unknown; mode?: unknown } | null;
	if (!b || typeof b.chatId !== "string" || typeof b.toolCallId !== "string" || typeof b.solution !== "string" || (b.mode !== "syntax" && b.mode !== "check")) {
		return Response.json({ error: 'Expected {chatId, toolCallId, solution, mode: "syntax" | "check"}' }, { status: 400 });
	}
	const record = stores.chatStore.getChat(b.chatId);
	if (!record) return Response.json({ error: "Chat not found." }, { status: 404 });
	const exercise = cppExerciseOfCall(record.messages, b.toolCallId);
	if (!exercise) return Response.json({ error: "No C++ exercise with that id in this chat." }, { status: 404 });
	try {
		return Response.json(await runCppCheck(exercise, b.solution, cppChecker(), b.mode));
	} catch (err) {
		if (err instanceof CppAnswerError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
