import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement } from "../components/menu-shell.tsx";
import { pinchedGraphView, zoomedGraphView } from "../components/pan-zoom.ts";

/**
 * Phone adaptation (2026-10-29) — the pure geometry behind two touch
 * fixes: menus clamped inside a narrow viewport, and the two-finger pinch
 * step of the pointer-driven pan/zoom overlays. The desktop guarantee is
 * pinned too: a menu that already fits places exactly as before.
 */

const phone = { width: 412, height: 915 };

describe("computeMenuPlacement — horizontal clamp", () => {
	it("leaves a fitting menu exactly where the aligned edge puts it (desktop path)", () => {
		const rect = { top: 400, bottom: 440, left: 900, right: 1100 };
		const withWidth = computeMenuPlacement(rect, { width: 1280, height: 800 }, 300, "down", "right", 352);
		const without = computeMenuPlacement(rect, { width: 1280, height: 800 }, 300, "down", "right");
		assert.deepEqual(withWidth, without);
		assert.equal(withWidth.style.right, 180);
	});

	it("right-aligned: a menu wider than the room left of its anchor pins to the left edge", () => {
		const p = computeMenuPlacement({ top: 700, bottom: 740, left: 200, right: 300 }, phone, 300, "up", "right", 352);
		assert.deepEqual(p.style, { left: 8, bottom: phone.height - 700 + 4 });
	});

	it("left-aligned: a menu running past the right edge slides back inside", () => {
		const p = computeMenuPlacement({ top: 100, bottom: 140, left: 200, right: 300 }, phone, 300, "down", "left", 352);
		assert.equal(p.style.left, phone.width - 8 - 352);
	});

	it("never slides past the left edge when the menu is wider than the viewport", () => {
		const p = computeMenuPlacement({ top: 100, bottom: 140, left: 200, right: 300 }, { width: 300, height: 900 }, 300, "down", "left", 352);
		assert.equal(p.style.left, 8);
	});
});

describe("pinchedGraphView", () => {
	const box = { w: 1000, h: 1000 };
	const vp = { w: 400, h: 400 };
	const floor = 0.384;

	it("zooms about the fingers' midpoint, then follows its travel", () => {
		const view = { zoom: 1, x: 0, y: 0 };
		const focus = { x: 200, y: 200 };
		const zoomed = zoomedGraphView(view, 2, floor, focus, box, vp);
		const pinched = pinchedGraphView(view, 2, focus, { x: 10, y: -5 }, floor, box, vp);
		assert.deepEqual(pinched, { zoom: 2, x: zoomed.x + 10, y: zoomed.y - 5 });
	});

	it("at the floor the view is the fit — the two-finger travel never pans it", () => {
		const view = { zoom: 0.5, x: 0, y: 0 };
		const pinched = pinchedGraphView(view, 0.1, { x: 200, y: 200 }, { x: 30, y: 30 }, floor, box, vp);
		assert.equal(pinched.zoom, floor);
		assert.deepEqual(pinched, zoomedGraphView(view, 0.1, floor, { x: 200, y: 200 }, box, vp));
	});
});
