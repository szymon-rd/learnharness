"use client";

/**
 * The C++ verdict as the learner reads it (owner, 2026-11-09): the summary,
 * compiler errors (and warnings) with their cell lines, and one row per
 * test — passed, or how it failed. A hidden test shows only its name and
 * how it failed, not its check. Shared by the Check panel, the answered card
 * and the practice submission card.
 */
import { cn } from "@/lib/utils";
import type { CppDiagnostic, CppTestResult, CppVerdict } from "@/src/core";

export function CppDiagnostics({ items, tone = "error" }: { items: CppDiagnostic[]; tone?: "error" | "warning" }) {
	if (!items.length) return null;
	return (
		<ul className="mt-2 flex flex-col gap-1.5" data-testid={tone === "error" ? "cpp-errors" : "cpp-warnings"}>
			{items.map((e, i) => (
				<li key={i} className={cn("whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 font-mono text-xs leading-relaxed", tone === "error" ? "bg-red-500/10" : "bg-amber-500/10")}>
					{e.line !== null && <span className="text-muted-foreground">line {e.line}: </span>}
					{tone === "warning" && <span className="text-muted-foreground">warning: </span>}
					{e.message}
				</li>
			))}
		</ul>
	);
}

const OUTCOME_TEXT: Record<CppTestResult["outcome"], string> = {
	passed: "passes",
	check: "check failed",
	sanitizer: "memory / undefined behavior",
	crash: "crashed",
	timeout: "time limit",
	exit: "ended early",
};

export function CppTests({ tests }: { tests: CppTestResult[] }) {
	if (!tests.length) return null;
	return (
		<ul className="mt-2 flex flex-col gap-1" data-testid="cpp-tests">
			{tests.map((t) => (
				<li key={t.name} className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs" data-passed={t.passed}>
					<div className="flex items-baseline justify-between gap-2">
						<span className="font-medium">
							{t.name}
							{t.hidden && <span className="ml-1.5 font-normal text-muted-foreground">(hidden)</span>}
						</span>
						<span className={t.passed ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{OUTCOME_TEXT[t.outcome]}</span>
					</div>
					{!t.passed && !t.hidden && t.message && (
						<pre className="mt-1 whitespace-pre-wrap break-words font-mono leading-relaxed">
							{t.line !== undefined && <span className="text-muted-foreground">line {t.line}: </span>}
							{t.message}
						</pre>
					)}
					{!t.passed && t.hidden && t.outcome !== "check" && t.message && (
						<pre className="mt-1 whitespace-pre-wrap break-words font-mono leading-relaxed">
							{t.line !== undefined && <span className="text-muted-foreground">line {t.line}: </span>}
							{t.message.split("\n")[0]}
						</pre>
					)}
					{!t.passed && !t.hidden && t.output && (
						<pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-1.5 py-1 font-mono text-[11px] text-muted-foreground">{t.output}</pre>
					)}
				</li>
			))}
		</ul>
	);
}

export function CppVerdictView({ verdict, summary, className, showWarnings = true }: { verdict: CppVerdict; summary: string; className?: string; showWarnings?: boolean }) {
	return (
		<div className={cn("text-sm", className)} data-testid="cpp-verdict" data-reason={verdict.reason}>
			<div className={verdict.passed ? "text-green-600 dark:text-green-400" : "text-foreground"}>{summary}</div>
			<CppDiagnostics items={verdict.errors} />
			{showWarnings && <CppDiagnostics items={verdict.warnings} tone="warning" />}
			<CppTests tests={verdict.tests} />
		</div>
	);
}
