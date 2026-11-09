/**
 * C++ code cells, server side (owner, 2026-11-09): the tutor's cpp_exercise
 * gates (plan C++ mark, no two code cells in a row across languages, the
 * reference solution must pass every test), cpp_review, registration behind
 * the setting, practice C++ problems, and the server-side grade (every test,
 * hidden ones included). The compiler is a stub replaying captured output;
 * .github/workflows/cpp.yml runs the real service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { cppExerciseToolFor, cppReviewOf, cppReviewToolFor } from "../src/agent/tools/cpp.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { CppCheckResult, CppChecker } from "../src/core/cpp-cell.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { newThinkingMessage, type LhMessage } from "../src/core/native-messages.ts";
import { parseChatInput } from "../src/core/input-events.ts";
import { planCodeCells } from "../src/core/contracts.ts";
import { CppAnswerError, cppExerciseOfCall, gradeCppAnswer } from "../src/server/cpp-answer.ts";
import { cppChecker, cppServiceUrl } from "../src/server/cpp-service.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(path.join(PATHS.root, "data"), { recursive: true });
const created: string[] = [];
after(() => {
	for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

function chatWithPlan(codeCells: true | "lean" | "tla" | "cpp" | undefined, kind?: "practice"): string {
	const chat = chatStore.createChat("C++ cells", kind);
	created.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "loops", title: "Loops" }], edges: [], version: 1, ...(codeCells === undefined ? {} : { codeCells }) });
	return chat.id;
}

function append(chatId: string, messages: unknown[]): void {
	chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...(messages as LhMessage[])]);
}

const fixtures = path.join(import.meta.dirname, "fixtures", "cpp");
function fixture(name: string): { result: CppCheckResult; nonce: string; exercise: { head: string; tests: { name: string; code: string; hidden?: boolean }[] } } {
	return JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), "utf8"));
}

/** A stub compiler: a solution that loops over the elements passes; one
 *  that special-cases fails the hidden test. Replays captured output with
 *  this check's nonce. */
function stubCpp(calls: string[] = []): CppChecker {
	return async (req) => {
		calls.push((req.runs ?? []).join(","));
		const nonce = /@@LH_PASS (\w+)/.exec(req.tests ?? "")?.[1] ?? "";
		const f = fixture(req.cell.includes("for (int x : v)") ? "sum-pass" : "sum-fitted");
		const runs = f.result.runs!.filter((r) => (req.runs ?? []).includes(r.test)).map((r) => ({ ...r, stdout: r.stdout.replace(f.nonce, nonce) }));
		return { ...f.result, runs };
	};
}

const base = fixture("sum-pass").exercise;
const good = "int sum(const std::vector<int>& v) {\n  int s = 0;\n  for (int x : v) s += x;\n  return s;\n}";
const fitted = "int sum(const std::vector<int>& v) {\n  return v.empty() ? 0 : 6;\n}";
const exercise = { nodeId: "loops", question: "Return the sum of the elements.", head: base.head, tests: base.tests, starter: "int sum(const std::vector<int>& v) {\n}", referenceSolution: good };

async function call(tool: { parameters: unknown; execute: (id: string, input: never) => Promise<unknown> }, input: unknown, id = "tc") {
	assert.ok(Value.Check(tool.parameters as never, input), "schema-valid input");
	const r = (await tool.execute(id, input as never)) as { isError?: boolean; details: { problems?: string[] } | null };
	return { ok: !r.isError, problems: r.details?.problems ?? [], details: r.details };
}

const nodeIdProblem = (id: string) => (id === "loops" ? null : `nodeId "${id}" matches no node`);

describe("cpp_exercise", () => {
	it("runs every test against the reference solution and poses the cell", async () => {
		const calls: string[] = [];
		const tool = cppExerciseToolFor({ chatId: chatWithPlan("cpp"), chatStore, cpp: stubCpp(calls) }, nodeIdProblem);
		const r = await call(tool, exercise);
		assert.equal(r.ok, true, r.problems.join("\n"));
		assert.deepEqual(calls, ["1,2,3"]);
	});

	it("returns the failing tests when the reference solution fails", async () => {
		const tool = cppExerciseToolFor({ chatId: chatWithPlan("cpp"), chatStore, cpp: stubCpp() }, nodeIdProblem);
		const r = await call(tool, { ...exercise, referenceSolution: fitted });
		assert.match(r.problems.join("\n"), /referenceSolution does not pass: 1 of 3 tests fail/);
		assert.match(r.problems.join("\n"), /test "negatives": CHECK_EQ/);
	});

	it("refuses sessions whose plan is not marked as a C++ topic", async () => {
		for (const mark of [undefined, true, "tla"] as const) {
			const tool = cppExerciseToolFor({ chatId: chatWithPlan(mark), chatStore, cpp: stubCpp() }, nodeIdProblem);
			assert.match((await call(tool, exercise)).problems.join("\n"), /not marked as a C\+\+ topic/);
		}
		assert.equal(planCodeCells({ codeCells: "cpp" }), "cpp");
	});

	it("refuses two code cells in a row across languages unless the learner asked", async () => {
		const chatId = chatWithPlan("cpp");
		append(chatId, [{ role: "assistant", content: [{ type: "toolCall", id: "prev", name: "tla_exercise", arguments: {} }], timestamp: 1 }]);
		const tool = cppExerciseToolFor({ chatId, chatStore, cpp: stubCpp() }, nodeIdProblem);
		assert.match((await call(tool, exercise)).problems.join("\n"), /already a code cell/);
		assert.equal((await call(tool, { ...exercise, learnerAsked: true })).ok, true);
	});

	it("is registered (with cpp_review) only with a C++ checker; plan_init offers cpp", () => {
		const chatId = chatWithPlan(undefined);
		const ctx = (extra: Partial<TeacherToolContext> = {}): TeacherToolContext => ({ chatId, chatStore, jobStore, spawn: () => {}, ...extra });
		assert.equal("cpp_exercise" in createTeacherTools(ctx()), false);
		const on = createTeacherTools(ctx({ cpp: stubCpp() }));
		assert.equal("cpp_exercise" in on, true);
		assert.equal("cpp_review" in on, true);
		const params = (on.plan_init!.parameters as { properties: { codeCells: { anyOf: { const: string }[] } } }).properties.codeCells;
		assert.deepEqual(params.anyOf.map((a) => a.const), ["cpp"]);
	});

	it("LH_CPP_URL configures the checker", () => {
		assert.equal(cppServiceUrl({}), null);
		assert.equal(cppChecker({}), null);
		assert.equal(cppServiceUrl({ LH_CPP_URL: "http://cpp:3500/" }), "http://cpp:3500");
	});
});

