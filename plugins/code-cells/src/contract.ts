/**
 * The code-cells plugin contract: the four languages, their exercise
 * payloads (shared by the teaching question and the practice problem of a
 * language), the tool names and the model-facing text. Pure; imported by
 * the backend, the frontend and the tests.
 */
import { Type, type Static, type TSchema } from "typebox";
import { DEFAULT_LEAN_PRELUDE, DEFAULT_LEAN_STARTER } from "./core/lean-cell.ts";
import { MAX_TLA_WITNESSES } from "./core/tla-cell.ts";
import { MAX_CPP_TESTS } from "./core/cpp-cell.ts";
import { DEFAULT_ROCQ_PRELUDE, DEFAULT_ROCQ_STARTER } from "./core/rocq-cell.ts";

export const PLUGIN_ID = "code-cells";
export const CONTRACT_VERSION = 1;
export const LANGUAGES = ["lean", "tla", "cpp", "rocq"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LABEL: Record<Language, string> = { lean: "Lean", tla: "TLA+", cpp: "C++", rocq: "Rocq" };
/** The checker service's environment variable, per language. */
export const SERVICE_ENV: Record<Language, string> = { lean: "LH_LEAN_URL", tla: "LH_TLA_URL", cpp: "LH_CPP_URL", rocq: "LH_ROCQ_URL" };
export const QUESTION_TOOL: Record<Language, string> = { lean: "lean_exercise", tla: "tla_exercise", cpp: "cpp_exercise", rocq: "rocq_exercise" };
export const PROBLEM_TOOL: Record<Language, string> = { lean: "lean_problem", tla: "tla_problem", cpp: "cpp_problem", rocq: "rocq_problem" };
export const VERIFY_TOOL = "code_cell_verify";
export const REVIEW_TOOL = "code_cell_review";
/** Languages whose pass needs the teacher's judgment (code_cell_review). */
export const REVIEWED: readonly Language[] = ["tla", "cpp"];

export function isLanguage(value: unknown): value is Language {
	return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

// ─── exercise payloads ──────────────────────────────────────────────────

const learnerAsked = Type.Optional(
	Type.Boolean({ description: "True only when the learner asked for another code cell right after the previous one." }),
);

const leanFields = {
	prelude: Type.Optional(
		Type.String({ description: `Locked lines before the statement: imports and \`open\`s. Default: "${DEFAULT_LEAN_PRELUDE}". No \`namespace\`.` }),
	),
	statement: Type.String({
		minLength: 1,
		description: "Locked: exactly one `theorem <fresh_name> … := by` (or `lemma`). The learner cannot edit it; the check re-uses it verbatim.",
	}),
	starter: Type.Optional(
		Type.String({
			description: `The editable proof the learner starts from, indented under the statement. Default: "${DEFAULT_LEAN_STARTER}". May hold a partial proof with \`sorry\` holes.`,
		}),
	),
	referenceProof: Type.String({
		minLength: 1,
		description: "Your complete tactic proof (indented like the starter). Shown to the learner only after they submit.",
	}),
};

const tlaFields = {
	mode: Type.Optional(
		Type.Union([Type.Literal("tla"), Type.Literal("pluscal")], {
			description:
				'"tla" (default): the learner writes TLA+ definitions. "pluscal": the head opens a PlusCal algorithm in a comment ' +
				"(`(* --algorithm Name` …), the learner writes (part of) the algorithm, the tail closes it (`end algorithm; *)`) and " +
				"defines what is checked; the server translates it (you may put `\\* BEGIN TRANSLATION` / `\\* END TRANSLATION` lines " +
				"in the tail, or the translator adds them right after the algorithm). Use `Spec` as the specification.",
		}),
	),
	head: Type.String({
		minLength: 1,
		description:
			"Locked lines at the top: `---- MODULE <Name> ----` (a fresh name, not a standard module), EXTENDS, CONSTANTS, VARIABLES " +
			"and any definitions you give. The learner cannot edit it.",
	}),
	starter: Type.Optional(
		Type.String({ description: "The editable text the learner starts from (may be empty or a partial definition with a comment saying what to fill in)." }),
	),
	tail: Type.String({
		minLength: 1,
		description:
			"Locked lines at the bottom: e.g. `Spec == Init /\\ [][Next]_vars`, the invariants and properties TLC checks, and the " +
			"closing `====` line (exactly one, at the end).",
	}),
	config: Type.Object(
		{
			constants: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "CONSTANT name → value in .cfg syntax, e.g. {\"N\": \"3\", \"Procs\": \"{p1, p2}\"}. Keep the model small." }),
			),
			specification: Type.Optional(Type.String({ description: "The temporal formula's name (e.g. Spec) — or give init and next instead." })),
			init: Type.Optional(Type.String({ description: "The initial predicate's name (with next)." })),
			next: Type.Optional(Type.String({ description: "The next-state relation's name (with init)." })),
			invariants: Type.Optional(Type.Array(Type.String(), { description: "Names of the invariants TLC checks." })),
			properties: Type.Optional(Type.Array(Type.String(), { description: "Names of the temporal properties TLC checks (needs a specification with fairness where relevant)." })),
			checkDeadlock: Type.Optional(Type.Boolean({ description: "TLC's deadlock check. Default true." })),
		},
		{ description: "The TLC model. The learner sees it read-only under the cell. It must check at least one invariant or property." },
	),
	witnesses: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ minLength: 1, description: "What the state means, shown to the learner (e.g. \"a process enters the critical section\")." }),
				expression: Type.String({ minLength: 1, description: "A one-line state predicate, e.g. pc[1] = \"cs\"." }),
			}),
			{
				maxItems: MAX_TLA_WITNESSES,
				description:
					"States that must be reachable, so a spec that does nothing cannot pass (e.g. Next == UNCHANGED vars satisfies most " +
					"invariants). Give at least one whenever the task is about behavior.",
			},
		),
	),
	referenceSolution: Type.String({
		minLength: 1,
		description: "Your complete solution for the editable part. Shown to the learner only after they submit.",
	}),
};

