"use client";

import { Loader2Icon } from "lucide-react";

/**
 * The transcript line while a cpp_exercise call is being written and its
 * reference solution compiled and tested (the call's part stays
 * input-streaming until the check finishes).
 */
export function CppPreparingLine() {
	return (
		<div data-testid="cpp-preparing" className="flex items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground">
			<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
			<span>Preparing the C++ exercise…</span>
		</div>
	);
}
