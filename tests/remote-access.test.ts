import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
	REMOTE_COOKIE,
	accessCodeMatches,
	normalizeAccessCode,
	remoteAccessAuthorized,
	remoteAccessMode,
	remoteCookieValue,
} from "../src/server/remote-access.ts";
import { proxy } from "../proxy.ts";
import { GET as pairGET, POST as pairPOST } from "../app/pair/route.ts";

const CODE = "NA11-TE99-C2EC-BT66-ZE58";
const origin = "http://192.168.1.20:3210";

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("access codes normalize case, separators and look-alike letters", () => {
	assert.equal(normalizeAccessCode("na11-te99 c2ec-bt66-ze58"), "NA11TE99C2ECBT66ZE58");
	assert.equal(normalizeAccessCode("O0-IL"), "0011");
	const mode = remoteAccessMode({ LH_REMOTE_ACCESS_CODE: CODE });
	assert.equal(mode.kind, "on");
	assert(accessCodeMatches("na11te99c2ecbt66ze58", mode));
	assert(!accessCodeMatches("NA11-TE99-C2EC-BT66-ZE59", mode));
	assert(!accessCodeMatches(CODE, { kind: "off" }));
});

test("remote mode is off by default, fails closed when the code is too short", () => {
	assert.deepEqual(remoteAccessMode({}), { kind: "off" });
	assert(remoteAccessAuthorized(undefined, {}), "desktop and web dev are unchanged");
	assert.deepEqual(remoteAccessMode({ LH_REMOTE_ACCESS_CODE: "short" }), { kind: "misconfigured" });
	assert(!remoteAccessAuthorized(remoteCookieValue("short"), { LH_REMOTE_ACCESS_CODE: "short" }));
});

test("the cookie is a hash of the code, and only the right one passes", () => {
	const env = { LH_REMOTE_ACCESS_CODE: CODE };
	const cookie = remoteCookieValue(CODE);
	assert(!cookie.includes("NA11"), "the code itself never rides in the cookie");
	assert(remoteAccessAuthorized(cookie, env));
	assert(remoteAccessAuthorized(remoteCookieValue(CODE.toLowerCase()), env));
	assert(!remoteAccessAuthorized(undefined, env));
	assert(!remoteAccessAuthorized("", env));
	assert(!remoteAccessAuthorized(remoteCookieValue("AAAA-BBBB-CCCC-DDDD-EEEE"), env));
});

test("proxy: unpaired pages show the pair form, unpaired API calls get 401, paired requests pass", async () => {
	await withEnv({ LH_REMOTE_ACCESS_CODE: CODE, LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined }, () => {
		const page = proxy(new NextRequest(origin + "/chat/new"));
		assert.equal(page.headers.get("x-middleware-rewrite"), origin + "/pair");
		for (const method of ["GET", "POST", "PUT", "DELETE"]) {
			assert.equal(proxy(new NextRequest(origin + "/api/settings", { method })).status, 401);
		}
		assert.equal(proxy(new NextRequest(origin + "/api/events")).status, 401, "SSE too");
		assert.equal(proxy(new NextRequest(origin + "/pair")).headers.get("x-middleware-next"), "1", "the pair page is the way in");
		const cookie = `${REMOTE_COOKIE}=${remoteCookieValue(CODE)}`;
		assert.equal(proxy(new NextRequest(origin + "/chat/new", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(new NextRequest(origin + "/api/settings", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
		const wrong = `${REMOTE_COOKIE}=${remoteCookieValue("AAAA-BBBB-CCCC-DDDD-EEEE")}`;
		assert.equal(proxy(new NextRequest(origin + "/api/settings", { headers: { cookie: wrong } })).status, 401);
	});
});

test("pair route: right code sets an HttpOnly cookie and goes home; wrong code shows the form again", async () => {
	await withEnv({ LH_REMOTE_ACCESS_CODE: CODE }, async () => {
		const ok = pairGET(new Request(`${origin}/pair?code=${encodeURIComponent(CODE.toLowerCase())}`));
		assert.equal(ok.status, 303);
		assert.equal(ok.headers.get("location"), "/");
		const setCookie = ok.headers.get("set-cookie") ?? "";
		assert(setCookie.startsWith(`${REMOTE_COOKIE}=${remoteCookieValue(CODE)};`));
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /SameSite=Lax/);
		assert.doesNotMatch(setCookie, /Secure/, "plain-http LAN pairing must still store the cookie");

		const https = pairGET(new Request(`${origin}/pair?code=${CODE}`, { headers: { "x-forwarded-proto": "https" } }));
		assert.match(https.headers.get("set-cookie") ?? "", /Secure/);

		const wrong = pairGET(new Request(`${origin}/pair?code=AAAA-BBBB-CCCC-DDDD-EEEE`));
		assert.equal(wrong.status, 200, "Android's WebView swaps HTTP error pages for its own");
		assert.equal(wrong.headers.get("set-cookie"), null);
		assert.match(await wrong.text(), /did not match/);

		const form = pairGET(new Request(`${origin}/pair`));
		assert.equal(form.status, 200);
		assert.match(await form.text(), /<form method="post" action="\/pair">/);

		const posted = await pairPOST(new Request(`${origin}/pair`, { method: "POST", body: new URLSearchParams({ code: CODE }) }));
		assert.equal(posted.status, 303);
		assert(posted.headers.get("set-cookie"));
	});
});

test("pair route outside remote mode just goes home", async () => {
	await withEnv({ LH_REMOTE_ACCESS_CODE: undefined }, () => {
		const res = pairGET(new Request(`${origin}/pair?code=${CODE}`));
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("set-cookie"), null);
	});
});
