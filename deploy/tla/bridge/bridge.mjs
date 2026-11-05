#!/usr/bin/env node
/**
 * TLA+ service for code cells (deploy/docker-compose.yml, service "tla").
 *
 *   POST /check   {module, pluscal?, runs?: [{id, cfg, appendDefs?}]}
 *                 1. PlusCal (pluscal: true): `pcal.trans` translates the
 *                    algorithm into the module (between the BEGIN/END
 *                    TRANSLATION lines, which it adds when missing).
 *                 2. SANY parses the (translated) module.
 *                 3. Each run: TLC (`-tool` output) on the module with the
 *                    run's config. `appendDefs` are extra definitions put
 *                    just before the closing `====` (the reachability
 *                    witnesses), so no other line moves.
 *                 Stops at the first step that fails (translation, parse).
 *                 Returns the raw outputs; grading happens in the app
 *                 (src/core/tla-cell.ts). Internal: only the app calls it.
 *   GET  /health  tla2tools version.
 *
 * Two lanes: parses (no runs, used while the learner types) and model
 * checks each run one at a time, so a parse never waits behind TLC.
 *
 * The container has no internet access and runs as a normal user; each
 * request works in its own temporary folder, removed afterwards.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3400);
const JAR = process.env.TLA_JAR ?? "/opt/tla/tla2tools.jar";
const TOOLS_VERSION = process.env.TLA_TOOLS_VERSION ?? null;
/** Budget for all TLC runs of one check. */
const CHECK_TIMEOUT_MS = Number(process.env.TLA_CHECK_TIMEOUT_SECONDS ?? 60) * 1000;
const PARSE_TIMEOUT_MS = Number(process.env.TLA_PARSE_TIMEOUT_SECONDS ?? 20) * 1000;
const TLC_HEAP = process.env.TLA_TLC_HEAP ?? "640m";
const SANY_HEAP = process.env.TLA_SANY_HEAP ?? "256m";
const MAX_QUEUED = 4;
const MAX_MODULE_BYTES = 100_000;
const MAX_RUNS = 8;
const MAX_OUTPUT = 60_000;
const MODULE_HEADER = /^\s*-{4,}\s*MODULE\s+([A-Za-z0-9_]+)\s*-{4,}/m;

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

/** Run a command; resolves with its exit code and combined output. */
function run(cmd, args, cwd, timeoutMs) {
	return new Promise((resolve) => {
		const started = Date.now();
		if (timeoutMs <= 0) return resolve({ exitCode: null, timedOut: true, ms: 0, output: "" });
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let output = "";
		const take = (c) => {
			if (output.length < MAX_OUTPUT) output += c;
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code, timedOut, ms: Date.now() - started, output: output.slice(0, MAX_OUTPUT) });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ exitCode: null, timedOut: false, ms: Date.now() - started, output: String(err?.message ?? err) });
		});
	});
}

const JAVA_FLAGS = ["-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xss4m"];

function java(heap, mainClass, args, cwd, timeoutMs) {
	return run("java", [`-Xmx${heap}`, ...JAVA_FLAGS, "-cp", JAR, mainClass, ...args], cwd, timeoutMs);
}

/** SANY reports semantic errors with exit code 0; read the text. */
function sanyFailed(result) {
	if (result.timedOut || result.exitCode !== 0) return true;
	return /\*\*\*Parse Error\*\*\*|Semantic errors:|Fatal errors|Could not parse module|\*\*\* Errors:/.test(result.output);
}

function insertBeforeEnd(module, defs) {
	if (!defs) return module;
	const lines = module.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^\s*={4,}\s*$/.test(lines[i])) {
			// Join onto the line before the end marker so no line number moves.
			const prev = i > 0 ? i - 1 : 0;
			lines[prev] = `${lines[prev]}\n${defs}`;
			return lines.join("\n");
		}
	}
	return `${module}\n${defs}\n`;
}

