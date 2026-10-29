/**
 * The scripted model for end-to-end tests (see server.mjs). One pi-ai faux
 * provider registered as "openrouter" with the model ids the golden test
 * settings name. Every request goes through respond(), which decides what
 * a plausible model would say from the request itself.
 */
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

export function respond(context) {
	const last = context.messages.at(-1);
	const said = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "").slice(0, 200);
	return fauxAssistantMessage([fauxText(`Scripted reply to: ${said.slice(0, 120)}`)]);
}

export function createScriptedProviders() {
	const faux = fauxProvider({
		provider: "openrouter",
		models: [
			{ id: "deepseek/deepseek-v4.1-flash", reasoning: true, contextWindow: 128000, maxTokens: 8192 },
			{ id: "qwen/qwen3.8-max-0902", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 8192 },
		],
		tokensPerSecond: 600,
	});
	// The faux queue is consumed one response per request; keep it topped up
	// with the same responder so any number of requests is answered.
	const step = (context) => {
		faux.appendResponses([step]);
		return respond(context);
	};
	faux.setResponses([step]);
	return [faux.provider];
}
