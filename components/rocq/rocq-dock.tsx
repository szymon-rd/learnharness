"use client";

/**
 * The dock form for a Rocq code cell (rocq_exercise), the same as Lean's
 * (owner, 2026-11-12): the task, the cell (live coq-lsp), "Your thinking",
 * and Submit. Submit is always available; the verdict is the server's.
 *
 * Phones (owner, 2026-11-01): "Your thinking" starts collapsed into a chip
 * beside Submit; dictation fills it without opening it, and a tap expands it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { useIsPhone } from "@/components/phone-layout";
import { ThinkingChip } from "@/components/thinking-chip";
import { cn } from "@/lib/utils";
import { TaskFold } from "@/components/lean/lean-dock";
import { emptyDockSelection, resolveRocqExercise, type QuestionAnswerData, type QuestionFormDraft, type RocqExercise } from "@/src/core";
import { RocqCell, type RocqCellStatus } from "./rocq-cell";

const SUBMIT_HINT: Record<RocqCellStatus, string> = {
	connecting: "Rocq is starting — the first check takes a few seconds.",
	checking: "Rocq is checking…",
	passes: "Rocq accepts this proof.",
	admitted: "The proof is not finished (Admitted / admit).",
	errors: "Rocq reports errors — you can still submit.",
	offline: "Rocq is offline here — the server checks on submit.",
};

/** Parse the model-authored input (defense in depth, like the other docks). */
export function parseRocqExerciseInput(input: unknown): RocqExercise | null {
	const i = input as Partial<RocqExercise> | null;
	if (!i || typeof i.question !== "string" || typeof i.statement !== "string") return null;
	return {
		question: i.question,
		statement: i.statement,
		...(typeof i.prelude === "string" ? { prelude: i.prelude } : {}),
		...(typeof i.starter === "string" ? { starter: i.starter } : {}),
	};
}

export function RocqDockForm({
	toolCallId,
	input,
	onSubmit,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: {
	toolCallId: string;
	input: RocqExercise;
	onSubmit: (output: QuestionAnswerData) => void;
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	/** Esc in the thinking field stops dictation. */
	onEscape?: () => void;
	/** Dictated speech lands in "Your thinking" while claimed (released while
	 *  a teach check waits behind its reveal). */
	dictationClaim?: boolean;
	compactionRunning?: boolean;
}) {
	const exercise = useMemo(() => resolveRocqExercise(input), [input]);
	// The draft's `text` holds the proof (restored after a reload/failed send).
	const initialProof = initialDraft?.text || exercise.starter;
	const proofRef = useRef(initialProof);
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	// Ref mirror: dictation appends and submit reads without stale closures.
	const thinkingRef = useRef(thinking);
	const [status, setStatus] = useState<RocqCellStatus>("connecting");
	const [submitting, setSubmitting] = useState(false);
	const phone = useIsPhone();
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const showThinking = !phone || thinkingOpen;
	// Phones, while typing in the cell (keyboard up): the task folds to one
	// line and the cell hides its locked Require lines, so the cell, goal, Rocq's
	// messages and Submit fit together (owner, 2026-11-01).
	const [editing, setEditing] = useState(false);
	const fold = phone && editing;

	const saveDraft = useCallback(
		(proof: string, thought: string) =>
			onSaveDraft?.({ selection: emptyDockSelection(), thinking: thought, other: "", text: proof, confidenceIndex: 0 }),
		[onSaveDraft],
	);

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
				saveDraft(proofRef.current, v);
			},
			[saveDraft],
		),
		dictationClaim,
	);

	const submit = () => {
		if (submitting || compactionRunning) return;
		setSubmitting(true);
		const thought = thinkingRef.current;
		saveDraft(proofRef.current, thought);
		onSubmit({
			kind: "rocq",
			tool: "rocq_exercise",
			questionText: exercise.question,
			dontKnow: false,
			answers: [],
			text: proofRef.current,
			...(thought.trim() ? { thinking: thought.trim() } : {}),
			answeredAt: new Date().toISOString(),
		});
		// A refused send keeps the dock; let the learner try again.
		setTimeout(() => setSubmitting(false), 1500);
	};

	return (
		<div className="flex max-h-[85vh] flex-col overflow-y-auto" data-testid="rocq-dock">
			<div className="px-4 pt-3">
				{fold ? (
					<TaskFold text={exercise.question} />
				) : (
					<>
						<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Rocq exercise</div>
						<div className="mb-3 font-medium">
							<ToolContentResponse>{exercise.question}</ToolContentResponse>
						</div>
					</>
				)}
				<RocqCell
					exercise={exercise}
					cellId={toolCallId}
					initialProof={initialProof}
					onProofChange={(p) => {
						proofRef.current = p;
					}}
					onStatus={setStatus}
					onEditingChange={setEditing}
					hidePrelude={fold}
				/>
			</div>
			<form
				className="mt-2 border-t border-border/60 p-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					{showThinking && (
						<>
							<div className="flex items-center justify-between px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
								<span>Your thinking</span>
								{phone && (
									<button type="button" data-testid="thinking-hide" className="normal-case tracking-normal" onClick={() => setThinkingOpen(false)}>
										Hide
									</button>
								)}
							</div>
							<textarea
								value={thinking}
								autoFocus={phone}
								onChange={(e) => {
									thinkingRef.current = e.target.value;
									setThinking(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape" && onEscape) {
										e.preventDefault();
										e.stopPropagation();
										onEscape();
									}
								}}
								onBlur={() => saveDraft(proofRef.current, thinkingRef.current)}
								placeholder="How did you approach it? Where did you get stuck?"
								rows={1}
								className="field-sizing-content lh-input max-h-40 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70"
							/>
						</>
					)}
					<div className="flex items-center justify-between gap-2 p-1">
						{showThinking ? (
							<span
								className={cn("pl-1.5 text-xs", status === "passes" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}
								data-testid="rocq-submit-hint"
							>
								{compactionRunning ? "compacting session…" : SUBMIT_HINT[status]}
							</span>
						) : (
							// Phone: the cell's header badge already shows Rocq's verdict.
							<ThinkingChip value={thinking} onOpen={() => setThinkingOpen(true)} />
						)}
						<Button type="submit" disabled={submitting || compactionRunning} className="ml-auto h-9 shrink-0 rounded-[6px] px-3.5 text-sm font-medium">
							Submit proof
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
