"use client";

import { useEffect, useState } from "react";

/**
 * Phone-only layout helpers (owner, 2026-11-01 declutter round): the slim
 * bottom row, the collapsed "Your thinking" chips, and hiding the row while
 * the on-screen keyboard is up. Desktop keeps its layout, so everything here
 * answers false outside phone widths.
 */

/** Tailwind's `max-sm` (below 40rem). */
const PHONE_QUERY = "(max-width: 39.99rem)";

/** True at phone widths. False during SSR and the first paint. */
export function useIsPhone(): boolean {
	const [phone, setPhone] = useState(false);
	useEffect(() => {
		// Test DOMs (and very old WebViews) have no matchMedia: not a phone.
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(PHONE_QUERY);
		const update = () => setPhone(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);
	return phone;
}

/** An element that brings up the on-screen keyboard when focused. */
function isTypingSurface(el: Element | null): boolean {
	if (!el) return false;
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement) return !["range", "checkbox", "radio", "button", "submit"].includes(el.type);
	return (el as HTMLElement).isContentEditable === true;
}

/**
 * Whether the on-screen keyboard is (very likely) open: a phone with a
 * touch screen and a focused typing surface — the composer, a thinking
 * field, or the Lean editor (CodeMirror is contenteditable). Focus is the
 * reliable signal in both the Android WebView and phone browsers, where
 * viewport-resize heuristics differ.
 */
export function useSoftKeyboardOpen(): boolean {
	const phone = useIsPhone();
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!phone || typeof window.matchMedia !== "function" || !window.matchMedia("(pointer: coarse)").matches) {
			setOpen(false);
			return;
		}
		const update = () => setOpen(isTypingSurface(document.activeElement));
		// Opening is immediate; closing waits a beat. Tapping a button
		// (Submit) moves focus to it on mousedown, and re-showing the row
		// then would shift the dock under the finger before the click lands.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onFocusIn = () => {
			clearTimeout(timer);
			if (isTypingSurface(document.activeElement)) setOpen(true);
			else timer = setTimeout(update, 400);
		};
		const onFocusOut = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 400);
		};
		update();
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
		};
	}, [phone]);
	return open;
}
