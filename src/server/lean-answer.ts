/**
 * The server-side grade of a Lean code cell answer (owner, 2026-10-30:
 * "Locked + checked"). The client sends only the learner's proof (answer
 * kind "lean", text = proof); the server rebuilds the cell from the
 * PERSISTED tool call — the exact locked prelude and statement — runs Lean,
 * and stores its own verdict as the answer. A client can therefore not
 * change the statement or claim a pass.
 */
import { checkLeanProof, resolveLeanExercise, verdictSummary, type LeanChecker } from "../core/lean-cell.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";

export class LeanAnswerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const MAX_PROOF_CHARS = 50_000;

/** The graded answer for the pending lean_exercise call `callInput`.
 *  Dismissals pass through untouched. */
export async function gradeLeanAnswer(
	callInput: unknown,
	answer: QuestionAnswerData,
	check: LeanChecker | null,
): Promise<QuestionAnswerData> {
	if (answer.dismissed) return answer;
	const input = callInput as { question?: string; prelude?: string; statement?: string; starter?: string; referenceProof?: string };
	if (typeof input?.statement !== "string" || typeof input.question !== "string") {
		throw new LeanAnswerError("The code cell's exercise is malformed.", 400);
	}
	const proof = typeof answer.text === "string" ? answer.text : "";
	if (proof.length > MAX_PROOF_CHARS) throw new LeanAnswerError("The proof is too long.", 400);
	if (!check) throw new LeanAnswerError("Lean is not available on this server.", 503);
	const exercise = resolveLeanExercise({ question: input.question, prelude: input.prelude, statement: input.statement, starter: input.starter });
	let verdict;
	try {
		verdict = await checkLeanProof(check, exercise, proof);
	} catch (err) {
		throw new LeanAnswerError(`Lean could not check the proof: ${(err as Error).message} Try again in a moment.`, 503);
	}
	return {
		kind: "lean",
		tool: "lean_exercise",
		questionText: input.question,
		dontKnow: false,
		answers: [],
		correct: verdict.passed,
		...(answer.thinking ? { thinking: answer.thinking } : {}),
		...(answer.readingThinking ? { readingThinking: answer.readingThinking } : {}),
		lean: {
			proof,
			verdict,
			summary: verdictSummary(verdict),
			...(typeof input.referenceProof === "string" ? { referenceProof: input.referenceProof } : {}),
		},
		answeredAt: new Date().toISOString(),
	};
}
