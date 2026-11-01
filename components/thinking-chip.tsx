"use client";

import { PenLineIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Words in a dictated/typed draft, for the chip's count. */
export function wordCount(text: string): number {
	const t = text.trim();
	return t ? t.split(/\s+/).length : 0;
}

/** "Thinking" when empty, "Thinking · 42 words" once there is text. */
export function thinkingChipLabel(label: string, text: string): string {
	const n = wordCount(text);
	return n === 0 ? label : `${label} · ${n} ${n === 1 ? "word" : "words"}`;
}

/**
 * The collapsed form of a thinking field on phones (owner, 2026-11-01):
 * dictation fills the field without showing it; tapping the chip expands it
 * to read or edit. The text still rides the answer exactly as before.
 */
export function ThinkingChip({
	value,
	onOpen,
	label = "Thinking",
	testId = "thinking-chip",
	className,
}: {
	value: string;
	onOpen: () => void;
	label?: string;
	testId?: string;
	className?: string;
}) {
	const filled = wordCount(value) > 0;
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onOpen}
			aria-label={`${thinkingChipLabel(label, value)} — show`}
			className={cn(
				"flex h-9 min-w-0 shrink items-center gap-1.5 rounded-[6px] border px-2.5 text-sm transition-colors",
				filled ? "border-border text-card-foreground" : "border-border/60 text-muted-foreground",
				className,
			)}
		>
			<PenLineIcon className="size-3.5 shrink-0" />
			<span className="truncate">{thinkingChipLabel(label, value)}</span>
		</button>
	);
}
