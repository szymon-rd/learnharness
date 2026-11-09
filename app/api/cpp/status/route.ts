/**
 * GET /api/cpp/status — whether this server has the C++ service for code
 * cells (LH_CPP_URL, the "cpp" container of deploy/docker-compose.yml) and
 * whether it answers. The settings page uses it for the "Code cells" row.
 */
import { cppServiceUrl } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const base = cppServiceUrl();
	if (!base) return Response.json({ available: false, reason: "This server has no C++ service (deploy with deploy/docker-compose.yml)." });
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
		const health = (await res.json()) as { compiler?: string; std?: string };
		return Response.json({ available: res.ok, compiler: health.compiler ?? null, std: health.std ?? null });
	} catch {
		return Response.json({ available: false, reason: "The C++ service is not answering." });
	}
}
