/**
 * The code-cells backend: for every enabled language (its toggle on AND its
 * checker service configured) a teaching question type and a practice
 * problem type, graded by the checker; the code_cell_verify tool behind the
 * pose-time reference check; code_cell_review for TLA+/C++ passes; and the
 * frontend's call handlers (settings, live checks, reviews).
 */
import path from "node:path";
import { Type } from "typebox";
import type { JsonValue, PluginBackendContext } from "learnharness-plugin-api";
import {
	ANSWER_SCHEMA,
	CONTRACT_VERSION,
	instructions,
	isLanguage,
	LABEL,
	LANGUAGES,
	PAYLOAD_SCHEMA,
	PROBLEM_TOOL,
	problemDescription,
	QUESTION_TOOL,
	questionDescription,
	REVIEW_DESCRIPTION,
	REVIEW_TOOL,
	REVIEWED,
	VERIFY_DESCRIPTION,
	VERIFY_TOOL,
	type Language,
} from "./contract.ts";
import { checkersFrom, exerciseProblems, type Checkers, gradeSubmission, liveCheck, referenceProblems } from "./server/grade.ts";
import { exerciseHash, parseSettings, readJson, ReviewStore, VerifiedStore, writeJson, type Settings } from "./server/store.ts";
import { latestAnsweredCodeCell, previousProblemWasCodeCell, previousQuestionWasCodeCell, savedExercise } from "./server/session.ts";

type Payload = Record<string, unknown>;

/** Plain JSON for the host (verdicts carry no undefined/functions). */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }] };
}
function refused(tool: string, problems: string[]) {
	return { ...text(`Invalid tool input for tool "${tool}":\n${problems.map((p) => `- ${p}`).join("\n")}`), isError: true, details: { tool, problems } };
}

export function activate(ctx: PluginBackendContext): () => void {
	return activateWith(ctx, checkersFrom());
}

