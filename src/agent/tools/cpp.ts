import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import {
	checkCppSolution,
	CPP_EXERCISE_TOOL,
	CPP_REVIEW_TOOL,
	cppExerciseProblems,
	cppVerdictSummary,
	MAX_CPP_TESTS,
	resolveCppExercise,
	type CppChecker,
	type CppVerdict,
} from "../../core/cpp-cell.ts";
import { planCodeCells } from "../../core/contracts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { isCodeCellTool, previousQuestionTool, type CodeCellToolContext } from "./lean.ts";
import { codeReviewOf, codeReviewToolFor, type CodeReview } from "./code-review.ts";

/**
 * cpp_exercise — the tutor's C++ code cell (owner, 2026-11-09), built like
 * the TLA+ cell: the learner writes the editable part between a locked head
 * (and optional tail), with live compiler errors and a Check button that
 * runs the visible tests; on submit the SERVER compiles the exact cell and
 * runs every test, hidden ones included (src/server/cpp-answer.ts).
 *
 * Gates (registered only when the "Code cells" setting is "Mixed in" and the
 * server has the C++ service): the plan marked codeCells "cpp"; not two code
 * cells in a row unless the learner asked; the hidden reference solution
 * passes every test.
 *
 * cpp_review — after the tests pass the tutor judges whether the solution
 * does what was asked; accepted: false overrules the pass.
 */

/** Exercise fields shared by cpp_exercise and a practice problem's `cpp`
 *  block. */
export const cppExerciseFields = {
	head: Type.String({
		minLength: 1,
		description:
			"Locked lines at the top of the file: the #includes the solution needs, any given types or helpers, and a comment " +
			"with the function signature(s) to implement. No main(): the tests provide it.",
	}),
	starter: Type.Optional(
		Type.String({ description: "The editable code the learner starts from, e.g. the signature with an empty body or a TODO." }),
	),
	tail: Type.Optional(Type.String({ description: "Optional locked lines after the learner's part (more given code)." })),
	tests: Type.Array(
		Type.Object({
			name: Type.String({ minLength: 1, description: "Short, shown to the learner, e.g. \"empty vector\"." }),
			code: Type.String({
				minLength: 1,
				description:
					"C++ statements that call the learner's code and check results with CHECK(cond), CHECK_EQ(actual, expected) " +
					"(values printable with << are shown on failure) or CHECK_NEAR(actual, expected, eps). Each test runs in its own " +
					"process with AddressSanitizer and UBSan and a 5 s time limit.",
			}),
			hidden: Type.Optional(
				Type.Boolean({ description: "true: runs only on Submit; the learner sees only its name. Add some so a solution fitted to the visible tests fails." }),
			),
		}),
		{ minItems: 1, maxItems: MAX_CPP_TESTS, description: "The tests (C++20, g++). At least one visible; visible ones are shown read-only and run on Check." },
	),
	referenceSolution: Type.String({
		minLength: 1,
		description: "Your complete code for the editable part. Every test is run against it before the learner sees the cell; shown to them only after they submit.",
	}),
};

export const cppExerciseInput = Type.Object({
	nodeId: Type.String({
		description: "The plan node this exercise is about — validated at call time against the session's plan map.",
	}),
	question: Type.String({
		minLength: 1,
		description: "The task shown above the cell (markdown + LaTeX): what to implement and how it must behave.",
	}),
	...cppExerciseFields,
	learnerAsked: Type.Optional(
		Type.Boolean({ description: "True only when the learner asked for another code exercise right after the previous one." }),
	),
});

export interface CppToolContext extends CodeCellToolContext {
	/** Compiles and runs C++ (the configured service). */
	cpp: CppChecker;
}

/** The problems with the tutor's reference solution, as tool feedback. */
export function cppReferenceProblems(field: string, verdict: CppVerdict): string[] {
	const out = [`${field} does not pass: ${cppVerdictSummary(verdict)}`];
	for (const e of verdict.errors) out.push(`${e.line !== null ? `line ${e.line}` : "error"}: ${e.message}`);
	for (const t of verdict.tests.filter((t) => !t.passed)) out.push(`test "${t.name}": ${t.message ?? t.outcome}`);
	return out;
}

export function cppExerciseToolFor(ctx: CppToolContext, nodeIdProblem: (nodeId: string) => string | null): AgentTool<typeof cppExerciseInput> {
	return {
		name: CPP_EXERCISE_TOOL,
		label: CPP_EXERCISE_TOOL,
		description:
			"Pose a C++ exercise as an editable code cell (C++20, g++), checked by your tests. The learner sees `question`, the " +
			"locked `head` (and `tail`), the visible tests (read-only), and writes the part between, with live compiler errors " +
			"and a Check button that runs the visible tests. On submit the server compiles the exact file and runs every test, " +
			"hidden ones included: it passes when it compiles and every test passes (no failed check, no sanitizer report, no " +
			"crash, within the time limit). The verdict and the solution come back as the result; on a pass, judge whether it " +
			"does what was asked and record that with cpp_review. Your referenceSolution is checked first: if it fails, the " +
			'errors come back and you fix the exercise. Only for sessions about C++: the plan must be marked codeCells: "cpp". ' +
			"Mix it with your other checks — never two code cells in a row unless the learner asked (learnerAsked). ONE question " +
			"per turn: call it, then end your turn.",
		parameters: cppExerciseInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = cppExerciseProblems(input);
			const nodeText = nodeIdProblem(input.nodeId);
			if (nodeText) problems.push(nodeText);
			const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
			if (tree && planCodeCells(tree) !== "cpp") {
				problems.push(
					"This session's plan is not marked as a C++ topic, so C++ code cells are off here. Use quiz/explain; " +
						'if the session IS about C++, re-call plan_init with codeCells: "cpp".',
				);
			}
			if (isCodeCellTool(previousQuestionTool(ctx, toolCallId)) && input.learnerAsked !== true) {
				problems.push(
					"The previous question was already a code cell. Mix them in: pose a different check first, unless the learner asked for another exercise (then set learnerAsked: true).",
				);
			}
			if (problems.length > 0) return invalidInputResult(CPP_EXERCISE_TOOL, problems);
			let verdict;
			try {
				verdict = await checkCppSolution(ctx.cpp, resolveCppExercise(input), input.referenceSolution, "all");
			} catch (err) {
				return invalidInputResult(CPP_EXERCISE_TOOL, [
					`The C++ checker is unavailable right now (${(err as Error).message}). Use quiz or explain for this check instead.`,
				]);
			}
			if (!verdict.passed) return invalidInputResult(CPP_EXERCISE_TOOL, cppReferenceProblems("referenceSolution", verdict));
			return questionResult();
		},
	};
}

export type CppReview = CodeReview;

/** Find the tutor's clean cpp_review of `exerciseCallId` in a record. */
export function cppReviewOf(messages: readonly LhMessage[], exerciseCallId: string): CppReview | null {
	return codeReviewOf(messages, exerciseCallId, CPP_REVIEW_TOOL);
}

export function cppReviewToolFor(ctx: CodeCellToolContext) {
	return codeReviewToolFor(ctx, { tool: CPP_REVIEW_TOOL, exerciseTool: CPP_EXERCISE_TOOL, detailKey: "cpp", checker: "the tests", checks: "the tests" });
}
