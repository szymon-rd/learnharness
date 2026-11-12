/**
 * The server-side grade of a Rocq code cell answer (owner, 2026-11-12, the
 * same as Lean's src/server/lean-answer.ts): the client sends only the
 * learner's proof; the server rebuilds the cell from the PERSISTED call (the
 * exact locked prelude and statement), runs Rocq, and stores its own
 * verdict. A client can therefore not change the statement or claim a pass.
 */
import { checkRocqProof, resolveRocqExercise, ROCQ_EXERCISE_TOOL, rocqVerdictSummary, type RocqChecker, type RocqVerdict } from "../core/rocq-cell.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";

export class RocqAnswerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const MAX_PROOF_CHARS = 50_000;

/** Grade a proof against an exercise from a persisted call (the
 *  rocq_exercise input, or a practice problem's `rocq` block). */
export async function gradeRocqProof(
	exerciseInput: unknown,
	proof: string,
	check: RocqChecker | null,
): Promise<{ verdict: RocqVerdict; summary: string; referenceProof?: string }> {
	const input = exerciseInput as { question?: string; prelude?: string; statement?: string; starter?: string; referenceProof?: string };
	if (typeof input?.statement !== "string") throw new RocqAnswerError("The code cell's exercise is malformed.", 400);
	if (proof.length > MAX_PROOF_CHARS) throw new RocqAnswerError("The proof is too long.", 400);
	if (!check) throw new RocqAnswerError("Rocq is not available on this server.", 503);
	const exercise = resolveRocqExercise({ question: input.question ?? "", prelude: input.prelude, statement: input.statement, starter: input.starter });
	let verdict;
	try {
		verdict = await checkRocqProof(check, exercise, proof);
	} catch (err) {
		throw new RocqAnswerError(`Rocq could not check the proof: ${(err as Error).message} Try again in a moment.`, 503);
	}
	return { verdict, summary: rocqVerdictSummary(verdict), ...(typeof input.referenceProof === "string" ? { referenceProof: input.referenceProof } : {}) };
}

/** The graded answer for the pending rocq_exercise call. Dismissals pass
 *  through untouched. */
export async function gradeRocqAnswer(callInput: unknown, answer: QuestionAnswerData, check: RocqChecker | null): Promise<QuestionAnswerData> {
	if (answer.dismissed) return answer;
	const input = callInput as { question?: string; statement?: string };
	if (typeof input?.statement !== "string" || typeof input.question !== "string") throw new RocqAnswerError("The code cell's exercise is malformed.", 400);
	const proof = typeof answer.text === "string" ? answer.text : "";
	const { verdict, summary, referenceProof } = await gradeRocqProof(callInput, proof, check);
	return {
		kind: "rocq",
		tool: ROCQ_EXERCISE_TOOL,
		questionText: input.question,
		dontKnow: false,
		answers: [],
		correct: verdict.passed,
		...(answer.thinking ? { thinking: answer.thinking } : {}),
		...(answer.readingThinking ? { readingThinking: answer.readingThinking } : {}),
		rocq: { proof, verdict, summary, ...(referenceProof !== undefined ? { referenceProof } : {}) },
		answeredAt: new Date().toISOString(),
	};
}
