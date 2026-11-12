import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import {
	checkRocqProof,
	DEFAULT_ROCQ_PRELUDE,
	DEFAULT_ROCQ_STARTER,
	resolveRocqExercise,
	ROCQ_EXERCISE_TOOL,
	rocqExerciseProblems,
	rocqVerdictSummary,
	type RocqChecker,
	type RocqVerdict,
} from "../../core/rocq-cell.ts";
import { planCodeCells } from "../../core/contracts.ts";
import { isCodeCellTool, previousQuestionTool, type CodeCellToolContext } from "./lean.ts";

/**
 * rocq_exercise — the tutor's Rocq code cell (owner, 2026-11-12: "the same
 * as the Lean kernel, with Iris"). A CLIENT-ANSWERED question tool like
 * lean_exercise: the turn ends, the learner writes the proof in the cell
 * (live coq-lsp feedback: errors and goals), and on submit the SERVER
 * re-checks the exact statement (src/server/rocq-answer.ts).
 *
 * Gates (registered only when the "Code cells" setting is "Mixed in" and the
 * server has the Rocq service): the plan marked codeCells "rocq"; not two
 * code cells in a row unless the learner asked; the hidden reference proof
 * passes Rocq.
 */

/** Exercise fields shared by rocq_exercise and a practice problem's `rocq` block. */
export const rocqExerciseFields = {
	prelude: Type.Optional(
		Type.String({
			description:
				`Locked lines before the statement: Require/Import lines. Default: "${DEFAULT_ROCQ_PRELUDE}". Iris is available, e.g. ` +
				'"From iris.proofmode Require Import proofmode.\\nFrom iris.base_logic Require Import iprop." or for HeapLang ' +
				'"From iris.heap_lang Require Import proofmode notation.". No Section or Module: put binders such as `{!heapGS Σ} in the statement.',
		}),
	),
	statement: Type.String({
		minLength: 1,
		description: "Locked: exactly one `Lemma <fresh_name> … .` (or Theorem) ending in a period. The learner cannot edit it; the check re-uses it verbatim.",
	}),
	starter: Type.Optional(
		Type.String({
			description: `The editable proof the learner starts from. Default: "${DEFAULT_ROCQ_STARTER.replace("\n", "\\n")}". May hold a partial proof ending in Admitted.`,
		}),
	),
	referenceProof: Type.String({
		minLength: 1,
		description: "Your complete proof, `Proof. … Qed.`. Checked with Rocq before the learner sees the cell; shown to them only after they submit.",
	}),
};

export const rocqExerciseInput = Type.Object({
	nodeId: Type.String({ description: "The plan node this exercise is about — validated at call time against the session's plan map." }),
	question: Type.String({ minLength: 1, description: "The task shown above the cell (markdown + LaTeX): what to prove and any hint about the approach." }),
	...rocqExerciseFields,
	learnerAsked: Type.Optional(Type.Boolean({ description: "True only when the learner asked for another code exercise right after the previous one." })),
});

export interface RocqToolContext extends CodeCellToolContext {
	rocq: RocqChecker;
}

export function rocqReferenceProblems(field: string, verdict: RocqVerdict): string[] {
	return [
		`${field} does not pass: ${rocqVerdictSummary(verdict)}`,
		...verdict.errors.map((e) => `${e.line > 0 ? `proof line ${e.line}` : "statement/prelude"}: ${e.message}`),
	];
}

export function rocqExerciseToolFor(ctx: RocqToolContext, nodeIdProblem: (nodeId: string) => string | null): AgentTool<typeof rocqExerciseInput> {
	return {
		name: ROCQ_EXERCISE_TOOL,
		label: ROCQ_EXERCISE_TOOL,
		description:
			"Pose a Rocq proof exercise as an editable code cell (Rocq 9 with the standard library, Iris and HeapLang). The " +
			"learner sees `question`, the locked `prelude` and `statement`, and edits the proof below them with live feedback " +
			"(goals, errors). On submit the server checks the proof against the exact statement: it passes when Rocq reports no " +
			"error, the lemma is not Admitted, and it uses no axiom declared in the cell (library axioms are fine). The verdict " +
			"and the proof come back as the result. Your referenceProof is checked first: if it fails, the errors come back and " +
			'you fix the exercise. Only for sessions about Rocq (or Iris): the plan must be marked codeCells: "rocq". Mix it ' +
			"with your other checks — never two code cells in a row unless the learner asked (learnerAsked). ONE question per " +
			"turn: call it, then end your turn.",
		parameters: rocqExerciseInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = rocqExerciseProblems(input);
			const nodeText = nodeIdProblem(input.nodeId);
			if (nodeText) problems.push(nodeText);
			const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
			if (tree && planCodeCells(tree) !== "rocq") {
				problems.push(
					"This session's plan is not marked as a Rocq topic, so Rocq code cells are off here. Use quiz/explain; " +
						'if the session IS about Rocq or Iris, re-call plan_init with codeCells: "rocq".',
				);
			}
			if (isCodeCellTool(previousQuestionTool(ctx, toolCallId)) && input.learnerAsked !== true) {
				problems.push(
					"The previous question was already a code cell. Mix them in: pose a different check first, unless the learner asked for another exercise (then set learnerAsked: true).",
				);
			}
			if (problems.length > 0) return invalidInputResult(ROCQ_EXERCISE_TOOL, problems);
			let verdict;
			try {
				verdict = await checkRocqProof(ctx.rocq, resolveRocqExercise(input), input.referenceProof);
			} catch (err) {
				return invalidInputResult(ROCQ_EXERCISE_TOOL, [`Rocq is unavailable right now (${(err as Error).message}). Use quiz or explain for this check instead.`]);
			}
			if (!verdict.passed) return invalidInputResult(ROCQ_EXERCISE_TOOL, rocqReferenceProblems("referenceProof", verdict));
			return questionResult();
		},
	};
}
