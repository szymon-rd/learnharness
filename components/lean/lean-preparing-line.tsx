"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

/** How often the line re-asks whether Lean is still warming up. */
const POLL_MS = 5000;

/**
 * The transcript line while a lean_exercise call is being written and its
 * reference proof checked (the call's part stays input-streaming until the
 * check finishes). Right after the Lean service starts it loads Mathlib
 * (about a minute on a small server) and the check waits for that, so the
 * line says so instead of looking stuck.
 */
export function LeanPreparingLine() {
	const [warming, setWarming] = useState(false);

	useEffect(() => {
		let alive = true;
		const poll = () => {
			fetch("/api/lean/status")
				.then((r) => r.json() as Promise<{ warming?: boolean }>)
				.then((s) => {
					if (alive) setWarming(s.warming === true);
				})
				.catch(() => {
					/* transient — keep the last answer */
				});
		};
		poll();
		const id = setInterval(poll, POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, []);

	return (
		<div
			data-testid="lean-preparing"
			className="flex items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground"
		>
			<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
			<span>
				{warming
					? "Lean server starting. The first check takes about a minute."
					: "Preparing the Lean exercise…"}
			</span>
		</div>
	);
}
