"use client";

/**
 * TLC's verdict as the learner reads it (owner, 2026-11-05): the summary,
 * the errors with their cell lines, the counterexample as a table (one row
 * per state, changed variables highlighted), and unreachable witnesses.
 * Shared by the cell's Check panel, the answered card and the practice
 * submission card.
 */
import { cn } from "@/lib/utils";
import type { TlaTraceState, TlaVerdict } from "@/src/core";

export function TlaErrors({ errors }: { errors: TlaVerdict["errors"] }) {
	if (!errors.length) return null;
	return (
		<ul className="mt-2 flex flex-col gap-1.5" data-testid="tla-errors">
			{errors.map((e, i) => (
				<li key={i} className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-2.5 py-1.5 font-mono text-xs leading-relaxed">
					{e.line !== null && <span className="text-muted-foreground">line {e.line}: </span>}
					{e.message}
				</li>
			))}
		</ul>
	);
}

/** The counterexample: a state per row; a variable that changed from the
 *  previous state is highlighted. */
export function TlaTrace({ trace }: { trace: TlaTraceState[] }) {
	if (!trace.length) return null;
	return (
		<div className="mt-2" data-testid="tla-trace">
			<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Counterexample</div>
			<ol className="flex flex-col gap-1">
				{trace.map((s, i) => {
					const prev = trace
						.slice(0, i)
						.reverse()
						.find((p) => p.kind === "state");
					return (
						<li key={i} className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
							<div className="mb-0.5 flex items-baseline gap-2">
								<span className="font-mono text-muted-foreground">{s.index}</span>
								<span className="font-medium">{s.action}</span>
							</div>
							{s.vars.length > 0 && (
								<div className="flex flex-col gap-0.5 font-mono">
									{s.vars.map((v) => {
										const before = prev?.vars.find((p) => p.name === v.name)?.value;
										const changed = prev !== undefined && before !== v.value;
										return (
											<div key={v.name} className={cn("break-words rounded px-1", changed && "bg-amber-500/15")}>
												<span className="text-muted-foreground">{v.name} = </span>
												{v.value}
											</div>
										);
									})}
								</div>
							)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}

/** Summary, errors, counterexample and unreachable witnesses. */
export function TlaVerdictView({ verdict, summary, className }: { verdict: TlaVerdict; summary: string; className?: string }) {
	return (
		<div className={cn("text-sm", className)} data-testid="tla-verdict" data-reason={verdict.reason}>
			<div className={verdict.passed ? "text-green-600 dark:text-green-400" : "text-foreground"}>{summary}</div>
			<TlaErrors errors={verdict.errors} />
			{verdict.unreachable && verdict.unreachable.length > 0 && (
				<ul className="mt-2 flex flex-col gap-1">
					{verdict.unreachable.map((label) => (
						<li key={label} className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs">
							Never reached: {label}
						</li>
					))}
				</ul>
			)}
			{verdict.trace && <TlaTrace trace={verdict.trace} />}
		</div>
	);
}
