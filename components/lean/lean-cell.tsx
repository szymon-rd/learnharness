"use client";

/**
 * The Lean code cell editor (owner, 2026-10-30): the exercise's locked
 * prelude + statement above the learner's editable proof, checked live by
 * the Lean language server (/lean/lsp): errors underlined, the goal at the
 * cursor below, and a status badge — "Passes" before submitting. On a
 * phone, a symbol bar inserts →, ∀, ℕ, …; on a keyboard, `\to` + space
 * expands like in the Lean editors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { linter, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { cn } from "@/lib/utils";
import { cellDocument, cellLayout, expandAbbreviationBefore, LEAN_SYMBOL_BAR, type ResolvedLeanExercise } from "@/src/core";
import { LeanSession, type LeanConnection, type LeanDiagnostic } from "./lean-lsp";

export type LeanCellStatus = "connecting" | "checking" | "passes" | "sorry" | "errors" | "offline";

const STATUS_TEXT: Record<LeanCellStatus, string> = {
	connecting: "Starting Lean…",
	checking: "Checking…",
	passes: "Passes",
	sorry: "Incomplete (sorry)",
	errors: "Errors",
	offline: "Lean offline",
};

const STATUS_CLASS: Record<LeanCellStatus, string> = {
	connecting: "bg-muted text-muted-foreground",
	checking: "bg-muted text-muted-foreground",
	passes: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	sorry: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	errors: "bg-red-500/15 text-red-700 dark:text-red-400",
	offline: "bg-muted text-muted-foreground",
};

// ─── a small Lean highlighter ───────────────────────────────────────────

const KEYWORDS = new Set(
	(
		"theorem lemma def example abbrev instance structure class inductive where extends namespace section end open " +
		"variable universe import by fun λ have show from let in at with match if then else do return calc suffices " +
		"obtain intro intros exact apply refine rw rwa simp simp_all dsimp norm_num ring ring_nf linarith nlinarith " +
		"positivity omega decide constructor cases rcases induction use exists left right ext funext congr gcongr " +
		"field_simp unfold specialize contradiction exfalso trivial rfl assumption aesop tauto push_neg by_contra " +
		"by_cases split_ifs sorry admit only using generalizing"
	).split(" "),
);

const leanLanguage = StreamLanguage.define<{ comment: number }>({
	startState: () => ({ comment: 0 }),
	token(stream, state) {
		if (state.comment > 0) {
			while (!stream.eol()) {
				if (stream.match("/-")) state.comment++;
				else if (stream.match("-/")) {
					state.comment--;
					if (state.comment === 0) break;
				} else stream.next();
			}
			return "comment";
		}
		if (stream.eatSpace()) return null;
		if (stream.match("--")) {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match("/-")) {
			state.comment = 1;
			return "comment";
		}
		if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
		if (stream.match(/^\d+(\.\d+)?/)) return "number";
		if (stream.match(/^[A-Za-z_Ͱ-Ͽ][\w'.!?Ͱ-Ͽ₀-ₜ]*/)) {
			const word = stream.current();
			if (KEYWORDS.has(word)) return word === "sorry" || word === "admit" ? "invalid" : "keyword";
			return /^[A-Z]/.test(word) ? "typeName" : "variableName";
		}
		stream.next();
		return "operator";
	},
	languageData: { commentTokens: { line: "--", block: { open: "/-", close: "-/" } } },
});

const leanHighlight = HighlightStyle.define([
	{ tag: tags.keyword, color: "var(--lean-keyword, #7c3aed)" },
	{ tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: tags.string, color: "var(--lean-string, #0f766e)" },
	{ tag: tags.number, color: "var(--lean-number, #b45309)" },
	{ tag: tags.typeName, color: "var(--lean-type, #2563eb)" },
	{ tag: tags.invalid, color: "var(--lean-sorry, #d97706)", fontWeight: "600" },
]);

// ─── locked region ──────────────────────────────────────────────────────

/** Edits may only start at or after `lockedEnd` (the proof). */
function lockedPrefix(lockedEnd: number): Extension {
	const lockedLines = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				const deco = Decoration.line({ class: "cm-lean-locked" });
				for (let pos = 0; pos < lockedEnd; ) {
					const line = view.state.doc.lineAt(pos);
					b.add(line.from, line.from, deco);
					pos = line.to + 1;
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations },
	);
	return [
		EditorState.transactionFilter.of((tr) => {
			if (!tr.docChanged) return tr;
			let touchesLocked = false;
			tr.changes.iterChangedRanges((fromA) => {
				if (fromA < lockedEnd) touchesLocked = true;
			});
			return touchesLocked ? [] : tr;
		}),
		lockedLines,
	];
}

