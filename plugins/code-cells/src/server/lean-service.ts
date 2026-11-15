/**
 * The Lean service client (code cells). The service itself is the "lean"
 * container in deploy/docker-compose.yml (deploy/lean/bridge/bridge.mjs);
 * LH_LEAN_URL points at it (http://lean:3300 in the Compose stack). Unset =
 * no Lean on this server: the code-cells gate stays closed.
 */
import type { LeanCheckResult, LeanChecker } from "../core/lean-cell.ts";

/** Longer than the service's own per-check limit (120 s) plus queueing. */
const CHECK_TIMEOUT_MS = 200_000;

export function leanServiceUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env.LH_LEAN_URL?.trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

export class LeanUnavailableError extends Error {}

/** A checker bound to the configured service, or null when none is. */
export function leanChecker(env: Record<string, string | undefined> = process.env): LeanChecker | null {
	const base = leanServiceUrl(env);
	if (!base) return null;
	return async (source: string): Promise<LeanCheckResult> => {
		let res: Response;
		try {
			res = await fetch(`${base}/check`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source }),
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch (err) {
			throw new LeanUnavailableError(`Lean is unreachable (${(err as Error).message}).`);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new LeanUnavailableError(`Lean answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
		}
		return (await res.json()) as LeanCheckResult;
	};
}