async function check({ module, pluscal, runs }, parseOnly) {
	const started = Date.now();
	const name = MODULE_HEADER.exec(module)?.[1];
	if (!name) return { ms: 0, error: "The module has no `---- MODULE Name ----` header." };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tla-"));
	try {
		const file = path.join(dir, `${name}.tla`);
		fs.writeFileSync(file, module);
		const out = { ms: 0, moduleName: name };
		if (pluscal) {
			const t = await java(SANY_HEAP, "pcal.trans", ["-nocfg", `${name}.tla`], dir, PARSE_TIMEOUT_MS);
			const translated = fs.readFileSync(file, "utf8");
			const ok = !t.timedOut && t.exitCode === 0;
			out.translation = { ok, timedOut: t.timedOut, output: t.output, ...(ok ? { module: translated } : {}) };
			if (!ok) return { ...out, ms: Date.now() - started };
		}
		const s = await java(SANY_HEAP, "tla2sany.SANY", [`${name}.tla`], dir, PARSE_TIMEOUT_MS);
		out.sany = { ok: !sanyFailed(s), timedOut: s.timedOut, output: s.output };
		if (!out.sany.ok || parseOnly) return { ...out, ms: Date.now() - started };
		const translated = fs.readFileSync(file, "utf8");
		out.runs = [];
		const deadline = Date.now() + CHECK_TIMEOUT_MS;
		for (const r of runs) {
			const runDir = fs.mkdtempSync(path.join(dir, "run-"));
			fs.writeFileSync(path.join(runDir, `${name}.tla`), insertBeforeEnd(translated, r.appendDefs ?? ""));
			fs.writeFileSync(path.join(runDir, "Model.cfg"), r.cfg);
			const res = await java(
				TLC_HEAP,
				"tlc2.TLC",
				["-tool", "-workers", "1", "-config", "Model.cfg", "-metadir", path.join(runDir, "states"), `${name}.tla`],
				runDir,
				deadline - Date.now(),
			);
			out.runs.push({ id: r.id, exitCode: res.exitCode, timedOut: res.timedOut, ms: res.ms, output: res.output });
			if (res.timedOut) break;
		}
		return { ...out, ms: Date.now() - started };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function validate(body) {
	if (!body || typeof body !== "object") return "Expected JSON {module, pluscal?, runs?}";
	if (typeof body.module !== "string" || Buffer.byteLength(body.module) > MAX_MODULE_BYTES) return "module must be a string under 100 KB";
	if (body.pluscal !== undefined && typeof body.pluscal !== "boolean") return "pluscal must be a boolean";
	const runs = body.runs ?? [];
	if (!Array.isArray(runs) || runs.length > MAX_RUNS) return `runs must be a list of at most ${MAX_RUNS}`;
	for (const r of runs) {
		if (!r || typeof r.id !== "string" || typeof r.cfg !== "string") return "each run needs {id, cfg}";
		if (r.appendDefs !== undefined && typeof r.appendDefs !== "string") return "appendDefs must be a string";
	}
	return null;
}

/** One lane = one request at a time, a few waiting. */
function lane() {
	let tail = Promise.resolve();
	let queued = 0;
	return {
		get busy() {
			return queued >= MAX_QUEUED;
		},
		push(job) {
			queued++;
			tail = tail.then(async () => {
				try {
					await job();
				} finally {
					queued--;
				}
			});
		},
	};
}

const parseLane = lane();
const checkLane = lane();

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://tla");
	if (req.method === "GET" && url.pathname === "/health") {
		return sendJson(res, 200, { ok: true, tools: TOOLS_VERSION });
	}
	if (req.method === "POST" && url.pathname === "/check") {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_MODULE_BYTES * 2 + 20_000) req.destroy();
			else chunks.push(c);
		});
		req.on("end", () => {
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return sendJson(res, 400, { error: "Expected JSON {module, pluscal?, runs?}" });
			}
			const problem = validate(body);
			if (problem) return sendJson(res, 400, { error: problem });
			const runs = body.runs ?? [];
			const parseOnly = runs.length === 0;
			const which = parseOnly ? parseLane : checkLane;
			if (which.busy) return sendJson(res, 503, { error: "The TLA+ checker is busy; try again shortly" });
			which.push(async () => {
				try {
					sendJson(res, 200, await check({ module: body.module, pluscal: body.pluscal === true, runs }, parseOnly));
				} catch (err) {
					sendJson(res, 500, { error: String(err?.message ?? err) });
				}
			});
		});
		return;
	}
	sendJson(res, 404, { error: "Not found" });
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

server.listen(PORT, () => log(`TLA+ service on :${PORT} (tla2tools ${TOOLS_VERSION ?? "?"})`));