const cppFields = {
	head: Type.String({
		minLength: 1,
		description:
			"Locked lines at the top of the file: the #includes the solution needs, any given types or helpers, and a comment " +
			"with the function signature(s) to implement. No main(): the tests provide it.",
	}),
	starter: Type.Optional(Type.String({ description: "The editable code the learner starts from, e.g. the signature with an empty body or a TODO." })),
	tail: Type.Optional(Type.String({ description: "Optional locked lines after the learner's part (more given code)." })),
	tests: Type.Array(
		Type.Object({
			name: Type.String({ minLength: 1, description: "Short, shown to the learner, e.g. \"empty vector\"." }),
			code: Type.String({
				minLength: 1,
				description:
					"C++ statements that call the learner's code and check results with CHECK(cond), CHECK_EQ(actual, expected) " +
					"(values printable with << are shown on failure) or CHECK_NEAR(actual, expected, eps). Each test runs in its own " +
					"process with AddressSanitizer and UBSan and a 5 s time limit.",
			}),
			hidden: Type.Optional(
				Type.Boolean({ description: "true: runs only on Submit; the learner sees only its name. Add some so a solution fitted to the visible tests fails." }),
			),
		}),
		{ minItems: 1, maxItems: MAX_CPP_TESTS, description: "The tests (C++20, g++). At least one visible; visible ones are shown read-only and run on Check." },
	),
	referenceSolution: Type.String({
		minLength: 1,
		description: "Your complete code for the editable part. Shown to the learner only after they submit.",
	}),
};

const rocqFields = {
	prelude: Type.Optional(
		Type.String({
			description:
				`Locked lines before the statement: Require/Import lines. Default: "${DEFAULT_ROCQ_PRELUDE}". Iris is available, e.g. ` +
				'"From iris.proofmode Require Import proofmode.\\nFrom iris.base_logic Require Import iprop." or for HeapLang ' +
				'"From iris.heap_lang Require Import proofmode notation.". No Section or Module: put binders such as `{!heapGS Σ} in the statement.',
		}),
	),
	statement: Type.String({
		minLength: 1,
		description: "Locked: exactly one `Lemma <fresh_name> … .` (or Theorem) ending in a period. The learner cannot edit it; the check re-uses it verbatim.",
	}),
	starter: Type.Optional(
		Type.String({
			description: `The editable proof the learner starts from. Default: "${DEFAULT_ROCQ_STARTER.replace("\n", "\\n")}". May hold a partial proof ending in Admitted.`,
		}),
	),
	referenceProof: Type.String({
		minLength: 1,
		description: "Your complete proof, `Proof. … Qed.`. Shown to the learner only after they submit.",
	}),
};

export const PAYLOAD_SCHEMA = {
	lean: Type.Object({ ...leanFields, learnerAsked }, { additionalProperties: false }),
	tla: Type.Object({ ...tlaFields, learnerAsked }, { additionalProperties: false }),
	cpp: Type.Object({ ...cppFields, learnerAsked }, { additionalProperties: false }),
	rocq: Type.Object({ ...rocqFields, learnerAsked }, { additionalProperties: false }),
} satisfies Record<Language, TSchema>;

