#!/usr/bin/env node
/**
 * Lean service for code cells (deploy/docker-compose.yml, service "lean").
 *
 *   WS   /lean/lsp  one Lean language server (`lake serve`) per connection.
 *                  Caddy routes it here only for paired devices (forward_auth
 *                  to the app). LSP messages travel as one JSON text per
 *                  WebSocket frame; this side adds/removes the Content-Length
 *                  framing. Documents live under the virtual folder
 *                  file:///cell/ (mapped into the project so `import Mathlib`
 *                  resolves).
 *   POST /check     {source} → Lean's messages for that file, from
 *                  `lake env lean --json`. Internal: only the app calls it
 *                  (Caddy does not route it). Grading happens in the app.
 *   GET  /health    toolchain, Mathlib version, open sessions.
 *
 * The container has no internet access and runs as a normal user; Lean code
 * can still run IO (#eval), so treat the container as disposable.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3300);
const PROJECT = path.resolve(process.env.LEAN_PROJECT ?? "/home/node/project");
/** Language servers running at once. A newer connection replaces the oldest
 * (a reload or a new cell takes over from the one left behind). */
const MAX_SESSIONS = Math.max(1, Number(process.env.LEAN_MAX_SESSIONS ?? 1));
const IDLE_MS = Number(process.env.LEAN_IDLE_MINUTES ?? 10) * 60_000;
const CHECK_TIMEOUT_MS = Number(process.env.LEAN_CHECK_TIMEOUT_SECONDS ?? 120) * 1000;
const MAX_QUEUED_CHECKS = 4;
const MAX_SOURCE_BYTES = 200_000;
const PUBLIC_ORIGIN = process.env.LH_PUBLIC_URL ? new URL(process.env.LH_PUBLIC_URL).origin : null;

const VIRTUAL_ROOT = "file:///cell/";
const REAL_ROOT = `${pathToFileURL(path.join(PROJECT, "Cells")).href}/`;
const CELL_URI = /^file:\/\/\/cell\/[A-Za-z0-9_]{1,64}\.lean$/;

/** Client methods passed to Lean; anything else is refused. */
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
	"completionItem/resolve",
	"textDocument/documentHighlight",
	"$/lean/plainGoal",
	"$/lean/plainTermGoal",
]);

const log = (...args) => console.log(new Date().toISOString(), ...args);

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function mathlibRev() {
	const manifest = readText(path.join(PROJECT, "lake-manifest.json"));
	if (!manifest) return null;
	const pkg = JSON.parse(manifest).packages?.find((p) => p.name === "mathlib");
	return pkg ? (pkg.inputRev ?? pkg.rev) : null;
}

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
	const lake = spawn("lake", ["serve"], { cwd: PROJECT, stdio: ["pipe", "pipe", "pipe"], detached: true });
	const session = { id, ws, lake, idle: null };
	sessions.add(session);
	log(`session ${id}: started (pid ${lake.pid}, ${sessions.size} open)`);

	const toClient = (text) => {
		if (ws.readyState !== ws.OPEN) return;
		ws.send(text.includes(REAL_ROOT) ? JSON.stringify(mapStrings(JSON.parse(text), (s) => s.split(REAL_ROOT).join(VIRTUAL_ROOT))) : text);
	};
	const framer = new Framer(toClient);
	lake.stdout.on("data", (chunk) => {
		try {
			framer.push(chunk);
		} catch (err) {
			log(`session ${id}: ${err.message}`);
			ws.close(1011, "Lean sent a malformed message");
		}
	});
	lake.stderr.on("data", (chunk) => {
		const text = chunk.toString().trim();
		if (text) log(`session ${id} stderr: ${text.slice(0, 500)}`);
	});
	lake.stdin.on("error", () => {});
	lake.on("exit", (code, signal) => {
		log(`session ${id}: Lean exited (${signal ?? code})`);
		if (ws.readyState === ws.OPEN) ws.close(4003, "The Lean server stopped");
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
		if (msg.method !== undefined) {
			if (!CLIENT_METHODS.has(msg.method)) return refuse(`${msg.method} is not available here`);
			if (msg.method === "initialize") {
				// The workspace is always the cells project, whatever the client says.
				msg.params = { ...msg.params, processId: null, rootUri: pathToFileURL(PROJECT).href, rootPath: PROJECT, workspaceFolders: null };
			} else if (!urisAllowed(msg.params)) {
				return refuse(`Documents must be ${VIRTUAL_ROOT}<name>.lean`);
			}
		}
		const out = JSON.stringify(mapStrings(msg, (s) => (s.startsWith(VIRTUAL_ROOT) ? REAL_ROOT + s.slice(VIRTUAL_ROOT.length) : s)));
		if (lake.stdin.writable) lake.stdin.write(frame(out));
	});

	ws.on("close", () => {
		clearTimeout(session.idle);
		sessions.delete(session);
		killGroup(lake);
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
		const file = path.join(dir, "Check.lean");
		fs.writeFileSync(file, source);
		const started = Date.now();
		const lean = spawn("lake", ["env", "lean", "--json", file], { cwd: PROJECT, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		lean.stdout.on("data", (c) => (stdout += c));
		lean.stderr.on("data", (c) => (stderr += c));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(lean);
		}, CHECK_TIMEOUT_MS);
		lean.on("close", (code) => {
			clearTimeout(timer);
			fs.rmSync(dir, { recursive: true, force: true });
			const messages = [];
			const other = [];
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				try {
					const m = JSON.parse(line);
					messages.push({ severity: m.severity, pos: m.pos, endPos: m.endPos ?? null, data: m.data });
				} catch {
					other.push(line);
				}
			}
			resolve({
				exitCode: code,
				timedOut,
				ms: Date.now() - started,
				messages,
				output: [...other, stderr.trim()].filter(Boolean).join("\n").slice(0, 4000),
			});
		});
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://lean");
	if (req.method === "GET" && url.pathname === "/health") {
		return sendJson(res, 200, {
			ok: true,
			toolchain: readText(path.join(PROJECT, "lean-toolchain"))?.trim() ?? null,
			mathlib: mathlibRev(),
			sessions: sessions.size,
			maxSessions: MAX_SESSIONS,
		});
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
			if (queuedChecks >= MAX_QUEUED_CHECKS) return sendJson(res, 503, { error: "Lean is busy; try again shortly" });
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
	const url = new URL(req.url ?? "/", "http://lean");
	const origin = req.headers.origin;
	if (url.pathname !== "/lean/lsp" || (PUBLIC_ORIGIN && origin && origin !== PUBLIC_ORIGIN)) {
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		while (sessions.size >= MAX_SESSIONS) {
			const oldest = sessions.values().next().value;
			sessions.delete(oldest);
			oldest.ws.close(4001, "Replaced by a newer Lean session");
			killGroup(oldest.lake);
		}
		startSession(ws);
	});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		for (const s of sessions) killGroup(s.lake);
		process.exit(0);
	});
}

server.listen(PORT, () => log(`Lean service on :${PORT} (project ${PROJECT}, Mathlib ${mathlibRev() ?? "?"}, ${MAX_SESSIONS} session(s))`));
