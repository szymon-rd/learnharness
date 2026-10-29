import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { PAIR_PATH, REMOTE_COOKIE, remoteAccessAuthorized } from "./src/server/remote-access.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function isApi(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/** Two gates, in order:
 *  1. Phone access (only when LH_REMOTE_ACCESS_CODE is set): every page and
 *     API request needs the pairing cookie; /pair is the only way in.
 *  2. Desktop capability: applies to every API method, including SSE and
 *     spending/settings routes. No public callback or worker bypass: internal
 *     jobs call server functions, and any legitimate self-HTTP request must
 *     carry the private capability. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname !== PAIR_PATH && !remoteAccessAuthorized(request.cookies.get(REMOTE_COOKIE)?.value)) {
		if (isApi(pathname)) {
			return NextResponse.json({ error: "This device is not paired. Open /pair and enter the access code." }, { status: 401, headers: NO_STORE });
		}
		// Serve the pair form in place (an internal rewrite, not a redirect):
		// no absolute URL to build, so it stays correct behind a reverse
		// proxy (e.g. Tailscale HTTPS) that rewrites the Host header.
		return NextResponse.rewrite(new URL(PAIR_PATH, request.url), { headers: NO_STORE });
	}
	if (isApi(pathname) && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: NO_STORE },
		);
	}
	return NextResponse.next();
}

// Everything except Next's static build output (public, content-hashed JS/CSS).
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
