"use client";

import { Loader2Icon } from "lucide-react";

/**
 * The transcript line while a tla_exercise call is being written and its
 * reference solution checked with TLC (the call's part stays
 * input-streaming until the check finishes).
 */
export function TlaPreparingLine() {
	return (
		<div data-testid="tla-preparing" className="flex items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground">
			<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
			<span>Preparing the TLA+ exercise…</span>
		</div>
	);
}
