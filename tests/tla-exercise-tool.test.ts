/**
 * TLA+ code cells, server side (owner, 2026-11-05): the teacher's
 * tla_exercise gates (plan TLA+ mark, no two code cells in a row across
 * Lean and TLA+, the reference solution must pass), tla_review (a judged
 * overrule of a TLC pass), registration behind the setting, plan_init's
 * language mark, practice TLA+ problems, and the server-side grade. TLC is a
 * stub replaying captured output here; .github/workflows/tla.yml runs the
 * real service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { tlaExerciseToolFor, tlaReviewOf, tlaReviewToolFor } from "../src/agent/tools/tla.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { TlaCheckResult, TlaChecker } from "../src/core/tla-cell.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { newThinkingMessage, type LhMessage } from "../src/core/native-messages.ts";
import { planCodeCells } from "../src/core/contracts.ts";
import { gradeTlaAnswer, TlaAnswerError, tlaExerciseOfCall } from "../src/server/tla-answer.ts";
import { tlaChecker, tlaServiceUrl } from "../src/server/tla-service.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(path.join(PATHS.root, "data"), { recursive: true });
const created: string[] = [];
after(() => {
	for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

function chatWithPlan(codeCells: true | "lean" | "tla" | undefined, kind?: "practice"): string {
	const chat = chatStore.createChat("TLA+ cells", kind);
	created.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "mutex", title: "Mutual exclusion" }], edges: [], version: 1, ...(codeCells === undefined ? {} : { codeCells }) });
	return chat.id;
}

/** Append messages to a chat's record. */
function append(chatId: string, messages: unknown[]): void {
	chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...(messages as LhMessage[])]);
}

function fixtureResult(name: string): TlaCheckResult {
	return (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "tla", `${name}.json`), "utf8")) as { result: TlaCheckResult }).result;
}

const reachedAll: TlaCheckResult = {
	ms: 5,
	runs: [1, 2].map((i) => ({
		id: `witness-${i}`,
		exitCode: 12,
		timedOut: false,
		ms: 2,
		output: `@!@!@STARTMSG 2110:1 @!@!@\nInvariant LH_Witness_${i} is violated.\n@!@!@ENDMSG 2110 @!@!@\n`,
	})),
};

/** A stub TLC: a solution passes when it bounds x by N ("x < N"). */
function stubTla(calls: string[] = []): TlaChecker {
	return async (req) => {
		calls.push(req.runs.map((r) => r.id).join(","));
		if (req.runs[0]?.id.startsWith("witness")) return reachedAll;
		return req.module.includes("x < N") ? fixtureResult("counter-pass") : fixtureResult("counter-invariant");
	};
}

const counterFields = {
	head: "---- MODULE Counter ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLE x",
	tail: "Spec == Init /\\ [][Next]_x /\\ WF_x(Next)\nTypeOK == x \\in 0..N\nReachesN == <>(x = N)\n====",
	config: { constants: { N: "3" }, init: "Init", next: "Next", invariants: ["TypeOK"], checkDeadlock: false },
	witnesses: [
		{ label: "x reaches N", expression: "x = N" },
		{ label: "x is 2", expression: "x = 2" },
	],
};

const exercise = {
	nodeId: "mutex",
	question: "Write Init and Next so x counts up to N.",
	...counterFields,
	starter: "Init == \\* fill in",
	referenceSolution: "Init == x = 0\nNext == x < N /\\ x' = x + 1",
};

async function call(tool: { parameters: unknown; execute: (id: string, input: never) => Promise<unknown> }, input: unknown, id = "tc") {
	assert.ok(Value.Check(tool.parameters as never, input), "schema-valid input");
	const r = (await tool.execute(id, input as never)) as { isError?: boolean; details: { problems?: string[] } | null };
	return { ok: !r.isError, problems: r.details?.problems ?? [], details: r.details };
}

const nodeIdProblem = (id: string) => (id === "mutex" ? null : `nodeId "${id}" matches no node`);