/** activate() with explicit checkers (the tests pass fakes). */
export function activateWith(ctx: PluginBackendContext, checkers: Checkers): () => void {
	const available = Object.fromEntries(LANGUAGES.map((l) => [l, checkers[l] !== null])) as Record<Language, boolean>;
	const settingsFile = path.join(ctx.dataDirectory, "settings.json");
	let settings: Settings = parseSettings(readJson(settingsFile, null));
	const verified = new VerifiedStore(ctx.dataDirectory);
	const reviews = new ReviewStore(ctx.dataDirectory);
	const enabled = () => LANGUAGES.filter((l) => settings[l] && available[l]);
	const assertActive = () => {
		if (ctx.signal.aborted) throw new Error("Code cells is disabled.");
	};
	const session = (chatId: string): unknown => {
		try {
			return ctx.learning.getSession(chatId);
		} catch {
			return null;
		}
	};

	/** The pose-time checks shared by questions and problems. */
	const poseProblems = (language: Language, chatId: string, question: string, payload: Payload, kind: "question" | "problem"): string[] | undefined => {
		const problems = exerciseProblems(language, question, payload);
		if (!verified.has(exerciseHash(language, payload))) {
			problems.push(`This payload has not been verified. Run ${VERIFY_TOOL} with language "${language}" and this exact payload first.`);
		}
		const record = session(chatId);
		const previous = kind === "question" ? previousQuestionWasCodeCell(record) : previousProblemWasCodeCell(record);
		if (previous && payload.learnerAsked !== true) {
			problems.push(
				kind === "question"
					? "The previous question was already a code cell. Mix them in: pose a different check first, unless the learner asked for another exercise (then set payload.learnerAsked: true)."
					: "The previous problem was already a code problem. Mix them in: pose a different problem first, unless the learner asked for another (then set payload.learnerAsked: true).",
			);
		}
		return problems.length ? problems : undefined;
	};

	// ─── per-language registrations (follow the settings) ───────────────
	const registered: (() => void)[] = [];
	const register = () => {
		registered.splice(0).forEach((dispose) => dispose());
		const languages = enabled();
		for (const language of languages) {
			const payloadSchema = PAYLOAD_SCHEMA[language];
			registered.push(
				ctx.registerQuestionType({
					id: language,
					label: `${LABEL[language]} code cell`,
					contractVersion: CONTRACT_VERSION,
					showThinking: true,
					questionSchema: payloadSchema,
					answerSchema: ANSWER_SCHEMA,
					teach: { toolName: QUESTION_TOOL[language], description: questionDescription(language) },
					validateQuestion: (c) => poseProblems(language, c.chatId, c.input.question, c.input.payload as Payload, "question"),
					gradeAnswer: (c) => gradeSubmission(language, c.input.question, c.input.payload as Payload, c.answer as string, checkers, "exercise").then(json),
				}),
				ctx.registerProblemType({
					id: language,
					label: `${LABEL[language]} problem`,
					contractVersion: CONTRACT_VERSION,
					tool: { toolName: PROBLEM_TOOL[language], description: problemDescription(language) },
					problemSchema: payloadSchema,
					submissionSchema: ANSWER_SCHEMA,
					validateProblem: (c) => poseProblems(language, c.chatId, c.input.statement, c.input.payload as Payload, "problem"),
					processSubmission: (c) => gradeSubmission(language, c.input.statement, c.input.payload as Payload, c.submission as string, checkers, "practice").then(json),
				}),
				ctx.registerInstructions({ agents: ["teacher", "practice"], text: instructions(language) }),
			);
		}
		if (languages.length === 0) return;
		registered.push(
			ctx.registerTools({
				agents: ["teacher", "practice"],
				create: () => [
					{
						name: VERIFY_TOOL,
						label: "Verify code cell",
						description: VERIFY_DESCRIPTION,
						parameters: Type.Object({
							language: Type.Union(languages.map((l) => Type.Literal(l)), { description: "The code cell's language." }),
							question: Type.String({ description: "The task text you will pose with it (the question, or the problem statement)." }),
							payload: Type.Record(Type.String(), Type.Unknown(), { description: `Exactly the payload you will pose (${languages.map((l) => `${QUESTION_TOOL[l]}/${PROBLEM_TOOL[l]}`).join(", ")}).` }),
						}),
						execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
							const input = params as { language: string; question: string; payload: Payload };
							if (signal?.aborted || ctx.signal.aborted) throw new Error("Operation aborted");
							const language = input.language;
							if (!isLanguage(language) || !languages.includes(language)) return refused(VERIFY_TOOL, [`language must be one of ${languages.join(", ")}.`]);
							const problems = exerciseProblems(language, input.question, input.payload);
							if (problems.length) return refused(VERIFY_TOOL, problems);
							let failures: string[];
							try {
								failures = await referenceProblems(language, input.payload, checkers);
							} catch (err) {
								return refused(VERIFY_TOOL, [`${LABEL[language]} is unavailable right now (${(err as Error).message}). Use another kind of check instead.`]);
							}
							if (failures.length) return refused(VERIFY_TOOL, failures);
							verified.add(exerciseHash(language, input.payload));
							return { ...text(`Verified: the reference passes. Pose it now with the identical payload (${QUESTION_TOOL[language]} or ${PROBLEM_TOOL[language]}).`), details: { language, verified: true } };
						},
					},
				],
			}),
		);
		const reviewed = languages.filter((l) => REVIEWED.includes(l));
		if (reviewed.length === 0) return;
		registered.push(
			ctx.registerTools({
				agents: ["teacher"],
				create: (context) => [
					{
						name: REVIEW_TOOL,
						label: "Review code cell",
						description: REVIEW_DESCRIPTION,
						parameters: Type.Object({
							accepted: Type.Boolean({ description: "true: the solution does what the task asked; false: it passes the checks without doing so." }),
							reason: Type.Optional(Type.String({ description: "One or two sentences; required when accepted is false." })),
						}),
						execute: async (_toolCallId: string, params: unknown) => {
							const input = params as { accepted: boolean; reason?: string };
							const latest = latestAnsweredCodeCell(session(context.chatId));
							if (!latest || !REVIEWED.includes(latest.language) || !latest.passed) {
								return refused(REVIEW_TOOL, ["There is no TLA+ or C++ answer that passed the checker to review (the newest code-cell answer must be one)."]);
							}
							if (!input.accepted && !input.reason?.trim()) return refused(REVIEW_TOOL, ["Give the reason when accepted is false."]);
							reviews.set(latest.questionId, { accepted: input.accepted, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}), at: new Date().toISOString() });
							ctx.events.emit("review", { questionId: latest.questionId });
							return { ...text(input.accepted ? "Recorded: accepted." : "Recorded: not accepted."), details: { questionId: latest.questionId, accepted: input.accepted } };
						},
					},
				],
			}),
		);
	};
	register();

	// ─── frontend call bridge ───────────────────────────────────────────
	const view = () => ({ settings: { ...settings }, available: { ...available } });
	const handlers = [
		ctx.handle("get-settings", () => {
			assertActive();
			return view();
		}),
		ctx.handle("set-language", (input) => {
			assertActive();
			const { language, enabled: on } = (input ?? {}) as { language?: unknown; enabled?: unknown };
			if (!isLanguage(language) || typeof on !== "boolean") throw new Error("Expected {language, enabled}.");
			if (settings[language] !== on) {
				const next = { ...settings, revision: settings.revision + 1, [language]: on };
				writeJson(ctx.dataDirectory, "settings.json", next);
				settings = next;
				register();
				ctx.events.emit("settings-changed", view());
			}
			return view();
		}),
		ctx.handle("live-check", async (input) => {
			assertActive();
			const { chatId, id, code, mode } = (input ?? {}) as { chatId?: unknown; id?: unknown; code?: unknown; mode?: unknown };
			if (typeof chatId !== "string" || typeof id !== "string" || typeof code !== "string" || typeof mode !== "string") throw new Error("Expected {chatId, id, code, mode}.");
			const exercise = savedExercise(session(chatId), id);
			if (!exercise || (exercise.language !== "tla" && exercise.language !== "cpp")) throw new Error("No TLA+ or C++ code cell with that id in this session.");
			return liveCheck(exercise.language, exercise.payload, code, mode, checkers);
		}),
		ctx.handle("review", (input) => {
			assertActive();
			const questionId = (input as { questionId?: unknown } | null)?.questionId;
			if (typeof questionId !== "string") throw new Error("Expected {questionId}.");
			return reviews.get(questionId);
		}),
	];

	return () => {
		handlers.forEach((dispose) => dispose());
		registered.splice(0).forEach((dispose) => dispose());
	};
}
