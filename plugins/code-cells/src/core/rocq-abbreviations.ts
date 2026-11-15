/**
 * Input abbreviations for Rocq cells (owner, 2026-11-12), the same input
 * method as the Lean cells (`\sep` then a space → `∗`): Iris's connectives
 * and the Unicode logic Iris and std++ use. Plain Rocq without
 * `From Stdlib Require Import Utf8` reads only ASCII (`->`, `/\`, `forall`),
 * so these are for Iris cells and Utf8 preludes.
 */
export const ROCQ_ABBREVIATIONS: Readonly<Record<string, string>> = {
	// Iris
	sep: "∗", star: "∗", "*": "∗", wand: "-∗", "-*": "-∗", later: "▷", "|>": "▷", box: "□", pers: "□", always: "□",
	diamond: "◇", except0: "◇", bupd: "|==>", fupd: "={⊤}=∗", own: "own", ent: "⊢", "|-": "⊢", vdash: "⊢", "-|-": "⊣⊢",
	equiv: "≡", "==": "≡", top: "⊤", bot: "⊥", emp: "emp", ".": "·", cdot: "·", "<": "⟨", ">": "⟩",
	// logic
	to: "→", r: "→", "->": "→", iff: "↔", "<->": "↔", and: "∧", or: "∨", not: "¬", forall: "∀", all: "∀", exists: "∃", ex: "∃",
	lam: "λ", fun: "λ", le: "≤", ge: "≥", ne: "≠", in: "∈", notin: "∉", sub: "⊆", subseteq: "⊆", cup: "∪", cap: "∩", empty: "∅",
	// Greek (Σ for Iris's resource algebras)
	S: "Σ", Sigma: "Σ", a: "α", b: "β", g: "γ", G: "Γ", d: "δ", e: "ε", th: "θ", k: "κ", l: "λ", lambda: "λ", m: "μ", phi: "φ", Phi: "Φ", Psi: "Ψ", psi: "ψ",
};

/** The symbols the cell's symbol bar offers (wider screens), in order. */
export const ROCQ_SYMBOL_BAR: readonly string[] = ["∗", "-∗", "▷", "□", "⊢", "∀", "∃", "→", "∧", "∨", "¬", "λ", "Σ", "Φ", "≡", "|==>", "⌜", "⌝"];
