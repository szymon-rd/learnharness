#!/usr/bin/env node
/**
 * Rocq service for code cells (deploy/docker-compose.yml, service "rocq"),
 * built like the Lean service (deploy/lean/bridge/bridge.mjs).
 *
 *   WS   /rocq/lsp  one coq-lsp language server per connection. Caddy routes
 *                   it here only for paired devices (forward_auth to the
 *                   app). LSP messages travel as one JSON text per WebSocket
 *                   frame; this side adds/removes the Content-Length
 *                   framing. Documents live under the virtual folder
 *                   file:///cell/ (mapped to ROCQ_CELLS).
 *   POST /check     {source} → `rocq compile` on that file: exit code and
 *                   output (errors, and the Print Assumptions report the app
 *                   appends). Internal: only the app calls it. Grading happens
 *                   in the app (src/core/rocq-cell.ts).
 *   GET  /health    Rocq, Iris and coq-lsp versions, open sessions, and
 *                   whether the start-up warm-up is still loading Iris.
 *
 * Warm-up (as for Lean): on start the service checks a file that loads Iris
 * and HeapLang, so their compiled files are read from disk once before the
 * first cell opens (cold, that can take long on a busy server). Checks that
 * arrive meanwhile queue behind it; /health reports `warming: true`.
 *
 * The container has no internet access and runs as a normal user; Rocq code
 * cannot run arbitrary programs, but treat the container as disposable.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3600);
const CELLS = path.resolve(process.env.ROCQ_CELLS ?? "/home/rocq/cells");
/** Language servers at once. A newer connection replaces the oldest. */
const MAX_SESSIONS = Math.max(1, Number(process.env.ROCQ_MAX_SESSIONS ?? 2));
const IDLE_MS = Number(process.env.ROCQ_IDLE_MINUTES ?? 10) * 60_000;
const CHECK_TIMEOUT_MS = Number(process.env.ROCQ_CHECK_TIMEOUT_SECONDS ?? 60) * 1000;
const MAX_QUEUED_CHECKS = 4;
const MAX_SOURCE_BYTES = 200_000;
const MAX_OUTPUT = 20_000;
const PUBLIC_ORIGIN = process.env.LH_PUBLIC_URL ? new URL(process.env.LH_PUBLIC_URL).origin : null;

const VIRTUAL_ROOT = "file:///cell/";
const REAL_ROOT = `${pathToFileURL(CELLS).href}/`;
const CELL_URI = /^file:\/\/\/cell\/[A-Za-z0-9_]{1,64}\.v$/;

/** Client methods passed to coq-lsp; anything else is refused. */
const CLIENT_METHODS = new Set([
	"initialize",
	"initialized",
	"shutdown",
	"exit",
	"$/cancelRequest",
	"$/setTrace",
	"textDocument/didOpen",
	"textDocument/didChange",
	"textDocument/didClose",
	"textDocument/hover",
	"textDocument/completion",
	"proof/goals",
]);

const log = (...args) => console.log(new Date().toISOString(), ...args);
/** ROCQ_DEBUG=1 logs each LSP message's method (or response id) both ways. */
const DEBUG = process.env.ROCQ_DEBUG === "1";

function version(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
	} catch {
		return null;
	}
}

const VERSIONS = {
	rocq: version("rocq", ["--version"])?.replace(/^The Rocq Prover, version /, "") ?? null,
	coqLsp: version("coq-lsp", ["--version"]),
	iris: process.env.IRIS_VERSION ?? null,
};

/** Map every string in a JSON value. */
function mapStrings(value, fn) {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
		return out;
	}
	return value;
}

/** Every "uri" in a client message must be a cell document. */
function urisAllowed(value) {
	if (Array.isArray(value)) return value.every(urisAllowed);
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (k === "uri" && (typeof v !== "string" || !CELL_URI.test(v))) return false;
			if (!urisAllowed(v)) return false;
		}
	}
	return true;
}

