/**
 * GET /api/rocq/status — whether this server has the Rocq service for code
 * cells (LH_ROCQ_URL, the "rocq" container of deploy/docker-compose.yml)
 * and whether it answers. The settings page uses it for the "Code cells" row.
 */
import { rocqServiceUrl } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const base = rocqServiceUrl();
	if (!base) return Response.json({ available: false, reason: "This server has no Rocq service (deploy with deploy/docker-compose.yml)." });
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
		const health = (await res.json()) as { rocq?: string; iris?: string; warming?: boolean };
		// warming: the service loads Iris after a start (checks wait for it).
		return Response.json({ available: res.ok, rocq: health.rocq ?? null, iris: health.iris ?? null, warming: health.warming === true });
	} catch {
		return Response.json({ available: false, reason: "The Rocq service is not answering." });
	}
}
