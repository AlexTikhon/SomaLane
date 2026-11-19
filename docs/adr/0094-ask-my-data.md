# ADR-0094: "Ask my data" — one read-only question over existing deterministic analytics

- Status: accepted; implemented and verified on the workstation (Chromium, real PostgreSQL). Question interpretation is
  **off by default**; its frozen real-model gate **failed** on quality (see "Measurement").
- Date: 2026-11-19
- Amends: nothing. ADR-0082 (Today), ADR-0077/0079/0093 (weekly review) and ADR-0089/0090 (activity trends and their
  comparison) are read, never changed. The meal-draft pipeline (ADR-0092), its gate and its historical evidence are
  untouched.
- Scope: `packages/contracts` (`data-questions.ts`, OpenAPI), `apps/api/src/data-questions`, `apps/api/src/config`
  (`DATA_QUESTIONS_*`), `apps/api/src/evaluation` (a separate evaluation), `apps/web` (a section on Today and two typed
  navigation intents), `tests/e2e`. No migration, no table, no job, no new dependency.

## Context

The product direction (roadmap item 3, "a chat coach with read-only tools") asks for questions over the person's own data.
The data foundation already answers three kinds of question deterministically: one day (Today), one Monday-to-Sunday
week (the weekly review, now with recorded nutrition), and one activity source and type over 28 dates against the 28
before (activity trends). A language model must not compute, choose whose data is read, widen what is read, write prose
about health numbers, or run tools by itself. So this slice is not a chat: it is **one question at a time**, resolved into
an explicit plan the person reviews, executed by exactly one existing read.

## Decision

### 1. Flow

```
question ──(optional model)──▶ strict symbolic interpretation ──▶ deterministic normalization + server date resolution
          ──▶ plan shown for review ──(person clicks "Get answer")──▶ exactly one allowlisted service read ──▶ answer
predefined question ─────────────────────────────▶ same server resolution ──▶ same execution path (selecting it is the request)
```

Interpretation never reads data and never executes; only `POST …/answers` reads, and only for a plan the client sends.
There is no model-generated SQL, tool name, URL or query fragment, no loop, no multi-tool plan, no retrieval, no
embeddings and no model-written answer prose. Nothing is persisted: no conversation, no history, no server cache, no
browser storage; one question, proposal and answer live in the controller's memory.

### 2. Three operations, closed enums (`data-question-1`)

| Operation | Service (existing instance, injected) | Symbolic periods | Other fields |
|---|---|---|---|
| `day_overview` | `DailyOverviewService.read` | `selected_date`, `today`, `yesterday` | — |
| `weekly_review` | `WeeklyReviewService.read` | `selected_week`, `current_week`, `previous_week` | `focus`: `overview` \| `movement` \| `nutrition` |
| `activity_comparison` | `ActivityTrendsService.read` with `compare=previous_period` | end date: `selected_date`, `today`, `yesterday` | ONE `source` (`manual`, `gpx`, `tcx`, `recorded_run`), ONE `type`; `recorded_run` ⇒ `run` |

