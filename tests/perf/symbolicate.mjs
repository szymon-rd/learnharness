#!/usr/bin/env node
/**
 * Summarize a .cpuprofile from tests/perf/perf.mjs --profiles by ORIGINAL
 * source (needs a build with LH_SOURCEMAPS=1, so .next/static/chunks/*.map
 * exist). Prints self time per source function and inclusive time per
 * source file (node_modules packages collapsed to the package name).
 *
 *   node tests/perf/symbolicate.mjs <file.cpuprofile> [top N]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("source-map-js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [file, topArg] = process.argv.slice(2);
const TOP = Number(topArg ?? 25);
const profile = JSON.parse(fs.readFileSync(file, "utf8"));

const consumers = new Map();
function consumerFor(url) {
	const m = url.match(/\/_next\/(static\/chunks\/[^?]+\.js)/);
	if (!m) return null;
	if (!consumers.has(m[1])) {
		// The chunk's last line names its map (Turbopack map names differ
		// from chunk names).
		const chunk = path.join(ROOT, ".next", m[1]);
		let mapFile = chunk + ".map";
		if (fs.existsSync(chunk)) {
			const ref = fs.readFileSync(chunk, "utf8").match(/\/\/# sourceMappingURL=(\S+)\s*$/);
			if (ref) mapFile = path.join(path.dirname(chunk), ref[1]);
		}
		consumers.set(m[1], fs.existsSync(mapFile) ? new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, "utf8"))) : null);
	}
	return consumers.get(m[1]);
}

function shortSource(src) {
	if (!src) return "?";
	const nm = src.lastIndexOf("node_modules/");
	if (nm >= 0) {
		const rest = src.slice(nm + "node_modules/".length).split("/");
		return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	}
	return src.replace(/^.*?\/(components|app|src|lib)\//, "$1/").replace(/^turbopack:\/\/\/\[project\]\//, "");
}

const where = new Map();
function locate(node) {
	if (where.has(node.id)) return where.get(node.id);
	const cf = node.callFrame;
	let out;
	const c = cf.url && cf.lineNumber >= 0 ? consumerFor(cf.url) : null;
	if (c) {
		const pos = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
		const src = shortSource(pos.source);
		out = { file: src, fn: `${pos.name || cf.functionName || "(anon)"} ${src}:${pos.line ?? "?"}` };
	} else {
		const name = cf.functionName || "(anon)";
		out = { file: cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, "") : `(${name})`, fn: `${name} ${cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, "") : "(native)"}` };
	}
	where.set(node.id, out);
	return out;
}

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const selfUs = new Map();
for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));

const fnSelf = new Map();
const fileIncl = new Map();
let total = 0;
for (const [id, us] of selfUs) {
	const node = byId.get(id);
	const name = node.callFrame.functionName;
	if (name === "(idle)" || name === "(program)") continue;
	total += us;
	const loc = locate(node);
	fnSelf.set(loc.fn, (fnSelf.get(loc.fn) ?? 0) + us);
	// Inclusive per file: count each file once per sample stack.
	const seen = new Set();
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
		const f = locate(byId.get(cur)).file;
		if (seen.has(f)) continue;
		seen.add(f);
		fileIncl.set(f, (fileIncl.get(f) ?? 0) + us);
	}
}
// --callers <substring>: who enters code whose file matches (the first
// frame outside it), weighted by the time spent inside.
const callersOf = process.argv.includes("--callers") ? process.argv[process.argv.indexOf("--callers") + 1] : null;
const entry = new Map();
if (callersOf) {
	for (const [id, us] of selfUs) {
		const name = byId.get(id).callFrame.functionName;
		if (name === "(idle)" || name === "(program)") continue;
		// Outermost run of frames inside the target: report its caller.
		let cur = id;
		let inside = null;
		while (cur !== undefined) {
			const loc = locate(byId.get(cur));
			if (loc.file.includes(callersOf)) inside = cur;
			else if (inside !== null) break;
			cur = parent.get(cur);
		}
		if (inside === null) continue;
		const caller = cur === undefined ? "(root)" : locate(byId.get(cur)).fn;
		const key = `${caller}  →  ${locate(byId.get(inside)).fn}`;
		entry.set(key, (entry.get(key) ?? 0) + us);
	}
}
const ms = (us) => `${Math.round(us / 1000)}ms`.padStart(8);
if (callersOf) {
	console.log(`— callers into ${callersOf} —`);
	for (const [k, v] of [...entry].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(ms(v), k);
	process.exit(0);
}
console.log(`busy ${ms(total)}  (${path.basename(file)})`);
console.log("— self time by function —");
for (const [k, v] of [...fnSelf].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(ms(v), k);
console.log("— inclusive time by source file / package —");
for (const [k, v] of [...fileIncl].filter(([k]) => !k.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(ms(v), k);
