"use client";

/**
 * The dock form for a TLA+ code cell (tla_exercise): the task, the cell
 * (live SANY errors, Check button, the TLC model), "Your thinking", and
 * Submit. Submit is always available; the verdict is the server's (owner,
 * 2026-11-05).
 *
 * Phones: "Your thinking" starts as a chip beside Submit (dictation fills it
 * unseen), and while editing the task folds to one line and the cell folds
 * its locked head.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { useIsPhone } from "@/components/phone-layout";
import { ThinkingChip } from "@/components/thinking-chip";
import { TaskFold } from "@/components/lean/lean-dock";
import { cn } from "@/lib/utils";
import { emptyDockSelection, tlaExerciseFromInput, type QuestionAnswerData, type QuestionFormDraft, type ResolvedTlaExercise } from "@/src/core";
import { TlaCell, type TlaCellStatus } from "./tla-cell";

const SUBMIT_HINT: Record<TlaCellStatus, string> = {
	parsing: "Parsing…",
	parses: "The module parses. Check runs TLC; you can submit any time.",
	errors: "SANY reports errors — you can still submit.",
	offline: "The checker is offline here — the server checks on submit.",
};

/** Parse the model-authored input (defense in depth, like the other docks). */
export function parseTlaExerciseInput(input: unknown): ResolvedTlaExercise | null {
	const i = input as { question?: unknown } | null;
	if (!i || typeof i.question !== "string") return null;
	return tlaExerciseFromInput(input);
}

export function TlaDockForm({
	chatId,
	toolCallId,
	exercise,
	onSubmit,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: {
	chatId: string;
	toolCallId: string;
	exercise: ResolvedTlaExercise;
	onSubmit: (output: QuestionAnswerData) => void;
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	onEscape?: () => void;
	dictationClaim?: boolean;
	compactionRunning?: boolean;
}) {
	// The draft's `text` holds the solution (restored after a reload/failed send).
	const initialSolution = useMemo(() => initialDraft?.text || exercise.starter, [initialDraft?.text, exercise.starter]);
	const solutionRef = useRef(initialSolution);
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const thinkingRef = useRef(thinking);
	const [status, setStatus] = useState<TlaCellStatus>("parsing");
	const [submitting, setSubmitting] = useState(false);
	const phone = useIsPhone();
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const showThinking = !phone || thinkingOpen;
	const [editing, setEditing] = useState(false);
	const fold = phone && editing;

	const saveDraft = useCallback(
		(solution: string, thought: string) =>
			onSaveDraft?.({ selection: emptyDockSelection(), thinking: thought, other: "", text: solution, confidenceIndex: 0 }),
		[onSaveDraft],
	);

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
				saveDraft(solutionRef.current, v);
			},
			[saveDraft],
		),
		dictationClaim,
	);

	const submit = () => {
		if (submitting || compactionRunning) return;
		setSubmitting(true);
		const thought = thinkingRef.current;
		saveDraft(solutionRef.current, thought);
		onSubmit({
			kind: "tla",
			tool: "tla_exercise",
			questionText: exercise.question,
			dontKnow: false,
			answers: [],
			text: solutionRef.current,
			...(thought.trim() ? { thinking: thought.trim() } : {}),
			answeredAt: new Date().toISOString(),
		});
		setTimeout(() => setSubmitting(false), 1500);
	};

	return (
		<div className="flex max-h-[85vh] flex-col overflow-y-auto" data-testid="tla-dock">
			<div className="px-4 pt-3">
				{fold ? (
					<TaskFold text={exercise.question} />
				) : (
					<>
						<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{exercise.mode === "pluscal" ? "PlusCal exercise" : "TLA+ exercise"}</div>
						<div className="mb-3 font-medium">
							<ToolContentResponse>{exercise.question}</ToolContentResponse>
						</div>
					</>
				)}
				<TlaCell
					exercise={exercise}
					chatId={chatId}
					toolCallId={toolCallId}
					initialSolution={initialSolution}
					onSolutionChange={(s) => {
						solutionRef.current = s;
					}}
					onStatus={setStatus}
					onEditingChange={setEditing}
					foldHead={fold}
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
								onBlur={() => saveDraft(solutionRef.current, thinkingRef.current)}
								placeholder="How did you approach it? Where did you get stuck?"
								rows={1}
								className="field-sizing-content lh-input max-h-40 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70"
							/>
						</>
					)}
					<div className="flex items-center justify-between gap-2 p-1">
						{showThinking ? (
							<span className={cn("pl-1.5 text-xs", status === "parses" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")} data-testid="tla-submit-hint">
								{compactionRunning ? "compacting session…" : SUBMIT_HINT[status]}
							</span>
						) : (
							<ThinkingChip value={thinking} onOpen={() => setThinkingOpen(true)} />
						)}
						<Button type="submit" disabled={submitting || compactionRunning} className="ml-auto h-9 shrink-0 rounded-[6px] px-3.5 text-sm font-medium">
							Submit
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
