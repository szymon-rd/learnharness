"use client";

/**
 * The dock form for a Lean code cell (lean_exercise): the task, the cell
 * (live Lean), "Your thinking", and Submit. Submit is always available —
 * the learner sees live whether the proof passes, but may hand in a
 * failing proof (owner, 2026-10-30). The verdict is the server's.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { emptyDockSelection, resolveLeanExercise, type LeanExercise, type QuestionAnswerData, type QuestionFormDraft } from "@/src/core";
import { LeanCell, type LeanCellStatus } from "./lean-cell";

const SUBMIT_HINT: Record<LeanCellStatus, string> = {
	connecting: "Lean is starting — the first check takes a few seconds.",
	checking: "Lean is checking…",
	passes: "Lean accepts this proof.",
	sorry: "The proof still has sorry.",
	errors: "Lean reports errors — you can still submit.",
	offline: "Lean is offline here — the server checks on submit.",
};

/** Parse the model-authored input (defense in depth, like the other docks). */
export function parseLeanExerciseInput(input: unknown): LeanExercise | null {
	const i = input as Partial<LeanExercise> | null;
	if (!i || typeof i.question !== "string" || typeof i.statement !== "string") return null;
	return {
		question: i.question,
		statement: i.statement,
		...(typeof i.prelude === "string" ? { prelude: i.prelude } : {}),
		...(typeof i.starter === "string" ? { starter: i.starter } : {}),
	};
}

export function LeanDockForm({
	toolCallId,
	input,
	onSubmit,
	initialDraft,
	onSaveDraft,
	compactionRunning = false,
}: {
	toolCallId: string;
	input: LeanExercise;
	onSubmit: (output: QuestionAnswerData) => void;
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	compactionRunning?: boolean;
}) {
	const exercise = useMemo(() => resolveLeanExercise(input), [input]);
	// The draft's `text` holds the proof (restored after a reload/failed send).
	const initialProof = initialDraft?.text || exercise.starter;
	const proofRef = useRef(initialProof);
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const [status, setStatus] = useState<LeanCellStatus>("connecting");
	const [submitting, setSubmitting] = useState(false);

	const saveDraft = useCallback(
		(proof: string, thought: string) =>
			onSaveDraft?.({ selection: emptyDockSelection(), thinking: thought, other: "", text: proof, confidenceIndex: 0 }),
		[onSaveDraft],
	);

	const submit = () => {
		if (submitting || compactionRunning) return;
		setSubmitting(true);
		saveDraft(proofRef.current, thinking);
		onSubmit({
			kind: "lean",
			tool: "lean_exercise",
			questionText: exercise.question,
			dontKnow: false,
			answers: [],
			text: proofRef.current,
			...(thinking.trim() ? { thinking: thinking.trim() } : {}),
			answeredAt: new Date().toISOString(),
		});
		// A refused send keeps the dock; let the learner try again.
		setTimeout(() => setSubmitting(false), 1500);
	};

	return (
		<div className="flex max-h-[85vh] flex-col overflow-y-auto" data-testid="lean-dock">
			<div className="px-4 pt-3">
				<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lean exercise</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{exercise.question}</ToolContentResponse>
				</div>
				<LeanCell
					exercise={exercise}
					cellId={toolCallId}
					initialProof={initialProof}
					onProofChange={(p) => {
						proofRef.current = p;
					}}
					onStatus={setStatus}
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
					<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Your thinking</div>
					<textarea
						value={thinking}
						onChange={(e) => setThinking(e.target.value)}
						onBlur={() => saveDraft(proofRef.current, thinking)}
						placeholder="How did you approach it? Where did you get stuck?"
						rows={1}
						className="field-sizing-content lh-input max-h-40 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70"
					/>
					<div className="flex items-center justify-between gap-2 p-1">
						<span
							className={cn("pl-1.5 text-xs", status === "passes" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}
							data-testid="lean-submit-hint"
						>
							{compactionRunning ? "compacting session…" : SUBMIT_HINT[status]}
						</span>
						<Button type="submit" disabled={submitting || compactionRunning} className="ml-auto h-9 shrink-0 rounded-[6px] px-3.5 text-sm font-medium">
							Submit proof
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
