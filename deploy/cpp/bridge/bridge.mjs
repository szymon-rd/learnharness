#!/usr/bin/env node
/**
 * C++ service for code cells (deploy/docker-compose.yml, service "cpp").
 *
 *   POST /check   {cell, tests?, runs?}
 *                 No tests: `g++ -fsyntax-only` on the cell (the editor's
 *                 live errors). With tests: compile tests.cpp (it includes
 *                 lh_test.hpp and the cell as cell.cpp) with AddressSanitizer
 *                 and UBSan, then run the binary once per test number in
 *                 `runs`, each in its own process with a time limit.
 *                 Diagnostics come as GCC's JSON. Returns the raw results;
 *                 grading happens in the app (src/core/cpp-cell.ts). Internal:
 *                 only the app calls it.
 *   GET  /health  compiler version.
 *
 * Two lanes: syntax checks (while the learner types) and compile-and-run
 * checks, so a syntax check never waits behind a test run.
 *
 * The container has no internet access, runs as a normal user on a
 * read-only filesystem with a memory and process cap; each request works in
 * its own temporary folder, removed afterwards. Learner code runs as the
 * same user as this bridge: it can at worst crash the container, which then
 * restarts.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 3500);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, "lh_test.hpp");
const STD = process.env.CPP_STD ?? "c++20";
const COMPILE_TIMEOUT_MS = Number(process.env.CPP_COMPILE_TIMEOUT_SECONDS ?? 30) * 1000;
const SYNTAX_TIMEOUT_MS = Number(process.env.CPP_SYNTAX_TIMEOUT_SECONDS ?? 15) * 1000;
const TEST_TIMEOUT_MS = Number(process.env.CPP_TEST_TIMEOUT_SECONDS ?? 5) * 1000;
/** Budget for all test runs of one check. */
const RUN_BUDGET_MS = Number(process.env.CPP_RUN_BUDGET_SECONDS ?? 30) * 1000;
const MAX_QUEUED = 4;
const MAX_SOURCE_BYTES = 100_000;
const MAX_RUNS = 30;
const MAX_OUTPUT = 20_000;
const WARNINGS = ["-Wall", "-Wextra"];
/** Processes (and threads) this user may have while a test runs: stops a
 *  fork bomb long before the container's own process cap. */