describe("tla_exercise", () => {
	it("checks the reference solution (model, then witnesses) and poses the cell", async () => {
		const calls: string[] = [];
		const tool = tlaExerciseToolFor({ chatId: chatWithPlan("tla"), chatStore, tla: stubTla(calls) }, nodeIdProblem);
		const r = await call(tool, exercise);
		assert.equal(r.ok, true, r.problems.join("\n"));
		assert.deepEqual(calls, ["main", "witness-1,witness-2"]);
	});

	it("returns TLC's verdict and counterexample when the reference solution fails", async () => {
		const tool = tlaExerciseToolFor({ chatId: chatWithPlan("tla"), chatStore, tla: stubTla() }, nodeIdProblem);
		const r = await call(tool, { ...exercise, referenceSolution: "Init == x = 0\nNext == x' = x + 1" });
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /referenceSolution does not pass: Invariant TypeOK is violated/);
		assert.match(r.problems.join("\n"), /counterexample: 1: Initial predicate \(x = 0\) → 2: Next \(x = 1\)/);
	});

	it("refuses sessions whose plan is not marked as a TLA+ topic (old `true` plans are Lean)", async () => {
		for (const mark of [undefined, true, "lean"] as const) {
			const tool = tlaExerciseToolFor({ chatId: chatWithPlan(mark), chatStore, tla: stubTla() }, nodeIdProblem);
			const r = await call(tool, exercise);
			assert.equal(r.ok, false);
			assert.match(r.problems.join("\n"), /not marked as a TLA\+ topic/);
		}
		assert.equal(planCodeCells({ codeCells: true }), "lean");
		assert.equal(planCodeCells({ codeCells: "tla" }), "tla");
		assert.equal(planCodeCells({}), null);
	});

	it("refuses two code cells in a row — Lean and TLA+ count together — unless the learner asked", async () => {
		const chatId = chatWithPlan("tla");
		append(chatId, [
			{ role: "assistant", content: [{ type: "toolCall", id: "prev", name: "lean_exercise", arguments: {} }], timestamp: 1 } as never,
		]);
		const tool = tlaExerciseToolFor({ chatId, chatStore, tla: stubTla() }, nodeIdProblem);
		const r = await call(tool, exercise);
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /already a code cell/);
		assert.equal((await call(tool, { ...exercise, learnerAsked: true })).ok, true);
	});

	it("says so when the checker is down", async () => {
		const down: TlaChecker = async () => {
			throw new Error("connection refused");
		};
		const tool = tlaExerciseToolFor({ chatId: chatWithPlan("tla"), chatStore, tla: down }, nodeIdProblem);
		const r = await call(tool, exercise);
		assert.match(r.problems.join("\n"), /checker is unavailable right now \(connection refused\)/);
	});

	it("is registered (with tla_review) only with a TLA+ checker, and plan_init offers what is up", () => {
		const chatId = chatWithPlan(undefined);
		const ctx = (extra: Partial<TeacherToolContext> = {}): TeacherToolContext => ({ chatId, chatStore, jobStore, spawn: () => {}, ...extra });
		const off = createTeacherTools(ctx());
		assert.equal("tla_exercise" in off, false);
		assert.equal("tla_review" in off, false);
		const on = createTeacherTools(ctx({ tla: stubTla() }));
		assert.equal("tla_exercise" in on, true);
		assert.equal("tla_review" in on, true);
		const params = (on.plan_init!.parameters as { properties: { codeCells: { anyOf: { const: string }[] } } }).properties.codeCells;
		assert.deepEqual(params.anyOf.map((a) => a.const), ["tla"]);
	});

	it("plan_init stores the TLA+ mark", async () => {
		const chatId = chatWithPlan(undefined);
		const tool = planTools({ chatId, chatStore }, { codeCells: ["lean", "tla"] }).plan_init!;
		await tool.execute("p1", { mermaid: "graph TD\n  a[A] --> b[B]", codeCells: "tla" } as never);
		assert.equal(chatStore.getChat(chatId)!.tree!.codeCells, "tla");
	});

	it("LH_TLA_URL configures the checker", () => {
		assert.equal(tlaServiceUrl({}), null);
		assert.equal(tlaChecker({}), null);
		assert.equal(tlaServiceUrl({ LH_TLA_URL: "http://tla:3400/" }), "http://tla:3400");
	});
});