describe("the server grades the submitted solution", () => {
	const submitted = (text: string): QuestionAnswerData => ({ kind: "cpp", questionText: "x", dontKnow: false, answers: [], text, correct: true, answeredAt: "t" });

	it("runs every test, hidden ones included, and stores the verdict", async () => {
		const calls: string[] = [];
		const passed = await gradeCppAnswer(exercise, submitted(good), stubCpp(calls));
		assert.deepEqual(calls, ["1,2,3"]);
		assert.equal(passed.correct, true);
		assert.equal(passed.cpp!.referenceSolution, good);
		assert.match(String(compactAnswerForModel(passed).review), /cpp_review/);
		const failed = await gradeCppAnswer(exercise, submitted(fitted), stubCpp());
		assert.equal(failed.correct, false, "the client's claim is ignored");
		assert.equal(compactAnswerForModel(failed).verdict, "1 of 3 tests fail.");
		await assert.rejects(gradeCppAnswer(exercise, submitted(good), null), (e) => e instanceof CppAnswerError && e.status === 503);
	});

	it("finds the exercise of a persisted call (teaching or a practice problem)", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "cpp_exercise", arguments: exercise }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "S", cpp: { head: base.head, tests: base.tests } } }] },
		] as unknown as LhMessage[];
		assert.equal(cppExerciseOfCall(messages, "c1")?.tests.length, 3);
		assert.equal(cppExerciseOfCall(messages, "p1")?.question, "S");
	});
});

describe("cpp_review", () => {
	it("records an overrule of a pass, once; nothing to review on a failed answer", async () => {
		const chatId = chatWithPlan("cpp");
		const answered = (id: string, passed: boolean) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "cpp_exercise",
			isError: false,
			details: { kind: "cpp", cpp: { solution: "s", summary: "", verdict: { passed, reason: passed ? "passed" : "tests", errors: [], warnings: [], tests: [], scope: "all", ms: 1 } } },
			content: [],
			timestamp: 2,
		});
		append(chatId, [answered("ok1", true), answered("bad1", false)]);
		const tool = cppReviewToolFor({ chatId, chatStore });
		const r = await call(tool, { exerciseCallId: "ok1", accepted: false, reason: "It special-cases the test inputs." });
		assert.equal(r.ok, true);
		append(chatId, [{ role: "toolResult", toolCallId: "rv1", toolName: "cpp_review", isError: false, details: r.details, content: [], timestamp: 3 }]);
		assert.deepEqual(cppReviewOf(chatStore.getChat(chatId)!.messages, "ok1"), { accepted: false, reason: "It special-cases the test inputs." });
		assert.match((await call(tool, { exerciseCallId: "ok1", accepted: true, reason: "x" })).problems.join("\n"), /already reviewed/);
		assert.match((await call(tool, { exerciseCallId: "bad1", accepted: true, reason: "x" })).problems.join("\n"), /The tests did not pass/);
	});
});

describe("practice C++ problems", () => {
	const pose = { statement: "Sum the elements.", mode: "recall", modelSolution: "loop", cpp: { head: base.head, tests: base.tests, referenceSolution: good } };

	it("pose only for material from C++ sessions, with a passing reference solution; one code cell per problem", async () => {
		const chatId = chatWithPlan(undefined, "practice");
		const tools = (sourced: boolean) => practiceTools({ chatId, chatStore, cpp: { check: stubCpp(), cppSourced: () => sourced } });
		assert.match((await call(tools(false).problem!, pose, "pr1")).problems.join("\n"), /only for material from C\+\+ sessions/);
		const ok = await call(tools(true).problem!, pose, "pr2");
		assert.equal(ok.ok, true, ok.problems.join("\n"));
	});

	it("a submission carries the solution; the verdict reaches the model", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: "", cppSolution: "int x;", cpp: { forged: true } }), {
			type: "thinking",
			problemCallId: "p1",
			text: "",
			cppSolution: "int x;",
		});
		const msg = newThinkingMessage("p1", "", undefined, undefined, {
			solution: "int sum…",
			summary: "1 of 3 tests fail.",
			verdict: { passed: false, reason: "tests", errors: [], warnings: [], scope: "all", ms: 1, tests: [{ name: "negatives", hidden: true, passed: false, outcome: "check", message: "CHECK_EQ failed", ms: 1 }] },
		});
		const content = String((msg as { content: unknown }).content);
		assert.match(content, /Submitted C\+\+ solution:\nint sum…/);
		assert.match(content, /Test verdict: does not pass — 1 of 3 tests fail\./);
		assert.match(content, /test "negatives" \(hidden\) fails: CHECK_EQ failed/);
	});
});
