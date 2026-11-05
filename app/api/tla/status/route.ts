/**
 * GET /api/tla/status — whether this server has the TLA+ service for code
 * cells (LH_TLA_URL, the "tla" container of deploy/docker-compose.yml) and
 * whether it answers. The settings page greys the "Code cells" row only
 * when neither Lean nor TLA+ is available.
 */
import { tlaServiceUrl } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const base = tlaServiceUrl();
	if (!base) return Response.json({ available: false, reason: "This server has no TLA+ service (deploy with deploy/docker-compose.yml)." });
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
		const health = (await res.json()) as { tools?: string };
		return Response.json({ available: res.ok, tools: health.tools ?? null });
	} catch {
		return Response.json({ available: false, reason: "The TLA+ service is not answering." });
	}
}
