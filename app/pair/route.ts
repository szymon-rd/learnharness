/**
 * Phone pairing (remote mode — see src/server/remote-access.ts).
 *
 * GET /pair?code=<access code> or a POSTed form: when the code matches
 * LH_REMOTE_ACCESS_CODE, set the long-lived pairing cookie and go home.
 * Otherwise show a small code form. The Android app opens
 * /pair?code=… directly; a phone browser can type the code here.
 * Outside remote mode there is nothing to pair: go home.
 */
import { REMOTE_COOKIE, accessCodeMatches, remoteAccessMode, remoteCookieValue } from "@/src/server";

const NO_STORE = { "Cache-Control": "no-store" };
/** Browsers cap cookie lifetime at 400 days. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

function isHttps(request: Request): boolean {
	const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
	return forwarded === "https" || new URL(request.url).protocol === "https:";
}

function goHome(cookie?: string): Response {
	const headers = new Headers({ ...NO_STORE, Location: "/" });
	if (cookie) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function page(error: string | null, status: number): Response {
	const message = error ? `<p class="error">${error}</p>` : "";
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Pair device · LearnHarness</title>
<style>
	:root { color-scheme: dark; }
	body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: #161616; color: #e8e8e8; font: 16px/1.5 ui-monospace, "JetBrains Mono", monospace; }
	main { width: 100%; max-width: 380px; padding: 24px; box-sizing: border-box; }
	h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
	p { margin: 0 0 20px; color: #a0a0a0; font-size: 14px; }
	input { width: 100%; box-sizing: border-box; padding: 14px; border-radius: 12px; border: 1px solid #3a3a3a; background: #1e1e1e; color: inherit; font: inherit; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; }
	button { margin-top: 12px; width: 100%; padding: 14px; border: 0; border-radius: 12px; background: #e8e8e8; color: #161616; font: inherit; font-weight: 600; }
	.error { color: #ff8a80; }
	code { color: #e8e8e8; overflow-wrap: anywhere; }
</style></head>
<body><main>
	<h1>Pair this device</h1>
	<p>Enter the access code for this server. On a VPS, <code>docker compose exec learnharness cat /data/phone-access-code</code> shows it; on a computer, <code>npm run phone</code> prints it.</p>
	${message}
	<form method="post" action="/pair">
		<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required autofocus>
		<button type="submit">Pair</button>
	</form>
</main></body></html>`;
	return new Response(html, { status, headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" } });
}

function attempt(request: Request, code: string | null): Response {
	const mode = remoteAccessMode();
	if (mode.kind === "off") return goHome();
	if (mode.kind === "misconfigured") return page("The server's access code is too short. Restart the phone server.", 200);
	if (code === null || code.trim() === "") return page(null, 200);
	if (!accessCodeMatches(code, mode)) return page("That code did not match. Check it and try again.", 200);
	const cookie = [
		`${REMOTE_COOKIE}=${remoteCookieValue(mode.code)}`,
		"Path=/",
		`Max-Age=${COOKIE_MAX_AGE}`,
		"HttpOnly",
		"SameSite=Lax",
		...(isHttps(request) ? ["Secure"] : []),
	].join("; ");
	return goHome(cookie);
}

export function GET(request: Request) {
	return attempt(request, new URL(request.url).searchParams.get("code"));
}

export async function POST(request: Request) {
	let code: string | null = null;
	try {
		const value = (await request.formData()).get("code");
		code = typeof value === "string" ? value : null;
	} catch {
		code = null;
	}
	return attempt(request, code);
}
