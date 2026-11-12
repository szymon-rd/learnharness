/**
 * The scripted model for end-to-end tests (see server.mjs): a deterministic
 * stand-in for every LLM the app calls, so the real UI can be driven
 * through a whole learning flow without a model API.
 *
 * One pi-ai faux provider, registered as "openrouter" with the model ids
 * the golden test settings name. Every request goes through respond():
 * detectRole() reads the request (the leading system message carries the
 * system prompt and the tool declarations — pi's TranscriptContext; the
 * factory's context has no separate `tools`), and one function per role
 * decides what a plausible model would say from the transcript alone. No
 * hidden state: the same transcript always gets the same reply (tool-call
 * ids are hashes of the request), so a reloaded or retried turn replays
 * identically.
 *
 * Roles and their scripts:
 *   prober     probe (multiple choice) → ask_user_question (goal) →
 *              probe (the "I don't know" one) → probe_done → handoff line.
 *              With the free-recall mechanics armed it asks `recall`
 *              instead of the first probe.
 *   teacher    plan_init → first explanation + research/visual/demo
 *              dispatch → predict quiz → explanation + check quiz → ask
 *              (how to continue) → wrap-up. Steers (job results), learner
 *              messages and queued steers are acknowledged in the next
 *              reply. A learner message containing "in detail" gets a long
 *              (~8 s) streamed explanation — the abort/reload/offline
 *              tests use it.
 *   practice   problem → (thinking trace) conclude → closing words →
 *              [NEXT PROBLEM] → problem → … ; "wrap up" ends the set.
 *   extractor  submit_findings anchored to the batch's TEACHER [id]s.
 *   auditor    submit_review with no links (every finding is a new node).
 *   researcher a fixed brief (no web tools — the test runs offline).
 *   visual     write_svg → render_svg → notes.
 *   demo       write_demo → run_demo → notes (needs a Chrome; the job
 *              fails gracefully without one).
 *   pdf reader a short "could not read" brief.
 *   summarizer the compaction summary.
 *
 * Streaming runs at a realistic speed (TOKENS_PER_SECOND) so the UI's
 * streaming states — spinners, partial markdown, queued steers, the
 * abort control — are on screen long enough to be exercised.
 */
import { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export const TOKENS_PER_SECOND = 220;

// ─── transcript helpers ─────────────────────────────────────────────────────

/** The leading system message (prompt + tool declarations). */
function systemOf(context) {
	return context.messages.find((m) => m.role === "system");
}

function systemText(context) {
	const sys = systemOf(context);
	if (!sys) return "";
	return typeof sys.content === "string" ? sys.content : sys.content.map((c) => c.text ?? "").join("\n");
}

/** Every tool declared anywhere in the transcript's system messages. */
function toolNames(context) {
	const names = new Set();
	for (const m of context.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) names.add(t.name);
		for (const t of m.toolsRemoved ?? []) names.delete(t.name);
	}
	return names;
}

/** The conversation without system messages. */
function conversation(context) {
	return context.messages.filter((m) => m.role !== "system");
}

function textOf(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function toolCallsOf(messages) {
	const out = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const c of m.content) if (c.type === "toolCall") out.push(c);
	}
	return out;
}

function resultFor(messages, callId) {
	return messages.find((m) => m.role === "toolResult" && m.toolCallId === callId);
}