/** Content-Length framed messages from a stream. */
class Framer {
	constructor(onMessage) {
		this.buf = Buffer.alloc(0);
		this.onMessage = onMessage;
	}
	push(chunk) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		for (;;) {
			const sep = this.buf.indexOf("\r\n\r\n");
			if (sep < 0) return;
			const header = this.buf.subarray(0, sep).toString("ascii");
			const m = /content-length:\s*(\d+)/i.exec(header);
			if (!m) throw new Error(`bad LSP header: ${header.slice(0, 80)}`);
			const end = sep + 4 + Number(m[1]);
			if (this.buf.length < end) return;
			const body = this.buf.subarray(sep + 4, end).toString("utf8");
			this.buf = this.buf.subarray(end);
			this.onMessage(body);
		}
	}
}

function frame(json) {
	const body = Buffer.from(json, "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function killGroup(child, signal = "SIGKILL") {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

// ── Language server sessions ─────────────────────────────────────────────

const sessions = new Set();
let nextSessionId = 1;

function startSession(ws) {
	const id = nextSessionId++;
	const server = spawn("coq-lsp", [], { cwd: CELLS, stdio: ["pipe", "pipe", "pipe"], detached: true });
	const session = { id, ws, server, idle: null };
	sessions.add(session);
	log(`session ${id}: started (pid ${server.pid}, ${sessions.size} open)`);

	const toClient = (text) => {
		if (DEBUG) {
			const m = JSON.parse(text);
			log(`session ${id} ← ${m.method ?? `reply ${m.id}${m.error ? ` error ${m.error.message}` : ""}`}${m.params?.status ? ` ${m.params.status}` : ""}`);
		}
		if (ws.readyState !== ws.OPEN) return;
		ws.send(text.includes(REAL_ROOT) ? JSON.stringify(mapStrings(JSON.parse(text), (s) => s.split(REAL_ROOT).join(VIRTUAL_ROOT))) : text);
	};
	const framer = new Framer(toClient);
	server.stdout.on("data", (chunk) => {
		try {
			framer.push(chunk);
		} catch (err) {
			log(`session ${id}: ${err.message}`);
			ws.close(1011, "coq-lsp sent a malformed message");
		}
	});
	server.stderr.on("data", (chunk) => {
		const text = chunk.toString().trim();
		if (text) log(`session ${id} stderr: ${text.slice(0, 500)}`);
	});
	server.stdin.on("error", () => {});
	server.on("exit", (code, signal) => {
		log(`session ${id}: coq-lsp exited (${signal ?? code})`);
		if (ws.readyState === ws.OPEN) ws.close(4003, "The Rocq server stopped");
	});

	const touch = () => {
		clearTimeout(session.idle);
		session.idle = setTimeout(() => ws.close(4002, "Closed after inactivity"), IDLE_MS);
	};
	touch();

	ws.on("message", (data, isBinary) => {
		touch();
		let msg;
		try {
			if (isBinary) throw new Error("binary frame");
			msg = JSON.parse(data.toString("utf8"));
		} catch {
			ws.close(1003, "Expected one JSON-RPC message per text frame");
			return;
		}
		const refuse = (message) => {
			if (msg.id !== undefined && msg.method) ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message } }));
		};
		if (DEBUG) log(`session ${id} → ${msg.method ?? "reply"}${msg.id !== undefined ? ` #${msg.id}` : ""}${msg.params?.textDocument?.version !== undefined ? ` v${msg.params.textDocument.version}` : ""}${msg.params?.position ? ` @${msg.params.position.line}:${msg.params.position.character}` : ""}`);
		if (msg.method !== undefined) {
			if (!CLIENT_METHODS.has(msg.method)) return refuse(`${msg.method} is not available here`);
			if (msg.method === "initialize") {
				// The workspace is always the cells folder, whatever the client says.
				msg.params = { ...msg.params, processId: null, rootUri: pathToFileURL(CELLS).href, rootPath: CELLS, workspaceFolders: null };
			} else if (!urisAllowed(msg.params)) {
				return refuse(`Documents must be ${VIRTUAL_ROOT}<name>.v`);
			}
		}
		const out = JSON.stringify(mapStrings(msg, (s) => (s.startsWith(VIRTUAL_ROOT) ? REAL_ROOT + s.slice(VIRTUAL_ROOT.length) : s)));
		if (server.stdin.writable) server.stdin.write(frame(out));
	});

	ws.on("close", () => {
		clearTimeout(session.idle);
		sessions.delete(session);
		killGroup(server);
		log(`session ${id}: closed (${sessions.size} open)`);
	});
	ws.on("error", () => {});
}

