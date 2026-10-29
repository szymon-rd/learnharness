"use client";

import { useRef } from "react";

/**
 * Two-finger pinch tracking for the pointer-driven pan/zoom overlays (the
 * plan popup, the diagram focus) — phone adaptation, 2026-10-29. Those
 * viewports are `touch-none` (the browser's own pinch would zoom the whole
 * page), so without this a touch screen could only use the ± buttons.
 *
 * The overlay's own pointer handlers call these first: `down`/`move`/`up`
 * return true while a pinch owns the gesture, and the one-finger drag
 * stays exactly as it was. A mouse never produces two pointers, so the
 * desktop path never enters the pinch branch.
 */
type Point = { x: number; y: number };

export function usePinchGesture(onPinch: (factor: number, focus: Point, shift: Point) => void) {
	const pointers = useRef(new Map<number, Point>());
	const last = useRef<{ dist: number; mid: Point } | null>(null);
	const onPinchRef = useRef(onPinch);
	onPinchRef.current = onPinch;

	const measure = (el: HTMLElement) => {
		const [a, b] = [...pointers.current.values()];
		if (!a || !b) return null;
		const rect = el.getBoundingClientRect();
		return {
			dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
		};
	};

	return {
		/** True: a second finger landed — the pinch owns the gesture now. */
		down(e: React.PointerEvent<HTMLElement>): boolean {
			if (e.pointerType !== "touch") return false;
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.current.size < 2) return false;
			last.current = measure(e.currentTarget);
			e.currentTarget.setPointerCapture(e.pointerId);
			return true;
		},
		move(e: React.PointerEvent<HTMLElement>): boolean {
			if (!pointers.current.has(e.pointerId)) return false;
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const prev = last.current;
			if (!prev) return false;
			const next = measure(e.currentTarget);
			if (!next) return true;
			onPinchRef.current(next.dist / prev.dist, next.mid, { x: next.mid.x - prev.mid.x, y: next.mid.y - prev.mid.y });
			last.current = next;
			return true;
		},
		/** True when this lift ended a pinch. */
		up(e: React.PointerEvent<HTMLElement>): boolean {
			pointers.current.delete(e.pointerId);
			if (last.current && pointers.current.size < 2) {
				last.current = null;
				return true;
			}
			return false;
		},
	};
}
