import { test } from "node:test";
import assert from "node:assert/strict";
import { plainEqual, stabilizeView, type LhViewMessage } from "../src/core/view.ts";

const msg = (id: string, text: string, extra: Partial<LhViewMessage> = {}): LhViewMessage =>
	({ id, role: "assistant", parts: [{ type: "text", text }], ...extra }) as LhViewMessage;

test("plainEqual compares plain data structurally", () => {
	assert.ok(plainEqual({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null }));
	assert.ok(!plainEqual({ a: [1, 2] }, { a: [1, 3] }));
	assert.ok(!plainEqual({ a: 1 }, { a: 1, b: undefined }));
	assert.ok(!plainEqual([1], { 0: 1 }));
	assert.ok(plainEqual(undefined, undefined));
});

test("stabilizeView keeps unchanged messages and returns prev when nothing changed", () => {
	const prev = [msg("a", "hello"), msg("b", "world")];
	const same = stabilizeView(prev, [msg("a", "hello"), msg("b", "world")]);
	assert.equal(same, prev);
});

test("stabilizeView reuses untouched messages and parts while one grows", () => {
	const a = msg("a", "done");
	const b = { id: "b", role: "assistant", parts: [{ type: "reasoning", text: "think" }, { type: "text", text: "par" }] } as LhViewMessage;
	const next = stabilizeView([a, b], [
		msg("a", "done"),
		{ id: "b", role: "assistant", parts: [{ type: "reasoning", text: "think" }, { type: "text", text: "partial" }] } as LhViewMessage,
	]);
	assert.equal(next[0], a, "untouched message keeps its object");
	assert.notEqual(next[1], b, "the growing message is new");
	assert.equal(next[1]!.parts[0], b.parts[0], "its unchanged part keeps its object");
	assert.equal((next[1]!.parts[1] as { text: string }).text, "partial");
});

test("stabilizeView handles added and removed messages", () => {
	const a = msg("a", "x");
	const added = stabilizeView([a], [msg("a", "x"), msg("b", "y")]);
	assert.equal(added.length, 2);
	assert.equal(added[0], a);
	const removed = stabilizeView([a, msg("b", "y")], [msg("a", "x")]);
	assert.equal(removed.length, 1);
	assert.equal(removed[0], a);
	assert.deepEqual(stabilizeView(null, [a]), [a]);
});
