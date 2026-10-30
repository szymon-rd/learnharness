/**
 * GET /api/lean/authorize — Caddy's forward_auth check before it opens the
 * Lean language-server WebSocket (/lean/lsp, deploy/Caddyfile). The proxy
 * (proxy.ts) has already refused unpaired devices with 401 by the time a
 * request gets here, so reaching this handler means "allowed".
 */
export const dynamic = "force-dynamic";

export function GET() {
	return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
