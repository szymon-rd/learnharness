"use client";

/**
 * The Rocq code cell editor (owner, 2026-11-12), the same as the Lean cell:
 * the exercise's locked prelude + statement above the learner's editable
 * proof, checked live by coq-lsp (/rocq/lsp): errors underlined, the goals
 * at the cursor below, and a status badge — "Passes" before submitting. On
 * wider screens a symbol bar inserts Iris's ∗, -∗, ▷, □, …; phones get a Tab
 * key in the header. Everywhere, `\sep` + space expands to ∗ (and so on).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { linter, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { autocompletion, closeCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { cn } from "@/lib/utils";
import { expandAbbreviationBefore, ROCQ_ABBREVIATIONS, ROCQ_SYMBOL_BAR, rocqCellDocument, rocqCellLayout, type ResolvedRocqExercise } from "@/src/core";
import { RocqSession, type RocqCompletion, type RocqConnection, type RocqDiagnostic } from "./rocq-lsp";

export type RocqCellStatus = "connecting" | "checking" | "passes" | "admitted" | "errors" | "offline";

const STATUS_TEXT: Record<RocqCellStatus, string> = {
	connecting: "Starting Rocq…",
	checking: "Checking…",
	passes: "Passes",
	admitted: "Incomplete (admit)",
	errors: "Errors",
	offline: "Rocq offline",
};

const STATUS_CLASS: Record<RocqCellStatus, string> = {
	connecting: "bg-muted text-muted-foreground",
	checking: "bg-muted text-muted-foreground",
	passes: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	admitted: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	errors: "bg-red-500/15 text-red-700 dark:text-red-400",
	offline: "bg-muted text-muted-foreground",
};

// ─── a small Rocq highlighter ───────────────────────────────────────────

const KEYWORDS = new Set(
	(
		"Proof Qed Defined Admitted Abort Lemma Theorem Fact Remark Corollary Proposition Example Definition Fixpoint Inductive " +
		"Record Structure Class Instance Context Section End Module Require Import Export From Open Scope Notation Let Variable " +
		"forall exists fun let in match with end as return if then else Type Prop Set " +
		"intros intro apply eapply exact reflexivity symmetry transitivity rewrite simpl cbn unfold induction destruct case " +
		"split left right exists constructor econstructor auto eauto trivial assumption discriminate injection inversion " +
		"subst lia ring field congruence tauto firstorder f_equal specialize generalize revert clear set pose assert " +
		"enough cut exfalso contradiction now by try repeat first solve done naive_solver set_solver " +
		"iIntros iIntro iApply iExact iFrame iSplit iSplitL iSplitR iLeft iRight iExists iDestruct iPureIntro iModIntro iMod " +
		"iNext iAssumption iSpecialize iRevert iInduction iLöb iInv iCombine iEval iRewrite iClear iPoseProof iAssert " +
		"wp_pures wp_load wp_store wp_alloc wp_apply wp_bind wp_rec wp_lam wp_let wp_seq wp_if wp_op wp_faa wp_cmpxchg_suc " +
		"admit"
	).split(" "),
);

const rocqLanguage = StreamLanguage.define<{ comment: number }>({
	startState: () => ({ comment: 0 }),
	token(stream, state) {
		if (state.comment > 0) {
			while (!stream.eol()) {
				if (stream.match("(*")) state.comment++;
				else if (stream.match("*)")) {
					state.comment--;
					if (state.comment === 0) break;
				} else stream.next();
			}
			return "comment";
		}
		if (stream.eatSpace()) return null;
		if (stream.match("(*")) {
			state.comment = 1;
			return "comment";
		}
		if (stream.match(/^"(?:[^"]|"")*"?/)) return "string";
		if (stream.match(/^\d+/)) return "number";
		if (stream.match(/^[A-Za-z_À-ɏͰ-Ͽ][\w'À-ɏͰ-Ͽ]*/)) {
			const word = stream.current();
			if (KEYWORDS.has(word)) return word === "admit" || word === "Admitted" ? "invalid" : "keyword";
			return /^[A-Z]/.test(word) ? "typeName" : "variableName";
		}
		stream.next();
		return "operator";
	},
	languageData: { commentTokens: { block: { open: "(*", close: "*)" } } },
});

