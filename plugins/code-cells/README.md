# Code cells

Lean, TLA+, C++ and Rocq exercises for LearnHarness, in lessons (`lean_exercise`,
`tla_exercise`, `cpp_exercise`, `rocq_exercise`) and in practice (`lean_problem`,
`tla_problem`, `cpp_problem`, `rocq_problem`).

The learner edits the open part of a cell whose locked parts the teacher wrote; the
server checks every submission against the saved exercise with the language's
checker service, and the verdict goes to the learner and the teacher.

## Checker services

A language is available only when its service is configured on the server:

| Language | Variable      | Service (see `deploy/`)            |
| -------- | ------------- | ---------------------------------- |
| Lean     | `LH_LEAN_URL` | Lean 4 + Mathlib, LSP at `/lean/lsp` |
| TLA+     | `LH_TLA_URL`  | SANY / TLC                          |
| C++      | `LH_CPP_URL`  | g++ with sanitizers                 |
| Rocq     | `LH_ROCQ_URL` | Rocq 9 + Iris, LSP at `/rocq/lsp`   |

Settings → Plugins → Code cells has one toggle per language (on by default when its
service is configured).

## How a cell is posed

1. The teacher writes the exercise and calls `code_cell_verify`, which runs the
   reference (proof or solution) through the checker. A passing payload is remembered.
2. The teacher poses it with the identical payload; an unverified payload is refused.
3. Never two code cells in a row unless the learner asked (`payload.learnerAsked`).
4. TLA+ and C++ passes are judged by the teacher with `code_cell_review`; the answered
   cell shows the review.

## Development

```sh
npm run sdk && npm ci   # or: npm run plugins:setup in the app
npm run typecheck
npm test
npm run build           # dist/
```
