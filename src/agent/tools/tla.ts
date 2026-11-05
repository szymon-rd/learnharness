import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult, toToolResult } from "../tool-execute.ts";
import {
	checkTlaSolution,
	MAX_TLA_WITNESSES,
	resolveTlaExercise,
	TLA_EXERCISE_TOOL,
	TLA_REVIEW_TOOL,
	tlaExerciseProblems,
	tlaVerdictSummary,
	type TlaChecker,
	type TlaVerdict,
} from "../../core/tla-cell.ts";
import { planCodeCells } from "../../core/contracts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { isCodeCellTool, previousQuestionTool, type CodeCellToolContext } from "./lean.ts";

/**
 * tla_exercise — the teacher's TLA+ code cell (owner, 2026-11-05). A
 * CLIENT-ANSWERED question tool like lean_exercise: the turn ends, the
 * learner writes the editable part of a TLA+ (or PlusCal) module, with live
 * SANY errors and a Check button, and on submit the SERVER re-checks it with
 * TLC against the exact locked parts and model (src/server/tla-answer.ts).
 *
 * Gates (registered only when the "Code cells" setting is "Mixed in" and the
 * server has the TLA+ service): the plan marked codeCells "tla"; not two code
 * cells (Lean or TLA+) in a row unless the learner asked; the hidden
 * reference solution passes TLC with every witness reachable.
 *
 * tla_review — after a TLC pass the teacher judges whether the solution does
 * what the task asked; accepted: false overrules the pass in the record.
 */

/** Exercise fields shared by tla_exercise and a practice problem's `tla`
 *  block. */
export const tlaExerciseFields = {
	mode: Type.Optional(
		Type.Union([Type.Literal("tla"), Type.Literal("pluscal")], {
			description:
				'"tla" (default): the learner writes TLA+ definitions. "pluscal": the head opens a PlusCal algorithm in a comment ' +
				"(`(* --algorithm Name` …), the learner writes (part of) the algorithm, the tail closes it (`end algorithm; *)`) and " +
				"defines what is checked; the server translates it (you may put `\\* BEGIN TRANSLATION` / `\\* END TRANSLATION` lines " +
				"in the tail, or the translator adds them right after the algorithm). Use `Spec` as the specification.",
		}),
	),
	head: Type.String({
		minLength: 1,
		description:
			"Locked lines at the top: `---- MODULE <Name> ----` (a fresh name, not a standard module), EXTENDS, CONSTANTS, VARIABLES " +
			"and any definitions you give. The learner cannot edit it.",
	}),
	starter: Type.Optional(
		Type.String({
			description: "The editable text the learner starts from (may be empty or a partial definition with a comment saying what to fill in).",
		}),
	),
	tail: Type.String({
		minLength: 1,
		description:
			"Locked lines at the bottom: e.g. `Spec == Init /\\ [][Next]_vars`, the invariants and properties TLC checks, and the " +
			"closing `====` line (exactly one, at the end).",
	}),
	config: Type.Object(
		{
			constants: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "CONSTANT name → value in .cfg syntax, e.g. {\"N\": \"3\", \"Procs\": \"{p1, p2}\"}. Keep the model small." }),
			),
			specification: Type.Optional(Type.String({ description: "The temporal formula's name (e.g. Spec) — or give init and next instead." })),
			init: Type.Optional(Type.String({ description: "The initial predicate's name (with next)." })),
			next: Type.Optional(Type.String({ description: "The next-state relation's name (with init)." })),
			invariants: Type.Optional(Type.Array(Type.String(), { description: "Names of the invariants TLC checks." })),
			properties: Type.Optional(Type.Array(Type.String(), { description: "Names of the temporal properties TLC checks (needs a specification with fairness where relevant)." })),
			checkDeadlock: Type.Optional(Type.Boolean({ description: "TLC's deadlock check. Default true." })),
		},
		{ description: "The TLC model. The learner sees it read-only under the cell. It must check at least one invariant or property." },
	),
	witnesses: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ minLength: 1, description: "What the state means, shown to the learner (e.g. \"a process enters the critical section\")." }),
				expression: Type.String({ minLength: 1, description: "A one-line state predicate, e.g. pc[1] = \"cs\"." }),
			}),
			{
				maxItems: MAX_TLA_WITNESSES,
				description:
					"States that must be reachable, so a spec that does nothing cannot pass (e.g. Next == UNCHANGED vars satisfies most " +
					"invariants). Give at least one whenever the task is about behavior.",
			},
		),
	),
	referenceSolution: Type.String({
		minLength: 1,
		description:
			"Your complete solution for the editable part. Checked with TLC (and the witnesses) before the learner sees the cell; shown to them only after they submit.",
	}),
};

