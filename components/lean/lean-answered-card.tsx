"use client";

import { useState } from "react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { ThinkingBlock } from "@/components/thinking-block";
import { cn } from "@/lib/utils";
import type { QuestionAnswerData } from "@/src/core";

/**
 * An answered Lean code cell: the submitted proof and the server's verdict
 * (Lean's errors with proof-relative lines), plus the teacher's reference
 * proof behind a toggle. Before the server's verdict lands (the optimistic
 * copy), it says Lean is checking.
 */
export function LeanAnsweredCard({ answer }: { answer: QuestionAnswerData }) {
	const [referenceOpen, setReferenceOpen] = useState(false);
	const lean = answer.lean;
	const proof = lean?.proof ?? answer.text ?? "";
	return (
		<>
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="answered-card" data-kind="lean">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Lean exercise
					{!lean ? (
						<span className="rounded bg-muted px-1.5 py-0.5 normal-case">checking with Lean…</span>
					) : lean.verdict.passed ? (
						<span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">passes</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">does not pass</span>
					)}
				</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{answer.questionText}</ToolContentResponse>
				</div>
				<pre className="mb-3 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed" data-testid="lean-submitted-proof">
					{proof || "(empty proof)"}
				</pre>
				{lean && (
					<div className={cn("text-sm", lean.verdict.passed ? "text-green-600 dark:text-green-400" : "text-foreground")}>
						{lean.summary}
						{lean.verdict.errors.length > 0 && (
							<ul className="mt-2 flex flex-col gap-1.5">
								{lean.verdict.errors.map((e, i) => (
									<li key={i} className="rounded-md bg-red-500/10 px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">
										<span className="text-muted-foreground">{e.line > 0 ? `line ${e.line}: ` : "statement: "}</span>
										{e.message}
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{lean?.referenceProof && (
					<div className="mt-3">
						<button type="button" className="text-xs font-medium text-muted-foreground underline" onClick={() => setReferenceOpen((o) => !o)}>
							{referenceOpen ? "Hide the reference proof" : "Show the reference proof"}
						</button>
						{referenceOpen && (
							<pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">{lean.referenceProof}</pre>
						)}
					</div>
				)}
			</div>
			{answer.thinking && <ThinkingBlock label="YOUR THINKING" text={answer.thinking} defaultOpen />}
		</>
	);
}
