import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { CodeCellToolContext } from "./lean.ts";

/**
 * The tutor's review of a code-cell answer that the machine check passed
 * (owner, 2026-11-05 for TLA+, 2026-11-09 for C++): does the solution do
 * what the task asked? accepted: false overrules the pass in the record and
 * on the answered card. One tool per language (tla_review, cpp_review),
 * built here.
 */

export interface CodeReview {
	accepted: boolean;
	reason: string;
}

export interface CodeReviewSpec {
	/** The review tool's name (tla_review, cpp_review). */
	tool: string;
	/** The exercise tool it reviews (tla_exercise, cpp_exercise). */
	exerciseTool: string;
	/** The answer's detail key holding the verdict (tla, cpp). */
	detailKey: string;
	/** Who passed it, for the texts ("TLC", "the tests"). */
	checker: string;
	/** What it passes ("the checks", "the tests"). */
	checks: string;
}

export function codeReviewInput(spec: CodeReviewSpec) {
	return Type.Object({
		exerciseCallId: Type.String({ description: `The tool call id of the ${spec.exerciseTool} whose answer you judge.` }),
		accepted: Type.Boolean({
			description:
				`true: the solution does what the task asked. false: it passes ${spec.checks} but does not (e.g. it weakens the ` +
				"task, models or computes something else, special-cases the checked inputs, or only satisfies the checks by accident) — this overrules the pass.",
		}),
		reason: Type.String({ minLength: 1, description: "One or two sentences for the learner: why it does or does not do what was asked." }),
	});
}

/** Find the tutor's clean review of `exerciseCallId` in a record. */
export function codeReviewOf(messages: readonly LhMessage[], exerciseCallId: string, tool: string): CodeReview | null {
	for (const m of messages) {
		const r = m as { role?: string; toolName?: string; isError?: boolean; details?: { exerciseCallId?: unknown; accepted?: unknown; reason?: unknown } };
		if (r.role !== "toolResult" || r.toolName !== tool || r.isError) continue;
		if (r.details?.exerciseCallId === exerciseCallId && typeof r.details.accepted === "boolean") {
			return { accepted: r.details.accepted, reason: typeof r.details.reason === "string" ? r.details.reason : "" };
		}
	}
	return null;
}

export function codeReviewToolFor(ctx: CodeCellToolContext, spec: CodeReviewSpec): AgentTool<ReturnType<typeof codeReviewInput>> {
	const parameters = codeReviewInput(spec);
	return {
		name: spec.tool,
		label: spec.tool,
		description:
			`Record your judgment of a ${spec.exerciseTool} answer that ${spec.checker} passed: does the solution do what the task asked? ` +
			`accepted: false overrules the pass — the answer then counts as not passed and the learner sees your reason. ` +
			"Call it once per passed answer, before your reply about it.",
		parameters,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const answer = messages.find(
				(m) =>
					(m as { role?: string }).role === "toolResult" &&
					(m as { toolCallId?: string }).toolCallId === input.exerciseCallId &&
					(m as { toolName?: string }).toolName === spec.exerciseTool,
			) as { isError?: boolean; details?: Record<string, unknown> & { dismissed?: boolean } } | undefined;
			const detail = answer?.details?.[spec.detailKey] as { verdict?: { passed?: boolean } } | undefined;
			const problems: string[] = [];
			if (!answer || answer.isError) problems.push(`No answered ${spec.exerciseTool} with id ${input.exerciseCallId}.`);
			else if (answer.details?.dismissed) problems.push("The learner skipped that exercise; there is nothing to review.");
			else if (detail?.verdict?.passed !== true) problems.push(`${spec.checker === "TLC" ? "TLC" : "The tests"} did not pass that answer; it already counts as not passed.`);
			else if (codeReviewOf(messages, input.exerciseCallId, spec.tool)) problems.push("That answer is already reviewed.");
			if (problems.length) return invalidInputResult(spec.tool, problems);
			return toToolResult({ ok: true, exerciseCallId: input.exerciseCallId, accepted: input.accepted, reason: input.reason.trim() });
		},
	};
}
