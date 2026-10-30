/**
 * Lean's input abbreviations for code cells: type `\to` then a space (or
 * Tab, or another `\`) and it becomes `→`, as in the Lean editors. A
 * subset of the official table — the symbols proofs in Lean + Mathlib use
 * most. The phone symbol bar inserts the same symbols directly.
 */
export const LEAN_ABBREVIATIONS: Readonly<Record<string, string>> = {
	// arrows and logic
	to: "→", r: "→", "->": "→", l: "←", "<-": "←", iff: "↔", "<->": "↔", lr: "↔", "=>": "⇒",
	and: "∧", or: "∨", not: "¬", n: "¬", forall: "∀", all: "∀", exists: "∃", ex: "∃",
	"|-": "⊢", vdash: "⊢", top: "⊤", bot: "⊥",
	// relations
	le: "≤", ge: "≥", ne: "≠", "!=": "≠", equiv: "≡", approx: "≈", "==": "≡",
	in: "∈", notin: "∉", sub: "⊆", subseteq: "⊆", ssub: "⊂", sup: "⊔", inf: "⊓",
	dvd: "∣", mid: "∣",
	// sets and operations
	cup: "∪", cap: "∩", union: "∪", inter: "∩", empty: "∅", emptyset: "∅", compl: "ᶜ",
	x: "×", times: "×", circ: "∘", comp: "∘", ".": "·", cdot: "·", "^-1": "⁻¹", inv: "⁻¹",
	sum: "∑", prod: "∏", Sum: "∑", Prod: "∏", sqrt: "√", infty: "∞",
	"<": "⟨", ">": "⟩", langle: "⟨", rangle: "⟩", "<<": "⟪", ">>": "⟫",
	// number systems
	N: "ℕ", nat: "ℕ", Z: "ℤ", int: "ℤ", Q: "ℚ", R: "ℝ", real: "ℝ", C: "ℂ",
	// Greek
	a: "α", alpha: "α", b: "β", beta: "β", g: "γ", gamma: "γ", d: "δ", delta: "δ",
	e: "ε", epsilon: "ε", eps: "ε", z: "ζ", zeta: "ζ", eta: "η", th: "θ", theta: "θ",
	i: "ι", iota: "ι", k: "κ", kappa: "κ", lam: "λ", lambda: "λ", fun: "λ", mu: "μ", nu: "ν",
	xi: "ξ", pi: "π", rho: "ρ", s: "σ", sigma: "σ", t: "τ", tau: "τ", phi: "φ", f: "φ",
	chi: "χ", psi: "ψ", w: "ω", omega: "ω", G: "Γ", Gamma: "Γ", D: "Δ", Delta: "Δ",
	Pi: "Π", Sigma: "Σ", Omega: "Ω",
	// sub/superscripts
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "_0": "₀", "_1": "₁", "_2": "₂", "_i": "ᵢ", "_n": "ₙ",
	"^2": "²", "^3": "³", "^n": "ⁿ",
};

/** The symbols the phone symbol bar offers, in order. */
export const LEAN_SYMBOL_BAR: readonly string[] = [
	"→", "←", "↔", "∀", "∃", "∧", "∨", "¬", "≤", "≥", "≠", "∈", "ℕ", "ℤ", "ℝ", "⟨", "⟩", "·", "λ", "⊢", "×", "∘", "⁻¹",
];

/**
 * If the text just before the cursor ends in a complete abbreviation
 * (`\to`), return the replacement and how many characters it replaces.
 * Called when the user types a separator (space, Tab, `\`, `(`…).
 */
export function expandAbbreviationBefore(textBeforeCursor: string): { from: number; insert: string } | null {
	const slash = textBeforeCursor.lastIndexOf("\\");
	if (slash < 0) return null;
	const name = textBeforeCursor.slice(slash + 1);
	if (!name || /\s/.test(name)) return null;
	const symbol = LEAN_ABBREVIATIONS[name];
	return symbol ? { from: slash, insert: symbol } : null;
}
