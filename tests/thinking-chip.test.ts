import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingChipLabel, wordCount } from "../components/thinking-chip.tsx";

test("wordCount counts whitespace-separated words, empty for blank text", () => {
	assert.equal(wordCount(""), 0);
	assert.equal(wordCount("   \n "), 0);
	assert.equal(wordCount("one"), 1);
	assert.equal(wordCount(" intro h \n then  rcases "), 4);
});

test("the chip reads the label alone when empty, with a word count otherwise", () => {
	assert.equal(thinkingChipLabel("Thinking", ""), "Thinking");
	assert.equal(thinkingChipLabel("Thinking", "split the or"), "Thinking · 3 words");
	assert.equal(thinkingChipLabel("Thinking", "stuck"), "Thinking · 1 word");
});
