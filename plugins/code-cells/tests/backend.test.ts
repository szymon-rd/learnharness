/**
 * The backend against a fake host context and a fake Lean checker: the
 * verify-then-pose flow, the mixing rule, grading, reviews, the live-check
 * lookup and the settings toggles.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { activateWith } from "../src/backend.ts";
import type { Checkers } from "../src/server/grade.ts";
import type { LeanCheckResult } from "../src/core/lean-cell.ts";

/** Lean, faked: `sorry` in the source fails, anything else passes. */
async function fakeLean(source: string): Promise<LeanCheckResult> {
	const lines = source.split("\n");
	const report = lines.findIndex((l) => l.startsWith("#print axioms")) + 1;
	if (/\bsorry\b/.test(source)) {
		return { exitCode: 0, timedOut: false, ms: 1, messages: [{ severity: "warning", pos: { line: 3, column: 0 }, data: "declaration uses 'sorry'" }, { severity: "information", pos: { line: report, column: 0 }, data: "'t' depends on axioms: [sorryAx]" }] };
	}
	return { exitCode: 0, timedOut: false, ms: 1, messages: [{ severity: "information", pos: { line: report, column: 0 }, data: "'t' depends on axioms: [propext]" }] };
}

type Registered = { kind: string; value: any };

function fakeHost(options: { checkers?: Partial<Checkers>; session?: () => unknown } = {}) {
	const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "code-cells-test-"));
	const live = new Set<Registered>();
	const handlers = new Map<string, (input: unknown) => unknown>();
	const events: { topic: string; data: unknown }[] = [];
	const add = (kind: string, value: unknown) => {
		const entry = { kind, value };
		live.add(entry);
		return () => live.delete(entry);
	};
	const ctx = {
		dataDirectory,
		signal: new AbortController().signal,
		learning: { getSession: () => options.session?.() ?? { messages: [] } },
		registerQuestionType: (value: unknown) => add("question", value),
		registerProblemType: (value: unknown) => add("problem", value),
		registerInstructions: (value: unknown) => add("instructions", value),
		registerTools: (value: unknown) => add("tools", value),
		handle: (name: string, handler: (input: unknown) => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		events: { emit: (topic: string, data: unknown) => events.push({ topic, data }) },
	};
	const checkers: Checkers = { lean: fakeLean, tla: null, cpp: null, rocq: null, ...options.checkers };
	const dispose = activateWith(ctx as never, checkers);
	const of = (kind: string) => [...live].filter((r) => r.kind === kind).map((r) => r.value);
	const tool = (name: string, agent = "teacher") => {
		for (const t of of("tools")) {
			if (!t.agents.includes(agent)) continue;
			const found = t.create({ chatId: "c1", agent }).find((x: { name: string }) => x.name === name);
			if (found) return found;
		}
		return undefined;
	};
	return { ctx, of, tool, handlers, events, dispose, dataDirectory };
}

const payload = { statement: "theorem t : 1 + 1 = 2 := by", referenceProof: "  norm_num" };
const teach = (p: Record<string, unknown>) => ({ chatId: "c1", variant: "teach", contractVersion: 1, input: { type: "check", nodeId: "n", question: "Prove it.", payload: p } });

test("only languages with a checker register, with the verify tool", () => {
	const host = fakeHost();
	assert.deepEqual(host.of("question").map((q) => q.teach.toolName), ["lean_exercise"]);
	assert.deepEqual(host.of("problem").map((p) => p.tool.toolName), ["lean_problem"]);
	assert.ok(host.tool("code_cell_verify"));
	assert.equal(host.tool("code_cell_review"), undefined, "no TLA+/C++ checker, no review tool");
	host.dispose();
});

test("a payload must be verified before it can be posed", async () => {
	const host = fakeHost();
	const question = host.of("question")[0];
	assert.match(question.validateQuestion(teach(payload)).join("\n"), /has not been verified/);
	const verify = host.tool("code_cell_verify");
	const ok = await verify.execute("v1", { language: "lean", question: "Prove it.", payload });
	assert.equal(ok.isError, undefined);
	assert.equal(question.validateQuestion(teach(payload)), undefined);
	// learnerAsked is pacing, not content: still verified.
	assert.equal(question.validateQuestion(teach({ ...payload, learnerAsked: true })), undefined);
	// Any content change needs a new verification.
	assert.match(question.validateQuestion(teach({ ...payload, statement: "theorem t : 2 + 2 = 4 := by" })).join("\n"), /has not been verified/);
	// The problem side shares the cache.
	const problem = host.of("problem")[0];
	assert.equal(problem.validateProblem({ chatId: "c1", contractVersion: 1, input: { statement: "Prove it.", mode: "composition", modelSolution: "x", payload } }), undefined);
	host.dispose();
});

