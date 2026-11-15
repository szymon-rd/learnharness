/**
 * The code-cells frontend: the per-language settings rows, the editors in
 * the host's question/practice docks, and the answered/submitted bodies.
 * Renderers are registered for every language regardless of the settings,
 * so saved sessions always render. The cells themselves (React +
 * CodeMirror) load on first use (ui/mount.tsx).
 */
import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import { LABEL, LANGUAGES, REVIEWED, SERVICE_ENV, type Language } from "./contract.ts";
import { setLiveCheck } from "./ui/live.ts";
import type { Review } from "./ui/views.tsx";

type Payload = Record<string, unknown>;
type SettingsView = { settings: { revision: number } & Record<Language, boolean>; available: Record<Language, boolean> };

const load = () => import("./ui/mount.tsx");

export function activate(ctx: PluginFrontendContext): () => void {
	const cleanups: (() => void)[] = [];
	setLiveCheck((request) => ctx.call("live-check", request));
	cleanups.push(() => setLiveCheck(null));

	// Review notifications: answered cards refresh their review.
	const reviewListeners = new Set<() => void>();
	cleanups.push(
		ctx.onNotification((event) => {
			if (event.topic === "review") reviewListeners.forEach((listener) => listener());
		}),
	);
	const subscribeReviews = (listener: () => void) => {
		reviewListeners.add(listener);
		return () => reviewListeners.delete(listener);
	};

	for (const language of LANGUAGES) {
		const reviewed = REVIEWED.includes(language);
		cleanups.push(
			ctx.registerQuestionRenderer({
				id: language,
				supportedContractVersions: [1],
				mountAnswerEditor: async (container, props) =>
					(await load()).mountEditor(container, {
						language,
						chatId: props.chatId,
						id: props.questionId,
						question: props.input.question,
						payload: props.input.payload as Payload,
						value: props.answer,
						active: props.active,
						signal: props.signal,
						publish: (state) => props.onChange(state),
					}),
				async mountAnswered(container, props) {
					const views = await load();
					if (props.signal.aborted) return;
					const loadReview = () => (reviewed ? ctx.call<Review | null>("review", { questionId: props.questionId }) : Promise.resolve(null));
					return views.mountAnswered(
						language,
						{ container, headerContainer: props.headerContainer, signal: props.signal, answer: props.answer, grading: props.grading, payload: props.input.payload as Payload },
						loadReview,
						subscribeReviews,
					);
				},
			}),
			ctx.registerProblemRenderer({
				id: language,
				supportedContractVersions: [1],
				async mountSubmissionEditor(container, props) {
					const handle = (await load()).mountEditor(container, {
						language,
						chatId: props.chatId,
						id: props.problemId,
						question: props.input.statement,
						payload: props.input.payload as Payload,
						value: props.submission,
						active: props.active,
						signal: props.signal,
						publish: (state) => props.onChange(state),
					});
					return { ...handle, update: (next) => handle.update({ answer: next.submission, active: next.active }) };
				},
				async mountSubmitted(container, props) {
					const views = await load();
					if (props.signal.aborted) return;
					return views.mountSubmitted(language, { container, headerContainer: props.headerContainer, signal: props.signal, submission: props.submission, processing: props.processing });
				},
			}),
		);
	}

	// ─── settings: one toggle per language ──────────────────────────────
	let current: SettingsView | null = null;
	let registration: PluginWidgetHandle<PluginSettingsSchema> | undefined;
	const rows = (v: SettingsView): PluginSettingsSchema["rows"] =>
		LANGUAGES.map((language) => ({
			key: language,
			type: "toggle" as const,
			label: `${LABEL[language]} code cells`,
			description: v.available[language] ? undefined : `This server has no ${LABEL[language]} checker (${SERVICE_ENV[language]} is not set).`,
			value: v.settings[language] && v.available[language],
			disabled: !v.available[language],
			async onChange(enabled: boolean) {
				apply(await ctx.call<SettingsView>("set-language", { language, enabled }));
			},
		}));
	const apply = (v: SettingsView) => {
		if (ctx.signal.aborted || (current && v.settings.revision < current.settings.revision)) return;
		current = v;
		if (registration) registration.update({ rows: rows(v) });
		else registration = ctx.registerSettings({ rows: rows(v) });
	};
	cleanups.push(
		ctx.onNotification((event) => {
			if (event.topic === "settings-changed") apply(event.data as SettingsView);
		}),
	);
	const refresh = () => void ctx.call<SettingsView>("get-settings").then(apply, (error) => console.error("Code cells: could not read the settings.", error));
	cleanups.push(ctx.onResync(refresh));
	refresh();
	cleanups.push(() => registration?.dispose());

	return () => cleanups.splice(0).reverse().forEach((dispose) => dispose());
}
