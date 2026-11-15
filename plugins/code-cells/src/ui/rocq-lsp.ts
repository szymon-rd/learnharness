/**
 * A minimal coq-lsp client over the /rocq/lsp WebSocket
 * (deploy/rocq/bridge/bridge.mjs; Caddy lets paired devices through), built
 * like the Lean client (components/lean/lean-lsp.ts). One JSON-RPC message
 * per frame. It covers what a cell needs: open one document, replace its
 * text, read diagnostics, file progress and goals.
 */

export interface RocqDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	/** 1 error, 2 warning, 3 information, 4 hint. */
	severity?: number;
	message: string;
}

export type RocqConnection = "connecting" | "ready" | "closed";

export interface RocqCompletion {
	label: string;
	kind?: number;
	detail?: string;
	sortText?: string;
	textEdit?: { newText: string };
}

export interface RocqSessionEvents {
	onConnection?: (state: RocqConnection, reason?: string) => void;
	onDiagnostics?: (version: number | null, diagnostics: RocqDiagnostic[]) => void;
	/** True while coq-lsp is still checking the document. */
	onProcessing?: (processing: boolean) => void;
}

/** coq-lsp's goal shapes (pp_format "Str": plain strings). */
interface Hyp {
	names: string[];
	def?: string;
	ty: string;
}
interface Goal {
	hyps: Hyp[];
	ty: string;
}
export interface RocqGoals {
	goals: Goal[];
	stack: [Goal[], Goal[]][];
	shelf: Goal[];
	given_up: Goal[];
	bullet?: string;
}

/** Render goals the way Rocq prints them: hypotheses, a rule, the goal. */
export function renderRocqGoals(goals: RocqGoals | null | undefined): string[] | null {
	if (!goals) return null;
	return goals.goals.map((g) => {
		const hyps = g.hyps.map((h) => `${h.names.join(", ")}${h.def ? ` := ${h.def}` : ""} : ${h.ty}`);
		return [...hyps, "────────────────────", g.ty].join("\n");
	});
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

export function rocqSocketUrl(location: { protocol: string; host: string } = window.location): string {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rocq/lsp`;
}

export class RocqSession {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private version = 0;
	private opened = false;
	private closedByUs = false;
	readonly uri: string;

	constructor(
		name: string,
		private readonly events: RocqSessionEvents,
		private readonly url: string = rocqSocketUrl(),
	) {
		this.uri = `file:///cell/${name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "Cell"}.v`;
	}

	async start(text: string): Promise<void> {
		this.closedByUs = false;
		this.events.onConnection?.("connecting");
		const ws = new WebSocket(this.url);
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("Could not reach Rocq."));
			ws.onclose = (e) => reject(new Error(e.reason || "Could not reach Rocq."));
		});
		ws.onmessage = (e) => this.receive(String(e.data));
		ws.onclose = (e) => {
			for (const p of this.pending.values()) p.reject(new Error("Rocq disconnected."));
			this.pending.clear();
			this.opened = false;
			if (!this.closedByUs) this.events.onConnection?.("closed", e.reason || "Rocq disconnected.");
		};
		await this.request("initialize", {
			processId: null,
			rootUri: null,
			capabilities: { textDocument: { publishDiagnostics: {}, completion: { completionItem: { snippetSupport: false } } } },
			initializationOptions: { eager_diagnostics: true, show_coq_info_messages: false, show_notices_as_diagnostics: false, goal_after_tactic: false },
		});
		this.notify("initialized", {});
		this.version = 1;
		this.notify("textDocument/didOpen", { textDocument: { uri: this.uri, languageId: "coq", version: this.version, text } });
		this.opened = true;
		this.events.onConnection?.("ready");
		this.events.onProcessing?.(true);
	}

	change(text: string): number {
		if (!this.opened) return this.version;
		this.version += 1;
		this.notify("textDocument/didChange", { textDocument: { uri: this.uri, version: this.version }, contentChanges: [{ text }] });
		this.events.onProcessing?.(true);
		return this.version;
	}

	/** The goals at a position (before the sentence there), rendered. */
	async goals(line: number, character: number): Promise<string[] | null> {
		if (!this.opened) return null;
		const res = (await this.request("proof/goals", {
			textDocument: { uri: this.uri, version: this.version },
			position: { line, character },
			pp_format: "Str",
		})) as { goals?: RocqGoals } | null;
		return res ? renderRocqGoals(res.goals ?? null) : null;
	}

	async completions(line: number, character: number): Promise<RocqCompletion[]> {
		if (!this.opened) return [];
		const res = (await this.request("textDocument/completion", { textDocument: { uri: this.uri }, position: { line, character } })) as
			| { items?: RocqCompletion[] }
			| RocqCompletion[]
			| null;
		return Array.isArray(res) ? res : (res?.items ?? []);
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
			if (msg.error) p?.reject(new Error(msg.error.message ?? "Rocq refused the request."));
			else p?.resolve(msg.result ?? null);
			return;
		}
		if (msg.id !== undefined) {
			this.send({ id: msg.id, result: null });
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === this.uri) {
			this.events.onDiagnostics?.(msg.params.version ?? null, msg.params.diagnostics ?? []);
		} else if (msg.method === "$/coq/serverStatus") {
			// coq-lsp reports Busy/Idle for the whole server (one document per
			// session); its file progress never sends a final empty list.
			this.events.onProcessing?.(msg.params?.status === "Busy");
		}
	}
}
