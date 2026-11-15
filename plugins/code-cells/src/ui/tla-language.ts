/**
 * A small TLA+ / PlusCal highlighter and the editor's word list (owner,
 * 2026-11-05). TLA+ is ASCII (`/\`, `\in`, `[]`), so no input method is
 * needed; completion offers keywords, standard-module operators and the
 * names the module defines.
 */
import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

const TLA_KEYWORDS = (
	"MODULE EXTENDS CONSTANT CONSTANTS VARIABLE VARIABLES ASSUME ASSUMPTION AXIOM THEOREM LEMMA PROPOSITION COROLLARY " +
	"LOCAL INSTANCE WITH LET IN IF THEN ELSE CASE OTHER CHOOSE EXCEPT DOMAIN SUBSET UNION ENABLED UNCHANGED RECURSIVE " +
	"LAMBDA TRUE FALSE BOOLEAN STRING WF_ SF_"
).split(" ");

const PLUSCAL_KEYWORDS = (
	"algorithm fair process procedure variables variable begin end while do if then else elsif either or with await " +
	"when goto skip return call assert print macro define labels"
).split(" ");

/** Operators from the standard modules a learner reaches for. */
const STANDARD_OPERATORS: { label: string; detail: string }[] = [
	{ label: "Nat", detail: "Naturals" },
	{ label: "Int", detail: "Integers" },
	{ label: "Seq", detail: "Sequences: Seq(S)" },
	{ label: "Len", detail: "Sequences: Len(s)" },
	{ label: "Head", detail: "Sequences: Head(s)" },
	{ label: "Tail", detail: "Sequences: Tail(s)" },
	{ label: "Append", detail: "Sequences: Append(s, e)" },
	{ label: "SubSeq", detail: "Sequences: SubSeq(s, m, n)" },
	{ label: "SelectSeq", detail: "Sequences: SelectSeq(s, Test)" },
	{ label: "Cardinality", detail: "FiniteSets: Cardinality(S)" },
	{ label: "IsFiniteSet", detail: "FiniteSets: IsFiniteSet(S)" },
	{ label: "Print", detail: "TLC: Print(out, val)" },
	{ label: "PrintT", detail: "TLC: PrintT(out)" },
	{ label: "Assert", detail: "TLC: Assert(val, out)" },
	{ label: "Permutations", detail: "TLC: Permutations(S)" },
	{ label: "SortSeq", detail: "TLC: SortSeq(s, Op(_, _))" },
	{ label: "ToString", detail: "TLC: ToString(v)" },
	{ label: "Naturals", detail: "module" },
	{ label: "Integers", detail: "module" },
	{ label: "Sequences", detail: "module" },
	{ label: "FiniteSets", detail: "module" },
	{ label: "TLC", detail: "module" },
];

const KEYWORD_SET = new Set([...TLA_KEYWORDS, ...PLUSCAL_KEYWORDS]);

/** Comment depth for `(* … *)` (nests in TLA+). */
export const tlaLanguage = StreamLanguage.define<{ comment: number }>({
	startState: () => ({ comment: 0 }),
	token(stream, state) {
		if (state.comment > 0) {
			// PlusCal lives inside a comment: highlight it as code, and only
			// the comment markers as comments.
			if (stream.match("*)")) {
				state.comment--;
				return "comment";
			}
			if (stream.match("(*")) {
				state.comment++;
				return "comment";
			}
		}
		if (stream.eatSpace()) return null;
		if (stream.match("\\*")) {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match("(*")) {
			state.comment++;
			return "comment";
		}
		if (stream.match(/^-{4,}|^={4,}/)) return "meta";
		if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
		if (stream.match(/^\d+/)) return "number";
		if (stream.match(/^\\[A-Za-z]+/)) return "operator"; // \in, \cup, \A, \E, \/ …
		if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
			const word = stream.current();
			if (KEYWORD_SET.has(word)) return "keyword";
			return /^[A-Z]/.test(word) ? "typeName" : "variableName";
		}
		if (stream.match(/^(\/\\|\\\/|=>|<=>|\[\]|<>|~>|==|#|\|->|->|:=|\.\.|'|<<|>>)/)) return "operator";
		stream.next();
		return null;
	},
	languageData: { commentTokens: { line: "\\*", block: { open: "(*", close: "*)" } } },
});

export const tlaHighlight = HighlightStyle.define([
	{ tag: tags.keyword, color: "var(--lean-keyword, #7c3aed)" },
	{ tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: tags.string, color: "var(--lean-string, #0f766e)" },
	{ tag: tags.number, color: "var(--lean-number, #b45309)" },
	{ tag: tags.typeName, color: "var(--lean-type, #2563eb)" },
	{ tag: tags.operator, color: "var(--lean-type, #2563eb)" },
	{ tag: tags.meta, color: "var(--muted-foreground)" },
]);

/** Names defined in the module text (`Name ==`, `Name(args) ==`, VARIABLES, CONSTANTS). */
export function definedNames(doc: string): string[] {
	const names = new Set<string>();
	for (const m of doc.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm)) names.add(m[1]!);
	for (const m of doc.matchAll(/^\s*(?:VARIABLES?|CONSTANTS?)\s+([^\n]+)/gm)) {
		for (const n of m[1]!.split(",")) {
			const id = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(n)?.[1];
			if (id) names.add(id);
		}
	}
	return [...names];
}

/** Keyword, standard-operator and defined-name completion. */
export function tlaCompletionSource(editableFrom: () => number): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		if (ctx.pos < editableFrom()) return null;
		const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
		if (!word || (word.text.length < 2 && !ctx.explicit)) return null;
		const defined = definedNames(ctx.state.doc.toString()).map((label): Completion => ({ label, type: "variable", detail: "defined here" }));
		const options: Completion[] = [
			...defined,
			...STANDARD_OPERATORS.map((o): Completion => ({ label: o.label, type: "function", detail: o.detail })),
			...TLA_KEYWORDS.map((label): Completion => ({ label, type: "keyword" })),
			...PLUSCAL_KEYWORDS.map((label): Completion => ({ label, type: "keyword", detail: "PlusCal" })),
		];
		const seen = new Set<string>();
		return {
			from: word.from,
			options: options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true))),
			validFor: /^[A-Za-z0-9_]*$/,
		};
	};
}
