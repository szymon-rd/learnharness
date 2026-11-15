/**
 * The Rocq service client (code cells). The service itself is the "rocq"
 * container in deploy/docker-compose.yml (deploy/rocq/bridge/bridge.mjs);
 * LH_ROCQ_URL points at it (http://rocq:3600 in the Compose stack). Unset =
 * no Rocq on this server: Rocq cells stay off.
 */
import type { RocqCheckResult, RocqChecker } from "../core/rocq-cell.ts";

/** Longer than the service's own per-check limit (60 s) plus queueing. */
const CHECK_TIMEOUT_MS = 200_000;

export function rocqServiceUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env.LH_ROCQ_URL?.trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

export class RocqUnavailableError extends Error {}

/** A checker bound to the configured service, or null when none is. */
export function rocqChecker(env: Record<string, string | undefined> = process.env): RocqChecker | null {
	const base = rocqServiceUrl(env);
	if (!base) return null;
	return async (source: string): Promise<RocqCheckResult> => {
		let res: Response;
		try {
			res = await fetch(`${base}/check`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source }),
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch (err) {
			throw new RocqUnavailableError(`Rocq is unreachable (${(err as Error).message}).`);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new RocqUnavailableError(`Rocq answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
		}
		return (await res.json()) as RocqCheckResult;
	};
}
