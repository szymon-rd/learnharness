/**
 * Rocq code cells, server side (owner, 2026-11-12, like Lean's): the
 * tutor's rocq_exercise gates (plan Rocq mark, no two code cells in a row,
 * reference proof must pass), registration behind the setting, practice
 * Rocq problems, and the server-side grade. Rocq is a stub replaying
 * captured output; .github/workflows/rocq.yml runs the real service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { rocqExerciseToolFor } from "../src/agent/tools/rocq.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { RocqCheckResult, RocqChecker } from "../src/core/rocq-cell.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { newThinkingMessage, type LhMessage } from "../src/core/native-messages.ts";
import { parseChatInput } from "../src/core/input-events.ts";
import { planCodeCells } from "../src/core/contracts.ts";
import { gradeRocqAnswer, RocqAnswerError } from "../src/server/rocq-answer.ts";
import { rocqChecker, rocqServiceUrl } from "../src/server/rocq-service.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(path.join(PATHS.root, "data"), { recursive: true });
const created: string[] = [];
after(() => {
	for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

function chatWithPlan(codeCells: true | "lean" | "rocq" | undefined, kind?: "practice"): string {
	const chat = chatStore.createChat("Rocq cells", kind);
	created.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "sep", title: "Separating conjunction" }], edges: [], version: 1, ...(codeCells === undefined ? {} : { codeCells }) });
	return chat.id;
}

function append(chatId: string, messages: unknown[]): void {
	chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...(messages as LhMessage[])]);
}

function result(name: string): RocqCheckResult {
	return (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "rocq", `${name}.json`), "utf8")) as { result: RocqCheckResult }).result;
}

/** A stub Rocq: a proof passes when it uses iFrame. */
function stubRocq(calls: string[] = []): RocqChecker {
	return async (source) => {
		calls.push(source);
		return result(source.includes("iFrame") ? "iris-pass" : "iris-error");
	};
}

const exercise = {
	nodeId: "sep",
	question: "Prove that ∗ is commutative.",
	prelude: "From iris.proofmode Require Import proofmode.\nFrom iris.base_logic Require Import iprop.",
	statement: "Lemma qa_sep_comm {Σ} (P Q : iProp Σ) : P ∗ Q ⊢ Q ∗ P.",
	referenceProof: 'Proof.\n  iIntros "[HP HQ]".\n  iFrame.\nQed.',
};

async function call(tool: { parameters: unknown; execute: (id: string, input: never) => Promise<unknown> }, input: unknown, id = "tc") {
	assert.ok(Value.Check(tool.parameters as never, input), "schema-valid input");
	const r = (await tool.execute(id, input as never)) as { isError?: boolean; details: { problems?: string[] } | null };
	return { ok: !r.isError, problems: r.details?.problems ?? [] };
}

const nodeIdProblem = (id: string) => (id === "sep" ? null : `nodeId "${id}" matches no node`);

