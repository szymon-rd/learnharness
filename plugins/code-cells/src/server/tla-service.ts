/**
 * The TLA+ service client (code cells). The service itself is the "tla"
 * container in deploy/docker-compose.yml (deploy/tla/bridge/bridge.mjs);
 * LH_TLA_URL points at it (http://tla:3400 in the Compose stack). Unset =
 * no TLA+ on this server: TLA+ cells stay off.
 */
import type { TlaCheckRequest, TlaCheckResult, TlaChecker } from "../core/tla-cell.ts";

/** Longer than the service's own budget (60 s of TLC per check, plus the
 *  translation and parse) and some queueing. */
const CHECK_TIMEOUT_MS = 150_000;

export function tlaServiceUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env.LH_TLA_URL?.trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

export class TlaUnavailableError extends Error {}

/** A checker bound to the configured service, or null when none is. */
export function tlaChecker(env: Record<string, string | undefined> = process.env): TlaChecker | null {
	const base = tlaServiceUrl(env);
	if (!base) return null;
	return async (request: TlaCheckRequest): Promise<TlaCheckResult> => {
		let res: Response;
		try {
			res = await fetch(`${base}/check`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch (err) {
			throw new TlaUnavailableError(`The TLA+ checker is unreachable (${(err as Error).message}).`);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new TlaUnavailableError(`The TLA+ checker answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
		}
		return (await res.json()) as TlaCheckResult;
	};
}
