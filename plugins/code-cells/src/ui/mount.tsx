/**
 * The React/CodeMirror half of the frontend, loaded on first use so the
 * plugin's entry stays small (main.tsx registers the renderers eagerly).
 */
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorKey } from "learnharness-plugin-api";
import { referenceOf, type Language } from "../contract.ts";
import { AnsweredBody, Editor, readGraded, starterOf, useReview, VerdictBadge, type Review } from "./views.tsx";

type Payload = Record<string, unknown>;

export interface EditorMount {
	language: Language;
	chatId: string;
	id: string;
	question: string;
	payload: Payload;
	value: PluginQuestionAnswerState;
	active: boolean;
	signal: AbortSignal;
	publish: (state: PluginQuestionAnswerState) => void;
}

/** One cell in a host editor slot, with the host editor handle. */
export function mountEditor(container: HTMLElement, m: EditorMount): PluginQuestionEditorHandle {
	let view: EditorView | null = null;
	let active = m.active;
	let disposed = false;
	const initial = m.value.status === "empty" ? starterOf(m.language, m.question, m.payload) : String(m.value.value);
	const publish = (code: string) => {
		if (!disposed && !m.signal.aborted) m.publish({ status: "ready", value: code });
	};
	const root: Root = createRoot(container);
	flushSync(() => root.render(<Editor language={m.language} chatId={m.chatId} id={m.id} question={m.question} payload={m.payload} initial={initial} onCode={publish} onView={(v) => (view = v)} />));
	publish(initial);
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		m.signal.removeEventListener("abort", dispose);
		root.unmount();
	};
	if (m.signal.aborted) dispose();
	else m.signal.addEventListener("abort", dispose, { once: true });
	return {
		update(next) {
			active = next.active;
		},
		focus() {
			if (!disposed && active) view?.focus();
		},
		handleKeyDown(key: PluginQuestionEditorKey) {
			if (disposed || !active || !view || !view.hasFocus) return "pass";
			if (key === "Tab") {
				if (completionStatus(view.state) === "active") acceptCompletion(view);
				else indentMore(view);
				return "handled";
			}
			if (key === "Enter" || key === "Shift+Enter") {
				if (key === "Enter" && completionStatus(view.state) === "active") acceptCompletion(view);
				else insertNewlineAndIndent(view);
				return "handled";
			}
			return "pass";
		},
		dispose,
	};
}

/** A React body in a host slot, unmounted with the slot's signal. */
function mountBody(container: HTMLElement, signal: AbortSignal, node: ReactNode): () => void {
	const root = createRoot(container);
	root.render(node);
	let done = false;
	const dispose = () => {
		if (done) return;
		done = true;
		signal.removeEventListener("abort", dispose);
		root.unmount();
	};
	if (signal.aborted) dispose();
	else signal.addEventListener("abort", dispose, { once: true });
	return dispose;
}

type Outcome = { result: unknown } | { error: string } | undefined;

/** An answered teaching cell: body and header chip, refreshed on reviews. */
export function mountAnswered(
	language: Language,
	props: { container: HTMLElement; headerContainer?: HTMLElement; signal: AbortSignal; answer: unknown; grading: Outcome; payload: Payload },
	loadReview: () => Promise<Review | null>,
	subscribeReviews: (listener: () => void) => () => void,
): () => void {
	const graded = readGraded(props.grading);
	const Body = ({ header }: { header: boolean }) => {
		const review = useReview(loadReview, subscribeReviews);
		return header ? (
			<VerdictBadge graded={graded} review={review} />
		) : (
			<AnsweredBody language={language} code={String(props.answer)} graded={graded} review={review} reference={referenceOf(language, props.payload)} />
		);
	};
	const disposers = [mountBody(props.container, props.signal, <Body header={false} />)];
	if (props.headerContainer) disposers.push(mountBody(props.headerContainer, props.signal, <Body header />));
	return () => disposers.forEach((dispose) => dispose());
}

/** A submitted practice cell (no reference: practice reveals it at conclude). */
export function mountSubmitted(language: Language, props: { container: HTMLElement; headerContainer?: HTMLElement; signal: AbortSignal; submission: unknown; processing: Outcome }): () => void {
	const graded = readGraded(props.processing);
	const disposers = [mountBody(props.container, props.signal, <AnsweredBody language={language} code={String(props.submission)} graded={graded} review={null} />)];
	if (props.headerContainer) disposers.push(mountBody(props.headerContainer, props.signal, <VerdictBadge graded={graded} review={null} />));
	return () => disposers.forEach((dispose) => dispose());
}
