/**
 * THE PRACTICE TOOLS (practice sessions, owner design 2026-10-04): the
 * practice agent's ENTIRE toolset — `problem` (pose: terminates the turn;
 * the commitment rides the call's arguments, hidden from the learner UI)
 * and `conclude` (end the problem: normal result, the turn continues so
 * the same reply can reveal + pose the next). The gating law (owner
 * ruling): an agent cannot pose while a problem is active and cannot
 * conclude with nothing active — activeProblemOf is the single fold both
 * gates read.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): the tool
 * descriptions carry WHAT to pass and WHAT happens — the theory, the
 * commit-before-pose law, the hint ladder all live in the system prompt
 * (prompts/practice/10-doctrine.md).
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { activeProblemOf } from "../../core/native-messages.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { concludeResult, invalidInputResult, problemResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import {
	checkLeanProof,
	DEFAULT_LEAN_PRELUDE,
	DEFAULT_LEAN_STARTER,
	leanExerciseProblems,
	resolveLeanExercise,
	verdictSummary,
	type LeanChecker,
} from "../../core/lean-cell.ts";


/** The record-reading context the gates need (the plan-tools idiom). */
export interface PracticeToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** The WHOLE-graph node list, read fresh per pose (owner round 9 — the
	 *  mastery-trace contract): targets validate against every proposition,
	 *  not just the session's picks, so pickless sessions and future
	 *  graph-tools poses stay valid. Absent (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<import("../../core/contracts/graph.ts").GraphNode, "id" | "name">>;
	/** THE RARELY-NEEDED SET (owner round 10, 2026-10-05): the map readers
	 *  behind the SAME settings gate as the prober's (graphToolsEnabled at
	 *  the composition root); the research + pdf jobs (both keyless).
	 *  Each absent context (tests) = absent from the registry. */
	graph?: GraphToolContext;
	jobs?: JobToolContext;
	/** Lean problems (owner, 2026-10-30): present only when the code-cells
	 *  gate opened (the setting AND a Lean service). `leanSourced` says
	 *  whether any of the given proposition ids came from a teaching session
	 *  whose plan was marked as a Lean topic — the practice session's
	 *  material decides, since practice has no plan of its own. */
	lean?: { check: LeanChecker; leanSourced: (propositionIds: string[]) => boolean };
}

/** TURN-SCOPED GATE STATE (the BKT incident, 2026-10-05): the gates used
 *  to read the STORED record — but the record freezes at the turn's
 *  write-ahead (persistTurn lands only at turn END), so a mid-turn
 *  conclude → pose pair could never see each other: every conclude
 *  succeeded against the stale record and every following pose died on
 *  "a problem is already active" until the model gave up ("the problem
 *  slot is stuck"). The gate seeds ONCE from the record at construction
 *  (one practiceTools per turn — chat-handler builds the agent per
 *  request, so there is no cross-turn leakage), and the executes flip
 *  this closure — the intra-turn truth the record cannot hold yet. */
export interface PracticeGate {
	problemActive: boolean;
}

/** Seed the turn's gate from the record (result-aware activeProblemOf —
 *  only a cleanly-posed problem counts). */
export function createPracticeGate(ctx: PracticeToolContext): PracticeGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	return { problemActive: record ? activeProblemOf(record.messages) !== null : false };
}

// ─── problem: the pose ───────────────────────────────────────────────────────

export const problemInputObject = Type.Object({
	statement: Type.String({
		description:
			"REQUIRED — the problem as the learner sees it (markdown + LaTeX). Must be self-contained and " +
			"solvable from the session's material. NEVER announces the target proposition.",
	}),
	mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
		description: "REQUIRED — the demand mode: recall, discrimination, or composition (bare words, no quotes).",
	}),
	target: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"The proposition id(s) this problem exercises, from the session context's [id] list — include when " +
				"the material is in the map; OMIT entirely when it is not (a topic session poses untagged problems). " +
				"Names are normalized to ids at the seam; an unknown proposition is rejected.",
		}),
	),
	modelSolution: Type.String({
		description: "REQUIRED — the full solution, moves in order, committed BEFORE the learner sees the problem. This IS the reveal — conclude shows it verbatim; never re-author it.",
	}),
});

export type ProblemInput = Static<typeof problemInputObject>;

/** The Lean block of a problem (owner, 2026-10-30): the learner proves the
 *  locked statement in a Lean cell; each submission carries the proof and
 *  the server's verdict. */