test("a failing reference is refused with the checker's reasons", async () => {
	const host = fakeHost();
	const result = await host.tool("code_cell_verify").execute("v1", { language: "lean", question: "Prove it.", payload: { ...payload, referenceProof: "  sorry" } });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /must not use sorry|does not pass/);
	host.dispose();
});

test("never two code cells in a row unless the learner asked", async () => {
	const session = { messages: [{ role: "toolResult", toolName: "lean_exercise", details: { kind: "plugin-question", pluginId: "code-cells", typeId: "lean", questionId: "q0" } }] };
	const host = fakeHost({ session: () => session });
	await host.tool("code_cell_verify").execute("v1", { language: "lean", question: "Prove it.", payload });
	const question = host.of("question")[0];
	assert.match(question.validateQuestion(teach(payload)).join("\n"), /already a code cell/);
	assert.equal(question.validateQuestion(teach({ ...payload, learnerAsked: true })), undefined);
	// Another question in between clears it.
	session.messages.push({ role: "toolResult", toolName: "quiz", details: {} as never });
	assert.equal(question.validateQuestion(teach(payload)), undefined);
	host.dispose();
});

test("grading returns the verdict, and a checker failure throws (the host saves grading.error)", async () => {
	const host = fakeHost();
	const question = host.of("question")[0];
	const pass = await question.gradeAnswer({ ...teach(payload), questionId: "q1", answer: "  norm_num", signal: new AbortController().signal });
	assert.equal(pass.passed, true);
	assert.equal(pass.summary, "Lean accepts the proof.");
	const fail = await question.gradeAnswer({ ...teach(payload), questionId: "q1", answer: "  sorry", signal: new AbortController().signal });
	assert.equal(fail.passed, false);
	host.dispose();
	const broken = fakeHost({ checkers: { lean: async () => { throw new Error("down"); } } });
	await assert.rejects(broken.of("question")[0].gradeAnswer({ ...teach(payload), questionId: "q1", answer: "x", signal: new AbortController().signal }), /down/);
	broken.dispose();
});

test("reviews attach to the newest passed TLA+/C++ answer", async () => {
	const session = { messages: [{ role: "toolResult", toolName: "cpp_exercise", details: { kind: "plugin-question", pluginId: "code-cells", typeId: "cpp", questionId: "q9", grading: { result: { passed: true } } } }] };
	const host = fakeHost({ checkers: { cpp: async () => { throw new Error("unused"); } }, session: () => session });
	const review = host.tool("code_cell_review");
	assert.ok(review);
	assert.equal((await review.execute("r1", { accepted: false })).isError, true, "a rejection needs a reason");
	const ok = await review.execute("r1", { accepted: false, reason: "special-cases the tests" });
	assert.equal(ok.isError, undefined);
	assert.deepEqual(await host.handlers.get("review")!({ questionId: "q9" }), { accepted: false, reason: "special-cases the tests", at: (await host.handlers.get("review")!({ questionId: "q9" }) as { at: string }).at });
	assert.equal(host.events.at(-1)?.topic, "review");
	host.dispose();
});

test("settings: switching a language off removes its tools; it persists", async () => {
	const host = fakeHost();
	const view = (await host.handlers.get("set-language")!({ language: "lean", enabled: false })) as { settings: { lean: boolean } };
	assert.equal(view.settings.lean, false);
	assert.equal(host.of("question").length, 0);
	assert.equal(host.tool("code_cell_verify"), undefined);
	assert.equal(JSON.parse(fs.readFileSync(path.join(host.dataDirectory, "settings.json"), "utf8")).lean, false);
	host.dispose();
	const again = fakeHost();
	assert.equal(again.of("question").length, 1, "a fresh data directory defaults to on");
	again.dispose();
});

test("live checks read the exercise from the saved session, never the client", async () => {
	const tlaPayload = { head: "---- MODULE M ----", tail: "====", config: { invariants: ["Inv"] }, referenceSolution: "x" };
	const session = { messages: [{ role: "assistant", lhQuestions: { 0: { questionId: "q1", pluginId: "code-cells", typeId: "tla", input: { question: "Q", payload: tlaPayload } } } }] };
	let seen: unknown = null;
	const host = fakeHost({ session: () => session, checkers: { tla: async (request) => { seen = request; return { runs: [], ms: 1 } as never; } } });
	await assert.rejects(Promise.resolve(host.handlers.get("live-check")!({ chatId: "c1", id: "nope", code: "", mode: "parse" })), /No TLA\+ or C\+\+ code cell/);
	await Promise.resolve(host.handlers.get("live-check")!({ chatId: "c1", id: "q1", code: "Inv == TRUE", mode: "parse" })).then(() => {}, () => {});
	assert.match(JSON.stringify(seen), /MODULE M/);
	host.dispose();
});
