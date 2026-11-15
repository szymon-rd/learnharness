import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal, UNPAIRED_REFUSAL } from "./src/server/desktop-access.ts";
import { PAIR_PATH, REMOTE_COOKIE, remoteAccessAuthorized } from "./src/server/remote-access.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function isApi(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/** Two gates, in order:
 *  1. Phone access (only when LH_REMOTE_ACCESS_CODE is set): every page and
 *     API request needs the pairing cookie; /pair is the only way in.
 *  2. API requests, including SSE and spending/settings routes
 *     (apiRequestRefusal, which re-checks the pairing for API calls). The one
 *     streamed document route enforces the identical all-method request
 *     policy inside its handler, avoiding Next's silently truncated Proxy
 *     body clone. No public callback or worker bypass: legitimate self-HTTP
 *     still needs the capability. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (!isApi(pathname)) {
		if (pathname === PAIR_PATH || remoteAccessAuthorized(request.cookies.get(REMOTE_COOKIE)?.value)) return NextResponse.next();
		// Serve the pair form in place (an internal rewrite, not a redirect):
		// no absolute URL to build, so it stays correct behind a reverse
		// proxy (e.g. Tailscale HTTPS) that rewrites the Host header.
		return NextResponse.rewrite(new URL(PAIR_PATH, request.url), { headers: NO_STORE });
	}
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json({ error: refusal }, { status: refusal === UNPAIRED_REFUSAL ? 401 : 403, headers: NO_STORE });
	}
	return NextResponse.next();
}

export const config = {
	// Everything except Next's static build output (public, content-hashed
	// JS/CSS) and the exact streamed document endpoint — not the documents
	// subtree or other plugin routes. Must remain static literals.
	matcher: ["/((?!_next/static|_next/image|api/plugins/[^/]+/documents/markdown/?$).*)"],
};
