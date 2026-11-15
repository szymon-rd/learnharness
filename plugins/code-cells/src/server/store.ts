/**
 * Plugin-owned JSON files in the plugin's data directory: the per-language
 * settings, the verified-exercise hashes behind code_cell_verify, and the
 * teacher's reviews. Writes are atomic (temp file + rename).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LANGUAGES, type Language } from "../contract.ts";

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

export function writeJson(directory: string, name: string, value: unknown): void {
	fs.mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
		fs.renameSync(temporary, path.join(directory, name));
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

// ─── settings ───────────────────────────────────────────────────────────

/** Per-language toggles; a language also needs its checker service. */
export type Settings = { revision: number } & Record<Language, boolean>;
export const DEFAULT_SETTINGS: Settings = { revision: 0, lean: true, tla: true, cpp: true, rocq: true };

export function parseSettings(value: unknown): Settings {
	const v = value as Partial<Record<string, unknown>> | null;
	if (!v || typeof v !== "object") return { ...DEFAULT_SETTINGS };
	const out: Settings = { ...DEFAULT_SETTINGS };
	if (typeof v.revision === "number" && Number.isSafeInteger(v.revision) && v.revision >= 0) out.revision = v.revision;
	for (const l of LANGUAGES) if (typeof v[l] === "boolean") out[l] = v[l] as boolean;
	return out;
}

// ─── verified exercises ─────────────────────────────────────────────────

const MAX_VERIFIED = 1000;

/** Stable JSON: object keys sorted, so equal payloads hash equally. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** The identity of an exercise for code_cell_verify: everything the check
 *  depends on (learnerAsked is pacing, not content). */
export function exerciseHash(language: Language, payload: Record<string, unknown>): string {
	const { learnerAsked: _ignored, ...content } = payload;
	return createHash("sha256").update(`${language}\n${stable(content)}`).digest("hex");
}

export class VerifiedStore {
	private hashes: string[];
	constructor(private readonly directory: string) {
		const saved = readJson<unknown>(path.join(directory, "verified.json"), []);
		this.hashes = Array.isArray(saved) ? saved.filter((h): h is string => typeof h === "string") : [];
	}
	has(hash: string): boolean {
		return this.hashes.includes(hash);
	}
	add(hash: string): void {
		this.hashes = [...this.hashes.filter((h) => h !== hash), hash].slice(-MAX_VERIFIED);
		writeJson(this.directory, "verified.json", this.hashes);
	}
}

// ─── reviews ────────────────────────────────────────────────────────────

export interface Review {
	accepted: boolean;
	reason?: string;
	at: string;
}

export class ReviewStore {
	private reviews: Record<string, Review>;
	constructor(private readonly directory: string) {
		const saved = readJson<unknown>(path.join(directory, "reviews.json"), {});
		this.reviews = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, Review>) : {};
	}
	get(questionId: string): Review | null {
		return Object.hasOwn(this.reviews, questionId) ? this.reviews[questionId]! : null;
	}
	set(questionId: string, review: Review): void {
		this.reviews = { ...this.reviews, [questionId]: review };
		writeJson(this.directory, "reviews.json", this.reviews);
	}
}
