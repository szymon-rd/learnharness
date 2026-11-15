import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { REMOTE_COOKIE, remoteAccessAuthorized, remoteAccessMode } from "./remote-access.ts";

/** Browser-only mode: `next dev` / `next start` without the desktop shell's
 * per-launch secret. */
export function browserOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER !== "1" && !env.LH_DESKTOP_API_SECRET;
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is checked by
 * browserAPIRefusal instead. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (browserOnlyMode(env)) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Same-origin browser controls, not user authentication. Web/dev deliberately
 * retains the existing shared-server/API-key trust model. Never trust forwarded
 * origins or add CORS grants here. A public deployment needs its own access gate. */
export function subscriptionRequestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${url.protocol}//${host}`);
		if (!["http:", "https:"].includes(addressed.protocol) || addressed.username || addressed.password || addressed.pathname !== "/" || addressed.search || addressed.hash) return;
		return addressed.origin;
	} catch { return; }
}

/** DNS rebinding needs an attacker-owned DNS name, so localhost names and IP
 * literals are always safe. Any other name must be listed in LH_ALLOWED_HOSTS
 * (comma-separated, case-insensitive, port ignored). */
export function browserHostAllowed(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(hostname);
}

/** Shared by Proxy and the streamed document route that deliberately bypasses
 * Proxy's truncated body clone. Check before any route-specific work. */
export function apiRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	// Phone access (remote mode): the pairing cookie is the gate. It also
	// stands in for the Host allowlist — a DNS-rebinding page is on another
	// origin and cannot carry the cookie — so a paired phone reaches the
	// server under any name (a VPS domain, a Tailscale name).
	if (remoteAccessMode(env).kind !== "off") {
		if (!remoteAccessAuthorized(requestCookie(request, REMOTE_COOKIE), env)) return UNPAIRED_REFUSAL;
		if (browserOnlyMode(env)) return crossSiteWriteRefusal(request);
	}
	if (browserOnlyMode(env)) return browserAPIRefusal(request, env);
	if (!desktopAPIAuthorized(request.headers, env)) return "Desktop API access requires the trusted LearnHarness window.";
}

export const UNPAIRED_REFUSAL = "This device is not paired. Open /pair and enter the access code.";

function requestCookie(request: Request, name: string): string | undefined {
	for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
		const at = pair.indexOf("=");
		if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
	}
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browser-only API gate: a Host check against DNS rebinding and a
 * cross-site check on writes. Writes without Origin or Sec-Fetch-Site come
 * from non-browser clients and are allowed. Returns the refusal, if any. */
export function browserAPIRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!browserHostAllowed(request.headers.get("host") ?? new URL(request.url).host, env)) {
		return "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.";
	}
	return crossSiteWriteRefusal(request);
}

function crossSiteWriteRefusal(request: Request): string | undefined {
	if (READ_METHODS.has(request.method.toUpperCase())) return;
	const site = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	if ((site !== null && site !== "same-origin") || (origin !== null && origin !== subscriptionRequestOrigin(request))) {
		return "Cross-site requests to the LearnHarness API are not allowed.";
	}
}