export type LeanPayload = Static<typeof PAYLOAD_SCHEMA.lean>;
export type TlaPayload = Static<typeof PAYLOAD_SCHEMA.tla>;
export type CppPayload = Static<typeof PAYLOAD_SCHEMA.cpp>;
export type RocqPayload = Static<typeof PAYLOAD_SCHEMA.rocq>;
export type Payload = LeanPayload | TlaPayload | CppPayload | RocqPayload;

/** The learner's answer / submission: the editable part of the cell. */
export const ANSWER_SCHEMA = Type.String({ maxLength: 50_000 });

/** The reference field of a payload (shown after submitting). */
export function referenceOf(language: Language, payload: Record<string, unknown>): string {
	const value = language === "lean" || language === "rocq" ? payload.referenceProof : payload.referenceSolution;
	return typeof value === "string" ? value : "";
}

// ─── model-facing text ──────────────────────────────────────────────────

const ABOUT: Record<Language, string> = {
	lean: "sessions about Lean itself — writing Lean programs or proving theorems in Lean (Lean 4 + Mathlib)",
	tla: "sessions about TLA+ or PlusCal itself — writing specifications and model checking them with TLC",
	cpp: "sessions about programming in C++ itself — writing C++ code (C++20, g++, sanitizers)",
	rocq: "sessions about Rocq (Coq) itself or Iris — writing Rocq proofs (Rocq 9, Iris, HeapLang)",
};

const CELL: Record<Language, string> = {
	lean:
		"The learner sees the locked prelude and statement and edits the proof below them with live Lean feedback (goals, errors). " +
		"On submit the server checks the proof against the exact statement: it passes when Lean reports no errors, no sorry, and " +
		"only the standard axioms (propext, Classical.choice, Quot.sound; no native_decide).",
	tla:
		"The learner edits the part between the locked head and tail, with live SANY errors and a Check button; on submit the " +
		"server runs TLC with your model and checks every witness is reachable.",
	cpp:
		"The learner edits the part between the locked head (and optional tail), with live compiler errors and a Check button " +
		"that runs the visible tests; on submit the server compiles the exact cell and runs every test, hidden ones included.",
	rocq:
		"The learner sees the locked prelude and statement and edits the proof below them with live Rocq feedback (goals, errors). " +
		"On submit the server re-checks the exact statement: it passes when Rocq accepts it with no Admitted and no extra axioms.",
};

export function questionDescription(language: Language): string {
	return (
		`Pose a ${LABEL[language]} code cell. ${CELL[language]} Your reference comes back to the learner only after they submit. ` +
		`Before this call, run ${VERIFY_TOOL} with language "${language}" and this exact payload; an unverified payload is refused. ` +
		"Mix code cells with your other checks — never two code cells in a row unless the learner asked (payload.learnerAsked). " +
		"ONE question per turn: call it, then end your turn."
	);
}

export function problemDescription(language: Language): string {
	return (
		`Pose a ${LABEL[language]} practice problem as a code cell. ${CELL[language]} Each submission brings the learner's code and ` +
		`the checker's verdict; repeated submissions are allowed and only conclude closes the problem. Before this call, run ` +
		`${VERIFY_TOOL} with language "${language}" and this exact payload; an unverified payload is refused. Never two code ` +
		"problems in a row unless the learner asked (payload.learnerAsked)."
	);
}

export function instructions(language: Language): string {
	return (
		`${LABEL[language]} code cells (${QUESTION_TOOL[language]} in lessons, ${PROBLEM_TOOL[language]} in practice) belong in ${ABOUT[language]}. ` +
		"Never use them for maths, physics, logic or concurrency taught without the language itself. " +
		`Write the exercise, run ${VERIFY_TOOL} on it (fix it until the reference passes), then pose it with the identical payload.` +
		(REVIEWED.includes(language)
			? ` When a ${LABEL[language]} answer passes the checker, judge whether it does what the task asked (not only whether it passes) and record that with ${REVIEW_TOOL} before replying.`
			: "")
	);
}

export const VERIFY_DESCRIPTION =
	"Check a code-cell exercise before posing it: runs the language's checker on your reference (Lean/Rocq: referenceProof; " +
	"TLA+: referenceSolution with TLC and every witness; C++: referenceSolution against every test). On success the exact payload " +
	"is remembered and may be posed; on failure fix the payload and verify again. The learner sees nothing.";

export const REVIEW_DESCRIPTION =
	"Record your judgment of the learner's latest TLA+ or C++ code-cell answer that passed the checker: accepted: true when it " +
	"does what the task asked, false (with the reason) when it passes the checks without doing what was asked. The learner sees it on the answered cell.";