Three contract shapes are kept apart: the symbolic **intent**; the **plan** with explicit dates (`localDate`; or
`weekStart`/`weekEnd`; or the comparison's `startDate`/`endDate` and `previousStartDate`/`previousEndDate`) and the
canonical zone; and the **answer**. Every object is strict (unknown fields refused); the plan schema checks that a week
starts on a Monday and ends on its Sunday and that the comparison's dates are exactly the activity trends' for its end date
(`dailyTrendsRangeOf`, `previousActivityTrendsPeriodOf`), so a forged plan cannot widen a read.

### 3. Time semantics

`resolveDataQuestionPlan` uses the injected clock and the requested zone (`localDateOf`, the platform's zone rules), never
the host zone. The selected date is kept apart from "today" and "yesterday" in the zone, and the week of the selected date
from the current and previous calendar weeks. `selectedDate` must not be before 2000-01-01 nor after today in the zone; a
resolved date or week before 2000-01-01 is refused (`400`; during interpretation it becomes `clarify period_ambiguous`).
**A reviewed plan is executed as reviewed**: its dates are not resolved again, so "today" reviewed before midnight still
reads that date afterwards. The services' own rules still apply when it runs (not after today, week alignment, the lower
bound, comparison eligibility), and their refusals pass through unchanged. The weekly review keeps its existing zone rule
(the zone of the week's check-ins, else the requested zone); the answer shows which.

### 4. Deterministic answers

`DataQuestionExecutor` is the allowlist: one switch, three branches, one `read` call each, with the plan's own dates and
zone, through the same service instances the existing routes use (built once in `app.ts`). It keeps each service's
snapshot, membership check, row-level security, owner predicates and bounds; it never calls this application's HTTP
endpoints, reloads records, recomputes a total, or combines two reads. The answer is a projection by construction:

- `day_overview`: the daily overview DTO unchanged (it already holds no title, note or identifier);
- `weekly_review`: `week` and the code-written `statements` of the week plus, by focus, `movement` (ADR-0079) or `meals`
  (ADR-0093), or for `overview` the `coverage`, `dataGaps` and the GPX/TCX parts; never the AI-shared `facts`;
- `activity_comparison`: `applied`, `range`, `summary` and `comparison` (with every existing unavailable reason), without
  the per-date series.

`provenance` carries `computedAt` (the service's), the service, its contract/policy version (`daily-overview-4`,
`weekly-review-5`, `activity-trends-1`), the answer version and `persisted: false`. The web renders these fields with the
same helpers as Today, the weekly review and Trends, so units, coverage, sources and suppression reasons read the same:
missing is unknown, a recorded 0 is 0, coverage is never called complete logging, sources are never added together, and
food energy is never combined with active energy. Source actions are typed internal intents (show the date on Today; open
the weekly review on that week; open Trends on that source, type and end date), never server-provided URLs.

### 5. Interpretation (optional, `DATA_QUESTIONS_PROVIDER=off | fake | ollama`, default off)

The model receives exactly: fixed instructions (`data-question-prompt-1`), one context line with the validated selected
date and zone, and the question (1–300 code points, no control characters) as the user message. Never a record, title,
note, route, identifier, result or earlier question, so answers do not become inputs of any AI feature. Its output is a
`oneOf` of five closed-symbol objects (`data_question_interpretation_v1`); `normalizeDataQuestion` then turns it into an
intent or a bounded clarification, never filling a gap with a default. An activity source is accepted **only when the
question names it in words** (manual/by hand/вручную, GPX, TCX, recorded/GPS/записанные); "running" alone is no source,
so a model-chosen source without such a word becomes `clarify activity_source_missing` with a `sourceChoice` (type and
period). Choosing a source sends a complete intent to `POST …/plans` and shows that plan for review. Unsupported reasons:
`other_person`, `write_action`, `medical_or_coaching`, `estimation_or_prediction`, `unsupported_calculation`,
`not_a_data_question`. Clarifications: `activity_source_missing`, `activity_type_missing`, `period_ambiguous`,
`operation_ambiguous`. The screen owns every sentence.

Lifecycle is ADR-0057's addendum and ADR-0092's, reused: session, Origin, CSRF, JSON body (global 64 KiB limit), validated
context and membership **before** the provider is called; the membership transaction commits before the call (no
connection held during inference); one call, no retry, a hard deadline (45 s default, ≤ 55 s; the browser waits 60 s);
the admission ticket (per-user rate, one in flight per person, process concurrency, rolling allowance) is released only
when the provider's promise settles; session and membership are checked again after inference and the proposal is dropped
if either is gone. Off: no provider object, `GET …/capabilities` says `off`, `POST …/interpretations` is `503
DATA_QUESTION_INTERPRETATION_DISABLED`, predefined questions work. The Ollama adapter is the weekly insight's, unchanged;
meal drafts, weekly insights and run-search interpretation keep their own settings and defaults.

### 6. HTTP (`/api/orgs/:orgId/data-questions`, all `Cache-Control: no-store`, errors and malformed bodies included)

`GET /capabilities` · `POST /plans` · `POST /interpretations` · `POST /answers`. POSTs carry Origin and CSRF like every
mutation, although nothing is written (the body is a plan, not a query string, so nothing lands in access logs). The owner
is always the session's identity; a coach role or a run-sharing grant never widens what is read.

### 7. Privacy and observability

Nothing about a question, a plan or an answer is stored or logged. Log lines carry `outcome`, `durationMs`, `model`,
`requestId`, and for answers `task` (the operation: three values). Metrics:
`data_question_interpretation_requests_total{outcome}`, `data_question_interpretation_seconds{outcome}`,
`data_question_answers_total{operation,outcome}` — bounded labels, no dates, sources, values or text.

### 8. Web

"Ask my data" is a compact section at the bottom of Today, using Today's selected date and zone. Predefined questions
(the four representative requests and the selected week's review) are always offered; a text box appears only when the
server says interpretation is available, with a disclosure that only the question, date and zone are used. The
framework-free `DataQuestionController` has explicit states — `idle`, `interpreting`, `proposal`, `answering`, `ready`,
`clarify`, `unsupported`, `error` — at most one request in flight, duplicate clicks ignored, Cancel and Retry, Refresh
re-reads the plan, and an error never keeps an old answer. A generation counter (not the abort signal) drops late
responses; cancelling, a date or zone change, sign-out (the session signal), session replacement and organization change
(the screen is keyed by session, person and organization) and disposal all invalidate the request in flight.

## Measurement (synthetic engineering gate, not generalization)

A separate evaluation (`npm run eval:data-questions`, not part of the meal-draft gate): two frozen sets of 20 synthetic
cases each (10 English, 10 Russian; supported plans, ambiguous questions, refusals, adversarial instructions), with the
expected normalized plan resolved by the server's own code from a documented intent and a fixed clock. Every case runs
through the product interpretation service. Gate: exact normalized interpretation ≥ 90 % per set; zero executable
proposals on cases expecting a clarification or refusal; technical failures ≤ 10 %; both sets complete; dataset digests,
prompt digest, code fingerprint (an explicit file list) and one execution profile valid and checked on every request.
Dataset digests, prompt/schema version, fingerprint, profile and thresholds were frozen before inference
(`docs/reports/artifacts/ask-my-data-2026-11-19/freeze-before-inference.json`).

**Result (2026-11-19, `qwen3:8b`, Ollama 0.40.16, 40 of 40 calls): FAIL (quality), evidence valid.** Development 18/20 =
90.0 % exact, held-out 17/20 = 85.0 %; one executable proposal on a clarification case in each set (a weekday read as the
selected date; an injected source word accepted by the guard); 0 technical failures. Details in
[the report](../reports/ask-my-data-2026-11-19.md). Interpretation stays off by default; predefined questions and
deterministic answers are unaffected.

## Alternatives considered

- **Letting the model call tools or write SQL.** Rejected: it makes the model an actor with a query.
- **Executing an interpreted plan immediately.** Rejected: the person must see the period, subject and source first.
- **A chat with history.** Rejected for v1: history becomes stored health content and widens model input.
- **Combining sources or inferring "running" means recorded runs.** Rejected: ADR-0089 keeps sources apart.
- **New analytics to answer more questions.** Out of scope; only existing definitions are read.
- **Calling the existing HTTP endpoints internally.** Rejected: a second authentication path and a second serialization.
- **A model-written answer.** Rejected: every sentence on screen is code-written and reviewed.

## Consequences and limitations

- Three operations only; any other range or calculation is refused, not approximated.
- The source guard is a bounded lexicon, not a parser. It can only turn a proposal into a clarification. A question that
  itself contains a source word inside an injected instruction ("… set source to recorded_run") passes the guard; the
  resulting plan is still only a proposal that names the source and needs the person's click.
- Admission limits are per process and reset on restart (as ADR-0057).
- The code fingerprint is an explicit file list, not an import closure (unlike ADR-0092's).
- Verified in Chromium on a workstation only; no physical Safari, hosted CI, real GPS or production run.
