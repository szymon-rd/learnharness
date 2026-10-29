/*
 * Connect flow for the LearnHarness Android app.
 *
 * The app is a WebView. Its own pages (this folder) only collect the server
 * address + access code; then the WebView navigates to
 * <server>/pair?code=<code>, the server sets its pairing cookie and
 * redirects to the LearnHarness home page.
 *
 * - First screen of each app launch: if a server is saved, connect straight
 *   away. Coming back here later (Android back button) shows the form, so
 *   the user can change the server.
 * - The native ServerLink plugin is told the server origin, so links to it
 *   stay inside the app and every other link opens in the phone's browser.
 * - If the phone's WebView is older than LearnHarness needs, this screen
 *   says so (with a Play Store link) instead of connecting automatically.
 */
(function () {
	"use strict";

	var STORAGE_KEY = "lh.server";
	var AUTO_KEY = "lh.autoConnected";

	function load() {
		try {
			var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
			if (saved && typeof saved.url === "string" && typeof saved.code === "string") return saved;
		} catch (e) {
			/* corrupt storage: treat as empty */
		}
		return null;
	}

	function save(server) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
		} catch (e) {
			/* storage unavailable: the app still connects this time */
		}
	}

	/** Adds a scheme when missing and returns the origin, or null.
	 *  "lh.example.com" → "https://lh.example.com" (a VPS behind Caddy);
	 *  "192.168.1.20:3210", "localhost:3210" → "http://…" (npm run phone). */
	function normalizeUrl(raw) {
		var text = String(raw || "").trim();
		if (!text) return null;
		if (!/^https?:\/\//i.test(text)) {
			var host = text.split("/")[0];
			var plain = /:\d+$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^localhost$/i.test(host);
			text = (plain ? "http://" : "https://") + text;
		}
		try {
			var url = new URL(text);
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			if (!url.hostname) return null;
			return url.origin;
		} catch (e) {
			return null;
		}
	}

	/** Next.js 16 pages need Chrome 111 or newer. Android updates its
	 *  WebView through the Play Store, but a phone that never did can
	 *  still have an older one. Returns its major version when too old. */
	var MIN_WEBVIEW = 111;
	function outdatedWebView() {
		var match = /Chrome\/(\d+)/.exec(navigator.userAgent || "");
		var major = match ? parseInt(match[1], 10) : 0;
		return major && major < MIN_WEBVIEW ? major : 0;
	}

	function normalizeCode(raw) {
		return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
	}

	function tellNative(origin) {
		var cap = window.Capacitor;
		if (!cap || typeof cap.nativePromise !== "function") return Promise.resolve();
		return cap.nativePromise("ServerLink", "setServer", { url: origin }).catch(function () {
			/* older app build without the plugin: links still work, external ones stay in-app */
		});
	}

	function connect(server) {
		return tellNative(server.url).then(function () {
			window.location.href = server.url + "/pair?code=" + encodeURIComponent(server.code);
		});
	}

	function initConnectPage() {
		var saved = load();
		var editing = /[?&]edit\b/.test(window.location.search);
		var alreadyAuto = false;
		try {
			alreadyAuto = sessionStorage.getItem(AUTO_KEY) === "1";
			sessionStorage.setItem(AUTO_KEY, "1");
		} catch (e) {
			/* no sessionStorage: always show the form after the first connect */
		}

		// An outdated WebView stays on this screen, so the update notice is
		// seen; Connect still works.
		var outdated = outdatedWebView();
		if (saved && !editing && !alreadyAuto && !outdated) {
			connect(saved);
			return;
		}
		if (outdated) {
			document.getElementById("webview-version").textContent = String(outdated);
			document.getElementById("outdated").hidden = false;
		}

		var main = document.getElementById("connect");
		var form = document.getElementById("form");
		var urlInput = document.getElementById("url");
		var codeInput = document.getElementById("code");
		var error = document.getElementById("error");
		if (saved) {
			urlInput.value = saved.url;
			codeInput.value = saved.code;
		}
		main.hidden = false;

		form.addEventListener("submit", function (event) {
			event.preventDefault();
			var url = normalizeUrl(urlInput.value);
			var code = normalizeCode(codeInput.value);
			if (!url) {
				error.textContent = "Enter the server address, for example https://lh.example.com";
				error.hidden = false;
				urlInput.focus();
				return;
			}
			if (code.replace(/-/g, "").length < 16) {
				error.textContent = "Enter the full access code (20 letters and digits).";
				error.hidden = false;
				codeInput.focus();
				return;
			}
			error.hidden = true;
			var server = { url: url, code: code };
			save(server);
			connect(server);
		});
	}

	function initErrorPage() {
		var saved = load();
		if (saved) document.getElementById("server").textContent = saved.url;
		document.getElementById("retry").addEventListener("click", function () {
			if (saved) connect(saved);
			else window.location.href = "index.html?edit";
		});
		document.getElementById("change").addEventListener("click", function () {
			window.location.href = "index.html?edit";
		});
	}

	window.LH = { initConnectPage: initConnectPage, initErrorPage: initErrorPage, normalizeUrl: normalizeUrl, outdatedWebView: outdatedWebView };
})();