const problemLeanBlock = Type.Object({
	prelude: Type.Optional(Type.String({ description: `Locked lines before the statement: imports and \`open\`s. Default: "${DEFAULT_LEAN_PRELUDE}". No \`namespace\`.` })),
	statement: Type.String({ minLength: 1, description: "Locked: exactly one `theorem <fresh_name> … := by` (or `lemma`)." }),
	starter: Type.Optional(Type.String({ description: `The editable proof the learner starts from. Default: "${DEFAULT_LEAN_STARTER}".` })),
	referenceProof: Type.String({ minLength: 1, description: "Your complete tactic proof — checked with Lean before the problem is posed." }),
	learnerAsked: Type.Optional(Type.Boolean({ description: "True only when the learner asked for another Lean problem right after one." })),
});

export const problemInputWithLean = Type.Object({
	...problemInputObject.properties,
	lean: Type.Optional(
		Type.Object(problemLeanBlock.properties, {
			description:
				"Make this a Lean problem: the learner writes the proof in a Lean code cell (Lean + Mathlib, live feedback); " +
				"each submission brings his proof and Lean's verdict. Only for material from Lean sessions; never two Lean " +
				"problems in a row unless he asked (learnerAsked).",
		}),
	),
});

type LeanBlock = Static<typeof problemLeanBlock>;

/** Proposition ids the session was started from (the graph-context picks). */
function sessionPickIds(messages: readonly LhMessage[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const marker = m as { role?: string; customType?: string; details?: { propositions?: Array<{ id?: unknown }> } };
		if (marker.role !== "custom" || marker.customType !== "graph-context") continue;
		for (const p of marker.details?.propositions ?? []) if (typeof p.id === "string") ids.push(p.id);
	}
	return ids;
}

/** Was the newest problem posed before this one a Lean problem? */
function previousProblemWasLean(messages: readonly LhMessage[], toolCallId: string): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (let j = m.content.length - 1; j >= 0; j--) {
			const b = m.content[j] as { type?: string; id?: string; name?: string; arguments?: { lean?: unknown } };
			if (b.type === "toolCall" && b.name === "problem" && b.id !== toolCallId) return b.arguments?.lean !== undefined && b.arguments.lean !== null;
		}
	}
	return false;
}

/** The Lean gates and the reference-proof check for one pose. */
async function leanProblemProblems(
	ctx: PracticeToolContext,
	toolCallId: string,
	block: LeanBlock,
	targets: string[],
): Promise<string[]> {
	const lean = ctx.lean!;
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	const problems = leanExerciseProblems({ question: "problem", ...block });
	if (!lean.leanSourced([...sessionPickIds(messages), ...targets])) {
		problems.push("Lean problems are only for material from Lean sessions; none of this session's propositions came from one. Pose it without `lean`.");
	}
	if (previousProblemWasLean(messages, toolCallId) && block.learnerAsked !== true) {
		problems.push("The previous problem was already a Lean problem. Mix them in: pose one without `lean` first, unless the learner asked for another (then set lean.learnerAsked: true).");
	}
	if (problems.length) return problems;
	try {
		const verdict = await checkLeanProof(lean.check, resolveLeanExercise({ question: "", ...block }), block.referenceProof);
		if (!verdict.passed) {
			return [
				`lean.referenceProof does not pass: ${verdictSummary(verdict)}`,
				...verdict.errors.map((e) => `${e.line > 0 ? `proof line ${e.line}` : "statement/prelude"}: ${e.message}`),
			];
		}
	} catch (err) {
		return [`Lean is unavailable right now (${(err as Error).message}). Pose the problem without \`lean\`.`];
	}
	return [];
}

