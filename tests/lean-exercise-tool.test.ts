/**
 * Lean code cells, server side (owner, 2026-10-30): the teacher's
 * lean_exercise gates (plan Lean mark, no two in a row, reference proof
 * must pass), registration behind the setting, plan_init's codeCells mark,
 * and the server-side grade of a submitted proof. Lean itself is a stub
 * checker here; .github/workflows/lean.yml runs the real one.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { leanExerciseToolFor } from "../src/agent/tools/lean.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import type { LeanCheckResult, LeanChecker } from "../src/core/lean-cell.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { codeCellsEnabled } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { gradeLeanAnswer, LeanAnswerError } from "../src/server/lean-answer.ts";
import { leanChecker, leanServiceUrl } from "../src/server/lean-service.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(path.join(PATHS.root, "data"), { recursive: true });
const created: string[] = [];
after(() => {
	for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

function chatWithPlan(codeCells: boolean | undefined): string {
	const chat = chatStore.createChat("Lean cells");
	created.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "induction", title: "Induction" }], edges: [], version: 1, ...(codeCells === undefined ? {} : { codeCells }) });
	return chat.id;
}

/** A stub Lean: a proof passes when it contains "omega"; reports the axioms on the last line. */
function stubLean(calls: string[] = []): LeanChecker {
	return async (source: string): Promise<LeanCheckResult> => {
		calls.push(source);
		const lines = source.split("\n");
		const axiomsLine = lines.findIndex((l) => l.startsWith("#print axioms")) + 1;
		const ok = source.includes("omega");
		return {
			exitCode: ok ? 0 : 1,
			timedOut: false,
			ms: 5,
			messages: ok
				? [{ severity: "information", pos: { line: axiomsLine, column: 0 }, data: "'t' depends on axioms: [propext]" }]
				: [{ severity: "error", pos: { line: axiomsLine - 2, column: 2 }, data: "unsolved goals" }],
		};
	};
}

const exercise = {
	nodeId: "induction",
	question: "Show $n < n + 1$.",
	statement: "theorem lt_succ' (n : ℕ) : n < n + 1 := by",
	referenceProof: "  omega",
};

async function call(tool: ReturnType<typeof leanExerciseToolFor>, input: unknown, id = "tc") {
	assert.ok(Value.Check(tool.parameters, input), "schema-valid input");
	const r = (await tool.execute(id, input as never)) as { isError?: boolean; details: { problems?: string[] } | null };
	return { ok: !r.isError, problems: r.details?.problems ?? [] };
}

describe("lean_exercise", () => {
	const nodeIdProblem = (known: string[]) => (id: string) => (known.includes(id) ? null : `nodeId "${id}" matches no node`);

	it("checks the reference proof with Lean and poses the cell", async () => {
		const chatId = chatWithPlan(true);
		const calls: string[] = [];
		const tool = leanExerciseToolFor({ chatId, chatStore, lean: stubLean(calls) }, nodeIdProblem(["induction"]));
		const r = await call(tool, exercise);
		assert.deepEqual(r, { ok: true, problems: [] });
		assert.equal(calls.length, 1);
		assert.match(calls[0]!, /^import Mathlib\n\ntheorem lt_succ' \(n : ℕ\) : n < n \+ 1 := by\n {2}omega\n\n#print axioms _root_\.lt_succ'\n$/);
	});

	it("returns Lean's errors when the reference proof fails", async () => {
		const tool = leanExerciseToolFor({ chatId: chatWithPlan(true), chatStore, lean: stubLean() }, nodeIdProblem(["induction"]));
		const r = await call(tool, { ...exercise, referenceProof: "  simp" });
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /referenceProof does not pass/);
		assert.match(r.problems.join("\n"), /unsolved goals/);
	});

	it("refuses sessions whose plan is not marked as a Lean topic", async () => {
		const tool = leanExerciseToolFor({ chatId: chatWithPlan(undefined), chatStore, lean: stubLean() }, nodeIdProblem(["induction"]));
		const r = await call(tool, exercise);
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /not marked as a Lean topic/);
	});

	it("refuses two code cells in a row unless the learner asked", async () => {
		const chatId = chatWithPlan(true);
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "prev", name: "lean_exercise", arguments: exercise }], timestamp: 1 } as never,
		]);
		const tool = leanExerciseToolFor({ chatId, chatStore, lean: stubLean() }, nodeIdProblem(["induction"]));
		const again = await call(tool, exercise, "next");
		assert.equal(again.ok, false);
		assert.match(again.problems.join("\n"), /previous question was already a code cell/);
		assert.equal((await call(tool, { ...exercise, learnerAsked: true }, "next")).ok, true);
	});

	it("reports an unreachable Lean as a retryable problem", async () => {
		const down: LeanChecker = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const tool = leanExerciseToolFor({ chatId: chatWithPlan(true), chatStore, lean: down }, nodeIdProblem(["induction"]));
		const r = await call(tool, exercise);
		assert.equal(r.ok, false);
		assert.match(r.problems[0]!, /Lean is unavailable right now/);
	});
});

