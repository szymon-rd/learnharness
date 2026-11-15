/**
 * The TLA+/C++ cells' live checks (the editor's errors and the Check
 * button) go through the plugin's backend bridge. main.tsx installs it on
 * activation; the server reads the exercise from the saved session.
 */
export type LiveCheck = (request: { chatId: string; id: string; code: string; mode: string }) => Promise<unknown>;

let bridge: LiveCheck | null = null;

export function setLiveCheck(next: LiveCheck | null): void {
	bridge = next;
}

export async function liveCheck<T>(chatId: string, id: string, code: string, mode: string): Promise<T> {
	if (!bridge) throw new Error("Code cells is not active.");
	return (await bridge({ chatId, id, code, mode })) as T;
}
