/**
 * A small C++ highlighter and the editor's word list (owner, 2026-11-09):
 * keywords, common std names, and the names the file defines.
 */
import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

const KEYWORDS = (
	"alignas alignof and auto bool break case catch char char8_t char16_t char32_t class concept const consteval constexpr " +
	"constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum " +
	"explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr " +
	"operator or private protected public register reinterpret_cast requires return short signed sizeof static " +
	"static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union " +
	"unsigned using virtual void volatile wchar_t while override final"
).split(" ");

/** Common std names a learner reaches for. */
const STD_NAMES: { label: string; detail: string }[] = [
	["std", "namespace"],
	["vector", "<vector>"],
	["string", "<string>"],
	["string_view", "<string_view>"],
	["map", "<map>"],
	["unordered_map", "<unordered_map>"],
	["set", "<set>"],
	["unordered_set", "<unordered_set>"],
	["array", "<array>"],
	["deque", "<deque>"],
	["queue", "<queue>"],
	["priority_queue", "<queue>"],
	["stack", "<stack>"],
	["pair", "<utility>"],
	["tuple", "<tuple>"],
	["optional", "<optional>"],
	["variant", "<variant>"],
	["unique_ptr", "<memory>"],
	["shared_ptr", "<memory>"],
	["make_unique", "<memory>"],
	["make_shared", "<memory>"],
	["move", "<utility>"],
	["swap", "<utility>"],
	["size_t", "<cstddef>"],
	["sort", "<algorithm>"],
	["find", "<algorithm>"],
	["min", "<algorithm>"],
	["max", "<algorithm>"],
	["accumulate", "<numeric>"],
	["reverse", "<algorithm>"],
	["begin", "iterator"],
	["end", "iterator"],
	["size", "member"],
	["push_back", "member"],
	["emplace_back", "member"],
	["empty", "member"],
	["cout", "<iostream>"],
	["endl", "<iostream>"],
	["to_string", "<string>"],
].map(([label, detail]) => ({ label: label!, detail: detail! }));

const KEYWORD_SET = new Set(KEYWORDS);
const TYPE_WORDS = new Set(["bool", "char", "int", "long", "short", "float", "double", "void", "auto", "unsigned", "signed", "size_t"]);

export const cppLanguage = StreamLanguage.define<{ comment: boolean }>({
	startState: () => ({ comment: false }),
	token(stream, state) {
		if (state.comment) {
			if (stream.skipTo("*/")) {
				stream.match("*/");
				state.comment = false;
			} else stream.skipToEnd();
			return "comment";
		}
		if (stream.eatSpace()) return null;
		if (stream.match("//")) {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match("/*")) {
			state.comment = true;
			return "comment";
		}
		if (stream.sol() && stream.match(/^\s*#\s*\w+/)) {
			stream.skipToEnd();
			return "meta";
		}
		if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
		if (stream.match(/^(?:0x[0-9a-fA-F']+|\d[\d']*(?:\.\d*)?(?:e[+-]?\d+)?)[uUlLfF]*/)) return "number";
		if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
			const word = stream.current();
			if (TYPE_WORDS.has(word)) return "typeName";
			if (KEYWORD_SET.has(word)) return "keyword";
			return /^[A-Z]/.test(word) ? "typeName" : "variableName";
		}
		stream.next();
		return null;
	},
	languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});

export const cppHighlight = HighlightStyle.define([
	{ tag: tags.keyword, color: "var(--lean-keyword, #7c3aed)" },
	{ tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: tags.string, color: "var(--lean-string, #0f766e)" },
	{ tag: tags.number, color: "var(--lean-number, #b45309)" },
	{ tag: tags.typeName, color: "var(--lean-type, #2563eb)" },
	{ tag: tags.meta, color: "var(--muted-foreground)" },
]);

/** Function, type and variable names defined in the file (rough). */
export function cppDefinedNames(doc: string): string[] {
	const names = new Set<string>();
	for (const m of doc.matchAll(/\b(?:struct|class|enum(?:\s+class)?|using|namespace)\s+([A-Za-z_]\w*)/g)) names.add(m[1]!);
	for (const m of doc.matchAll(/\b[A-Za-z_][\w:<>,\s*&]*?\s+\**&?([A-Za-z_]\w*)\s*\(/g)) if (!KEYWORD_SET.has(m[1]!)) names.add(m[1]!);
	for (const m of doc.matchAll(/\b(?:auto|int|long|double|float|bool|char|size_t|std::\w+(?:<[^;=()]*>)?)\s+&?([A-Za-z_]\w*)\s*[=;{(,)]/g)) names.add(m[1]!);
	return [...names];
}

export function cppCompletionSource(editableFrom: () => number): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		if (ctx.pos < editableFrom()) return null;
		const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
		if (!word || (word.text.length < 2 && !ctx.explicit)) return null;
		const options: Completion[] = [
			...cppDefinedNames(ctx.state.doc.toString()).map((label): Completion => ({ label, type: "variable", detail: "defined here" })),
			...STD_NAMES.map((o): Completion => ({ label: o.label, type: "function", detail: o.detail })),
			...KEYWORDS.map((label): Completion => ({ label, type: "keyword" })),
		];
		const seen = new Set<string>();
		return { from: word.from, options: options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true))), validFor: /^[A-Za-z0-9_]*$/ };
	};
}
