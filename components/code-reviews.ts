"use client";

/**
 * The tutor's reviews of code-cell answers (tla_review, cpp_review), keyed by
 * the exercise's tool call id. The transcript provides them; each answered
 * card reads its own (a rejected review overrules the machine check's pass).
 */
import { createContext } from "react";

export interface CodeReviewView {
	accepted: boolean;
	reason: string;
}

export const CodeReviewsContext = createContext<ReadonlyMap<string, CodeReviewView>>(new Map());

const REVIEW_PARTS = new Set(["tool-tla_review", "tool-cpp_review"]);

/** Collect the reviews from the transcript's UI parts. */
export function collectCodeReviews(messages: readonly { parts?: readonly unknown[] }[]): Map<string, CodeReviewView> {
	const out = new Map<string, CodeReviewView>();
	for (const m of messages) {
		for (const p of m.parts ?? []) {
			const part = p as { type?: string; state?: string; output?: { ok?: unknown; exerciseCallId?: unknown; accepted?: unknown; reason?: unknown } };
			if (!REVIEW_PARTS.has(part.type ?? "") || part.state !== "output-available") continue;
			const o = part.output;
			if (o?.ok === true && typeof o.exerciseCallId === "string" && typeof o.accepted === "boolean") {
				out.set(o.exerciseCallId, { accepted: o.accepted, reason: typeof o.reason === "string" ? o.reason : "" });
			}
		}
	}
	return out;
}

/** True when two review maps hold the same reviews (keeps the context value
 *  stable across stream renders). */
export function sameCodeReviews(a: ReadonlyMap<string, CodeReviewView>, b: ReadonlyMap<string, CodeReviewView>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) {
		const w = b.get(k);
		if (!w || w.accepted !== v.accepted || w.reason !== v.reason) return false;
	}
	return true;
}
