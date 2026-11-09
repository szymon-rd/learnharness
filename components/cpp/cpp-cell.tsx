"use client";

/**
 * The C++ code cell editor (owner, 2026-11-09), built like the TLA+ cell:
 * the exercise's locked head (and optional tail) around the learner's
 * editable part. While the learner types, the server compiles the file
 * (syntax and types only) and errors and warnings are marked inline; the
 * Check button compiles and runs the visible tests without submitting. The
 * visible tests are shown read-only under the cell; hidden ones by name.
 *
 * Phones get a Tab key in the header; while editing, the locked head folds
 * to one line ("n locked lines") that a tap opens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { autocompletion, closeCompletion } from "@codemirror/autocomplete";
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { cppCellDocument, type CppDiagnostic, type CppVerdict, type ResolvedCppExercise } from "@/src/core";
import { cppCompletionSource, cppHighlight, cppLanguage } from "./cpp-language";
import { CppDiagnostics, CppVerdictView } from "./cpp-verdict";

export type CppCellStatus = "compiling" | "compiles" | "errors" | "offline";

const STATUS_TEXT: Record<CppCellStatus, string> = {
	compiling: "Compiling…",
	compiles: "Compiles",
	errors: "Errors",
	offline: "Checker offline",
};

const STATUS_CLASS: Record<CppCellStatus, string> = {
	compiling: "bg-muted text-muted-foreground",
	compiles: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	errors: "bg-red-500/15 text-red-700 dark:text-red-400",
	offline: "bg-muted text-muted-foreground",
};

/** One run of the tools on the current solution (app/api/cpp/check). */
export interface CppRun {
	verdict: CppVerdict;
	summary: string;
}

async function runTools(chatId: string, toolCallId: string, solution: string, mode: "syntax" | "check"): Promise<CppRun> {
	const res = await fetch("/api/cpp/check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chatId, toolCallId, solution, mode }),
	});
	const body = (await res.json().catch(() => ({}))) as Partial<CppRun> & { error?: string };
	if (!res.ok || !body.verdict) throw new Error(body.error ?? `The checker answered HTTP ${res.status}.`);
	return { verdict: body.verdict, summary: body.summary ?? "" };
}

const cellTheme = EditorView.theme({
	"&": { fontSize: "13px", backgroundColor: "transparent" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.55", maxHeight: "45vh" },
	".cm-content": { padding: "8px 0" },
	".cm-line": { padding: "0 10px" },
	".cm-cpp-locked": { backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)", color: "var(--muted-foreground)" },
	".cm-cpp-headfold": {
		display: "block",
		width: "100%",
		padding: "4px 10px",
		textAlign: "left",
		fontSize: "12px",
		color: "var(--muted-foreground)",
		backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)",
		cursor: "pointer",
	},
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
	".cm-completionDetail": { color: "var(--muted-foreground)", marginLeft: "8px", fontStyle: "normal" },
	".cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-lint": { backgroundColor: "var(--popover, var(--card))", color: "var(--popover-foreground, var(--foreground))", border: "1px solid var(--border)", borderRadius: "8px" },
	".cm-tooltip-lint": { maxWidth: "min(90vw, 36rem)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" },
});

/** Edits only between the head and the tail; both are shaded. `bounds`
 *  reads the current [start, end) of the editable part. */
function lockedRegions(prefixLength: number, suffixLength: number): Extension {
	const shade = ViewPlugin.fromClass(
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
				const deco = Decoration.line({ class: "cm-cpp-locked" });
				const doc = view.state.doc;
				const tailFrom = doc.length - suffixLength;
				for (let n = 1; n <= doc.lines; n++) {
					const line = doc.line(n);
					if (line.to < prefixLength || line.from > tailFrom) b.add(line.from, line.from, deco);
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations },
	);
	return [
		EditorState.transactionFilter.of((tr) => {
			if (!tr.docChanged) return tr;
			const end = tr.startState.doc.length - suffixLength;
			let ok = true;
			tr.changes.iterChangedRanges((fromA, toA) => {
				if (fromA < prefixLength || toA > end) ok = false;
			});
			return ok ? tr : [];
		}),
		shade,
	];
}

class HeadFoldWidget extends WidgetType {
	constructor(
		readonly label: string,
		readonly onOpen: () => void,
	) {
		super();
	}
	eq(other: HeadFoldWidget) {
		return other.label === this.label;
	}
	toDOM() {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "cm-cpp-headfold";
		b.dataset.testid = "cpp-head-fold";
		b.textContent = `▸ ${this.label}`;
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", () => this.onOpen());
		return b;
	}
	ignoreEvent() {
		return false;
	}
}

/** Display-only: the head lines (and the blank after them) as one line. */
function headFolded(headLines: number, label: string, onOpen: () => void): Extension {
	return EditorView.decorations.compute([], (state) => {
		if (state.doc.lines <= headLines + 1) return Decoration.none;
		const to = state.doc.line(headLines + 1).to;
		return Decoration.set([Decoration.replace({ block: true, widget: new HeadFoldWidget(label, onOpen) }).range(0, to)]);
	});
}

