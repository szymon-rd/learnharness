#!/usr/bin/env node
/**
 * End-to-end checks for the C++ service (run by .github/workflows/cpp.yml).
 *
 *   node smoke.mjs http://cpp:3500
 *       /health, then /check: a syntax check with a warning, a compile
 *       error, passing and failing tests, AddressSanitizer, UBSan, a crash
 *       and a time limit. Needs no packages, so it runs inside the app
 *       container (the only one on the "cpp" network).
 */
const target = process.argv.slice(2).find((a) => a !== "-");

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}
function ok(message) {
	console.log(`✓ ${message}`);
}

async function post(name, body) {
	const res = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (res.status !== 200) fail(`${name}: HTTP ${res.status} ${await res.text()}`);
	const r = await res.json();
	console.log(`  ${name}: ${r.ms} ms, compile ${r.compile?.ok}, runs ${(r.runs ?? []).map((x) => `${x.test}:exit ${x.exitCode}${x.signal ? ` ${x.signal}` : ""}${x.timedOut ? " (timed out)" : ""}`).join(", ") || "-"}`);
	return r;
}

const tests = (bodies) =>
	`#include "lh_test.hpp"\n#include "cell.cpp"\n${bodies.map((b, i) => `static void lh_test_${i + 1}() {\n${b}\n}\n`).join("")}` +
	`int main(int argc, char** argv) {\n  int n = argc > 1 ? std::atoi(argv[1]) : 0;\n  switch (n) {\n${bodies.map((_, i) => `    case ${i + 1}: lh_test_${i + 1}(); break;\n`).join("")}    default: return 2;\n  }\n  std::cout << "\\n@@LH_PASS smoke" << std::endl;\n  return 0;\n}\n`;

const health = await (await fetch(`${target}/health`)).json();
if (!health.ok || !health.compiler) fail(`health: ${JSON.stringify(health)}`);
ok(`health: ${health.compiler}, ${health.std}`);

const warn = await post("syntax with a warning", { cell: "int f(int x) { int unused; return x; }\n" });
if (!warn.compile.ok || !warn.compile.diagnostics.some((d) => d.kind === "warning" && /unused/.test(d.message))) fail("the warning was not reported as JSON");
ok("a syntax check reports warnings as JSON");

const bad = await post("compile error", { cell: "int f(int x) {\n  return x +\n}\n" });
if (bad.compile.ok || !bad.compile.diagnostics.some((d) => d.kind === "error" && d.locations?.[0]?.caret?.line)) fail("the compile error was not reported with a line");
ok("a compile error comes with its line");

const cell =
	"#include <vector>\n#include <climits>\nint sum(const std::vector<int>& v) {\n  int s = 0;\n  for (int x : v) s += x;\n  return s;\n}\n" +
	"int at(const std::vector<int>& v, int i) { return v[i]; }\nint inc(int x) { return x + 1; }\nint* none() { return nullptr; }\n";
const r = await post("tests", {
	cell,
	tests: tests(["CHECK_EQ(sum({1, 2, 3}), 6);", "CHECK_EQ(sum({1, 2, 3}), 7);", "std::vector<int> v(3);\nCHECK_EQ(at(v, 3), 0);", "CHECK(inc(INT_MAX) < 0);", "volatile int* p = none();\n*p = 1;", "while (true) {}"]),
	runs: [1, 2, 3, 4, 5, 6],
});
const run = (n) => r.runs.find((x) => x.test === n);
if (!r.compile.ok) fail(`the tests did not compile: ${JSON.stringify(r.compile).slice(0, 400)}`);
if (run(1).exitCode !== 0 || !run(1).stdout.includes("@@LH_PASS smoke")) fail("a passing test did not pass");
ok("a passing test passes");
if (run(2).exitCode !== 1 || !/@@LH_FAIL\n[\s\S]*got: +6[\s\S]*expected: 7/.test(run(2).stdout)) fail("a failing CHECK_EQ did not report got/expected");
ok("a failing CHECK_EQ reports got and expected");
if (run(3).exitCode !== 86 || !/AddressSanitizer: (heap|container)-buffer-overflow/.test(run(3).stderr)) fail("AddressSanitizer did not catch the out-of-bounds read");
ok("AddressSanitizer catches an out-of-bounds read");
if (run(4).exitCode !== 87 || !/signed integer overflow/.test(run(4).stderr)) fail("UBSan did not catch the signed overflow");
ok("UBSan catches a signed overflow");
if (run(5).exitCode === 0 || run(5).timedOut) fail("a null write did not fail fast");
ok("a null write fails fast");
if (!run(6).timedOut) fail("an endless loop was not stopped");
ok("an endless loop is stopped at the time limit");

const malformed = await fetch(`${target}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cell: 5 }) });
if (malformed.status !== 400) fail(`malformed request: HTTP ${malformed.status}`);
ok("malformed requests are refused");
