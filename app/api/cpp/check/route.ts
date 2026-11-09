/**
 * POST /api/cpp/check {chatId, toolCallId, solution, mode} — a C++ code
 * cell's live check ("syntax": compile errors and warnings) and Check button
 * ("check": compile and run the visible tests). The exercise is read from
 * the persisted call; the result is not recorded (Submit records).
 */
import { cppCellCheckResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	}
	return cppCellCheckResponse(body);
}
