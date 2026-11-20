# Runbook: "Ask my data" (ADR-0094, ADR-0095)

"Ask my data" is a section on Today. The guided builder and the predefined shortcuts always work and need no model. Typed
questions are optional and **off by default**. An answer is always one read of the person's own daily overview, weekly review or 28-day activity
comparison; nothing is stored.

## Modes

| `DATA_QUESTIONS_PROVIDER` | What happens | When |
|---|---|---|
| `off` (default) | No provider object is built; `GET …/data-questions/capabilities` answers `{"interpretation":"off"}`; `POST …/interpretations` answers `503 DATA_QUESTION_INTERPRETATION_DISABLED`; the screen shows the predefined questions and a note that typed questions are not available. Plans and answers work. | Every deployment unless an operator decides otherwise |
| `fake` | A deterministic keyword stand-in, in process. Refused when `APP_ENV=production`. **Never model evidence.** Control words for tests: `[delay=MS]`, `[fail]`, `[unavailable]`, `[invalid]`, `[implied-source]`. | Automated tests, the browser suite, demonstrations |
| `ollama` | One non-streaming chat call per question to a local Ollama, with the closed JSON schema as `format`. Requires `DATA_QUESTIONS_MODEL` (a local model name; cloud names refused). | Only after a measured, reviewed decision |

## Guided questions (ADR-0095, always available)

The builder offers every combination the contracts accept and nothing else: **What to read** (one day; one week; one
activity over 28 days compared with the 28 before), then that view's fields — the period (the selected date, today or
yesterday; the week of the selected date, this week or last week; a comparison ending on the selected date, today or
yesterday), the part of the week (overview, steps and active energy, recorded nutrition), the records (manual entries, GPX
imports, TCX imports or recorded runs; never combined) and the activity type (recorded runs: run only; other types are
shown disabled). Other dates come from Today's own date field. Every field starts empty; an incomplete draft or recorded
runs with another type shows what is missing and sends nothing. **Review question** sends the symbolic intent to
`POST …/plans` (nothing is read) and shows the plan; **Get answer** sends that plan to `POST …/answers`. The builder never
calls `…/interpretations`. With interpretation available the section offers "Choose a question" (the initial mode) and
"Type a question"; switching modes, editing any choice or the text, a new date or zone, New question, sign-out and an
organization change drop the previous proposal, answer, clarification and Retry. A new date keeps the builder's choices
(they are symbolic) and empties the typed text.

Every clarification of a typed question offers one action into the builder: "Choose the source" (prefilled with the type
and period the server verified), "Choose the activity type", "Choose a period" or "Choose the view". Nothing the model
guessed is prefilled.

## Settings (defaults)

`DATA_QUESTIONS_MODEL` (none), `DATA_QUESTIONS_OLLAMA_BASE_URL` (`http://127.0.0.1:11434`; loopback, private network,
`host.docker.internal` or a single-label service only), `DATA_QUESTIONS_TIMEOUT_MS` (45 000, at most 55 000; the browser
waits 60 s), `DATA_QUESTIONS_MAX_CONCURRENT` (1), `DATA_QUESTIONS_USER_RATE_PER_MINUTE` (5),
`DATA_QUESTIONS_ALLOWANCE` (200 per `DATA_QUESTIONS_ALLOWANCE_WINDOW_MS`, 24 h), `DATA_QUESTIONS_LIMITER_MAX_USERS`
(1000), `DATA_QUESTIONS_MAX_OUTPUT_TOKENS` (300), `DATA_QUESTIONS_MAX_RESPONSE_BYTES` (32 KiB). These are independent of
`MEAL_DRAFTS_*`, `WEEKLY_INSIGHTS_*` and `RUN_SEARCH_AI_*`. Limits are per process and reset on restart.

Enabling Ollama locally (synthetic data only):

```
DATA_QUESTIONS_PROVIDER=ollama
DATA_QUESTIONS_MODEL=qwen3:8b      # must already be installed: nothing is pulled
```

The first question after the model was unloaded can take longer than the 45 s deadline on a CPU (a cold load); the person
then sees "took too long" and can retry. Nothing retries by itself.

## What the model receives

Fixed instructions (`data-question-prompt-2`), one context line with the selected date and the zone, and the question.
Never a record, a result, a title, a note, an identifier or an earlier question. The answer is a closed set of symbols
that the server checks against the question's own words (the constraints policy,
[docs/data-question-constraints-policy.md](../data-question-constraints-policy.md)) and resolves into dates itself. In
short: a question with a structural instruction (a "System:"/"Assistant:" label, "ignore your instructions", "set the
source to …", SQL) is refused as a whole; a period must be the one the words name (the selected date only when the
question names no time at all); weekdays, calendar dates and vague days ask for a period; other ranges are refused; a
comparison needs exactly one named, non-negated source and one named type. English and Russian only. A proposal is only
shown; the person executes it.

On the screen a proposal, answer, clarification or Retry belongs to exactly the question text it came from: editing the
text removes them (the new text waits for Interpret, and a late response to the old text is ignored); a new selected date
or zone, and New question, also empty the text. Discard keeps the text so it can be interpreted again on purpose.