describe("rocq_exercise", () => {
	it("checks the reference proof with Rocq and poses the cell", async () => {
		const calls: string[] = [];
		const tool = rocqExerciseToolFor({ chatId: chatWithPlan("rocq"), chatStore, rocq: stubRocq(calls) }, nodeIdProblem);
		const r = await call(tool, exercise);
		assert.equal(r.ok, true, r.problems.join("\n"));
		assert.match(calls[0]!, /iFrame\.\nQed\.\n\nPrint Assumptions qa_sep_comm\.\n$/);
	});

	it("returns Rocq's errors when the reference proof fails", async () => {
		const tool = rocqExerciseToolFor({ chatId: chatWithPlan("rocq"), chatStore, rocq: stubRocq() }, nodeIdProblem);
		const r = await call(tool, { ...exercise, referenceProof: 'Proof.\n  iIntros "[HP HQ]".\n  iExact "HP".\nQed.' });
		assert.match(r.problems.join("\n"), /referenceProof does not pass: Rocq reports an error/);
	});

	it("refuses sessions whose plan is not marked as a Rocq topic, and two code cells in a row", async () => {
		for (const mark of [undefined, true, "lean"] as const) {
			const tool = rocqExerciseToolFor({ chatId: chatWithPlan(mark), chatStore, rocq: stubRocq() }, nodeIdProblem);
			assert.match((await call(tool, exercise)).problems.join("\n"), /not marked as a Rocq topic/);
		}
		assert.equal(planCodeCells({ codeCells: "rocq" }), "rocq");
		const chatId = chatWithPlan("rocq");
		append(chatId, [{ role: "assistant", content: [{ type: "toolCall", id: "prev", name: "cpp_exercise", arguments: {} }], timestamp: 1 }]);
		const tool = rocqExerciseToolFor({ chatId, chatStore, rocq: stubRocq() }, nodeIdProblem);
		assert.match((await call(tool, exercise)).problems.join("\n"), /already a code cell/);
		assert.equal((await call(tool, { ...exercise, learnerAsked: true })).ok, true);
	});

	it("is registered only with a Rocq checker; plan_init offers rocq", () => {
		const chatId = chatWithPlan(undefined);
		const ctx = (extra: Partial<TeacherToolContext> = {}): TeacherToolContext => ({ chatId, chatStore, jobStore, spawn: () => {}, ...extra });
		assert.equal("rocq_exercise" in createTeacherTools(ctx()), false);
		const on = createTeacherTools(ctx({ rocq: stubRocq() }));
		assert.equal("rocq_exercise" in on, true);
		const params = (on.plan_init!.parameters as { properties: { codeCells: { anyOf: { const: string }[] } } }).properties.codeCells;
		assert.deepEqual(params.anyOf.map((a) => a.const), ["rocq"]);
		assert.equal(rocqServiceUrl({}), null);
		assert.equal(rocqChecker({}), null);
		assert.equal(rocqServiceUrl({ LH_ROCQ_URL: "http://rocq:3600/" }), "http://rocq:3600");
	});
});

describe("the server grades the submitted proof", () => {
	const submitted = (proof: string): QuestionAnswerData => ({ kind: "rocq", questionText: "x", dontKnow: false, answers: [], text: proof, correct: true, answeredAt: "t" });

	it("re-checks against the persisted statement and stores Rocq's verdict", async () => {
		const passed = await gradeRocqAnswer(exercise, submitted('Proof.\n  iIntros "[HP HQ]".\n  iFrame.\nQed.'), stubRocq());
		assert.equal(passed.correct, true);
		assert.equal(passed.rocq!.referenceProof, exercise.referenceProof);
		const failed = await gradeRocqAnswer(exercise, submitted('Proof.\n  iIntros "[HP HQ]".\n  iExact "HP".\nQed.'), stubRocq());
		assert.equal(failed.correct, false, "the client's claim is ignored");
		const view = compactAnswerForModel(failed);
		assert.equal(view.verdict, "Rocq reports an error.");
		assert.ok(Array.isArray(view.errors));
		await assert.rejects(gradeRocqAnswer(exercise, submitted("Proof. Qed."), null), (e) => e instanceof RocqAnswerError && e.status === 503);
	});
});

describe("practice Rocq problems", () => {
	const pose = { statement: "Prove ∗ commutes.", mode: "recall", modelSolution: "iFrame", rocq: { prelude: exercise.prelude, statement: exercise.statement, referenceProof: exercise.referenceProof } };

	it("pose only for material from Rocq sessions, with a passing reference proof", async () => {
		const chatId = chatWithPlan(undefined, "practice");
		const tools = (sourced: boolean) => practiceTools({ chatId, chatStore, rocq: { check: stubRocq(), rocqSourced: () => sourced } });
		assert.match((await call(tools(false).problem!, pose, "pr1")).problems.join("\n"), /only for material from Rocq sessions/);
		const ok = await call(tools(true).problem!, pose, "pr2");
		assert.equal(ok.ok, true, ok.problems.join("\n"));
	});

	it("a submission carries the proof; the verdict reaches the model", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: "", rocqProof: "Proof. Qed.", rocq: { forged: true } }), {
			type: "thinking",
			problemCallId: "p1",
			text: "",
			rocqProof: "Proof. Qed.",
		});
		const msg = newThinkingMessage("p1", "", undefined, undefined, undefined, {
			proof: "Proof. Qed.",
			summary: "Rocq reports an error.",
			verdict: { passed: false, reason: "errors", ms: 1, errors: [{ line: 1, message: "Attempt to save an incomplete proof" }] },
		});
		const content = String((msg as { content: unknown }).content);
		assert.match(content, /Submitted Rocq proof:\nProof\. Qed\./);
		assert.match(content, /Rocq verdict: does not pass — Rocq reports an error\.\n- proof line 1: Attempt to save/);
	});
});