describe("the server grades the submitted solution", () => {
	const submitted = (solution: string): QuestionAnswerData => ({ kind: "tla", questionText: "x", dontKnow: false, answers: [], text: solution, thinking: "bounded it", correct: true, answeredAt: "t" });

	it("re-checks against the persisted head, tail and model and stores TLC's verdict", async () => {
		const passed = await gradeTlaAnswer(exercise, submitted("Init == x = 0\nNext == x < N /\\ x' = x + 1"), stubTla());
		assert.equal(passed.correct, true);
		assert.equal(passed.tla!.verdict.reason, "passed");
		assert.equal(passed.tla!.referenceSolution, exercise.referenceSolution);
		const model = compactAnswerForModel(passed);
		assert.match(String(model.review), /record your judgment with tla_review/);
		const failed = await gradeTlaAnswer(exercise, submitted("Init == x = 0\nNext == x' = x + 1"), stubTla());
		assert.equal(failed.correct, false, "the client's claim is ignored");
		const view = compactAnswerForModel(failed);
		assert.equal(view.verdict, "Invariant TypeOK is violated.");
		assert.equal(view.violated, "TypeOK");
		assert.ok(Array.isArray(view.counterexample));
		assert.equal(view.review, undefined);
	});

	it("refuses when the checker is missing or the solution cuts the module", async () => {
		await assert.rejects(gradeTlaAnswer(exercise, submitted("Init == TRUE"), null), (e) => e instanceof TlaAnswerError && e.status === 503);
		const cut = await gradeTlaAnswer(exercise, submitted("TypeOK == TRUE\n===="), stubTla());
		assert.equal(cut.tla!.verdict.reason, "solution");
	});

	it("finds the exercise of a persisted call (teaching or a practice problem)", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tla_exercise", arguments: exercise }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "S", tla: counterFields } }] },
		] as unknown as LhMessage[];
		assert.equal(tlaExerciseOfCall(messages, "t1")?.moduleName, "Counter");
		assert.equal(tlaExerciseOfCall(messages, "p1")?.question, "S");
		assert.equal(tlaExerciseOfCall(messages, "nope"), null);
	});
});

describe("tla_review", () => {
	const answered = (passed: boolean) =>
		({
			role: "toolResult",
			toolCallId: "ex1",
			toolName: "tla_exercise",
			isError: false,
			details: { kind: "tla", tla: { solution: "s", summary: "", verdict: { passed, reason: passed ? "passed" : "invariant", errors: [], ms: 1 } } },
			content: [],
			timestamp: 2,
		}) as never;

	it("records an overrule of a TLC pass, once", async () => {
		const chatId = chatWithPlan("tla");
		append(chatId, [answered(true)]);
		const tool = tlaReviewToolFor({ chatId, chatStore });
		const r = await call(tool, { exerciseCallId: "ex1", accepted: false, reason: "It never lets two processes run." });
		assert.equal(r.ok, true);
		assert.deepEqual(r.details, { ok: true, exerciseCallId: "ex1", accepted: false, reason: "It never lets two processes run." });
		append(chatId, [{ role: "toolResult", toolCallId: "rv1", toolName: "tla_review", isError: false, details: r.details, content: [], timestamp: 3 } as never]);
		assert.deepEqual(tlaReviewOf(chatStore.getChat(chatId)!.messages, "ex1"), { accepted: false, reason: "It never lets two processes run." });
		const again = await call(tool, { exerciseCallId: "ex1", accepted: true, reason: "x" });
		assert.match(again.problems.join("\n"), /already reviewed/);
	});

	it("has nothing to review on a failed or unknown answer", async () => {
		const chatId = chatWithPlan("tla");
		append(chatId, [answered(false)]);
		const tool = tlaReviewToolFor({ chatId, chatStore });
		assert.match((await call(tool, { exerciseCallId: "ex1", accepted: true, reason: "x" })).problems.join("\n"), /did not pass/);
		assert.match((await call(tool, { exerciseCallId: "nope", accepted: true, reason: "x" })).problems.join("\n"), /No answered tla_exercise/);
	});
});

describe("practice TLA+ problems", () => {
	const pose = { statement: "Make x count to N.", mode: "recall", modelSolution: "bound x", tla: { ...counterFields, referenceSolution: exercise.referenceSolution } };

	it("pose only for material from TLA+ sessions, with a passing reference solution", async () => {
		const chatId = chatWithPlan(undefined, "practice");
		const tools = (sourced: boolean) => practiceTools({ chatId, chatStore, tla: { check: stubTla(), tlaSourced: () => sourced } });
		const refused = await call(tools(false).problem!, pose, "pr1");
		assert.match(refused.problems.join("\n"), /only for material from TLA\+ sessions/);
		const ok = await call(tools(true).problem!, pose, "pr2");
		assert.equal(ok.ok, true, ok.problems.join("\n"));
		const off = practiceTools({ chatId, chatStore });
		assert.equal("tla" in (off.problem!.parameters as { properties: object }).properties, false);
	});

	it("a submission carries the solution and TLC's verdict to the model", () => {
		const msg = newThinkingMessage("pr2", "my attempt", undefined, {
			solution: "Init == x = 0",
			summary: "TLC finds no error (4 distinct states).",
			verdict: { passed: true, reason: "passed", errors: [], ms: 1, distinctStates: 4 },
		});
		const content = String((msg as { content: unknown }).content);
		assert.match(content, /Submitted TLA\+ solution:\nInit == x = 0/);
		assert.match(content, /TLC verdict: passes/);
		assert.match(content, /before you count it as solved/);
	});
});