export const tlaExerciseInput = Type.Object({
	nodeId: Type.String({
		description: "The plan node this exercise is about — validated at call time against the session's plan map.",
	}),
	question: Type.String({
		minLength: 1,
		description: "The task shown above the cell (markdown + LaTeX): what to write and what it must achieve.",
	}),
	...tlaExerciseFields,
	learnerAsked: Type.Optional(
		Type.Boolean({
			description: "True only when the learner asked for another code exercise right after the previous one.",
		}),
	),
});

export interface TlaToolContext extends CodeCellToolContext {
	/** Runs SANY/TLC (the configured service). */
	tla: TlaChecker;
}

/** The problems with the teacher's reference solution, as tool feedback. */
export function referenceProblems(field: string, verdict: TlaVerdict): string[] {
	const out = [`${field} does not pass: ${tlaVerdictSummary(verdict)}`];
	for (const e of verdict.errors) out.push(`${e.line !== null ? `line ${e.line}` : "error"}: ${e.message}`);
	if (verdict.trace?.length) {
		out.push(
			`counterexample: ${verdict.trace
				.slice(0, 12)
				.map((s) => `${s.index}: ${s.action}${s.vars.length ? ` (${s.vars.map((v) => `${v.name} = ${v.value}`).join(", ")})` : ""}`)
				.join(" → ")}`,
		);
	}
	return out;
}

export function tlaExerciseToolFor(
	ctx: TlaToolContext,
	nodeIdProblem: (nodeId: string) => string | null,
): AgentTool<typeof tlaExerciseInput> {
	return {
		name: TLA_EXERCISE_TOOL,
		label: TLA_EXERCISE_TOOL,
		description:
			"Pose a TLA+ (or PlusCal) exercise as an editable code cell checked by TLC. The learner sees `question`, the locked " +
			"`head` and `tail`, the TLC model (read-only), and writes the part between them, with live SANY errors and a Check " +
			"button. On submit the server checks the exact module with TLC: it passes when it translates and parses, TLC explores " +
			"the whole state space with no violated invariant or property and no deadlock (if checked), and every witness is " +
			"reachable. The verdict (with any counterexample) and the solution come back as the result; on a pass, judge whether " +
			"it does what was asked and record that with tla_review. Your referenceSolution is checked first: if it fails, the " +
			'errors come back and you fix the exercise. Only for sessions about TLA+: the plan must be marked codeCells: "tla". ' +
			"Mix it with your other checks — never two code cells in a row unless the learner asked (learnerAsked). ONE question " +
			"per turn: call it, then end your turn.",
		parameters: tlaExerciseInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = tlaExerciseProblems(input);
			const nodeText = nodeIdProblem(input.nodeId);
			if (nodeText) problems.push(nodeText);
			const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
			if (tree && planCodeCells(tree) !== "tla") {
				problems.push(
					"This session's plan is not marked as a TLA+ topic, so TLA+ code cells are off here. Use quiz/explain; " +
						'if the session IS about TLA+, re-call plan_init with codeCells: "tla".',
				);
			}
			if (isCodeCellTool(previousQuestionTool(ctx, toolCallId)) && input.learnerAsked !== true) {
				problems.push(
					"The previous question was already a code cell. Mix them in: pose a different check first, unless the learner asked for another exercise (then set learnerAsked: true).",
				);
			}
			if (problems.length > 0) return invalidInputResult(TLA_EXERCISE_TOOL, problems);

			let verdict;
			try {
				verdict = await checkTlaSolution(ctx.tla, resolveTlaExercise(input), input.referenceSolution);
			} catch (err) {
				return invalidInputResult(TLA_EXERCISE_TOOL, [
					`The TLA+ checker is unavailable right now (${(err as Error).message}). Use quiz or explain for this check instead.`,
				]);
			}
			if (!verdict.passed) return invalidInputResult(TLA_EXERCISE_TOOL, referenceProblems("referenceSolution", verdict));
			return questionResult();
		},
	};
}