function toDiagnostics(doc: EditorState["doc"], items: CppDiagnostic[], severity: "error" | "warning"): Diagnostic[] {
	return items
		.filter((e) => e.line !== null)
		.map((e) => {
			const line = doc.line(Math.min(Math.max(e.line!, 1), doc.lines));
			return { from: line.from, to: Math.max(line.from, line.to), severity, message: e.message } as Diagnostic;
		});
}

/** How long "editing" outlives a blur (a tap on Submit lands first). */
const EDITING_RELEASE_MS = 400;
/** Pause in typing before the live compile. */
const PARSE_DELAY_MS = 800;

export interface CppCellProps {
	exercise: ResolvedCppExercise;
	chatId: string;
	/** The exercise's tool call (cpp_exercise, or the practice problem). */
	toolCallId: string;
	initialSolution: string;
	onSolutionChange: (solution: string) => void;
	onStatus?: (status: CppCellStatus) => void;
	onEditingChange?: (editing: boolean) => void;
	/** Fold the locked head to one line (phones, while editing). */
	foldHead?: boolean;
}

export function CppCell({ exercise, chatId, toolCallId, initialSolution, onSolutionChange, onStatus, onEditingChange, foldHead = false }: CppCellProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const latest = useRef(initialSolution);
	const exerciseRef = useRef(exercise);
	exerciseRef.current = exercise;
	const exerciseKey = `${exercise.head}\u0000${exercise.tail}`;
	const onSolutionChangeRef = useRef(onSolutionChange);
	onSolutionChangeRef.current = onSolutionChange;
	const onEditingChangeRef = useRef(onEditingChange);
	onEditingChangeRef.current = onEditingChange;
	const headSlot = useRef(new Compartment());
	const [headOpen, setHeadOpen] = useState(false);
	const [parse, setParse] = useState<{ status: CppCellStatus; errors: CppDiagnostic[]; warnings: CppDiagnostic[]; reason?: string }>({ status: "compiling", errors: [], warnings: [] });
	const [check, setCheck] = useState<{ running: boolean; run?: CppRun; error?: string; stale?: boolean }>({ running: false });

	const prefix = useMemo(() => `${exercise.head}\n\n`, [exercise.head]);
	// Without a tail the editable part runs to the end of the file.
	const suffix = useMemo(() => (exercise.tail ? `\n\n${exercise.tail}` : ""), [exercise.tail]);
	const headLines = exercise.head.split("\n").length;
	const solutionOf = useCallback(
		(doc: string) => (doc.startsWith(prefix) && doc.endsWith(suffix) ? doc.slice(prefix.length, doc.length - suffix.length) : latest.current),
		[prefix, suffix],
	);

	// The live compile: the newest request wins.
	const parseSeq = useRef(0);
	const runParse = useCallback(() => {
		const seq = ++parseSeq.current;
		setParse((p) => ({ ...p, status: "compiling" }));
		runTools(chatId, toolCallId, latest.current, "syntax")
			.then((r) => {
				if (seq !== parseSeq.current) return;
				setParse({ status: r.verdict.passed ? "compiles" : "errors", errors: r.verdict.errors, warnings: r.verdict.warnings });
				const v = view.current;
				if (v) v.dispatch(setDiagnostics(v.state, [...toDiagnostics(v.state.doc, r.verdict.errors, "error"), ...toDiagnostics(v.state.doc, r.verdict.warnings, "warning")]));
			})
			.catch((err: Error) => {
				if (seq !== parseSeq.current) return;
				setParse({ status: "offline", errors: [], warnings: [], reason: err.message });
			});
	}, [chatId, toolCallId]);

	// The editor (once per cell).
	useEffect(() => {
		if (!host.current) return;
		let parseTimer: ReturnType<typeof setTimeout> | undefined;
		let editingTimer: ReturnType<typeof setTimeout> | undefined;
		const ex = exerciseRef.current;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: cppCellDocument(ex, latest.current).replace(/\n$/, ""),
				extensions: [
					history(),
					indentUnit.of("  "),
					keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
					cppLanguage,
					syntaxHighlighting(cppHighlight),
					lockedRegions(prefix.length, suffix.length),
					autocompletion({ override: [cppCompletionSource(() => prefix.length)], activateOnTypingDelay: 150, maxRenderedOptions: 60, icons: true }),
					linter(null),
					lintGutter(),
					cellTheme,
					headSlot.current.of([]),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "C++ source" }),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) {
							latest.current = solutionOf(u.state.doc.toString());
							onSolutionChangeRef.current(latest.current);
							setCheck((c) => (c.run || c.error ? { ...c, stale: true } : c));
							clearTimeout(parseTimer);
							parseTimer = setTimeout(runParse, PARSE_DELAY_MS);
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
		const outside = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && !v.dom.contains(t) && !(t as Element).closest?.(".cm-tooltip")) closeCompletion(v);
		};
		document.addEventListener("pointerdown", outside, true);
		// The cursor starts at the end of the editable part.
		v.dispatch({ selection: { anchor: v.state.doc.length - suffix.length } });
		runParse();
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			clearTimeout(parseTimer);
			clearTimeout(editingTimer);
			v.destroy();
			view.current = null;
		};
		// The cell is fixed for its lifetime; the initial solution is read once.
	}, [exerciseKey, prefix, suffix, solutionOf, runParse]);

	// Phones fold the head while editing (display only).
	const label = `${headLines} locked ${headLines === 1 ? "line" : "lines"}`;
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		v.dispatch({ effects: headSlot.current.reconfigure(foldHead && !headOpen ? headFolded(headLines, label, () => setHeadOpen(true)) : []) });
	}, [foldHead, headOpen, headLines, label]);
	useEffect(() => {
		if (!foldHead) setHeadOpen(false);
	}, [foldHead]);

	useEffect(() => onStatus?.(parse.status), [parse.status, onStatus]);

	const runCheck = () => {
		setCheck({ running: true });
		runTools(chatId, toolCallId, latest.current, "check")
			.then((run) => setCheck({ running: false, run }))
			.catch((err: Error) => setCheck({ running: false, error: err.message }));
	};

	const insert = (text: string) => {
		const v = view.current;
		if (!v) return;
		const { from, to } = v.state.selection.main;
		if (from < prefix.length || to > v.state.doc.length - suffix.length) return;
		v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
		v.focus();
	};

	const errors = [...parse.errors.filter((e) => e.line !== null).slice(0, 4), ...parse.errors.filter((e) => e.line === null)];
	const visibleTests = exercise.tests.filter((t) => !t.hidden);
	const hiddenTests = exercise.tests.filter((t) => t.hidden);

	return (
		<div className="flex flex-col gap-2" data-testid="cpp-cell">
			<div className="overflow-hidden rounded-lg border border-border/70 bg-background">
				<div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs">
					<span className="font-medium text-muted-foreground">C++20 · g++</span>
					<span className="flex items-center gap-1.5">
						<button
							type="button"
							data-testid="cpp-tab-key"
							className="h-7 shrink-0 rounded-md border border-border/60 px-2 text-xs text-muted-foreground sm:hidden"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => insert("  ")}
						>
							Tab
						</button>
						<span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_CLASS[parse.status])} data-testid="cpp-status" data-status={parse.status}>
							{STATUS_TEXT[parse.status]}
						</span>
					</span>
				</div>
				{/* An Esc the editor used (closing the completion list) stops here:
				    the window's Esc chain would otherwise also dismiss the question. */}
				<div
					ref={host}
					onKeyDown={(e) => {
						if (e.key === "Escape" && e.defaultPrevented) e.stopPropagation();
					}}
				/>
			</div>
			{parse.status === "offline" ? (
				<div className="flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
					<span title={parse.reason}>The C++ checker is not answering. You can still submit; the server checks on submit.</span>
					<button type="button" className="shrink-0 font-medium text-foreground underline" onClick={runParse}>
						Retry
					</button>
				</div>
			) : (
				(errors.length > 0 || parse.warnings.length > 0) && (
					<div className="rounded-lg border border-border/60 px-3 py-2" data-testid="cpp-messages">
						<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">The compiler says</div>
						<CppDiagnostics items={errors} />
						<CppDiagnostics items={parse.warnings.slice(0, 4)} tone="warning" />
					</div>
				)
			)}
			<details className="rounded-lg bg-muted/40 px-3 py-2" data-testid="cpp-tests-panel">
				<summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					Tests ({visibleTests.length} shown{hiddenTests.length ? `, ${hiddenTests.length} hidden` : ""})
				</summary>
				<ul className="mt-1 flex flex-col gap-1.5">
					{visibleTests.map((t) => (
						<li key={t.name} className="text-xs">
							<div className="font-medium">{t.name}</div>
							<pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">{t.code}</pre>
						</li>
					))}
				</ul>
				{hiddenTests.length > 0 && (
					<div className="mt-2 text-xs text-muted-foreground">Hidden (run on Submit): {hiddenTests.map((t) => t.name).join(", ")}</div>
				)}
			</details>
			<div className="rounded-lg border border-border/60 px-3 py-2" data-testid="cpp-check">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
						Visible tests{check.stale ? " · edited since" : ""}
					</span>
					<button
						type="button"
						data-testid="cpp-check-button"
						disabled={check.running}
						onMouseDown={(e) => e.preventDefault()}
						onClick={runCheck}
						className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs font-medium disabled:opacity-60"
					>
						{check.running && <Loader2Icon className="size-3.5 animate-spin" />}
						{check.running ? "Checking…" : "Check"}
					</button>
				</div>
				{check.error && <div className="mt-1.5 text-xs text-muted-foreground">{check.error}</div>}
				{check.run && <CppVerdictView verdict={check.run.verdict} summary={check.run.summary} showWarnings={false} className={cn("mt-1.5", check.stale && "opacity-60")} />}
				{!check.run && !check.error && !check.running && (
					<div className="mt-1 text-xs text-muted-foreground">Compiles and runs the shown tests without submitting.</div>
				)}
			</div>
		</div>
	);
}