const rocqHighlight = HighlightStyle.define([
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
				const deco = Decoration.line({ class: "cm-rocq-locked" });
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

/** `\sep` + space → `∗ ` (the same input method as the Lean cell). */
const abbreviations = EditorView.inputHandler.of((view, from, to, text) => {
	if (!/^[\s\\(),:\]]$/.test(text) || from !== to) return false;
	const line = view.state.doc.lineAt(from);
	const hit = expandAbbreviationBefore(line.text.slice(0, from - line.from), ROCQ_ABBREVIATIONS);
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
	// The cursor follows the text color (CodeMirror draws it black by default,
	// invisible on the dark theme).
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
	".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.55", maxHeight: "45vh" },
	".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
	".cm-line": { padding: "0 10px" },
	".cm-rocq-locked": { backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)", color: "var(--muted-foreground)" },
	".cm-gutters": { backgroundColor: "transparent", border: "none" },
	".cm-tooltip.cm-tooltip-autocomplete": {
		backgroundColor: "var(--popover, var(--card))",
		color: "var(--popover-foreground, var(--foreground))",
		border: "1px solid var(--border)",
		borderRadius: "8px",
		overflow: "hidden",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono, monospace)", fontSize: "12px", maxHeight: "40vh" },
	".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 8px" },
	".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground, var(--foreground))" },
	".cm-tooltip.cm-completionInfo": {
		backgroundColor: "var(--popover, var(--card))",
		color: "var(--popover-foreground, var(--foreground))",
		border: "1px solid var(--border)",
		borderRadius: "8px",
		padding: "6px 8px",
		maxWidth: "min(80vw, 28rem)",
		whiteSpace: "pre-wrap",
	},
	".cm-rocq-completion-type": { fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
	".cm-rocq-completion-doc": { marginTop: "4px", fontSize: "12px", color: "var(--muted-foreground)" },
	".cm-completionDetail": { color: "var(--muted-foreground)", marginLeft: "8px", fontStyle: "normal" },
	".cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-lint": { backgroundColor: "var(--popover, var(--card))", color: "var(--popover-foreground, var(--foreground))", border: "1px solid var(--border)", borderRadius: "8px" },
	".cm-tooltip-lint": { maxWidth: "min(90vw, 36rem)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
});

