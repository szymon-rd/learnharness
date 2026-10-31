#!/usr/bin/env node
/**
 * End-to-end test server: the real LearnHarness production server (a
 * `next build` is required first) with a SCRIPTED model in place of the
 * real providers, so the whole learning flow can be driven through the UI
 * deterministically, for free, without network access to any model API.
 *
 *   node tests/e2e/server.mjs --port 3300 --data <data dir> [--code <access code>]
 *
 * How: the scripted model (tests/e2e/scripted-model.mjs) is a pi-ai faux
 * provider registered under the provider ids the test settings use
 * ("openrouter"). It goes on globalThis.__lhTestProviders, and
 * LH_TEST_PROVIDERS=1 makes src/agent/models.ts install it. A dummy
 * OPENROUTER_API_KEY makes the app treat the provider as configured.
 * --code turns on phone access (pairing), as on a VPS.
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedProviders } from "./scripted-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(option("--port", "3300"));
const data = option("--data");
if (!data) {
	console.error("usage: server.mjs --port <port> --data <data dir> [--code <access code>]");
	process.exit(2);
}
const code = option("--code");

process.env.NODE_ENV = "production";
process.env.NEXT_TELEMETRY_DISABLED = "1";
process.env.LH_DATA_DIR = path.resolve(data);
process.env.LH_AUTH_FILE = path.join(path.resolve(data), "..", "auth.json");
process.env.LH_TEST_PROVIDERS = "1";
process.env.OPENROUTER_API_KEY = "e2e-scripted-model";
if (code) process.env.LH_REMOTE_ACCESS_CODE = code;

globalThis.__lhTestProviders = createScriptedProviders();

const next = (await import("next")).default;
const app = next({ dev: false, dir: ROOT, hostname: "0.0.0.0", port });
await app.prepare();
const handle = app.getRequestHandler();
const server = http.createServer((req, res) => handle(req, res));
// Lean code cells (tests/e2e/lean-qa.e2e.mjs): LH_LEAN_URL points the app at
// a Lean service; the browser's /lean/lsp WebSocket is passed through to it
// here, the way Caddy does it on a server.
server.on("upgrade", (req, socket, head) => {
	const lean = process.env.LH_LEAN_URL;
	if (!lean || !req.url?.startsWith("/lean/lsp")) {
		socket.destroy();
		return;
	}
	const { hostname, port: leanPort } = new URL(lean);
	const upstream = net.connect(Number(leanPort), hostname, () => {
		const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
		upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
		upstream.write(head);
		upstream.pipe(socket).pipe(upstream);
	});
	upstream.on("error", () => socket.destroy());
	socket.on("error", () => upstream.destroy());
});
server.listen(port, "0.0.0.0", () => {
	console.log(`E2E server ready on http://127.0.0.1:${port} (scripted model)`);
});
