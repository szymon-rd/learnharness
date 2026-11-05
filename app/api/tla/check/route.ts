/**
 * POST /api/tla/check {chatId, toolCallId, solution, mode} — a TLA+ code
 * cell's live parse ("parse": PlusCal translation + SANY) and Check button
 * ("check": the full TLC check with witnesses). The exercise is read from
 * the persisted call; the result is not recorded (Submit records).
 */
import { tlaCellCheckResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	}
	return tlaCellCheckResponse(body);
}
