"use client";

import { createContext, useContext, useState } from "react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { ThinkingBlock } from "@/components/thinking-block";
import type { QuestionAnswerData } from "@/src/core";
import { TlaVerdictView } from "./tla-verdict";

/** The teacher's reviews of TLA+ answers (tla_review), keyed by the
 *  exercise's tool call id. The transcript provides it; the answered card
 *  reads its own. */
export interface TlaReviewView {
	accepted: boolean;
	reason: string;
}
export const TlaReviewsContext = createContext<ReadonlyMap<string, TlaReviewView>>(new Map());

/** Collect tla_review results from the transcript's UI parts. */
export function collectTlaReviews(messages: readonly { parts?: readonly unknown[] }[]): Map<string, TlaReviewView> {
	const out = new Map<string, TlaReviewView>();
	for (const m of messages) {
		for (const p of m.parts ?? []) {
			const part = p as { type?: string; state?: string; output?: { ok?: unknown; exerciseCallId?: unknown; accepted?: unknown; reason?: unknown } };
			if (part.type !== "tool-tla_review" || part.state !== "output-available") continue;
			const o = part.output;
			if (o?.ok === true && typeof o.exerciseCallId === "string" && typeof o.accepted === "boolean") {
				out.set(o.exerciseCallId, { accepted: o.accepted, reason: typeof o.reason === "string" ? o.reason : "" });
			}
		}
	}
	return out;
}

/** True when two review maps hold the same reviews (keeps the context
 *  value stable across stream renders). */
export function sameTlaReviews(a: ReadonlyMap<string, TlaReviewView>, b: ReadonlyMap<string, TlaReviewView>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) {
		const w = b.get(k);
		if (!w || w.accepted !== v.accepted || w.reason !== v.reason) return false;
	}
	return true;
}

/**
 * An answered TLA+ code cell: the submitted solution, TLC's verdict (errors,
 * counterexample, unreachable witnesses), the teacher's review when it gave
 * one (a rejected review overrules a TLC pass), and the reference solution
 * behind a toggle.
 */
export function TlaAnsweredCard({ answer, toolCallId }: { answer: QuestionAnswerData; toolCallId?: string }) {
	const [referenceOpen, setReferenceOpen] = useState(false);
	const reviews = useContext(TlaReviewsContext);
	const review = toolCallId ? reviews.get(toolCallId) : undefined;
	const tla = answer.tla;
	const solution = tla?.solution ?? answer.text ?? "";
	const passed = tla ? tla.verdict.passed && review?.accepted !== false : false;
	return (
		<>
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="answered-card" data-kind="tla">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					TLA+ exercise
					{!tla ? (
						<span className="rounded bg-muted px-1.5 py-0.5 normal-case">checking with TLC…</span>
					) : passed ? (
						<span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">passes</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">does not pass</span>
					)}
				</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{answer.questionText}</ToolContentResponse>
				</div>
				<pre className="mb-3 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed" data-testid="tla-submitted-solution">
					{solution || "(empty solution)"}
				</pre>
				{tla && <TlaVerdictView verdict={tla.verdict} summary={tla.summary} />}
				{review && (
					<div
						className={review.accepted ? "mt-2 rounded-md bg-green-500/10 px-2.5 py-1.5 text-sm" : "mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-sm"}
						data-testid="tla-review"
						data-accepted={review.accepted}
					>
						<span className="font-medium">{review.accepted ? "Tutor: does what was asked." : "Tutor: passes TLC, but does not do what was asked."}</span>
						{review.reason && <span> {review.reason}</span>}
					</div>
				)}
				{tla?.referenceSolution && (
					<div className="mt-3">
						<button type="button" className="text-xs font-medium text-muted-foreground underline" onClick={() => setReferenceOpen((o) => !o)}>
							{referenceOpen ? "Hide the reference solution" : "Show the reference solution"}
						</button>
						{referenceOpen && (
							<pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">{tla.referenceSolution}</pre>
						)}
					</div>
				)}
			</div>
			{answer.thinking && <ThinkingBlock label="YOUR THINKING" text={answer.thinking} defaultOpen />}
		</>
	);
}