// ── One-shot checks ──────────────────────────────────────────────────────

let checkQueue = Promise.resolve();
let queuedChecks = 0;

function runCheck(source) {
	return new Promise((resolve) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-"));
		fs.writeFileSync(path.join(dir, "Check.v"), source);
		const started = Date.now();
		const rocq = spawn("rocq", ["compile", "-q", "Check.v"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let output = "";
		const take = (c) => {
			if (output.length < MAX_OUTPUT) output += c;
		};
		rocq.stdout.on("data", take);
		rocq.stderr.on("data", take);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(rocq);
		}, CHECK_TIMEOUT_MS);
		rocq.on("close", (code) => {
			clearTimeout(timer);
			fs.rmSync(dir, { recursive: true, force: true });
			resolve({ exitCode: code, timedOut, ms: Date.now() - started, output: output.slice(0, MAX_OUTPUT) });
		});
		rocq.on("error", (err) => {
			clearTimeout(timer);
			fs.rmSync(dir, { recursive: true, force: true });
			resolve({ exitCode: null, timedOut: false, ms: Date.now() - started, output: String(err?.message ?? err) });
		});
	});
}

/** "warming" until the start-up warm-up settles, then "warm" or "failed". */
let warmup = { state: "warming", ms: null };

function startWarmup() {
	log("warm-up: loading Iris");
	checkQueue = checkQueue.then(async () => {
		const result = await runCheck("From iris.heap_lang Require Import proofmode notation.\nFrom iris.base_logic Require Import iprop.\n");
		const ok = result.exitCode === 0 && !result.timedOut;
		warmup = { state: ok ? "warm" : "failed", ms: result.ms };
		log(ok ? `warm-up: Iris loaded (${result.ms} ms)` : `warm-up: failed after ${result.ms} ms: ${result.output.slice(0, 300)}`);
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://rocq");
	if (req.method === "GET" && url.pathname === "/health") {
		return sendJson(res, 200, { ok: true, ...VERSIONS, sessions: sessions.size, maxSessions: MAX_SESSIONS, warming: warmup.state === "warming", warmup });
	}
	if (req.method === "POST" && url.pathname === "/check") {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_SOURCE_BYTES + 1000) req.destroy();
			else chunks.push(c);
		});
		req.on("end", () => {
			let source;
			try {
				source = JSON.parse(Buffer.concat(chunks).toString("utf8")).source;
			} catch {
				return sendJson(res, 400, { error: "Expected JSON {source}" });
			}
			if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
				return sendJson(res, 400, { error: "source must be a string under 200 KB" });
			}
			if (queuedChecks >= MAX_QUEUED_CHECKS) return sendJson(res, 503, { error: "Rocq is busy; try again shortly" });
			queuedChecks++;
			checkQueue = checkQueue.then(async () => {
				try {
					sendJson(res, 200, await runCheck(source));
				} catch (err) {
					sendJson(res, 500, { error: String(err?.message ?? err) });
				} finally {
					queuedChecks--;
				}
			});
		});
		return;
	}
	sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://rocq");
	const origin = req.headers.origin;
	if (url.pathname !== "/rocq/lsp" || (PUBLIC_ORIGIN && origin && origin !== PUBLIC_ORIGIN)) {
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		while (sessions.size >= MAX_SESSIONS) {
			const oldest = sessions.values().next().value;
			sessions.delete(oldest);
			oldest.ws.close(4001, "Replaced by a newer Rocq session");
			killGroup(oldest.server);
		}
		startSession(ws);
	});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		for (const s of sessions) killGroup(s.server);
		process.exit(0);
	});
}

server.listen(PORT, () => {
	log(`Rocq service on :${PORT} (Rocq ${VERSIONS.rocq ?? "?"}, Iris ${VERSIONS.iris ?? "?"}, ${VERSIONS.coqLsp ?? "coq-lsp ?"})`);
	startWarmup();
});