function toCmDiagnostics(doc: EditorState["doc"], diagnostics: RocqDiagnostic[]): Diagnostic[] {
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

const IDENT_TAIL = /[\w'À-ɏͰ-Ͽ]*$/;

/** coq-lsp's completions (names in scope) plus tactics, as a CodeMirror source. */
function rocqCompletionSource(
	lockedEnd: number,
	session: { current: RocqSession | null },
	flush: () => void,
): (ctx: CompletionContext) => Promise<CompletionResult | null> {
	return async (ctx) => {
		if (ctx.pos < lockedEnd) return null;
		const word = ctx.matchBefore(/[\w'.À-ɏͰ-Ͽ]+/);
		if (!ctx.explicit && (!word || word.text.length < 2)) return null;
		const s = session.current;
		if (!s) return null;
		flush();
		const line = ctx.state.doc.lineAt(ctx.pos);
		let items: RocqCompletion[] = [];
		try {
			items = await s.completions(line.number - 1, ctx.pos - line.from);
		} catch {
			/* keywords only */
		}
		if (ctx.aborted) return null;
		const typed = (word?.text ?? "").toLowerCase();
		const keywords = [...KEYWORDS].filter((k) => k.toLowerCase().startsWith(typed)).map((label): Completion => ({ label, type: "keyword" }));
		const options: Completion[] = [
			...keywords,
			...items.slice(0, 200).map(
				(item): Completion => ({
					label: item.label,
					...(item.detail ? { detail: item.detail.length > 60 ? `${item.detail.slice(0, 60)}…` : item.detail } : {}),
					apply: item.textEdit?.newText ?? item.label,
				}),
			),
		];
		if (!options.length) return null;
		return { from: word?.from ?? ctx.pos, options, validFor: IDENT_TAIL };
	};
}

/** The learner's proof still uses admit / Admitted (comments ignored). */
function usesAdmit(proof: string): boolean {
	let out = "";
	let depth = 0;
	for (let i = 0; i < proof.length; i++) {
		if (proof.startsWith("(*", i)) {
			depth++;
			i++;
		} else if (depth > 0 && proof.startsWith("*)", i)) {
			depth--;
			i++;
		} else if (depth === 0) out += proof[i];
	}
	return /\b(admit|Admitted)\b/.test(out);
}

function statusOf(connection: RocqConnection, processing: boolean, diagnostics: RocqDiagnostic[], proof: string): RocqCellStatus {
	if (connection === "connecting") return "connecting";
	if (connection === "closed") return "offline";
	if (processing) return "checking";
	if (diagnostics.some((d) => (d.severity ?? 1) === 1)) return "errors";
	if (usesAdmit(proof)) return "admitted";
	return "passes";
}

export interface RocqCellProps {
	exercise: ResolvedRocqExercise;
	/** Names the document (one cell per question call). */
	cellId: string;
	initialProof: string;
	onProofChange: (proof: string) => void;
	onStatus?: (status: RocqCellStatus) => void;
	/** Whether the learner is editing the cell. True at once on focus; false
	 *  only after a short delay, so a tap on Submit (which blurs the editor)
	 *  lands before the docks unfold their layout. */
	onEditingChange?: (editing: boolean) => void;
	/** Hide the locked prelude lines (the Require lines and the blank line):
	 *  phones fold them while the keyboard is up. */
	hidePrelude?: boolean;
}

/** Display-only: a hidden block over the prelude lines (before the statement). */
function preludeHidden(statementLine: number): Extension {
	if (statementLine < 1) return [];
	return EditorView.decorations.compute([], (state) => {
		if (state.doc.lines <= statementLine) return Decoration.none;
		const to = state.doc.line(statementLine).to;
		return Decoration.set([Decoration.replace({ block: true }).range(0, to)]);
	});
}

/** How long "editing" outlives a blur (see onEditingChange). */
const EDITING_RELEASE_MS = 400;

export function RocqCell({ exercise, cellId, initialProof, onProofChange, onStatus, onEditingChange, hidePrelude = false }: RocqCellProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const session = useRef<RocqSession | null>(null);
	const [connection, setConnection] = useState<RocqConnection>("connecting");
	const [offlineReason, setOfflineReason] = useState<string | null>(null);
	const [processing, setProcessing] = useState(true);
	const [diagnostics, setDiags] = useState<RocqDiagnostic[]>([]);
	const [goals, setGoals] = useState<string[] | null>(null);
	const [goalsBeforeLine, setGoalsBeforeLine] = useState(false);
	// The newest status, for the goal fallback (read inside async callbacks).
	const statusRef = useRef<RocqCellStatus>("connecting");
	const [attempt, setAttempt] = useState(0);
	// The proof as last edited: survives an editor rebuild (the parent
	// re-rendering with an equal-but-new exercise object must not reset it).
	const latestProof = useRef(initialProof);
	const exerciseRef = useRef(exercise);
	exerciseRef.current = exercise;
	// The editor is rebuilt only when the exercise's TEXT changes.
	const exerciseKey = `${exercise.prelude}\u0000${exercise.statement}`;
	const onProofChangeRef = useRef(onProofChange);
	onProofChangeRef.current = onProofChange;
	const setProofTextRef = useRef<(p: string) => void>(() => {});
	const onEditingChangeRef = useRef(onEditingChange);
	onEditingChangeRef.current = onEditingChange;
	const preludeSlot = useRef(new Compartment());
	const hidePreludeRef = useRef(hidePrelude);
	hidePreludeRef.current = hidePrelude;

	const layout = useMemo(() => rocqCellLayout(exercise), [exercise]);
	const prefix = useMemo(() => rocqCellDocument(exercise, "").slice(0, -1), [exercise]); // everything before the proof
	const lockedEnd = prefix.length;
	const proofOf = useCallback((doc: string) => (doc.startsWith(prefix) ? doc.slice(prefix.length).replace(/\n$/, "") : ""), [prefix]);

	// The newest text not yet sent to Rocq (edits are debounced).
	const pendingText = useRef<string | null>(null);
	const flushChange = useCallback(() => {
		if (pendingText.current === null) return;
		session.current?.change(pendingText.current);
		pendingText.current = null;
	}, []);

	const refreshGoals = useCallback(() => {
		const v = view.current;
		const s = session.current;
		if (!v || !s) return;
		flushChange();
		const head = v.state.selection.main.head;
		const line = v.state.doc.lineAt(head);
		const indent = line.text.search(/\S/);
		void (async () => {
			try {
				const at = await s.goals(line.number - 1, head - line.from);
				// After a line's last tactic (often `admit`, which closes the
				// goal) Rocq reports no goals. While the proof is unfinished
				// that reads like "done": show the goal that line works on.
				if (at && at.length === 0 && statusRef.current !== "passes" && indent >= 0 && head - line.from > indent && head > lockedEnd) {
					const before = await s.goals(line.number - 1, indent);
					if (before && before.length > 0) {
						setGoals(before);
						setGoalsBeforeLine(true);
						return;
					}
				}
				setGoals(at);
				setGoalsBeforeLine(false);
			} catch {
				setGoals(null);
			}
		})();
	}, [flushChange, lockedEnd]);

	// The editor (once per cell).
	useEffect(() => {
		if (!host.current) return;
		let changeTimer: ReturnType<typeof setTimeout> | undefined;
		let goalTimer: ReturnType<typeof setTimeout> | undefined;
		let editingTimer: ReturnType<typeof setTimeout> | undefined;
		const statementLine = rocqCellLayout(exerciseRef.current).statementLine;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				// No trailing blank line: the proof is the editor's last line.
				doc: rocqCellDocument(exerciseRef.current, latestProof.current).replace(/\n$/, ""),
				extensions: [
					history(),
					indentUnit.of("  "),
					keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
					rocqLanguage,
					syntaxHighlighting(rocqHighlight),
					lockedPrefix(lockedEnd),
					abbreviations,
					autocompletion({ override: [rocqCompletionSource(lockedEnd, session, flushChange)], activateOnTypingDelay: 150, maxRenderedOptions: 60, icons: true }),
					linter(null),
					lintGutter(),
					cellTheme,
					preludeSlot.current.of(hidePreludeRef.current ? preludeHidden(statementLine) : []),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Rocq proof" }),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) {
							const text = u.state.doc.toString();
							latestProof.current = proofOf(text);
							onProofChangeRef.current(latestProof.current);
							setProofTextRef.current(latestProof.current);
							pendingText.current = text;
							clearTimeout(changeTimer);
							changeTimer = setTimeout(flushChange, 250);
						}
						if (u.docChanged || u.selectionSet) {
							clearTimeout(goalTimer);
							goalTimer = setTimeout(refreshGoals, 300);
						}
						if (u.focusChanged) {
							clearTimeout(editingTimer);
							if (u.view.hasFocus) onEditingChangeRef.current?.(true);
							else editingTimer = setTimeout(() => onEditingChangeRef.current?.(false), EDITING_RELEASE_MS);
						}
					}),
				],
			}),
		});
		view.current = v;
		// A tap anywhere outside the editor (e.g. Submit) closes the completion
		// list: touch taps do not always move focus, so blur alone is not enough.
		const outside = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && !v.dom.contains(t) && !(t as Element).closest?.(".cm-tooltip")) closeCompletion(v);
		};
		document.addEventListener("pointerdown", outside, true);
		// Start with the cursor at the end of the proof.
		v.dispatch({ selection: { anchor: v.state.doc.length } });
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			clearTimeout(changeTimer);
			clearTimeout(goalTimer);
			clearTimeout(editingTimer);
			v.destroy();
			view.current = null;
		};
		// The cell is fixed for its lifetime; the initial proof is read once.
	}, [exerciseKey, lockedEnd]);

	// Phones fold the prelude while editing (display only; the text is unchanged).
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		v.dispatch({ effects: preludeSlot.current.reconfigure(hidePrelude ? preludeHidden(layout.statementLine) : []) });
	}, [hidePrelude, layout.statementLine]);

	// The Rocq session (reconnects on retry).
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		const s = new RocqSession(cellId.replace(/[^A-Za-z0-9_]/g, "_"), {
			onConnection: (state, reason) => {
				setConnection(state);
				setOfflineReason(state === "closed" ? (reason ?? null) : null);
			},
			onProcessing: (p) => {
				setProcessing(p);
				// After the re-render, so the goal fallback sees the new status.
				if (!p) setTimeout(refreshGoals, 120);
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

	const [proofText, setProofText] = useState(initialProof);
	setProofTextRef.current = setProofText;
	const status = statusOf(connection, processing, diagnostics, proofText);
	statusRef.current = status;
	const shown = diagnostics
		.filter((d) => (d.severity ?? 1) <= 2)
		.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
		.slice(0, 4);
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
		<div className="flex flex-col gap-2" data-testid="rocq-cell">
			<div className="overflow-hidden rounded-lg border border-border/70 bg-background">
				<div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs">
					<span className="font-medium text-muted-foreground">Rocq 9 · Iris</span>
					<span className="flex items-center gap-1.5">
						{/* Phone: the only key a touch keyboard lacks; symbols are
						    typed as \to, \forall, … (mousedown keeps the editor's focus). */}
						<button
							type="button"
							data-testid="rocq-tab-key"
							className="h-7 shrink-0 rounded-md border border-border/60 px-2 text-xs text-muted-foreground sm:hidden"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => insert("  ")}
						>
							Tab
						</button>
						<span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_CLASS[status])} data-testid="rocq-status" data-status={status}>
							{STATUS_TEXT[status]}
						</span>
					</span>
				</div>
				{/* An Esc the editor used (closing the completion list) stops here:
				    the window's Esc chain would otherwise also dismiss the question. */}
				<div
					ref={host}
					data-proof-line={layout.proofLine}
					onKeyDown={(e) => {
						if (e.key === "Escape" && e.defaultPrevented) e.stopPropagation();
					}}
				/>
			</div>
			{/* Symbol bar (wider screens; phones keep only the header's Tab):
			    mousedown keeps the editor's focus. */}
			<div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 max-sm:hidden" role="toolbar" aria-label="Rocq symbols">
				<button
					type="button"
					className="h-8 shrink-0 rounded-md border border-border/60 px-2 text-xs text-muted-foreground"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => insert("  ")}
				>
					Tab
				</button>
				{ROCQ_SYMBOL_BAR.map((sym) => (
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
					<span>{offlineReason ?? "Rocq is not connected."} You can still submit; the server checks the proof.</span>
					<button type="button" className="shrink-0 font-medium text-foreground underline" onClick={() => setAttempt((n) => n + 1)}>
						Reconnect
					</button>
				</div>
			) : (
				<div className="rounded-lg bg-muted/40 px-3 py-2" data-testid="rocq-goals">
					<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{goalsBeforeLine ? "Goals on this line" : "Goals at cursor"}</div>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
						{goals === null ? (connection === "ready" ? "—" : "…") : goals.length === 0 ? "No more goals" : goals.join("\n\n")}
					</pre>
				</div>
			)}
			{/* Rocq's messages, readable without hover (phones have none):
			    errors first, then warnings, with the line in the cell. */}
			{connection !== "closed" && shown.length > 0 && (
				<div className="rounded-lg border border-border/60 px-3 py-2" data-testid="rocq-messages">
					<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Rocq says</div>
					<ul className="flex flex-col gap-1.5">
						{shown.map((d, i) => (
							<li
								key={i}
								className={cn(
									"whitespace-pre-wrap break-words rounded-md px-2 py-1 font-mono text-xs leading-relaxed",
									(d.severity ?? 1) === 1 ? "bg-red-500/10" : "bg-amber-500/10",
								)}
							>
								<span className="text-muted-foreground">line {d.range.start.line + 1}: </span>
								{d.message.length > 600 ? `${d.message.slice(0, 600)}…` : d.message}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