/** The messages after the last assistant message: what this call answers. */
function trailing(messages) {
	let i = messages.length - 1;
	while (i >= 0 && messages[i].role !== "assistant") i--;
	return messages.slice(i + 1);
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** FNV-1a — deterministic ids from the request itself. */
function hash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic tool calls: the id hashes the request + the call slot.
 *  User-message timestamps join the seed, so two sessions that happen to
 *  say the same things still get distinct ids (jobs dedupe by call id),
 *  while a replay of one transcript reproduces its ids exactly. */
function caller(context, role) {
	const msgs = conversation(context);
	const seed = `${role}|${msgs.length}|${msgs.map((m) => `${m.role}:${m.role === "user" ? m.timestamp : ""}:${textOf(m).slice(0, 200)}`).join("|")}`;
	let n = 0;
	return (name, args) => fauxToolCall(name, args, { id: `call_${hash(`${seed}|${name}|${n++}`)}${hash(seed)}` });
}

const reply = (blocks) => fauxAssistantMessage(blocks, { stopReason: blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop" });

// Steers and learner input, as the model sees them (core/contracts texts).
const HANDOFF = "Next: plan the full teaching arc";
const NEXT_PROBLEM = "[NEXT PROBLEM]";
const THINKING = "Your thinking:";

function isSteer(text) {
	return /^(Research complete|Research aborted|PDF reading|The demo|The figure|The PDF|Demo failed|Research failed|Visual failed|PDF failed)/.test(text) || /job was aborted by the learner/.test(text);
}

// ─── role detection ─────────────────────────────────────────────────────────

export function detectRole(context) {
	const tools = toolNames(context);
	const system = systemText(context);
	if (tools.has("probe_done")) return "prober";
	if (tools.has("plan_init")) return "teacher";
	if (tools.has("problem") && tools.has("conclude")) return "practice";
	if (tools.has("submit_findings")) return "extractor";
	if (tools.has("submit_review")) return "auditor";
	if (tools.has("write_svg")) return "visual";
	if (tools.has("write_demo")) return "demo";
	if (system.startsWith("You are a research specialist")) return "researcher";
	if (system.startsWith("You are a PDF reading specialist")) return "pdf";
	if (system.includes("session-compaction summarizer")) return "summarizer";
	return "unknown";
}

export function respond(context) {
	const role = detectRole(context);
	const script = SCRIPTS[role] ?? unknownRole;
	return script(context, caller(context, role));
}

// ─── the lesson content (always Bayes' rule — the e2e topic) ─────────────────

const PLAN_MERMAID = [
	"graph TD",
	"  joint[Joint probability] --> conditional[Conditional probability]",
	"  conditional --> product[Product rule]",
	"  product --> bayes[Bayes' rule]",
	"  base[Base rates matter] --> bayes",
	"  bayes --> update[Updating on evidence]",
].join("\n");

const EXPLAIN_CONDITIONAL = [
	"## Conditioning shrinks the world",
	"",
	"Start from something you already accept: a probability is a share of all the ways things can go. **Conditioning on $B$** throws away every outcome where $B$ failed and re-measures what is left:",
	"",
	"$$",
	"P(A \\mid B) = \\frac{P(A \\cap B)}{P(B)}",
	"$$",
	"",
	"Nothing new was assumed — the formula is just *share of the remaining world*. Two consequences follow immediately:",
	"",
	"1. $P(A \\mid B)$ and $P(B \\mid A)$ divide **the same overlap** by **different totals**, so they are generally different numbers.",
	"2. Multiplying back gives the product rule, $P(A \\cap B) = P(A \\mid B)\\,P(B)$ — the overlap can be computed from either side.",
	"",
	"I've sent off a short research brief, a figure and an interactive demo for this; they'll land in the lesson as they finish.",
].join("\n");

const EXPLAIN_BAYES = [
	"## Bayes' rule is the product rule read twice",
	"",
	"Write the overlap from both sides and set the two equal:",
	"",
	"$$",
	"P(H \\mid E)\\,P(E) = P(E \\mid H)\\,P(H) \\quad\\Longrightarrow\\quad P(H \\mid E) = \\frac{P(E \\mid H)\\,P(H)}{P(E)}",
	"$$",
	"",
	"| Piece | Name | What it measures, in plain words |",
	"|---|---|---|",
	"| $P(H)$ | prior | how common the hypothesis is before the evidence |",
	"| $P(E \\mid H)$ | likelihood | how expected the evidence is if $H$ holds |",
	"| $P(E)$ | evidence | how common the evidence is overall |",
	"",
	"The prior is the piece people drop. A test that is 99% sensitive still leaves most positives false when the condition is rare — the **base rate** sets how much room the evidence has to move into.",
	"",
	"```mermaid",
	"graph LR",
	'  prior["Prior P(H)"] --> posterior["Posterior P(H|E)"]',
	'  likelihood["Likelihood P(E|H)"] --> posterior',
	'  evidence["Evidence P(E)"] --> posterior',
	"```",
	"",
	"The whole rule fits in a few lines of code:",
	"",
	"```python",
	"def posterior(prior, likelihood, evidence_rate_if_not_h):",
	"    evidence = likelihood * prior + evidence_rate_if_not_h * (1 - prior)  # total probability of the evidence",
	"    return likelihood * prior / evidence",
	"```",
].join("\n");

function longExplanation() {
	const paragraph = (i) =>
		`**Step ${i}.** Take a population of 10,000 people and a condition with a base rate of 1%. That is 100 people with the condition and 9,900 without. ` +
		`A test with 99% sensitivity flags 99 of the 100; with a 5% false-positive rate it also flags 495 of the 9,900. ` +
		`Among the 594 positives only 99 actually have the condition, so $P(H \\mid E) = 99/594 \\approx 0.17$ — the evidence raised the belief from 0.01 to 0.17, a seventeen-fold update that still leaves the hypothesis unlikely. ` +
		`Every number here is the product rule applied to counts: the overlap divided by the total that survived the conditioning.`;
	return ["## The same idea, slowly and in detail", "", ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1) + "\n")].join("\n");
}

// Question bodies (shapes copied from the golden fixture's real calls).
const PROBE_FIRST = {
	question: "A fair die is rolled. Given that the result is **even**, what is the probability that it is a **6**?",
	details: "One correct option. Attach your reasoning in the thinking field if you want it read.",
	options: [
		{ label: "$1/3$", value: "third" },
		{ label: "$1/6$", value: "sixth" },
		{ label: "$1/2$", value: "half" },
	],
	explanation: "Conditioning on *even* leaves three equally likely outcomes, $\\{2, 4, 6\\}$, and one of them is a 6: $P(6 \\mid \\text{even}) = \\frac{1/6}{1/2} = \\frac{1}{3}$.",
	correctAnswer: "third",
};

const RECALL_FIRST = {
	question: "In your own words: what does it mean to **condition** on an event $B$?",
	details: "Free recall — write it in your own words, reasoning included.",
	correctAnswer: "Conditioning on $B$ restricts attention to the outcomes where $B$ happened and re-measures probabilities as shares of that smaller world: $P(A \\mid B) = P(A \\cap B)/P(B)$.",
};

const ASK_GOAL = {
	question: "What do you want to be able to do by the end?",
	details: "Not graded — this sets the lesson's goal.",
	options: [
		{ label: "Solve medical-test style problems", value: "tests" },
		{ label: "Understand where the formula comes from", value: "derive" },
		{ label: "Both", value: "both" },
	],
};

const PROBE_SECOND = {
	question: "A test for a rare condition (1 in 1,000) is 99% accurate. You test positive. Roughly how likely is it that you have the condition?",
	details: "If you have no idea, \"I don't know\" is an honest answer — it tells me where to start.",
	options: [
		{ label: "About 99%", value: "p99" },
		{ label: "About 50%", value: "p50" },
		{ label: "About 9%", value: "p9" },
	],
	explanation: "Out of 100,000 people, 100 have it and 99 test positive; of the 99,900 without it, 999 test positive. So $99/(99+999) \\approx 9\\%$.",
	correctAnswer: "p9",
};

const QUIZ_PREDICT = {
	type: "predict",
	nodeId: "bayes",
	question: "Before the next step: if $P(A \\mid B) = 0.9$, what can you say about $P(B \\mid A)$?",
	details: "Prediction — answer before the teaching. A wrong attempt is as useful as a right one.",
	options: [
		{ label: "It is also $0.9$", value: "same" },
		{ label: "Nothing yet — it depends on $P(A)$ and $P(B)$", value: "depends" },
		{ label: "It is $0.1$", value: "complement" },
	],
	explanation: "Both divide the same overlap $P(A \\cap B)$, but by different totals — $P(B)$ versus $P(A)$ — so without those totals nothing follows.",
	correctAnswer: "depends",
};

const QUIZ_CHECK = {
	type: "check",
	nodeId: "base",
	question: "A disease has prior $P(H) = 0.01$. A test has $P(E \\mid H) = 0.9$ and $P(E) = 0.05$. What is $P(H \\mid E)$?",
	details: "Applied check — compute it.",
	options: [
		{ label: "$0.18$", value: "p18" },
		{ label: "$0.90$", value: "p90" },
		{ label: "$0.05$", value: "p05" },
		{ label: "$0.01$", value: "p01" },
	],
	explanation: "$P(H \\mid E) = \\frac{0.9 \\times 0.01}{0.05} = 0.18$. The likelihood alone ($0.90$) ignores how rare the disease is.",
	correctAnswer: "p18",
};

const EXPLAIN_CHECK = {
	type: "check",
	nodeId: "base",
	question: "Why can a positive result from a very accurate test still leave the hypothesis unlikely?",
	correctAnswer: "Because the posterior scales with the prior: when the base rate is tiny, false positives from the large negative population outnumber the true positives, so $P(H \\mid E)$ stays small even with a high likelihood.",
};

const ASK_CONTINUE = {
	question: "How do you want to continue?",
	options: [
		{ label: "Wrap up with a summary", value: "wrap" },
		{ label: "One more worked example", value: "example" },
	],
};

// ─── prober ─────────────────────────────────────────────────────────────────

function prober(context, call) {
	const msgs = conversation(context);
	const tools = toolNames(context);
	const calls = toolCallsOf(msgs);
	const last = msgs.at(-1);
	if (last?.role === "toolResult" && last.toolName === "probe_done") {
		return reply([fauxText("That's the assessment — handing over to the lesson plan now.")]);
	}
	const asked = calls.filter((c) => ["probe", "recall", "ask_user_question"].includes(c.name) && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const ack = acknowledge(trailing(msgs));
	const firstQuestion = tools.has("recall") && !tools.has("probe") ? call("recall", RECALL_FIRST) : call("probe", PROBE_FIRST);
	switch (asked.length) {
		case 0:
			return reply([
				fauxThinking("Start at the floor: conditioning on a simple, countable event."),
				fauxText(`Let's find where your footing is. First, a quick one on conditioning.`),
				firstQuestion,
			]);
		case 1:
			return reply([fauxText(`${ack}${verdictLine(msgs, asked[0])} Now, so I aim the lesson right:`), call("ask_user_question", ASK_GOAL)]);
		case 2:
			return reply([
				fauxThinking("Goal set. One ceiling probe: base-rate neglect."),
				fauxText(`${ack}Good — that sets the goal. One more, nearer the edge:`),
				tools.has("probe") ? call("probe", PROBE_SECOND) : call("recall", { ...RECALL_FIRST, question: "Why does a rare condition make a positive test less convincing?" }),
			]);
		default:
			return reply([
				fauxText(`${ack}${verdictLine(msgs, asked.at(-1))} That brackets it.`),
				call("probe_done", {
					assessment: {
						strands: [
							{ strand: "Conditional probability", assessment: "FLOOR: restricts to the conditioning event correctly on a countable example. BUILD FROM: the ratio definition." },
							{ strand: "Base rates in Bayesian updating", assessment: "CEILING: base-rate neglect is likely — the rare-condition test question did not land. Teach the prior explicitly." },
						],
						summary: "Solid on conditioning; the lesson should enter at the product rule and build Bayes' rule with base rates front and centre.",
					},
				}),
			]);
	}
}

/** One line reading the learner's answer back (the question tools' JSON). */
function verdictLine(msgs, questionCall) {
	const answer = parseJson(textOf(resultFor(msgs, questionCall?.id) ?? {})) ?? {};
	if (answer.dismissed) return "Skipped — fine.";
	if (answer.dontKnow) return "\"I don't know\" is an honest gap, not a wrong answer — noted.";
	if (answer.kind === "ask") return "Noted.";
	if (answer.kind === "explain") return "Read against my committed answer: the core is there.";
	if (answer.correct === true) return `Correct${answer.confidence !== undefined ? ` (confidence ${answer.confidence})` : ""}.`;
	if (answer.correct === false) return "Not quite — that's useful, it shows where to build.";
	return "Got it.";
}

/** Acknowledge steers and learner messages that arrived since our last reply. */
function acknowledge(messages) {
	const lines = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = textOf(m).trim();
		if (!text || text.startsWith(HANDOFF) || text.startsWith(NEXT_PROBLEM) || text.startsWith(THINKING)) continue;
		if (text.startsWith("Research complete")) lines.push("The research brief is in: the base-rate effect is well documented, and I'll cite it where it matters.");
		else if (/^The demo .* is built/.test(text)) lines.push("The demo is ready — try moving the prior and watch the posterior.");
		else if (text.startsWith("The figure is drawn")) lines.push("The figure is in: it shows the overlap divided by two different totals.");
		else if (/could not be built|failed|FAILED/.test(text) && isSteer(text)) lines.push("One of the background jobs failed, so I'll teach that part in prose.");
		else if (/aborted/.test(text) && isSteer(text)) lines.push("Understood — that job was stopped.");
		else lines.push(`You said: “${text.slice(0, 80)}” — noted, I'll fold that in.`);
	}
	return lines.length ? lines.join(" ") + "\n\n" : "";
}

// ─── teacher ────────────────────────────────────────────────────────────────

function teacher(context, call) {
	const msgs = conversation(context);
	const tools = toolNames(context);
	const handoffAt = msgs.findLastIndex((m) => m.role === "user" && textOf(m).startsWith(HANDOFF));
	const teach = msgs.slice(handoffAt + 1);
	if (tools.has("lean_exercise") && aboutLean(msgs)) return leanTeacher(context, call, msgs, teach, acknowledge(trailing(msgs)));
	if (tools.has("tla_exercise") && aboutTla(msgs)) return tlaTeacher(context, call, msgs, teach, acknowledge(trailing(msgs)));
	if (tools.has("cpp_exercise") && aboutCpp(msgs)) return cppTeacher(context, call, msgs, teach, acknowledge(trailing(msgs)));
	if (tools.has("rocq_exercise") && aboutRocq(msgs)) return rocqTeacher(context, call, msgs, teach, acknowledge(trailing(msgs)));
	const calls = toolCallsOf(teach);
	const done = (name) => calls.some((c) => c.name === name && resultFor(teach, c.id) && !resultFor(teach, c.id).isError);
	const questions = calls.filter((c) => ["quiz", "explain", "ask_user_question"].includes(c.name));
	const answered = questions.filter((c) => {
		const r = resultFor(teach, c.id);
		return r && !r.isError && !textOf(r).startsWith("The question was interrupted");
	});
	const tail = trailing(msgs);
	const ack = acknowledge(tail);
	const learnerAsked = tail.filter((m) => m.role === "user" && !isSteer(textOf(m)) && !textOf(m).startsWith(HANDOFF)).map((m) => textOf(m));
	const last = msgs.at(-1);
	const checkTool = tools.has("quiz") ? call("quiz", QUIZ_CHECK) : call("explain", EXPLAIN_CHECK);

	// A learner asking for detail gets the long explanation (abort/reload tests).
	if (learnerAsked.some((t) => /in detail/i.test(t))) {
		return reply([fauxThinking("Slow down and work the numbers through."), fauxText(longExplanation())]);
	}
	if (!done("plan_init")) {
		return reply([
			fauxThinking("Root the plan at what he holds (conditioning) and build to Bayes' rule with the base rate as its own node."),
			fauxText(`${ack}Here's the route: from the share-of-the-world reading of probability to Bayes' rule, with base rates as their own stop because that is where the probe found the gap.`),
			call("plan_init", { mermaid: PLAN_MERMAID }),
		]);
	}
	if (!calls.some((c) => ["research", "visual", "demo"].includes(c.name))) {
		const jobs = [];
		if (tools.has("research")) jobs.push(call("research", { question: "What does the research literature say about base-rate neglect in medical test interpretation?", context: "Teaching Bayes' rule; I need two citable findings." }));
		if (tools.has("visual")) jobs.push(call("visual", { brief: "One SVG, one idea: two overlapping circles A and B; shade the overlap and show P(A|B) as overlap/B and P(B|A) as overlap/A. Canvas 600x300, white background." }));
		if (tools.has("demo")) jobs.push(call("demo", { title: "Base-rate slider", brief: "A single-file demo: sliders for prior, sensitivity and false-positive rate; show the posterior P(H|E) live with a 1000-dot icon array." }));
		return reply([fauxText(`${ack}${EXPLAIN_CONDITIONAL}`), ...jobs]);
	}
	if (questions.length === 0) {
		return reply([fauxText(`${ack}While those run, a prediction before the next step.`), tools.has("quiz") ? call("quiz", QUIZ_PREDICT) : call("explain", { ...EXPLAIN_CHECK, type: "predict", nodeId: "bayes" })]);
	}
	if (answered.length === 1 && questions.length === 1) {
		return reply([fauxText(`${ack}${verdictLine(teach, answered[0])}\n\n${EXPLAIN_BAYES}\n\nNow check it with numbers:`), checkTool]);
	}
	if (answered.length === 2 && questions.length === 2) {
		return reply([fauxText(`${ack}${verdictLine(teach, answered[1])} That's the core of the plan covered.`), call("ask_user_question", ASK_CONTINUE)]);
	}
	if (answered.length === 3 && questions.length === 3 && last?.role === "toolResult") {
		return reply([
			fauxText(
				`${ack}## Summary\n\n- Conditioning re-measures probability inside the event you condition on.\n- The product rule writes the overlap from either side; setting the two equal **is** Bayes' rule.\n- The prior (base rate) decides how far evidence can move a belief.\n\nThat completes the plan. Ask me anything, or say *in detail* for a slower pass.`,
			),
		]);
	}
	// Anything else: steers, learner messages, wakes — acknowledge only.
	return reply([fauxText(ack.trim() || "Noted.")]);
}

// ─── practice ───────────────────────────────────────────────────────────────

const PROBLEMS = [
	{
		statement: "A bag holds 3 red and 2 blue marbles. You draw two **without replacement**. Given that the first is red, what is the probability that the second is red?",
		mode: "recall",
		modelSolution: "After a red is drawn, 2 red and 2 blue remain, so $P(\\text{second red} \\mid \\text{first red}) = 2/4 = 1/2$.",
	},
	{
		statement: "1% of emails are spam. A filter flags 95% of spam and 2% of legitimate mail. An email is flagged. What is the probability it is spam?",
		mode: "composition",
		modelSolution: "$P(S \\mid F) = \\frac{0.95 \\times 0.01}{0.95 \\times 0.01 + 0.02 \\times 0.99} = \\frac{0.0095}{0.0293} \\approx 0.32$.",
	},
	{
		statement: "Show that $P(A \\mid B) = P(B \\mid A)$ exactly when $P(A) = P(B)$ (assume both are positive).",
		mode: "discrimination",
		modelSolution: "Both equal $P(A \\cap B)$ divided by $P(B)$ and $P(A)$ respectively, so they are equal iff the denominators are.",
	},
];

function practice(context, call) {
	const msgs = conversation(context);
	if (toolDeclaration(context, "problem").includes('"lean"') && aboutLean(msgs)) return leanPractice(context, call, msgs);
	if (toolDeclaration(context, "problem").includes('"tla"') && aboutTla(msgs)) return tlaPractice(context, call, msgs);
	if (toolDeclaration(context, "problem").includes('"cpp"') && aboutCpp(msgs)) return cppPractice(context, call, msgs);
	if (toolDeclaration(context, "problem").includes('"rocq"') && aboutRocq(msgs)) return rocqPractice(context, call, msgs);
	const calls = toolCallsOf(msgs);
	const posed = calls.filter((c) => c.name === "problem" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const concluded = calls.filter((c) => c.name === "conclude" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const active = posed.length > concluded.length;
	const last = msgs.at(-1);
	const tail = trailing(msgs);
	const tailText = tail.map((m) => textOf(m)).join("\n");

	if (last?.role === "toolResult" && last.toolName === "conclude") {
		return reply([fauxText("That's the committed solution above. Press **Next problem** when you're ready, or ask about this one.")]);
	}
	if (active && tailText.includes(THINKING)) {
		const answer = tailText.slice(tailText.lastIndexOf(THINKING) + THINKING.length).trim();
		const solved = /1\/2|0\.5|half|0\.32|32%|denominator/i.test(answer);
		return reply([
			fauxThinking("Read the trace against the committed solution."),
			call("conclude", {
				outcome: solved ? "solved" : "movedOn",
				verdict: solved ? "Correct: the conditioning step is right and the arithmetic follows." : "The setup is there, but the conditioning step was skipped — the denominator should be the reduced world.",
				rung: null,
				missClass: solved ? null : "execution",
				retest: !solved,
			}),
		]);
	}
	if (!active && (posed.length === 0 || tailText.includes(NEXT_PROBLEM))) {
		const next = PROBLEMS[posed.length % PROBLEMS.length];
		return reply([
			fauxThinking("Pose the next problem; commit the solution first."),
			fauxText(posed.length === 0 ? "One warm-up to calibrate, then we run." : "Next one — a notch up."),
			call("problem", next),
		]);
	}
	if (!active && /\b(wrap up|done|end)\b/i.test(tailText)) {
		return reply([fauxText(`That's the set: ${concluded.length} problem${concluded.length === 1 ? "" : "s"} worked. Conditioning was solid; keep an eye on the base rate in composed problems.`)]);
	}
	return reply([fauxText(active ? "Keep going — write your working in the thinking field and submit when you have an answer." : "Ask away, or press **Next problem** to continue.")]);
}

// ─── extraction ─────────────────────────────────────────────────────────────

const EXTRACTED = [
	{ name: "Conditional probability", statement: "The conditional probability of A given B is the probability of A and B together divided by the probability of B." },
	{ name: "Product rule", statement: "The probability of A and B together equals the probability of A given B times the probability of B." },
	{ name: "Bayes' rule", statement: "The probability of a hypothesis given evidence equals the likelihood of the evidence under the hypothesis times the prior, divided by the probability of the evidence." },
	{ name: "Base-rate effect", statement: "When a hypothesis is rare, even highly likely evidence leaves its posterior probability low, because the prior scales the posterior." },
];

function extractor(context, call) {
	const msgs = conversation(context);
	const prompt = textOf(msgs.find((m) => m.role === "user"));
	const ids = [...prompt.matchAll(/TEACHER \[([^\]]+)\]/g)].map((m) => m[1]);
	const last = msgs.at(-1);
	if (last?.role === "toolResult" && last.toolName === "submit_findings" && !last.isError) {
		return reply([fauxText("Submitted.")]);
	}
	if (ids.length === 0) {
		return reply([call("submit_findings", { propositions: [], chains: [] })]);
	}
	// Only ideas the digest doesn't already hold (THE GRAPH SO FAR).
	const fresh = EXTRACTED.filter((p) => !prompt.includes(` | ${p.name} | `));
	const propositions = fresh.map((p, i) => ({ id: `p${i + 1}`, ...p, messageId: ids[Math.min(i, ids.length - 1)] }));
	const chains = [];
	for (let i = 1; i < propositions.length; i++) chains.push({ premises: [propositions[i - 1].id], conclusion: propositions[i].id });
	return reply([fauxThinking("Core ideas, foundations first."), call("submit_findings", { propositions, chains })]);
}

function auditor(context, call) {
	const last = conversation(context).at(-1);
	if (last?.role === "toolResult" && last.toolName === "submit_review" && !last.isError) {
		return reply([fauxText("Reviewed.")]);
	}
	return reply([call("submit_review", { links: [] })]);
}

// ─── background jobs ────────────────────────────────────────────────────────

function researcher() {
	return reply([
		fauxText(
			"## Summary\nBase-rate neglect is robust: people judge a positive result from an accurate test as near-certain even when the condition is rare.\n\n" +
				"## Findings\n1. **Physicians overestimate post-test probability** — classic mammography vignettes put the answer near 10% while most respondents say 70–80%. [Source](https://example.org/base-rates)\n" +
				"2. **Natural frequencies help** — restating probabilities as counts out of 1,000 roughly doubles correct answers. [Source](https://example.org/frequencies)\n\n" +
				"## Sources\n- Kept: Example review (https://example.org/base-rates) — direct evidence\n\n## Gaps\nScripted test brief — no live search was run.",
		),
	]);
}

const FIGURE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">' +
	'<rect width="600" height="300" fill="#fff"/>' +
	'<circle cx="250" cy="150" r="100" fill="#4f7cff" fill-opacity="0.25" stroke="#223"/>' +
	'<circle cx="350" cy="150" r="100" fill="#ff9f43" fill-opacity="0.25" stroke="#223"/>' +
	'<text x="190" y="155" font-family="sans-serif" font-size="22" fill="#223">A</text>' +
	'<text x="400" y="155" font-family="sans-serif" font-size="22" fill="#223">B</text>' +
	'<text x="300" y="280" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#223">P(A|B) = overlap / B    P(B|A) = overlap / A</text>' +
	"</svg>";

function visualMaker(context, call) {
	const msgs = conversation(context);
	const calls = toolCallsOf(msgs).map((c) => c.name);
	if (!calls.includes("write_svg")) return reply([fauxThinking("Two circles, one overlap."), call("write_svg", { svg: FIGURE_SVG })]);
	if (!calls.includes("render_svg")) return reply([call("render_svg", {})]);
	return reply([fauxText("Two overlapping circles; the overlap is divided by B's area for P(A|B) and by A's for P(B|A).")]);
}

const DEMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Base rates</title>
<style>body{font-family:sans-serif;margin:16px;background:#fafafa;color:#222}label{display:block;margin:8px 0}#out{font-size:20px;font-weight:600}</style></head>
<body><label>Prior <input id="prior" type="range" min="0.001" max="0.5" step="0.001" value="0.01"> <span id="pv"></span></label>
<label>Sensitivity <input id="sens" type="range" min="0.5" max="1" step="0.01" value="0.9"> <span id="sv"></span></label>
<label>False-positive rate <input id="fpr" type="range" min="0" max="0.3" step="0.005" value="0.05"> <span id="fv"></span></label>
<p>Posterior P(H|E): <span id="out"></span></p>
<script>
const $=(id)=>document.getElementById(id);
function update(){const p=+$("prior").value,s=+$("sens").value,f=+$("fpr").value;
$("pv").textContent=p.toFixed(3);$("sv").textContent=s.toFixed(2);$("fv").textContent=f.toFixed(3);
$("out").textContent=(s*p/(s*p+f*(1-p))).toFixed(3);}
for(const id of ["prior","sens","fpr"])$(id).addEventListener("input",update);update();
</script></body></html>`;

function demoBuilder(context, call) {
	const msgs = conversation(context);
	const calls = toolCallsOf(msgs).map((c) => c.name);
	const last = msgs.at(-1);
	if (!calls.includes("write_demo")) return reply([fauxThinking("Three sliders and a live posterior."), call("write_demo", { html: DEMO_HTML })]);
	if (last?.role === "toolResult" && last.toolName === "write_demo") return reply([call("run_demo", { probe: "document.querySelectorAll('input').length" })]);
	const runResult = textOf(msgs.filter((m) => m.role === "toolResult" && m.toolName === "run_demo").at(-1));
	if (!runResult.startsWith("PASSED")) return reply([fauxText(`The demo could not be verified: ${runResult.slice(0, 200)}`)]);
	return reply([fauxText("Three sliders (prior, sensitivity, false-positive rate) drive a live posterior. Try a prior of 0.001 with a 99% sensitive test.")]);
}

function pdfReader() {
	return reply([fauxText("## Summary\nThe scripted PDF reader does not read files; no content is available.")]);
}

function summarizer() {
	return reply([fauxText("## Session so far\nThe learner was probed on conditioning and base rates, then taught Bayes' rule from the product rule. Quizzes: predict (answered), check (answered).")]);
}

// ─── Lean code cells (tests/e2e/lean-qa.e2e.mjs) ───────────────────────────
//
// Only when code cells are on (the tools carry lean_exercise / the problem
// tool's lean block) AND the learner's topic mentions Lean — the Bayes flow
// above never sees any of this.

/** The JSON of one declared tool, if any (system messages' toolsAdded). */
function toolDeclaration(context, name) {
	let found = null;
	for (const m of context.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) if (t.name === name) found = t;
	}
	return found ? JSON.stringify(found) : "";
}

function aboutLean(msgs) {
	return msgs.some((m) => m.role === "user" && /\bLean\b/.test(textOf(m)) && !textOf(m).startsWith("[Session context]"));
}

const LEAN_PLAN = ["graph TD", "  nat-arith[Arithmetic on ℕ] --> tactics[Tactic proofs]", "  tactics --> mathlib[Mathlib automation]"].join("\n");

const LEAN_EX1 = {
	nodeId: "nat-arith",
	question: "Prove that addition on natural numbers is **commutative**. Hint: `omega` decides linear arithmetic over ℕ — or look for a library lemma such as `Nat.add_comm`.",
	statement: "theorem qa_add_comm (a b : ℕ) : a + b = b + a := by",
	referenceProof: "  omega",
};

const LEAN_EX2 = {
	nodeId: "mathlib",
	question: "Using Mathlib, show that the square of a real number is never negative.",
	statement: "theorem qa_sq_nonneg (x : ℝ) : 0 ≤ x ^ 2 := by",
	referenceProof: "  positivity",
};

const LEAN_QUIZ = {
	type: "check",
	nodeId: "tactics",
	question: "Which tactic is a decision procedure for linear arithmetic over ℕ and ℤ?",
	options: [
		{ label: "`omega`", value: "omega" },
		{ label: "`rfl`", value: "rfl" },
		{ label: "`exact?`", value: "exact" },
	],
	explanation: "`omega` decides linear (in)equalities over ℕ and ℤ; `rfl` only closes goals true by definition.",
	correctAnswer: "omega",
};

function leanVerdict(msgs, c) {
	const a = parseJson(textOf(resultFor(msgs, c.id) ?? {})) ?? {};
	if (a.dismissed) return "Skipped — fine.";
	if (a.correct === true) return "Lean accepts your proof — well done.";
	return `Lean did not accept that proof (${a.verdict ?? "it reports errors"}). Look at the errors in the card; we'll come back to it.`;
}

function leanTeacher(context, call, msgs, teach, ack) {
	const calls = toolCallsOf(teach);
	const ok = (c) => resultFor(teach, c.id) && !resultFor(teach, c.id).isError;
	if (!calls.some((c) => c.name === "plan_init" && ok(c))) {
		return reply([
			fauxText(`${ack}Here's the route: arithmetic on ℕ, then tactic proofs, then Mathlib's automation. You'll write the proofs yourself in Lean cells.`),
			call("plan_init", { mermaid: LEAN_PLAN, codeCells: "lean" }),
		]);
	}
	const lean = calls.filter((c) => c.name === "lean_exercise");
	const quiz = calls.filter((c) => c.name === "quiz");
	if (lean.length === 0) {
		return reply([fauxText(`${ack}## Proofs are programs\n\nIn Lean a theorem is a type and a proof is a term of that type. A tactic block (\`by …\`) builds the term step by step; the **goal** shows what is left to prove.\n\nYour turn:`), call("lean_exercise", LEAN_EX1)]);
	}
	if (lean.length === 1 && ok(lean[0])) {
		// Deliberately a second code cell in a row: the tool must refuse it.
		return reply([fauxText(`${ack}${leanVerdict(teach, lean[0])}\n\nAnother one:`), call("lean_exercise", LEAN_EX2)]);
	}
	if (lean.length === 2 && resultFor(teach, lean[1].id)?.isError && quiz.length === 0) {
		return reply([fauxText("Let's mix in a quick check before the next proof."), call("quiz", LEAN_QUIZ)]);
	}
	if (quiz.length === 1 && ok(quiz[0]) && lean.length === 2) {
		return reply([fauxText(`${ack}${verdictLine(teach, quiz[0])}\n\nNow with Mathlib:`), call("lean_exercise", LEAN_EX2)]);
	}
	if (lean.length === 3 && ok(lean[2])) {
		return reply([fauxText(`${ack}${leanVerdict(teach, lean[2])}\n\n## Summary\n\n- A proof is a term; tactics build it.\n- \`omega\` decides linear arithmetic over ℕ and ℤ.\n- Mathlib's \`positivity\` proves goals of the form \`0 ≤ e\` and \`0 < e\`.`)]);
	}
	return reply([fauxText(ack.trim() || "Noted.")]);
}

const LEAN_PROBLEM = {
	statement: "Prove in Lean that every natural number is smaller than its successor.",
	mode: "recall",
	modelSolution: "`omega` closes it: the goal `n < n + 1` is linear arithmetic over ℕ.",
	lean: { statement: "theorem qa_lt_succ (n : ℕ) : n < n + 1 := by", referenceProof: "  omega" },
};

function leanPractice(context, call, msgs) {
	const ids = [...msgs.map((m) => textOf(m)).join("\n").matchAll(/\[(n_[a-z0-9]+)\]/g)].map((m) => m[1]);
	const calls = toolCallsOf(msgs);
	const problems = calls.filter((c) => c.name === "problem");
	const posed = problems.filter((c) => resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const concluded = calls.filter((c) => c.name === "conclude" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const active = posed.length > concluded.length;
	const last = msgs.at(-1);
	const tailText = trailing(msgs).map((m) => textOf(m)).join("\n");
	const target = ids.length ? { target: [ids[0]] } : {};
	if (last?.role === "toolResult" && last.toolName === "conclude") {
		return reply([fauxText("That's the committed solution above. Press **Next problem** when you're ready.")]);
	}
	if (last?.role === "toolResult" && last.toolName === "problem" && last.isError) {
		// The two-in-a-row guard refused a second Lean problem: pose a plain one.
		return reply([fauxText("A non-Lean one in between, then."), call("problem", { ...PROBLEMS[0], ...target })]);
	}
	if (active && tailText.includes(THINKING)) {
		if (/Lean verdict: passes/.test(tailText)) {
			return reply([call("conclude", { outcome: "solved", verdict: "Lean accepts the proof.", rung: null, missClass: null, retest: false })]);
		}
		if (/Lean verdict: does not pass/.test(tailText)) {
			return reply([fauxText("Lean still reports an error — read it in your submission card. Hint: this goal is linear arithmetic over ℕ.")]);
		}
		return reply([call("conclude", { outcome: "movedOn", verdict: "Read your trace.", rung: null, missClass: null, retest: false })]);
	}
	if (!active && (posed.length === 0 || tailText.includes(NEXT_PROBLEM))) {
		return reply([fauxText(posed.length === 0 ? "A Lean one to start." : "Another Lean one."), call("problem", { ...LEAN_PROBLEM, ...target })]);
	}
	return reply([fauxText(active ? "Edit the proof and submit when Lean accepts it." : "Press **Next problem** to continue.")]);
}

// ─── TLA+ code cells (tests/e2e/tla-qa.e2e.mjs) ────────────────────────────
//
// Only when code cells are on (the tools carry tla_exercise / the problem
// tool's tla block) AND the learner's topic mentions TLA+.

function aboutTla(msgs) {
	return msgs.some((m) => m.role === "user" && /\bTLA\+/.test(textOf(m)) && !textOf(m).startsWith("[Session context]"));
}

const TLA_PLAN = ["graph TD", "  states[States and actions] --> invariants[Invariants]", "  invariants --> pluscal[PlusCal algorithms]"].join("\n");

const TLA_EX1 = {
	nodeId: "states",
	question: "Write `Init` and `Next` so that `x` starts at 0 and counts up by one **until it reaches `N`**, then stops. TLC checks `TypeOK`, and `x = N` must be reachable.",
	head: "---- MODULE QaCounter ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLE x",
	starter: "Init == x = 0\nNext == x' = x + 1",
	tail: "TypeOK == x \\in 0..N\n====",
	config: { constants: { N: "3" }, init: "Init", next: "Next", invariants: ["TypeOK"], checkDeadlock: false },
	witnesses: [{ label: "x reaches N", expression: "x = N" }],
	referenceSolution: "Init == x = 0\nNext == x < N /\\ x' = x + 1",
};

const TLA_EX2 = {
	nodeId: "pluscal",
	question: "Two processes share a critical section (label `cs:`). Using the `lock` variable, write each process's steps so that it **enters the critical section and leaves it**, and the two are never in it at once (`Mutex`).",
	mode: "pluscal",
	head: "---- MODULE QaMutex ----\nEXTENDS Naturals\n(* --algorithm QaMutex\nvariables lock = FALSE;\nprocess proc \\in 1..2\nbegin",
	starter: "  start:\n    skip;",
	tail: "end process;\nend algorithm; *)\n\nMutex == ~(pc[1] = \"cs\" /\\ pc[2] = \"cs\")\n====",
	config: { specification: "Spec", invariants: ["Mutex"] },
	referenceSolution: "  acquire:\n    await ~lock;\n    lock := TRUE;\n  cs:\n    lock := FALSE;",
};

const TLA_QUIZ = {
	type: "check",
	nodeId: "invariants",
	question: "What does TLC report when an invariant fails?",
	options: [
		{ label: "A behavior that reaches a state violating it", value: "trace" },
		{ label: "Only the name of the invariant", value: "name" },
		{ label: "A proof that the invariant is false in every state", value: "proof" },
	],
	explanation: "TLC prints a counterexample: the shortest behavior from an initial state to a state where the invariant is false.",
	correctAnswer: "trace",
};

function tlaAnswer(msgs, c) {
	return parseJson(textOf(resultFor(msgs, c.id) ?? {})) ?? {};
}

function tlaVerdict(msgs, c, reviews) {
	const a = tlaAnswer(msgs, c);
	if (a.dismissed) return "Skipped — fine.";
	const review = reviews.find((r) => r.arguments.exerciseCallId === c.id);
	if (a.correct === true && review && review.arguments.accepted === false) return `TLC passes, but that is not what was asked: ${review.arguments.reason}`;
	if (a.correct === true) return "TLC finds no error, and it does what was asked — well done.";
	return `TLC did not accept that (${a.verdict ?? "it reports errors"}). Look at the card; we'll come back to it.`;
}

function tlaTeacher(context, call, msgs, teach, ack) {
	const calls = toolCallsOf(teach);
	const ok = (c) => resultFor(teach, c.id) && !resultFor(teach, c.id).isError;
	if (!calls.some((c) => c.name === "plan_init" && ok(c))) {
		return reply([
			fauxText(`${ack}Here's the route: states and actions, then invariants, then PlusCal. You'll write the specs yourself in TLA+ cells and check them with TLC.`),
			call("plan_init", { mermaid: TLA_PLAN, codeCells: "tla" }),
		]);
	}
	const ex = calls.filter((c) => c.name === "tla_exercise");
	const reviews = calls.filter((c) => c.name === "tla_review" && ok(c));
	const quiz = calls.filter((c) => c.name === "quiz");
	// A TLC pass is judged first: does it do what was asked?
	for (const c of ex.filter(ok)) {
		const a = tlaAnswer(teach, c);
		if (a.correct !== true || !a.review || reviews.some((r) => r.arguments.exerciseCallId === c.id)) continue;
		const mutex = c.arguments.head?.includes("QaMutex");
		const accepted = !mutex || /\bcs:/.test(a.solution ?? "");
		return reply([
			call("tla_review", {
				exerciseCallId: c.id,
				accepted,
				reason: accepted ? "It models the behavior the task describes." : "It never enters the critical section, so Mutex holds trivially. Write the acquire, cs and release steps.",
			}),
		]);
	}
	if (ex.length === 0) {
		return reply([fauxText(`${ack}## A spec is a state machine\n\n\`Init\` says which states a behavior may start in; \`Next\` relates each state to the next (primed variables are the next state). TLC explores every reachable state and checks the invariants in each.\n\nYour turn:`), call("tla_exercise", TLA_EX1)]);
	}
	if (ex.length === 1 && ok(ex[0])) {
		// Deliberately a second code cell in a row: the tool must refuse it.
		return reply([fauxText(`${ack}${tlaVerdict(teach, ex[0], reviews)}\n\nAnother one:`), call("tla_exercise", TLA_EX2)]);
	}
	if (ex.length === 2 && resultFor(teach, ex[1].id)?.isError && quiz.length === 0) {
		return reply([fauxText("Let's mix in a quick check before the next spec."), call("quiz", TLA_QUIZ)]);
	}
	if (quiz.length === 1 && ok(quiz[0]) && ex.length === 2) {
		return reply([fauxText(`${ack}${verdictLine(teach, quiz[0])}\n\nNow in PlusCal:`), call("tla_exercise", TLA_EX2)]);
	}
	if (ex.length === 3 && ok(ex[2])) {
		return reply([fauxText(`${ack}${tlaVerdict(teach, ex[2], reviews)}\n\n## Summary\n\n- A spec is \`Init\` plus \`Next\`; TLC explores every reachable state.\n- An invariant violation comes with the behavior that reaches it.\n- Passing the checks is not the same as doing what was asked: say what must be reachable.`)]);
	}
	return reply([fauxText(ack.trim() || "Noted.")]);
}

const TLA_PROBLEM = {
	statement: "Write `Init` and `Next` so that `x` starts at `N` and counts **down** to 0, then stops.",
	mode: "recall",
	modelSolution: "Init == x = N; Next == x > 0 /\\ x' = x - 1.",
	tla: {
		head: "---- MODULE QaDown ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLE x",
		starter: "Init == x = N\nNext == x' = x - 1",
		tail: "TypeOK == x \\in 0..N\n====",
		config: { constants: { N: "3" }, init: "Init", next: "Next", invariants: ["TypeOK"], checkDeadlock: false },
		witnesses: [{ label: "x reaches 0", expression: "x = 0" }],
		referenceSolution: "Init == x = N\nNext == x > 0 /\\ x' = x - 1",
	},
};

function tlaPractice(context, call, msgs) {
	const ids = [...msgs.map((m) => textOf(m)).join("\n").matchAll(/\[(n_[a-z0-9]+)\]/g)].map((m) => m[1]);
	const calls = toolCallsOf(msgs);
	const problems = calls.filter((c) => c.name === "problem");
	const posed = problems.filter((c) => resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const concluded = calls.filter((c) => c.name === "conclude" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const active = posed.length > concluded.length;
	const last = msgs.at(-1);
	const tailText = trailing(msgs).map((m) => textOf(m)).join("\n");
	const target = ids.length ? { target: [ids[0]] } : {};
	if (last?.role === "toolResult" && last.toolName === "conclude") {
		return reply([fauxText("That's the committed solution above. Press **Next problem** when you're ready.")]);
	}
	if (last?.role === "toolResult" && last.toolName === "problem" && last.isError) {
		return reply([fauxText("A plain one in between, then."), call("problem", { ...PROBLEMS[0], ...target })]);
	}
	if (active && tailText.includes(THINKING)) {
		if (/TLC verdict: passes/.test(tailText)) {
			return reply([call("conclude", { outcome: "solved", verdict: "TLC finds no error and it counts down as asked.", rung: null, missClass: null, retest: false })]);
		}
		if (/TLC verdict: does not pass/.test(tailText)) {
			return reply([fauxText("TLC still finds a problem — read the counterexample in your submission card. Hint: what should stop the count at 0?")]);
		}
		return reply([call("conclude", { outcome: "movedOn", verdict: "Read your trace.", rung: null, missClass: null, retest: false })]);
	}
	if (!active && (posed.length === 0 || tailText.includes(NEXT_PROBLEM))) {
		return reply([fauxText(posed.length === 0 ? "A TLA+ one to start." : "Another TLA+ one."), call("problem", { ...TLA_PROBLEM, ...target })]);
	}
	return reply([fauxText(active ? "Edit the spec, use Check, and submit when TLC accepts it." : "Press **Next problem** to continue.")]);
}

// ─── C++ code cells (tests/e2e/cpp-qa.e2e.mjs) ─────────────────────────────
//
// Only when code cells are on (the tools carry cpp_exercise / the problem
// tool's cpp block) AND the learner's topic mentions C++.

function aboutCpp(msgs) {
	return msgs.some((m) => m.role === "user" && /\bC\+\+/.test(textOf(m)) && !textOf(m).startsWith("[Session context]"));
}

const CPP_PLAN = ["graph TD", "  loops[Loops over a vector] --> bounds[Index bounds]", "  bounds --> strings[Strings]"].join("\n");

const CPP_EX1 = {
	nodeId: "loops",
	question: "Implement `sum` so it returns the sum of the elements of `v` (0 for an empty vector). The starter has a bug — use **Check** to find it.",
	head: "#include <vector>\n\n// Return the sum of the elements of v.",
	starter: "int sum(const std::vector<int>& v) {\n  int s = 0;\n  for (std::size_t i = 0; i <= v.size(); i++) s += v[i];\n  return s;\n}",
	tests: [
		{ name: "three numbers", code: "CHECK_EQ(sum({1, 2, 3}), 6);" },
		{ name: "empty", code: "CHECK_EQ(sum({}), 0);" },
		{ name: "negatives", code: "CHECK_EQ(sum({-5, 5, -1}), -1);", hidden: true },
	],
	referenceSolution: "int sum(const std::vector<int>& v) {\n  int s = 0;\n  for (int x : v) s += x;\n  return s;\n}",
};

const CPP_EX2 = {
	nodeId: "strings",
	question: "Implement `reversed` so it returns `s` reversed, **with your own loop** (not `std::reverse`).",
	head: "#include <string>\n\n// Return s reversed, using a loop.",
	starter: "std::string reversed(const std::string& s) {\n  return s;\n}",
	tests: [
		{ name: "word", code: 'CHECK_EQ(reversed("abc"), std::string("cba"));' },
		{ name: "empty", code: 'CHECK_EQ(reversed(""), std::string(""));' },
		{ name: "palindrome", code: 'CHECK_EQ(reversed("abba"), std::string("abba"));', hidden: true },
	],
	referenceSolution: "std::string reversed(const std::string& s) {\n  std::string out;\n  for (std::size_t i = s.size(); i > 0; i--) out += s[i - 1];\n  return out;\n}",
};

const CPP_QUIZ = {
	type: "check",
	nodeId: "bounds",
	question: "For a vector `v`, which index is out of bounds?",
	options: [
		{ label: "`v.size()`", value: "size" },
		{ label: "`0` when `v` is not empty", value: "zero" },
		{ label: "`v.size() - 1` when `v` is not empty", value: "last" },
	],
	explanation: "Valid indices are 0 … size()-1; reading v[v.size()] is undefined behavior.",
	correctAnswer: "size",
};

function cppAnswer(msgs, c) {
	return parseJson(textOf(resultFor(msgs, c.id) ?? {})) ?? {};
}

function cppVerdictText(msgs, c, reviews) {
	const a = cppAnswer(msgs, c);
	if (a.dismissed) return "Skipped — fine.";
	const review = reviews.find((r) => r.arguments.exerciseCallId === c.id);
	if (a.correct === true && review && review.arguments.accepted === false) return `The tests pass, but that is not what was asked: ${review.arguments.reason}`;
	if (a.correct === true) return "All tests pass, and it does what was asked — well done.";
	const hidden = (a.failedTests ?? []).filter((t) => t.hidden).map((t) => t.name);
	return `Not yet (${a.verdict ?? "the tests fail"})${hidden.length ? ` — a hidden test failed: ${hidden.join(", ")}` : ""}. Look at the card; we'll come back to it.`;
}

function cppTeacher(context, call, msgs, teach, ack) {
	const calls = toolCallsOf(teach);
	const ok = (c) => resultFor(teach, c.id) && !resultFor(teach, c.id).isError;
	if (!calls.some((c) => c.name === "plan_init" && ok(c))) {
		return reply([
			fauxText(`${ack}Here's the route: loops over a vector, index bounds, then strings. You'll write the code yourself in C++ cells, checked by tests.`),
			call("plan_init", { mermaid: CPP_PLAN, codeCells: "cpp" }),
		]);
	}
	const ex = calls.filter((c) => c.name === "cpp_exercise");
	const reviews = calls.filter((c) => c.name === "cpp_review" && ok(c));
	const quiz = calls.filter((c) => c.name === "quiz");
	// A pass is judged first: does it do what was asked?
	for (const c of ex.filter(ok)) {
		const a = cppAnswer(teach, c);
		if (a.correct !== true || !a.review || reviews.some((r) => r.arguments.exerciseCallId === c.id)) continue;
		const accepted = !/std::reverse|\breverse\s*\(/.test(a.solution ?? "");
		return reply([
			call("cpp_review", {
				exerciseCallId: c.id,
				accepted,
				reason: accepted ? "It does the work itself, as asked." : "It calls std::reverse; the task asked for your own loop.",
			}),
		]);
	}
	if (ex.length === 0) {
		return reply([fauxText(`${ack}## Loops and bounds\n\nA vector of size n has indices 0 … n−1. A range-for (\`for (int x : v)\`) visits each element without any index to get wrong.\n\nYour turn:`), call("cpp_exercise", CPP_EX1)]);
	}
	if (ex.length === 1 && ok(ex[0])) {
		// Deliberately a second code cell in a row: the tool must refuse it.
		return reply([fauxText(`${ack}${cppVerdictText(teach, ex[0], reviews)}\n\nAnother one:`), call("cpp_exercise", CPP_EX2)]);
	}
	if (ex.length === 2 && resultFor(teach, ex[1].id)?.isError && quiz.length === 0) {
		return reply([fauxText("Let's mix in a quick check before the next exercise."), call("quiz", CPP_QUIZ)]);
	}
	if (quiz.length === 1 && ok(quiz[0]) && ex.length === 2) {
		return reply([fauxText(`${ack}${verdictLine(teach, quiz[0])}\n\nNow strings:`), call("cpp_exercise", CPP_EX2)]);
	}
	if (ex.length === 3 && ok(ex[2])) {
		return reply([fauxText(`${ack}${cppVerdictText(teach, ex[2], reviews)}\n\n## Summary\n\n- Indices run from 0 to size()−1; the sanitizers catch the rest.\n- Hidden tests catch solutions fitted to the shown cases.\n- Passing the tests is not the same as doing what was asked.`)]);
	}
	return reply([fauxText(ack.trim() || "Noted.")]);
}

const CPP_PROBLEM = {
	statement: "Implement `largest` so it returns the largest element of a non-empty vector.",
	mode: "recall",
	modelSolution: "Start from v[0], not 0: int m = v[0]; for (int x : v) if (x > m) m = x; return m;",
	cpp: {
		head: "#include <vector>\n\n// Return the largest element of a non-empty vector.",
		starter: "int largest(const std::vector<int>& v) {\n  int m = 0;\n  for (int x : v) if (x > m) m = x;\n  return m;\n}",
		tests: [
			{ name: "mixed", code: "CHECK_EQ(largest({3, 1, 2}), 3);" },
			{ name: "all negative", code: "CHECK_EQ(largest({-5, -2, -9}), -2);", hidden: true },
		],
		referenceSolution: "int largest(const std::vector<int>& v) {\n  int m = v[0];\n  for (int x : v) if (x > m) m = x;\n  return m;\n}",
	},
};

function cppPractice(context, call, msgs) {
	const ids = [...msgs.map((m) => textOf(m)).join("\n").matchAll(/\[(n_[a-z0-9]+)\]/g)].map((m) => m[1]);
	const calls = toolCallsOf(msgs);
	const problems = calls.filter((c) => c.name === "problem");
	const posed = problems.filter((c) => resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const concluded = calls.filter((c) => c.name === "conclude" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const active = posed.length > concluded.length;
	const last = msgs.at(-1);
	const tailText = trailing(msgs).map((m) => textOf(m)).join("\n");
	const target = ids.length ? { target: [ids[0]] } : {};
	if (last?.role === "toolResult" && last.toolName === "conclude") {
		return reply([fauxText("That's the committed solution above. Press **Next problem** when you're ready.")]);
	}
	if (last?.role === "toolResult" && last.toolName === "problem" && last.isError) {
		return reply([fauxText("A plain one in between, then."), call("problem", { ...PROBLEMS[0], ...target })]);
	}
	if (active && tailText.includes(THINKING)) {
		if (/Test verdict: passes/.test(tailText)) {
			return reply([call("conclude", { outcome: "solved", verdict: "Every test passes, and it finds the largest element.", rung: null, missClass: null, retest: false })]);
		}
		if (/Test verdict: does not pass/.test(tailText)) {
			return reply([fauxText("A test still fails — see your submission card. Hint: what if every element is negative?")]);
		}
		return reply([call("conclude", { outcome: "movedOn", verdict: "Read your trace.", rung: null, missClass: null, retest: false })]);
	}
	if (!active && (posed.length === 0 || tailText.includes(NEXT_PROBLEM))) {
		return reply([fauxText(posed.length === 0 ? "A C++ one to start." : "Another C++ one."), call("problem", { ...CPP_PROBLEM, ...target })]);
	}
	return reply([fauxText(active ? "Edit the code, use Check, and submit when the tests pass." : "Press **Next problem** to continue.")]);
}

// ─── Rocq code cells (tests/e2e/rocq-qa.e2e.mjs) ───────────────────────────
//
// Only when code cells are on (the tools carry rocq_exercise / the problem
// tool's rocq block) AND the learner's topic mentions Rocq.

function aboutRocq(msgs) {
	return msgs.some((m) => m.role === "user" && /\bRocq\b/.test(textOf(m)) && !textOf(m).startsWith("[Session context]"));
}

const ROCQ_PLAN = ["graph TD", "  tactics[Tactic proofs] --> sep[Separating conjunction]", "  sep --> ipm[The Iris proof mode]"].join("\n");

const ROCQ_EX1 = {
	nodeId: "tactics",
	question: "Prove that addition on natural numbers is **commutative**. Hint: `lia` decides linear arithmetic.",
	statement: "Lemma qa_add_comm (a b : nat) : a + b = b + a.",
	referenceProof: "Proof.\n  lia.\nQed.",
};

const ROCQ_EX2 = {
	nodeId: "ipm",
	question: "In Iris, prove that separating conjunction `∗` is commutative. Destruct the hypothesis with `iIntros`, then frame.",
	prelude: "From iris.proofmode Require Import proofmode.\nFrom iris.base_logic Require Import iprop.",
	statement: "Lemma qa_sep_comm {Σ} (P Q : iProp Σ) : P ∗ Q ⊢ Q ∗ P.",
	referenceProof: 'Proof.\n  iIntros "[HP HQ]".\n  iFrame.\nQed.',
};

const ROCQ_QUIZ = {
	type: "check",
	nodeId: "sep",
	question: "In separation logic, what does `P ∗ Q` assert?",
	options: [
		{ label: "P and Q hold for disjoint parts of the resources", value: "disjoint" },
		{ label: "P and Q both hold for the same resources", value: "same" },
		{ label: "P implies Q", value: "implies" },
	],
	explanation: "∗ splits the resources: P owns one part and Q a disjoint other part.",
	correctAnswer: "disjoint",
};

function rocqVerdict(msgs, c) {
	const a = parseJson(textOf(resultFor(msgs, c.id) ?? {})) ?? {};
	if (a.dismissed) return "Skipped — fine.";
	if (a.correct === true) return "Rocq accepts your proof — well done.";
	return `Rocq did not accept that proof (${a.verdict ?? "it reports errors"}). Look at the errors in the card; we'll come back to it.`;
}

function rocqTeacher(context, call, msgs, teach, ack) {
	const calls = toolCallsOf(teach);
	const ok = (c) => resultFor(teach, c.id) && !resultFor(teach, c.id).isError;
	if (!calls.some((c) => c.name === "plan_init" && ok(c))) {
		return reply([
			fauxText(`${ack}Here's the route: tactic proofs, the separating conjunction, then the Iris proof mode. You'll write the proofs yourself in Rocq cells.`),
			call("plan_init", { mermaid: ROCQ_PLAN, codeCells: "rocq" }),
		]);
	}
	const ex = calls.filter((c) => c.name === "rocq_exercise");
	const quiz = calls.filter((c) => c.name === "quiz");
	if (ex.length === 0) {
		return reply([fauxText(`${ack}## Proofs as scripts\n\nA proof starts with \`Proof.\`, runs tactics that transform the goal, and ends with \`Qed.\` once no goals remain. The **goals** panel shows what is left.\n\nYour turn:`), call("rocq_exercise", ROCQ_EX1)]);
	}
	if (ex.length === 1 && ok(ex[0])) {
		// Deliberately a second code cell in a row: the tool must refuse it.
		return reply([fauxText(`${ack}${rocqVerdict(teach, ex[0])}\n\nAnother one:`), call("rocq_exercise", ROCQ_EX2)]);
	}
	if (ex.length === 2 && resultFor(teach, ex[1].id)?.isError && quiz.length === 0) {
		return reply([fauxText("Let's mix in a quick check before the Iris proof."), call("quiz", ROCQ_QUIZ)]);
	}
	if (quiz.length === 1 && ok(quiz[0]) && ex.length === 2) {
		return reply([fauxText(`${ack}${verdictLine(teach, quiz[0])}\n\nNow in Iris:`), call("rocq_exercise", ROCQ_EX2)]);
	}
	if (ex.length === 3 && ok(ex[2])) {
		return reply([fauxText(`${ack}${rocqVerdict(teach, ex[2])}\n\n## Summary\n\n- A Rocq proof is a script of tactics between \`Proof.\` and \`Qed.\`.\n- \`lia\` decides linear arithmetic over \`nat\` and \`Z\`.\n- In the Iris proof mode, \`iIntros "[HP HQ]"\` splits \`P ∗ Q\` and \`iFrame\` closes goals from the context.`)]);
	}
	return reply([fauxText(ack.trim() || "Noted.")]);
}

const ROCQ_PROBLEM = {
	statement: "Prove in Rocq that every natural number is smaller than its successor.",
	mode: "recall",
	modelSolution: "`lia` closes it: n < S n is linear arithmetic.",
	rocq: { statement: "Lemma qa_lt_succ (n : nat) : n < S n.", referenceProof: "Proof.\n  lia.\nQed." },
};

function rocqPractice(context, call, msgs) {
	const ids = [...msgs.map((m) => textOf(m)).join("\n").matchAll(/\[(n_[a-z0-9]+)\]/g)].map((m) => m[1]);
	const calls = toolCallsOf(msgs);
	const problems = calls.filter((c) => c.name === "problem");
	const posed = problems.filter((c) => resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const concluded = calls.filter((c) => c.name === "conclude" && resultFor(msgs, c.id) && !resultFor(msgs, c.id).isError);
	const active = posed.length > concluded.length;
	const last = msgs.at(-1);
	const tailText = trailing(msgs).map((m) => textOf(m)).join("\n");
	const target = ids.length ? { target: [ids[0]] } : {};
	if (last?.role === "toolResult" && last.toolName === "conclude") {
		return reply([fauxText("That's the committed solution above. Press **Next problem** when you're ready.")]);
	}
	if (last?.role === "toolResult" && last.toolName === "problem" && last.isError) {
		return reply([fauxText("A plain one in between, then."), call("problem", { ...PROBLEMS[0], ...target })]);
	}
	if (active && tailText.includes(THINKING)) {
		if (/Rocq verdict: passes/.test(tailText)) {
			return reply([call("conclude", { outcome: "solved", verdict: "Rocq accepts the proof.", rung: null, missClass: null, retest: false })]);
		}
		if (/Rocq verdict: does not pass/.test(tailText)) {
			return reply([fauxText("Rocq still reports a problem — read it in your submission card. Hint: this goal is linear arithmetic.")]);
		}
		return reply([call("conclude", { outcome: "movedOn", verdict: "Read your trace.", rung: null, missClass: null, retest: false })]);
	}
	if (!active && (posed.length === 0 || tailText.includes(NEXT_PROBLEM))) {
		return reply([fauxText(posed.length === 0 ? "A Rocq one to start." : "Another Rocq one."), call("problem", { ...ROCQ_PROBLEM, ...target })]);
	}
	return reply([fauxText(active ? "Edit the proof and submit when Rocq accepts it." : "Press **Next problem** to continue.")]);
}

function unknownRole(context) {
	const last = conversation(context).at(-1);
	return reply([fauxText(`Scripted reply to: ${textOf(last).slice(0, 120)}`)]);
}

const SCRIPTS = {
	prober,
	teacher,
	practice,
	extractor,
	auditor,
	researcher,
	visual: visualMaker,
	demo: demoBuilder,
	pdf: pdfReader,
	summarizer,
};

// ─── the provider ───────────────────────────────────────────────────────────

export function createScriptedProviders() {
	const faux = fauxProvider({
		provider: "openrouter",
		models: [
			{ id: "deepseek/deepseek-v4.1-flash", reasoning: true, contextWindow: 128000, maxTokens: 8192 },
			{ id: "qwen/qwen3.8-max-0902", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 8192 },
		],
		tokensPerSecond: TOKENS_PER_SECOND,
		// Fixed chunk size: deterministic delta boundaries.
		tokenSize: { min: 4, max: 4 },
	});
	// The faux queue is consumed one response per request (shifted
	// synchronously, resolved later): keep a deep buffer of the same
	// responder, topped up per call, so concurrent requests (parallel jobs,
	// extraction) never find it empty.
	const step = (context) => {
		faux.appendResponses([step]);
		const message = respond(context);
		if (process.env.LH_E2E_TRACE === "1") {
			const role = detectRole(context);
			const summary = message.content.map((c) => (c.type === "toolCall" ? `call:${c.name}` : c.type)).join(",");
			console.log(`[scripted-model] ${role} → ${summary}`);
		}
		return message;
	};
	faux.setResponses(Array.from({ length: 64 }, () => step));
	return [faux.provider];
}
