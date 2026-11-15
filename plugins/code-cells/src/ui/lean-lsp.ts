/**
 * A minimal Lean language-server client over the /lean/lsp WebSocket
 * (deploy/lean/bridge/bridge.mjs; Caddy lets paired devices through). One
 * JSON-RPC message per frame. It covers what a code cell needs: open one
 * document, replace its text, read diagnostics, file progress and goals.
 */

export interface LeanDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	/** 1 error, 2 warning, 3 information, 4 hint. */
	severity?: number;
	message: string;
}

export type LeanConnection = "connecting" | "ready" | "closed";

/** One LSP completion item (the fields the cell uses). */
export interface LeanCompletion {
	label: string;
	/** LSP CompletionItemKind (3 function, 5 field, 6 variable, 7 class, 14 keyword, 21 constant…). */
	kind?: number;
	detail?: string;
	sortText?: string;
	textEdit?: { newText: string; range?: unknown; insert?: unknown; replace?: unknown };
	documentation?: string | { value?: string };
	/** Lean's own payload, sent back on resolve. */
	data?: unknown;
}

export interface LeanSessionEvents {
	onConnection?: (state: LeanConnection, reason?: string) => void;
	onDiagnostics?: (version: number | null, diagnostics: LeanDiagnostic[]) => void;
	/** True while Lean is still processing the document. */
	onProcessing?: (processing: boolean) => void;
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

export function leanSocketUrl(location: { protocol: string; host: string } = window.location): string {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/lean/lsp`;
}

export class LeanSession {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private version = 0;
	private opened = false;
	private closedByUs = false;
	readonly uri: string;

	constructor(
		name: string,
		private readonly events: LeanSessionEvents,
		private readonly url: string = leanSocketUrl(),
	) {
		this.uri = `file:///cell/${name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "Cell"}.lean`;
	}

	/** Connect, initialize and open the document with `text`. */
	async start(text: string): Promise<void> {
		this.closedByUs = false;
		this.events.onConnection?.("connecting");
		const ws = new WebSocket(this.url);
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("Could not reach Lean."));
			ws.onclose = (e) => reject(new Error(e.reason || "Could not reach Lean."));
		});
		ws.onmessage = (e) => this.receive(String(e.data));
		ws.onclose = (e) => {
			for (const p of this.pending.values()) p.reject(new Error("Lean disconnected."));
			this.pending.clear();
			this.opened = false;
			if (!this.closedByUs) this.events.onConnection?.("closed", e.reason || "Lean disconnected.");
		};
		await this.request("initialize", {
			processId: null,
			rootUri: null,
			capabilities: { textDocument: { publishDiagnostics: {}, completion: { completionItem: { snippetSupport: false } } } },
		});
		this.notify("initialized", {});
		this.version = 1;
		this.notify("textDocument/didOpen", { textDocument: { uri: this.uri, languageId: "lean4", version: this.version, text } });
		this.opened = true;
		this.events.onConnection?.("ready");
		this.events.onProcessing?.(true);
	}

	/** Replace the whole document (cells are small). Returns the new version. */
	change(text: string): number {
		if (!this.opened) return this.version;
		this.version += 1;
		this.notify("textDocument/didChange", { textDocument: { uri: this.uri, version: this.version }, contentChanges: [{ text }] });
		this.events.onProcessing?.(true);
		return this.version;
	}

	/** The goals at a position, as Lean renders them ("⊢ …" blocks). */
	async goals(line: number, character: number): Promise<string[] | null> {
		if (!this.opened) return null;
		const res = (await this.request("$/lean/plainGoal", { textDocument: { uri: this.uri }, position: { line, character } })) as { goals?: string[] } | null;
		return res?.goals ?? null;
	}

	/** Lean's completions at a position (identifiers, dotted names, tactics). */
	async completions(line: number, character: number): Promise<LeanCompletion[]> {
		if (!this.opened) return [];
		const res = (await this.request("textDocument/completion", { textDocument: { uri: this.uri }, position: { line, character } })) as
			| { items?: LeanCompletion[] }
			| LeanCompletion[]
			| null;
		return Array.isArray(res) ? res : (res?.items ?? []);
	}

	/** The details Lean leaves out of the list (the type of a name). */
	async resolveCompletion(item: LeanCompletion): Promise<LeanCompletion | null> {
		if (!this.opened) return null;
		return (await this.request("completionItem/resolve", item)) as LeanCompletion | null;
	}

	close(): void {
		this.closedByUs = true;
		this.opened = false;
		this.ws?.close();
		this.ws = null;
	}

	private send(message: object): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
	}

	private notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ id, method, params });
		});
	}

	private receive(raw: string): void {
		let msg: { id?: number; method?: string; params?: any; result?: unknown; error?: { message?: string } };
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.id !== undefined && msg.method === undefined) {
			const p = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			if (msg.error) p?.reject(new Error(msg.error.message ?? "Lean refused the request."));
			else p?.resolve(msg.result ?? null);
			return;
		}
		if (msg.id !== undefined) {
			// A server request (e.g. client/registerCapability): acknowledge.
			this.send({ id: msg.id, result: null });
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === this.uri) {
			this.events.onDiagnostics?.(msg.params.version ?? null, msg.params.diagnostics ?? []);
		} else if (msg.method === "$/lean/fileProgress" && msg.params?.textDocument?.uri === this.uri) {
			this.events.onProcessing?.((msg.params.processing ?? []).length > 0);
		}
	}
}