const TEST_NPROC = Number(process.env.CPP_TEST_NPROC ?? 64);

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function compilerVersion() {
	try {
		return execFileSync("g++", ["-dumpfullversion"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

/** Our own child processes still running (g++, test binaries). */
const active = new Set();

/** Kill a child's whole process group, repeating until it is empty (a
 *  forking program can add members while the first signal lands). */
function killGroup(child) {
	for (let i = 0; i < 50; i++) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			return; // ESRCH: the group is gone
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

/** Kill leftovers: processes re-parented to us (PID 1 in the container)
 *  that are not our running children — e.g. what a test forked into its
 *  own session before it ended. */
function sweepOrphans() {
	let entries = [];
	try {
		entries = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
	} catch {
		return;
	}
	for (const d of entries) {
		const pid = Number(d);
		if (pid === process.pid || active.has(pid)) continue;
		let stat;
		try {
			stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
		} catch {
			continue;
		}
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		if (ppid === process.pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}

/** Run a command; resolves with exit code, signal and separate outputs. */
function run(cmd, args, { cwd, timeoutMs, env }) {
	return new Promise((resolve) => {
		const started = Date.now();
		if (timeoutMs <= 0) return resolve({ exitCode: null, signal: null, timedOut: true, ms: 0, stdout: "", stderr: "" });
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { PATH: process.env.PATH, ...env } });
		if (child.pid) active.add(child.pid);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			if (stdout.length < MAX_OUTPUT) stdout += c;
		});
		child.stderr.on("data", (c) => {
			if (stderr.length < MAX_OUTPUT * 5) stderr += c;
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			killGroup(child); // anything it left behind
			active.delete(child.pid);
			sweepOrphans();
			resolve({ exitCode: code, signal, timedOut, ms: Date.now() - started, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT * 5) });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			active.delete(child.pid);
			resolve({ exitCode: null, signal: null, timedOut: false, ms: Date.now() - started, stdout: "", stderr: String(err?.message ?? err) });
		});
	});
}

/** Split GCC's stderr into its JSON diagnostics and any other text. */
function diagnosticsOf(stderr) {
	const start = stderr.indexOf("[");
	if (start >= 0) {
		const end = stderr.lastIndexOf("]");
		try {
			const json = JSON.parse(stderr.slice(start, end + 1));
			const other = (stderr.slice(0, start) + stderr.slice(end + 1)).trim();
			return { diagnostics: json, other };
		} catch {
			/* not JSON */
		}
	}
	return { diagnostics: [], other: stderr.trim() };
}

async function check({ cell, tests, runs }) {
	const started = Date.now();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-"));
	try {
		fs.writeFileSync(path.join(dir, "cell.cpp"), cell);
		fs.copyFileSync(HARNESS, path.join(dir, "lh_test.hpp"));
		const diagFlags = ["-fdiagnostics-format=json", "-fno-diagnostics-show-caret"];
		if (tests === undefined) {
			const r = await run("g++", [`-std=${STD}`, "-fsyntax-only", ...WARNINGS, ...diagFlags, "cell.cpp"], { cwd: dir, timeoutMs: SYNTAX_TIMEOUT_MS });
			return { ms: Date.now() - started, compile: { ok: !r.timedOut && r.exitCode === 0, timedOut: r.timedOut, ...diagnosticsOf(r.stderr) } };
		}
		fs.writeFileSync(path.join(dir, "tests.cpp"), tests);
		const c = await run(
			"g++",
			[`-std=${STD}`, "-O0", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-sanitize-recover=undefined", ...WARNINGS, ...diagFlags, "-o", "tests", "tests.cpp"],
			{ cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS },
		);
		const compile = { ok: !c.timedOut && c.exitCode === 0, timedOut: c.timedOut, ...diagnosticsOf(c.stderr) };
		if (!compile.ok) return { ms: Date.now() - started, compile };
		const results = [];
		const deadline = Date.now() + RUN_BUDGET_MS;
		for (const n of runs) {
			const r = await run("prlimit", [`--nproc=${TEST_NPROC}`, "--", "./tests", String(n)], {
				cwd: dir,
				timeoutMs: Math.min(TEST_TIMEOUT_MS, deadline - Date.now()),
				// Leak checking needs ptrace, which the container does not allow.
				env: { ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0:exitcode=86", UBSAN_OPTIONS: "print_stacktrace=1:exitcode=87" },
			});
			results.push({ test: n, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, ms: r.ms, stdout: r.stdout, stderr: r.stderr.slice(0, MAX_OUTPUT) });
		}
		return { ms: Date.now() - started, compile, runs: results };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function validate(body) {
	if (!body || typeof body !== "object") return "Expected JSON {cell, tests?, runs?}";
	if (typeof body.cell !== "string" || Buffer.byteLength(body.cell) > MAX_SOURCE_BYTES) return "cell must be a string under 100 KB";
	if (body.tests !== undefined && (typeof body.tests !== "string" || Buffer.byteLength(body.tests) > MAX_SOURCE_BYTES)) return "tests must be a string under 100 KB";
	if (body.tests !== undefined) {
		if (!Array.isArray(body.runs) || body.runs.length === 0 || body.runs.length > MAX_RUNS) return `runs must list 1 to ${MAX_RUNS} test numbers`;
		if (!body.runs.every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) return "runs must be positive test numbers";
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

const syntaxLane = lane();
const runLane = lane();
const VERSION = compilerVersion();

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://cpp");
	if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, compiler: VERSION ? `g++ ${VERSION}` : null, std: STD });
	if (req.method === "POST" && url.pathname === "/check") {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_SOURCE_BYTES * 3) req.destroy();
			else chunks.push(c);
		});
		req.on("end", () => {
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return sendJson(res, 400, { error: "Expected JSON {cell, tests?, runs?}" });
			}
			const problem = validate(body);
			if (problem) return sendJson(res, 400, { error: problem });
			const which = body.tests === undefined ? syntaxLane : runLane;
			if (which.busy) return sendJson(res, 503, { error: "The C++ checker is busy; try again shortly" });
			which.push(async () => {
				try {
					sendJson(res, 200, await check(body));
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

server.listen(PORT, () => log(`C++ service on :${PORT} (${VERSION ? `g++ ${VERSION}` : "no g++"}, ${STD})`));
