"use client";

import { useContext, useState } from "react";
import { CodeReviewsContext } from "@/components/code-reviews";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { ThinkingBlock } from "@/components/thinking-block";
import type { QuestionAnswerData } from "@/src/core";
import { CppVerdictView } from "./cpp-verdict";

/**
 * An answered C++ code cell: the submitted solution, the verdict (compiler
 * errors, every test's result), the tutor's review when it gave one (a
 * rejected review overrules a pass), and the reference solution behind a
 * toggle.
 */
export function CppAnsweredCard({ answer, toolCallId }: { answer: QuestionAnswerData; toolCallId?: string }) {
	const [referenceOpen, setReferenceOpen] = useState(false);
	const reviews = useContext(CodeReviewsContext);
	const review = toolCallId ? reviews.get(toolCallId) : undefined;
	const cpp = answer.cpp;
	const solution = cpp?.solution ?? answer.text ?? "";
	const passed = cpp ? cpp.verdict.passed && review?.accepted !== false : false;
	return (
		<>
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="answered-card" data-kind="cpp">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					C++ exercise
					{!cpp ? (
						<span className="rounded bg-muted px-1.5 py-0.5 normal-case">compiling and running the tests…</span>
					) : passed ? (
						<span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">passes</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">does not pass</span>
					)}
				</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{answer.questionText}</ToolContentResponse>
				</div>
				<pre className="mb-3 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed" data-testid="cpp-submitted-solution">
					{solution || "(empty solution)"}
				</pre>
				{cpp && <CppVerdictView verdict={cpp.verdict} summary={cpp.summary} />}
				{review && (
					<div
						className={review.accepted ? "mt-2 rounded-md bg-green-500/10 px-2.5 py-1.5 text-sm" : "mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-sm"}
						data-testid="cpp-review"
						data-accepted={review.accepted}
					>
						<span className="font-medium">{review.accepted ? "Tutor: does what was asked." : "Tutor: passes the tests, but does not do what was asked."}</span>
						{review.reason && <span> {review.reason}</span>}
					</div>
				)}
				{cpp?.referenceSolution && (
					<div className="mt-3">
						<button type="button" className="text-xs font-medium text-muted-foreground underline" onClick={() => setReferenceOpen((o) => !o)}>
							{referenceOpen ? "Hide the reference solution" : "Show the reference solution"}
						</button>
						{referenceOpen && (
							<pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">{cpp.referenceSolution}</pre>
						)}
					</div>
				)}
			</div>
			{answer.thinking && <ThinkingBlock label="YOUR THINKING" text={answer.thinking} defaultOpen />}
		</>
	);
}
