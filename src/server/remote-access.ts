import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Phone access (remote mode). When LH_REMOTE_ACCESS_CODE is set, the server
 * is meant to be reached from other devices (the Android app, a phone
 * browser) over the network, so EVERY request — pages and API — must carry
 * the pairing cookie. A device gets the cookie once by opening
 * /pair?code=<access code>. Unset (desktop and plain web dev), this module
 * allows everything and the desktop guard in desktop-access.ts is the only
 * check, unchanged.
 *
 * The cookie holds a hash of the code, never the code itself. Changing the
 * code (scripts/phone-server.mjs --new-code) signs out every paired device.
 */

export const REMOTE_COOKIE = "lh_remote";
export const PAIR_PATH = "/pair";
/** Shortest code the server accepts. A set-but-shorter code fails closed. */
const MIN_CODE_LENGTH = 16;

/** Upper-case, drop separators, and fold the look-alike letters the
 * generator never emits (Crockford base32), so a hand-typed code matches. */
export function normalizeAccessCode(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[\s-]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
}

export type RemoteAccessMode = { kind: "off" } | { kind: "on"; code: string } | { kind: "misconfigured" };

export function remoteAccessMode(env: Record<string, string | undefined> = process.env): RemoteAccessMode {
	const raw = env.LH_REMOTE_ACCESS_CODE;
	if (raw === undefined || raw === "") return { kind: "off" };
	const code = normalizeAccessCode(raw);
	return code.length >= MIN_CODE_LENGTH ? { kind: "on", code } : { kind: "misconfigured" };
}

export function remoteCookieValue(code: string): string {
	return createHash("sha256").update(`learnharness-remote:${normalizeAccessCode(code)}`).digest("hex");
}

function sameSecret(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** True when a submitted code matches the server's code. */
export function accessCodeMatches(submitted: string, mode: RemoteAccessMode): boolean {
	if (mode.kind !== "on") return false;
	return sameSecret(normalizeAccessCode(submitted), mode.code);
}

/** True when the request may proceed past the remote-access gate. */
export function remoteAccessAuthorized(
	cookieValue: string | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const mode = remoteAccessMode(env);
	if (mode.kind === "off") return true;
	if (mode.kind === "misconfigured" || !cookieValue) return false;
	return sameSecret(cookieValue, remoteCookieValue(mode.code));
}