export function problemTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	ctx?: PracticeToolContext,
): AgentTool<typeof problemInputObject> {
	const withLean = ctx?.lean !== undefined;
	return {
		name: "problem",
		label: "problem",
		description:
			"Pose one practice problem. Ends the turn — the learner works in the thinking field; their thinking " +
			"traces and answer commits arrive back as labeled messages. The modelSolution rides this call's " +
			"arguments and stays hidden from the learner until you conclude (conclude shows it verbatim — the " +
			"reveal needs no new field). Only one problem may be active — conclude it before posing the next.",
		parameters: (withLean ? problemInputWithLean : problemInputObject) as typeof problemInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = healEncodedArguments(args, withLean ? problemInputWithLean : problemInputObject);
			// TARGET NORMALIZATION (owner round 9): names silently become ids —
			// the RECORD carries canonical ids (the mastery trace groups on
			// them); unresolvable strings pass through for execute to reject.
			// UNTAGGED PROBLEMS (owner round 12): an explicit empty list is
			// the model saying "no targets" — healed AWAY, so the record's
			// canonical form is tagged-or-absent, never [].
			if (!graphNodes) {
				const bare = (healed as { target?: unknown }).target;
				return Array.isArray(bare) && bare.length === 0
					? ({ ...(healed as Record<string, unknown>), target: undefined } as never)
					: (healed as never);
			}
			const target = (healed as { target?: unknown }).target;
			if (!Array.isArray(target) || target.length === 0) {
				return { ...(healed as Record<string, unknown>), target: undefined } as never;
			}
			const list = graphNodes();
			const normalized = target.map((t) =>
				typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t,
			);
			if (normalized.every((t, i) => t === target[i])) return healed as never;
			return { ...(healed as Record<string, unknown>), target: normalized } as never;
		},
		execute: async (toolCallId, input) => {
			if (gate.problemActive) {
				return invalidInputResult("problem", [
					"a problem is already active — call conclude on it before posing the next one",
				]);
			}
			// TARGET VALIDATION (owner round 9, round 12): against the WHOLE
			// graph, and ONLY when targets are present — absent means an
			// untagged problem (topic sessions, owner round 12), which poses
			// freely. A one-line rejection — the proposition list already
			// sits in the agent's context (the [id] marker); no re-listing.
			// The message teaches the exit: omitting always works.
			if (graphNodes && input.target && input.target.length > 0) {
				const list = graphNodes();
				const unknown = input.target.filter((t) => resolveTargetId(t, list) === null);
				if (unknown.length > 0) {
					return invalidInputResult("problem", [
						`target ${JSON.stringify(unknown)} is not a known proposition — targets must be proposition ids from the session context; if the material is not in the map, omit target entirely`,
					]);
				}
			}
			const leanBlock = (input as { lean?: LeanBlock }).lean;
			if (leanBlock) {
				if (!withLean) return invalidInputResult("problem", ["Lean problems are off here (the Code cells setting or Lean is unavailable). Pose it without `lean`."]);
				const leanProblems = await leanProblemProblems(ctx!, toolCallId, leanBlock, input.target ?? []);
				if (leanProblems.length) return invalidInputResult("problem", leanProblems);
			}
			gate.problemActive = true;
			return problemResult();
		},
	};
}

// ─── conclude: the end of a problem ──────────────────────────────────────────

export const concludeInputObject = Type.Object({
	outcome: Type.Union(
		[
			Type.Literal("solved"),
			Type.Literal("solvedWithHints"),
			Type.Literal("movedOn"),
			Type.Literal("surrendered"),
			Type.Literal("dismissed"),
		],
		{ description: "REQUIRED — the outcome: solved, solvedWithHints, movedOn, or surrendered — bare words, no quotes (dismissed is synthesized, never yours)." },
	),
	verdict: Type.String({
		description: "REQUIRED — the plain-language verdict: what was credited, where it broke. On a wrong answer: localize the break, do NOT give the correction.",
	}),
	rung: Type.Union(
		[Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"), Type.Literal("R4"), Type.Literal("R5"), Type.Null()],
		{ description: "REQUIRED — the hint-ladder rung the problem needed: R0 through R5, or null = no hint was given (bare, no quotes)." },
	),
	missClass: Type.Union(
		[
			Type.Literal("cue"),
			Type.Literal("discrimination"),
			Type.Literal("execution"),
			Type.Literal("careless"),
			Type.Literal("structural"),
			Type.Null(),
		],
		{ description: "REQUIRED — the miss classification: cue, discrimination, execution, careless, or structural — or null = no miss (bare, no quotes)." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends." }),
});

export type ConcludeInput = Static<typeof concludeInputObject>;

export function concludeTool(gate: PracticeGate): AgentTool<typeof concludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees " +
			"the learner's composer. After the result, say your closing words about the learner's work if useful, then " +
			"END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's " +
			"explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, " +
			"answer their questions about the concluded one. Nothing may conclude unless a problem is active.",
		parameters: concludeInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, concludeInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, _input) => {
			if (!gate.problemActive) {
				return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
			}
			gate.problemActive = false;
			return concludeResult();
		},
	};
}

/** The practice toolset (the practice agent's whole registry). */
export function practiceTools(ctx: PracticeToolContext): Record<string, AgentTool<any>> {
	// ONE gate per turn, shared by both tools — the intra-turn truth.
	const gate = createPracticeGate(ctx);
	// THE RARELY-NEEDED SET (owner round 10): read/ls/find/grep over the
	// learner's files (always — the same read-only set the teacher and
	// prober carry), the research + pdf jobs (available without search
	// keys; demo/visual stay teach-only), and
	// the prober's map readers when the settings gate opened. None are
	// toggle-filtered: problem/conclude are the session; these are
	// exceptions the doctrine says to reach for rarely.
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the standard argument heal over the WHOLE registry. problem/conclude
	// keep their own (target-normalizing) prepareArguments as the composed
	// inner pass; the double heal is idempotent by construction.
	return healToolRecord({
		problem: problemTool(gate, ctx.graphNodes, ctx),
		conclude: concludeTool(gate),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
	});
}