describe("registration and the plan mark", () => {
	const ctx = (chatId: string, lean?: LeanChecker): TeacherToolContext => ({ chatId, chatStore, jobStore, spawn: () => {}, ...(lean ? { lean } : {}) });

	it("lean_exercise exists only with a Lean checker (the code-cells gate)", () => {
		const chatId = chatWithPlan(undefined);
		assert.equal("lean_exercise" in createTeacherTools(ctx(chatId)), false);
		assert.equal("lean_exercise" in createTeacherTools(ctx(chatId, stubLean())), true);
	});

	it("plan_init offers and stores codeCells only while code cells are on", async () => {
		const chatId = chatWithPlan(undefined);
		const off = planTools({ chatId, chatStore }).plan_init!;
		assert.equal("codeCells" in (off.parameters as { properties: object }).properties, false);
		const on = planTools({ chatId, chatStore }, { codeCells: true }).plan_init!;
		await on.execute("p1", { mermaid: "graph TD\n  a[A] --> b[B]", codeCells: true } as never);
		assert.equal(chatStore.getChat(chatId)!.tree!.codeCells, true);
		await on.execute("p2", { mermaid: "graph TD\n  a[A] --> b[B]" } as never);
		assert.equal(chatStore.getChat(chatId)!.tree!.codeCells, undefined);
	});

	it("the setting is off unless set, and needs the Lean service", () => {
		assert.equal(codeCellsEnabled({ agent: { codeCells: {} } }, true), false);
		assert.equal(codeCellsEnabled({ agent: { codeCells: { enabled: true } } }, false), false);
		assert.equal(codeCellsEnabled({ agent: { codeCells: { enabled: true } } }, true), true);
		assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { codeCells: { enabled: true } } }).agent?.codeCells, { enabled: true });
		assert.equal(sanitizeUserSettings({ version: 1, agent: { codeCells: { enabled: "yes" } } }).agent?.codeCells, undefined);
		assert.equal(parseAgentSettingsBody({ codeCells: { enabled: "yes" } }).ok, false);
		const ok = parseAgentSettingsBody({ codeCells: { enabled: true } });
		assert.ok(ok.ok && ok.settings.codeCells?.enabled === true);
	});

	it("LH_LEAN_URL configures the checker", () => {
		assert.equal(leanServiceUrl({}), null);
		assert.equal(leanChecker({}), null);
		assert.equal(leanServiceUrl({ LH_LEAN_URL: "http://lean:3300/" }), "http://lean:3300");
	});
});

describe("the server grades the submitted proof", () => {
	const submitted = (proof: string): QuestionAnswerData => ({ kind: "lean", questionText: "x", dontKnow: false, answers: [], text: proof, thinking: "tried omega", correct: true, answeredAt: "t" });

	it("re-checks against the persisted statement and stores Lean's verdict", async () => {
		const calls: string[] = [];
		const passed = await gradeLeanAnswer(exercise, submitted("  omega"), stubLean(calls));
		assert.equal(passed.correct, true);
		assert.equal(passed.lean!.verdict.reason, "passed");
		assert.equal(passed.lean!.referenceProof, "  omega");
		assert.ok(calls[0]!.includes(exercise.statement));
		const failed = await gradeLeanAnswer(exercise, submitted("  simp"), stubLean());
		assert.equal(failed.correct, false, "the client's claim is ignored");
		assert.deepEqual(compactAnswerForModel(failed), {
			kind: "lean",
			correct: false,
			thinking: "tried omega",
			proof: "  simp",
			verdict: "Lean reports an error.",
			errors: [{ line: 1, message: "unsolved goals" }],
		});
	});

	it("passes dismissals through and refuses when Lean is down", async () => {
		const dismissed = { ...submitted(""), dismissed: true };
		assert.equal(await gradeLeanAnswer(exercise, dismissed, null), dismissed);
		await assert.rejects(gradeLeanAnswer(exercise, submitted("  omega"), null), (e: unknown) => e instanceof LeanAnswerError && e.status === 503);
	});
});
