/**
 * GET /api/lean/status — whether this server has the Lean service for code
 * cells (LH_LEAN_URL, the "lean" container of deploy/docker-compose.yml)
 * and whether it answers. The settings page greys the "Code cells" row
 * without it.
 */
import { leanServiceUrl } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const base = leanServiceUrl();
	if (!base) return Response.json({ available: false, reason: "This server has no Lean service (deploy with deploy/docker-compose.yml)." });
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
		const health = (await res.json()) as { toolchain?: string; mathlib?: string };
		return Response.json({ available: res.ok, toolchain: health.toolchain ?? null, mathlib: health.mathlib ?? null });
	} catch {
		return Response.json({ available: false, reason: "The Lean service is not answering." });
	}
}