/** `\to` + space → `→ ` (the Lean editors' input method). */
const abbreviations = EditorView.inputHandler.of((view, from, to, text) => {
	if (!/^[\s\\(),:\]]$/.test(text) || from !== to) return false;
	const line = view.state.doc.lineAt(from);
	const hit = expandAbbreviationBefore(line.text.slice(0, from - line.from));
	if (!hit) return false;
	const start = line.from + hit.from;
	const keep = text === "\t" ? "" : text;
	view.dispatch({
		changes: { from: start, to: from, insert: hit.insert + keep },
		selection: { anchor: start + hit.insert.length + keep.length },
		userEvent: "input.type",
	});
	return true;
});

const cellTheme = EditorView.theme({
	"&": { fontSize: "13px", backgroundColor: "transparent" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.55", maxHeight: "45vh" },
	".cm-content": { padding: "8px 0" },
	".cm-line": { padding: "0 10px" },
	".cm-lean-locked": { backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)", color: "var(--muted-foreground)" },
	".cm-gutters": { backgroundColor: "transparent", border: "none" },
	".cm-tooltip-lint": { maxWidth: "min(90vw, 36rem)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
});

function toCmDiagnostics(doc: EditorState["doc"], diagnostics: LeanDiagnostic[]): Diagnostic[] {
	const pos = (p: { line: number; character: number }) => {
		const line = doc.line(Math.min(Math.max(p.line + 1, 1), doc.lines));
		return Math.min(line.from + p.character, line.to);
	};
	return diagnostics
		.filter((d) => (d.severity ?? 1) <= 2)
		.map((d) => {
			const from = pos(d.range.start);
			const to = Math.max(from, pos(d.range.end));
			return { from, to, severity: d.severity === 2 ? "warning" : "error", message: d.message } as Diagnostic;
		});
}

function statusOf(connection: LeanConnection, processing: boolean, diagnostics: LeanDiagnostic[]): LeanCellStatus {
	if (connection === "connecting") return "connecting";
	if (connection === "closed") return "offline";
	if (processing) return "checking";
	if (diagnostics.some((d) => (d.severity ?? 1) === 1)) return "errors";
	if (diagnostics.some((d) => /declaration uses ['`]sorry['`]/.test(d.message))) return "sorry";
	return "passes";
}

export interface LeanCellProps {
	exercise: ResolvedLeanExercise;
	/** Names the document (one cell per question call). */
	cellId: string;
	initialProof: string;
	onProofChange: (proof: string) => void;
	onStatus?: (status: LeanCellStatus) => void;
}

export function LeanCell({ exercise, cellId, initialProof, onProofChange, onStatus }: LeanCellProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const session = useRef<LeanSession | null>(null);
	const [connection, setConnection] = useState<LeanConnection>("connecting");
	const [offlineReason, setOfflineReason] = useState<string | null>(null);
	const [processing, setProcessing] = useState(true);
	const [diagnostics, setDiags] = useState<LeanDiagnostic[]>([]);
	const [goals, setGoals] = useState<string[] | null>(null);
	const [attempt, setAttempt] = useState(0);
	const onProofChangeRef = useRef(onProofChange);
	onProofChangeRef.current = onProofChange;

	const layout = useMemo(() => cellLayout(exercise), [exercise]);
	const prefix = useMemo(() => cellDocument(exercise, "").slice(0, -1), [exercise]); // everything before the proof
	const lockedEnd = prefix.length;
	const proofOf = useCallback((doc: string) => (doc.startsWith(prefix) ? doc.slice(prefix.length).replace(/\n$/, "") : ""), [prefix]);

	const refreshGoals = useCallback(() => {
		const v = view.current;
		const s = session.current;
		if (!v || !s) return;
		const head = v.state.selection.main.head;
		const line = v.state.doc.lineAt(head);
		s.goals(line.number - 1, head - line.from)
			.then((g) => setGoals(g))
			.catch(() => setGoals(null));
	}, []);

	// The editor (once per cell).
	useEffect(() => {
		if (!host.current) return;
		let changeTimer: ReturnType<typeof setTimeout> | undefined;
		let goalTimer: ReturnType<typeof setTimeout> | undefined;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				// No trailing blank line: the proof is the editor's last line.
				doc: cellDocument(exercise, initialProof).replace(/\n$/, ""),
				extensions: [
					history(),
					indentUnit.of("  "),
					keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
					leanLanguage,
					syntaxHighlighting(leanHighlight),
					lockedPrefix(lockedEnd),
					abbreviations,
					linter(null),
					lintGutter(),
					cellTheme,
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Lean proof" }),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) {
							const text = u.state.doc.toString();
							onProofChangeRef.current(proofOf(text));
							clearTimeout(changeTimer);
							changeTimer = setTimeout(() => session.current?.change(text), 250);
						}
						if (u.docChanged || u.selectionSet) {
							clearTimeout(goalTimer);
							goalTimer = setTimeout(refreshGoals, 300);
						}
					}),
				],
			}),
		});
		view.current = v;
		// Start with the cursor at the end of the proof.
		v.dispatch({ selection: { anchor: v.state.doc.length } });
		return () => {
			clearTimeout(changeTimer);
			clearTimeout(goalTimer);
			v.destroy();
			view.current = null;
		};
		// The cell is fixed for its lifetime; the initial proof is read once.
	}, [exercise, lockedEnd]);

	// The Lean session (reconnects on retry).
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		const s = new LeanSession(cellId.replace(/[^A-Za-z0-9_]/g, "_"), {
			onConnection: (state, reason) => {
				setConnection(state);
				setOfflineReason(state === "closed" ? (reason ?? null) : null);
			},
			onProcessing: (p) => {
				setProcessing(p);
				if (!p) refreshGoals();
			},
			onDiagnostics: (_version, diags) => {
				setDiags(diags);
				const ed = view.current;
				if (ed) ed.dispatch(setDiagnostics(ed.state, toCmDiagnostics(ed.state.doc, diags)));
			},
		});
		session.current = s;
		setConnection("connecting");
		s.start(v.state.doc.toString()).catch((err: Error) => {
			setConnection("closed");
			setOfflineReason(err.message);
		});
		return () => {
			s.close();
			if (session.current === s) session.current = null;
		};
	}, [cellId, attempt, refreshGoals]);

	const status = statusOf(connection, processing, diagnostics);
	useEffect(() => onStatus?.(status), [status, onStatus]);

	const insert = (text: string) => {
		const v = view.current;
		if (!v) return;
		const { from, to } = v.state.selection.main;
		if (from < lockedEnd) return;
		v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
		v.focus();
	};

	return (
		<div className="flex flex-col gap-2" data-testid="lean-cell">
			<div className="overflow-hidden rounded-lg border border-border/70 bg-background">
				<div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs">
					<span className="font-medium text-muted-foreground">Lean 4 · Mathlib</span>
					<span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_CLASS[status])} data-testid="lean-status" data-status={status}>
						{STATUS_TEXT[status]}
					</span>
				</div>
				<div ref={host} data-proof-line={layout.proofLine} />
			</div>
			{/* Phone symbol bar: mousedown keeps the editor's focus. */}
			<div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" role="toolbar" aria-label="Lean symbols">
				<button
					type="button"
					className="h-8 shrink-0 rounded-md border border-border/60 px-2 text-xs text-muted-foreground"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => insert("  ")}
				>
					Tab
				</button>
				{LEAN_SYMBOL_BAR.map((sym) => (
					<button
						key={sym}
						type="button"
						className="h-8 min-w-8 shrink-0 rounded-md border border-border/60 px-1.5 font-mono text-sm"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => insert(sym)}
					>
						{sym}
					</button>
				))}
			</div>
			{connection === "closed" ? (
				<div className="flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
					<span>{offlineReason ?? "Lean is not connected."} You can still submit; the server checks the proof.</span>
					<button type="button" className="shrink-0 font-medium text-foreground underline" onClick={() => setAttempt((n) => n + 1)}>
						Reconnect
					</button>
				</div>
			) : (
				<div className="rounded-lg bg-muted/40 px-3 py-2" data-testid="lean-goals">
					<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal at cursor</div>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
						{goals === null ? (connection === "ready" ? "—" : "…") : goals.length === 0 ? "No goals" : goals.join("\n\n")}
					</pre>
				</div>
			)}
		</div>
	);
}
