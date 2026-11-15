/**
 * The React views the plugin mounts into the host's slots: the editor (the
 * language's cell) and the answered/submitted body (the code, the checker's
 * verdict, the teacher's review and — for lessons — the reference).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import type { Language } from "../contract.ts";
import { resolveLeanExercise } from "../core/lean-cell.ts";
import { resolveRocqExercise } from "../core/rocq-cell.ts";
import { tlaExerciseFromInput, type TlaVerdict } from "../core/tla-cell.ts";
import { cppExerciseFromInput, type CppVerdict } from "../core/cpp-cell.ts";
import { LeanCell } from "./lean-cell";
import { RocqCell } from "./rocq-cell";
import { TlaCell } from "./tla-cell";
import { CppCell } from "./cpp-cell";
import { TlaVerdictView } from "./tla-verdict";
import { CppVerdictView } from "./cpp-verdict";
import { cn } from "./util";

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Phones (< 640px), live. */
function usePhone(): boolean {
	return useSyncExternalStore(
		(change) => {
			const q = window.matchMedia("(max-width: 639px)");
			q.addEventListener("change", change);
			return () => q.removeEventListener("change", change);
		},
		() => window.matchMedia("(max-width: 639px)").matches,
		() => false,
	);
}

/** The starter the learner begins with (the editable part, before edits). */
export function starterOf(language: Language, question: string, payload: Payload): string {
	switch (language) {
		case "lean":
			return resolveLeanExercise({ question, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter) }).starter;
		case "rocq":
			return resolveRocqExercise({ question, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter) }).starter;
		case "tla":
			return tlaExerciseFromInput(payload, question)?.starter ?? "";
		case "cpp":
			return cppExerciseFromInput(payload, question)?.starter ?? "";
	}
}

export interface EditorProps {
	language: Language;
	chatId: string;
	/** The question or problem id (the live checks find the exercise by it). */
	id: string;
	question: string;
	payload: Payload;
	initial: string;
	onCode: (code: string) => void;
	onView: (view: EditorView | null) => void;
}

/** The language's cell. On phones, while typing, the locked part above the
 *  code folds away. */
export function Editor({ language, chatId, id, question, payload, initial, onCode, onView }: EditorProps) {
	const phone = usePhone();
	const [editing, setEditing] = useState(false);
	const fold = phone && editing;
	switch (language) {
		case "lean":
			return (
				<LeanCell
					exercise={resolveLeanExercise({ question, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter) })}
					cellId={id}
					initialProof={initial}
					onProofChange={onCode}
					onEditingChange={setEditing}
					hidePrelude={fold}
					onView={onView}
				/>
			);
		case "rocq":
			return (
				<RocqCell
					exercise={resolveRocqExercise({ question, prelude: str(payload.prelude), statement: str(payload.statement) ?? "", starter: str(payload.starter) })}
					cellId={id}
					initialProof={initial}
					onProofChange={onCode}
					onEditingChange={setEditing}
					hidePrelude={fold}
					onView={onView}
				/>
			);
		case "tla": {
			const exercise = tlaExerciseFromInput(payload, question);
			if (!exercise) return <p className="text-sm text-error">This TLA+ exercise is malformed.</p>;
			return <TlaCell exercise={exercise} chatId={chatId} toolCallId={id} initialSolution={initial} onSolutionChange={onCode} onEditingChange={setEditing} foldHead={fold} onView={onView} />;
		}
		case "cpp": {
			const exercise = cppExerciseFromInput(payload, question);
			if (!exercise) return <p className="text-sm text-error">This C++ exercise is malformed.</p>;
			return <CppCell exercise={exercise} chatId={chatId} toolCallId={id} initialSolution={initial} onSolutionChange={onCode} onEditingChange={setEditing} foldHead={fold} onView={onView} />;
		}
	}
}

/** The saved grading result (GradeResult in src/server/grade.ts). */
export interface Graded {
	passed: boolean;
	summary: string;
	verdict: unknown;
}

export function readGraded(outcome: { result: unknown } | { error: string } | undefined): Graded | { error: string } | null {
	if (!outcome) return null;
	if ("error" in outcome) return { error: outcome.error };
	const r = outcome.result as Partial<Graded> | null;
	if (!r || typeof r.passed !== "boolean" || typeof r.summary !== "string") return { error: "The saved verdict is unreadable." };
	return { passed: r.passed, summary: r.summary, verdict: r.verdict };
}