// ─── tla_review ─────────────────────────────────────────────────────────

export const tlaReviewInput = Type.Object({
	exerciseCallId: Type.String({ description: "The tool call id of the tla_exercise whose answer you judge." }),
	accepted: Type.Boolean({
		description:
			"true: the solution does what the task asked. false: it passes TLC but does not (e.g. it weakens the spec, models " +
			"something else, or only satisfies the checks by accident) — this overrules the pass.",
	}),
	reason: Type.String({ minLength: 1, description: "One or two sentences for the learner: why it does or does not do what was asked." }),
});

/** The review recorded for a tla_exercise call, if any. */
export interface TlaReview {
	accepted: boolean;
	reason: string;
}

/** Find the teacher's clean tla_review of `exerciseCallId` in a record. */
export function tlaReviewOf(messages: readonly LhMessage[], exerciseCallId: string): TlaReview | null {
	for (const m of messages) {
		const r = m as { role?: string; toolName?: string; isError?: boolean; details?: { exerciseCallId?: unknown; accepted?: unknown; reason?: unknown } };
		if (r.role !== "toolResult" || r.toolName !== TLA_REVIEW_TOOL || r.isError) continue;
		if (r.details?.exerciseCallId === exerciseCallId && typeof r.details.accepted === "boolean") {
			return { accepted: r.details.accepted, reason: typeof r.details.reason === "string" ? r.details.reason : "" };
		}
	}
	return null;
}

export function tlaReviewToolFor(ctx: CodeCellToolContext): AgentTool<typeof tlaReviewInput> {
	return {
		name: TLA_REVIEW_TOOL,
		label: TLA_REVIEW_TOOL,
		description:
			"Record your judgment of a TLA+ exercise answer that TLC passed: does the solution do what the task asked? " +
			"accepted: false overrules TLC's pass — the answer then counts as not passed and the learner sees your reason. " +
			"Call it once per passed answer, before your reply about it.",
		parameters: tlaReviewInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const answer = messages.find(
				(m) => (m as { role?: string; toolCallId?: string; toolName?: string }).role === "toolResult" &&
					(m as { toolCallId?: string }).toolCallId === input.exerciseCallId &&
					(m as { toolName?: string }).toolName === TLA_EXERCISE_TOOL,
			) as { isError?: boolean; details?: { dismissed?: boolean; tla?: { verdict?: { passed?: boolean } } } } | undefined;
			const problems: string[] = [];
			if (!answer || answer.isError) problems.push(`No answered tla_exercise with id ${input.exerciseCallId}.`);
			else if (answer.details?.dismissed) problems.push("The learner skipped that exercise; there is nothing to review.");
			else if (answer.details?.tla?.verdict?.passed !== true) problems.push("TLC did not pass that answer; it already counts as not passed.");
			else if (tlaReviewOf(messages, input.exerciseCallId)) problems.push("That answer is already reviewed.");
			if (problems.length) return invalidInputResult(TLA_REVIEW_TOOL, problems);
			return toToolResult({ ok: true, exerciseCallId: input.exerciseCallId, accepted: input.accepted, reason: input.reason.trim() });
		},
	};
}
