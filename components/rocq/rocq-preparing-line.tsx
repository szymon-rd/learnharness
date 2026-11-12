"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

/** How often the line re-asks whether Rocq is still warming up. */
const POLL_MS = 5000;

/**
 * The transcript line while a rocq_exercise call is being written and its
 * reference proof checked, like Lean's: right after the Rocq service starts
 * it loads Iris once and the check waits for that, so the line says so.
 */
export function RocqPreparingLine() {
	const [warming, setWarming] = useState(false);

	useEffect(() => {
		let alive = true;
		const poll = () => {
			fetch("/api/rocq/status")
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
			data-testid="rocq-preparing"
			className="flex items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground"
		>
			<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
			<span>
				{warming
					? "Rocq server starting (loading Iris)."
					: "Preparing the Rocq exercise…"}
			</span>
		</div>
	);
}