export interface Review {
	accepted: boolean;
	reason?: string;
}

/** The pass/fail chip after the host's card label (a review can overrule a pass). */
export function VerdictBadge({ graded, review }: { graded: Graded | { error: string } | null; review: Review | null }) {
	if (!graded || "error" in graded) return <Chip text="not checked" />;
	const passed = graded.passed && review?.accepted !== false;
	return <Chip text={passed ? "passes" : "does not pass"} color={passed ? "var(--lh-success)" : "var(--lh-error)"} />;
}

function Chip({ text, color }: { text: string; color?: string }) {
	return (
		<span
			className={cn("rounded px-1.5 py-0.5 font-ui text-xs font-medium uppercase tracking-wide", !color && "bg-muted text-muted-foreground")}
			style={color ? { color, backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)` } : undefined}
		>
			{text}
		</span>
	);
}

const REFERENCE_LABEL: Record<Language, string> = { lean: "reference proof", rocq: "reference proof", tla: "reference solution", cpp: "reference solution" };

/** The answered/submitted body: the code, the verdict, the review, and
 *  (lessons only — practice reveals at conclude) the reference. */
export function AnsweredBody({
	language,
	code,
	graded,
	review,
	reference,
}: {
	language: Language;
	code: string;
	graded: Graded | { error: string } | null;
	review: Review | null;
	reference?: string;
}) {
	const [referenceOpen, setReferenceOpen] = useState(false);
	return (
		<div data-testid="code-cell-answered" data-language={language}>
			<pre className="mb-3 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">{code || "(empty)"}</pre>
			{graded && "error" in graded ? (
				<p className="text-sm text-error">The checker could not grade this: {graded.error}</p>
			) : graded ? (
				<Verdict language={language} graded={graded} />
			) : null}
			{review && (
				<div className={review.accepted ? "mt-2 rounded-md bg-success/10 px-2.5 py-1.5 text-sm" : "mt-2 rounded-md bg-error/10 px-2.5 py-1.5 text-sm"} data-testid="code-cell-review" data-accepted={review.accepted}>
					<span className="font-medium">{review.accepted ? "Tutor: does what was asked." : `Tutor: passes ${language === "tla" ? "TLC" : "the tests"}, but does not do what was asked.`}</span>
					{review.reason && <span> {review.reason}</span>}
				</div>
			)}
			{reference && (
				<div className="mt-3">
					<button type="button" className="text-xs font-medium text-muted-foreground underline" onClick={() => setReferenceOpen((o) => !o)}>
						{referenceOpen ? `Hide the ${REFERENCE_LABEL[language]}` : `Show the ${REFERENCE_LABEL[language]}`}
					</button>
					{referenceOpen && <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">{reference}</pre>}
				</div>
			)}
		</div>
	);
}

function Verdict({ language, graded }: { language: Language; graded: Graded }) {
	if (language === "tla") return <TlaVerdictView verdict={graded.verdict as TlaVerdict} summary={graded.summary} />;
	if (language === "cpp") return <CppVerdictView verdict={graded.verdict as CppVerdict} summary={graded.summary} />;
	const errors = ((graded.verdict as { errors?: { line: number; message: string }[] } | null)?.errors ?? []).filter((e) => e && typeof e.message === "string");
	return (
		<div className={cn("text-sm", graded.passed ? "text-success" : "text-foreground")}>
			{graded.summary}
			{errors.length > 0 && (
				<ul className="mt-2 flex flex-col gap-1.5">
					{errors.map((e, i) => (
						<li key={i} className="whitespace-pre-wrap rounded-md bg-error/10 px-2.5 py-1.5 font-mono text-xs">
							<span className="text-muted-foreground">{e.line > 0 ? `line ${e.line}: ` : "statement: "}</span>
							{e.message}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Re-render on the review notifications for one question. */
export function useReview(load: () => Promise<Review | null>, subscribe: (onChange: () => void) => () => void): Review | null {
	const [review, setReview] = useState<Review | null>(null);
	useEffect(() => {
		let live = true;
		const refresh = () => void load().then((r) => live && setReview(r), () => {});
		refresh();
		const unsubscribe = subscribe(refresh);
		return () => {
			live = false;
			unsubscribe();
		};
	}, [load, subscribe]);
	return review;
}
