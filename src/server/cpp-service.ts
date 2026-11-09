/**
 * The C++ service client (code cells). The service itself is the "cpp"
 * container in deploy/docker-compose.yml (deploy/cpp/bridge/bridge.mjs);
 * LH_CPP_URL points at it (http://cpp:3500 in the Compose stack). Unset =
 * no C++ on this server: C++ cells stay off.
 */
import type { CppCheckRequest, CppCheckResult, CppChecker } from "../core/cpp-cell.ts";

/** Longer than the service's own budget (30 s compile + 30 s of tests per
 *  check) and some queueing. */
const CHECK_TIMEOUT_MS = 150_000;

export function cppServiceUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env.LH_CPP_URL?.trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

export class CppUnavailableError extends Error {}

/** A checker bound to the configured service, or null when none is. */
export function cppChecker(env: Record<string, string | undefined> = process.env): CppChecker | null {
	const base = cppServiceUrl(env);
	if (!base) return null;
	return async (request: CppCheckRequest): Promise<CppCheckResult> => {
		let res: Response;
		try {
			res = await fetch(`${base}/check`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch (err) {
			throw new CppUnavailableError(`The C++ checker is unreachable (${(err as Error).message}).`);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new CppUnavailableError(`The C++ checker answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
		}
		return (await res.json()) as CppCheckResult;
	};
}