## Failures and what they mean

| Answer | Meaning | Action |
|---|---|---|
| `503 DATA_QUESTION_INTERPRETATION_DISABLED` | Off | None needed; predefined questions work |
| `429 DATA_QUESTION_RATE_LIMITED` / `DATA_QUESTION_IN_PROGRESS` | Per-person rate, or the person's earlier call has not settled (also after a timeout) | Wait |
| `503 DATA_QUESTION_BUSY` / `DATA_QUESTION_BUDGET_EXHAUSTED` | Concurrency or rolling allowance reached | Wait, or raise the limits deliberately |
| `504 DATA_QUESTION_TIMEOUT` | The model did not answer within the deadline; its place stays taken until it settles | Check `ollama ps`; a cold load is expected once |
| `502 DATA_QUESTION_FAILED` `details.reason` | `provider_unavailable`, `provider_error`, `invalid_output`, `incomplete`, `oversized` | Check that Ollama runs and the model is installed |
| `400 INVALID_REQUEST` on `…/answers` | A plan the service's own rules refuse (a date after today, a forged or misaligned plan) | Ask again |

Logs: `data_question.interpretation`, `data_question.operation_settled`, `data_question.answer` with outcome codes only.
Metrics: `data_question_interpretation_requests_total`, `data_question_interpretation_seconds`,
`data_question_answers_total`.

## Measuring a model

```
npm run eval:data-questions -- --set development --provider fake                         # harness self-check, NOT evidence
npm run eval:data-questions -- --freeze --model qwen3:8b --out freeze.json                # digests and profile; no inference
npm run eval:data-questions -- --set development --provider ollama --model qwen3:8b --out dev.json
npm run eval:data-questions -- --set heldout --provider ollama --model qwen3:8b --out heldout.json
npm run eval:data-questions -- --check --report dev.json --report heldout.json --out gates.json    # offline
```

Every form takes `--dataset-version v1|v2`; **v1 is the default**, so the commands above keep their ADR-0094 meaning. v2 is
the pair written from the constraints policy (ADR-0095). A check judges exactly the selected version: reports of another
version, or a mix, are NOT_RUN. Example for v2:

```
npm run eval:data-questions -- --freeze --dataset-version v2 --model qwen3:8b --out freeze.json
npm run eval:data-questions -- --set development --dataset-version v2 --provider ollama --model qwen3:8b --out dev.json
npm run eval:data-questions -- --set heldout --dataset-version v2 --provider ollama --model qwen3:8b --out heldout.json
npm run eval:data-questions -- --check --dataset-version v2 --report dev.json --report heldout.json --out gates.json
```

Relative `--report` and `--out` paths mean the directory the command was typed in (npm's `INIT_CWD`; the working
directory when the script is run directly with `node --import tsx apps/api/src/evaluation/data-question-evaluation-main.ts`).
Absolute paths are used as typed; `--out` creates missing directories. The frozen datasets are always read from
`apps/api/evaluation/`. Recheck of the saved ADR-0094 measurement from the repository root:

```
npm run eval:data-questions -- --check --report docs/reports/artifacts/ask-my-data-2026-11-19/qwen3-8b-development.json --report docs/reports/artifacts/ask-my-data-2026-11-19/qwen3-8b-heldout.json
```

Since ADR-0095 this answers **NOT_RUN** (exit 3): the saved reports were measured with `data-question-prompt-1` and the
ADR-0094 code, so their prompt digest, prompt version and code fingerprint are stale. They are kept unchanged as history;
judged as measured (their own fingerprint and prompt, in the tests) they remain FAIL (quality), development 18/20 and
held-out 17/20 with one executable proposal each.

One sequential call per case, no retries, no warm-up, at most 40 calls for both sets; a run stops after three identical
systemic failures. `--check` is offline (it never uses the network) and answers PASS (0), FAIL (2) or NOT_RUN (3). It
does not trust a report's own summary: it validates each report's structure, loads the pinned datasets, requires exactly
one report per set with every frozen case exactly once and in order, recomputes each case's judgment from the recorded
outcome against the frozen expectation, and recomputes the scores with the frozen denominators. Evidence is invalid
(NOT_RUN) when a report is missing, unreadable, not JSON or malformed; when a set is stopped, partial, has missing,
duplicate, unknown or reordered cases, or unchecked or extra calls; when it came from the fake provider; when the dataset
version or digest, prompt, wire schema, fingerprinted code, stored thresholds or execution profile differ; or when a stored
score, flag, expected outcome, `complete` flag or latency summary contradicts what the gate recomputes. The printed
quality lines are always the recomputed ones. Thresholds: exact normalized interpretation ≥ 90 % per set, zero executable
proposals on clarification/refusal cases, technical failures ≤ 10 %. A PASS does not turn the feature on; that is a
separate decision.

The fingerprint covers an explicit file list (`DATA_QUESTION_FINGERPRINT_FILES` in
`apps/api/src/evaluation/data-question-evaluation.ts`, now including `data-question-constraints.ts`); changing any of them
makes earlier reports stale. The datasets are frozen by their pinned digests in `DATA_QUESTION_DATASET_REGISTRY`; a changed
case is a new version.
