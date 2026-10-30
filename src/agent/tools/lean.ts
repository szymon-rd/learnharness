import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import {
	checkLeanProof,
	DEFAULT_LEAN_PRELUDE,
	DEFAULT_LEAN_STARTER,
	LEAN_EXERCISE_TOOL,
	leanExerciseProblems,
	resolveLeanExercise,
	verdictSummary,
	type LeanChecker,
} from "../../core/lean-cell.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import type { PlanToolContext } from "./plan.ts";

/**
 * lean_exercise — the teacher's Lean code cell (owner, 2026-10-30). A
 * CLIENT-ANSWERED question tool like quiz: the turn ends, the learner
 * writes the proof in the cell (live Lean feedback in the editor), and on
 * submit the SERVER re-checks the exact statement and returns the verdict
 * (src/server/lean-answer.ts) as the tool result.
 *
 * Registered only when the "Code cells" setting is "Mixed in" and the
 * server has Lean (codeCellsEnabled). Per call it further requires:
 *   - the plan marked as a Lean topic (plan_init codeCells) — code cells
 *     never appear in maths/physics/logic sessions that are not about Lean;
 *   - the previous question was not also a code cell, unless the learner
 *     asked for another (learnerAsked) — they stay mixed in;
 *   - the hidden referenceProof passes Lean, so every exercise is solvable.
 */

export const leanExerciseInput = Type.Object({
	nodeId: Type.String({
		description: "The plan node this exercise is about — validated at call time against the session's plan map.",
	}),
	question: Type.String({
		minLength: 1,
		description: "The task shown above the cell (markdown + LaTeX): what to prove and any hint about the approach.",
	}),
	prelude: Type.Optional(
		Type.String({
			description: `Locked lines before the statement: imports and \`open\`s. Default: "${DEFAULT_LEAN_PRELUDE}". No \`namespace\`.`,
		}),
	),
	statement: Type.String({
		minLength: 1,
		description:
			"Locked: exactly one `theorem <fresh_name> … := by` (or `lemma`). The learner cannot edit it; the check re-uses it verbatim.",
	}),
	starter: Type.Optional(
		Type.String({
			description: `The editable proof the learner starts from, indented under the statement. Default: "${DEFAULT_LEAN_STARTER}". May hold a partial proof with \`sorry\` holes.`,
		}),
	),
	referenceProof: Type.String({
		minLength: 1,
		description:
			"Your complete tactic proof (indented like the starter). Checked with Lean before the learner sees the cell; shown to him only after he submits.",
	}),
	learnerAsked: Type.Optional(
		Type.Boolean({
			description: "True only when the learner asked for another code exercise right after the previous one.",
		}),
	),
});

export interface LeanToolContext extends Pick<PlanToolContext, "chatId" | "chatStore"> {
	/** Runs Lean (the configured service). */
	lean: LeanChecker;
}

/** The newest question call before `toolCallId` in the record, if any. */
function previousQuestionTool(ctx: LeanToolContext, toolCallId: string): string | null {
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (let j = m.content.length - 1; j >= 0; j--) {
			const block = m.content[j] as { type?: string; id?: string; name?: string };
			if (block.type !== "toolCall" || block.id === toolCallId) continue;
			if ((QUESTION_TOOLS as readonly string[]).includes(block.name ?? "")) return block.name!;
		}
	}
	return null;
}

export function leanExerciseToolFor(
	ctx: LeanToolContext,
	nodeIdProblem: (nodeId: string) => string | null,
): AgentTool<typeof leanExerciseInput> {
	return {
		name: LEAN_EXERCISE_TOOL,
		label: LEAN_EXERCISE_TOOL,
		description:
			"Pose a Lean 4 proof exercise as an editable code cell (Lean + Mathlib). The learner sees `question`, the locked " +
			"`prelude` and `statement`, and edits the proof below them with live Lean feedback (goals, errors). On submit the " +
			"server checks the proof against the exact statement: it passes when Lean reports no errors, no sorry, and only the " +
			"standard axioms (propext, Classical.choice, Quot.sound; no native_decide). The verdict and his proof come back as " +
			"the result. Your referenceProof is checked first: if it fails, the errors come back and you fix the exercise. " +
			"Only for sessions about Lean: the plan must be marked codeCells. Mix it with your other checks — never two code " +
			"cells in a row unless the learner asked (learnerAsked). ONE question per turn: call it, then end your turn.",
		parameters: leanExerciseInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = leanExerciseProblems(input);
			const nodeText = nodeIdProblem(input.nodeId);
			if (nodeText) problems.push(nodeText);
			const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
			if (tree && tree.codeCells !== true) {
				problems.push(
					"This session's plan is not marked as a Lean topic, so code cells are off here. Use quiz/explain; " +
						"if the session IS about Lean, re-call plan_init with codeCells: true.",
				);
			}
			if (previousQuestionTool(ctx, toolCallId) === LEAN_EXERCISE_TOOL && input.learnerAsked !== true) {
				problems.push(
					"The previous question was already a code cell. Mix them in: pose a different check first, unless the learner asked for another exercise (then set learnerAsked: true).",
				);
			}
			if (problems.length > 0) return invalidInputResult(LEAN_EXERCISE_TOOL, problems);

			const exercise = resolveLeanExercise(input);
			let verdict;
			try {
				verdict = await checkLeanProof(ctx.lean, exercise, input.referenceProof);
			} catch (err) {
				return invalidInputResult(LEAN_EXERCISE_TOOL, [
					`Lean is unavailable right now (${(err as Error).message}). Use quiz or explain for this check instead.`,
				]);
			}
			if (!verdict.passed) {
				return invalidInputResult(LEAN_EXERCISE_TOOL, [
					`referenceProof does not pass: ${verdictSummary(verdict)}`,
					...verdict.errors.map((e) => `${e.line > 0 ? `proof line ${e.line}` : "statement/prelude"}: ${e.message}`),
				]);
			}
			return questionResult();
		},
	};
}
