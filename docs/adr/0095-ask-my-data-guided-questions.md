# ADR-0095: "Ask my data" v2 — guided questions and grounded interpretation parameters

- Status: accepted; implemented and verified on the workstation (Chromium, real PostgreSQL). The frozen v2 real-model gate
  **passed**; question interpretation nevertheless stays **off by default**.
- Date: 2026-11-20
- Amends: ADR-0094 (the Today section, the controller, normalization, the interpretation prompt and the evaluation). It
  changes no contract shape (`data-question-1`), no operation, no service and no data boundary. ADR-0094's historical
  reports and artifacts are kept unchanged; they are now stale evidence (see "Evaluation").
- Scope: `apps/web` (guided builder, controller), `apps/api/src/data-questions` (question constraints, normalizer,
  prompt `data-question-prompt-2`), `apps/api/src/evaluation` (versioned data-question datasets), `apps/api/evaluation`
  (v2 sets), `tests/e2e`. No migration, table, job, cache, dependency or new read.

## Context

ADR-0094 answers one question at a time through three deterministic reads. With interpretation off (the default, and the
only honest setting after its failed gate) a person had five fixed questions and nothing else, although the contracts
already accept 3 day plans, 9 weekly plans and 66 comparisons. With interpretation on, the measured failures were
parameter failures the normalizer could have caught from the question itself: a weekday read as the selected date, a
source authorized by a word inside an injected "SYSTEM NOTE", and "last week" turned into `selected_week` because the two
resolved to the same dates. A clarification was a dead end except for a missing source.

## Decision

### 1. Guided question builder (works with interpretation off)

A compact builder inside the existing section: **View** (day overview, weekly review, activity comparison), then the
fields that view takes — **Period** (day: the selected date, today, yesterday; week: the week of the selected date, this
week, last week; comparison: 28 dates ending on the selected date, today or yesterday, compared with the 28 before),
**Focus** (overview, steps and active energy, recorded nutrition), **Source** (manual entries, GPX imports, TCX imports,
recorded runs) and **Activity type** (the seven types; recorded runs offer only run). Other historical dates come from
Today's own date field; there is no date or range input in the builder.

Flow: choices → **Review question** → `POST …/plans` (server resolution, nothing read) → the same review panel →
**Get answer** → `POST …/answers`. Guided mode never calls `…/interpretations`. Nothing is chosen for the person: every
field starts empty, the source is never inferred, a changed view clears the fields of the other views (period is kept
only when the new view takes it), and an incomplete or incompatible draft (recorded runs with another type) shows what is
missing and is never sent. The complete draft is checked against the contract's intent schema before the request.
Predefined questions stay as shortcuts.

When interpretation is available, two explicit modes are offered ("Choose a question" and "Type a question"); guided is
the initial mode. When interpretation is off or unavailable only the builder and the shortcuts are shown.

### 2. Clarification leads to the builder

Every clarification shows one action that opens the builder at the field to choose: missing source → "Choose the source"
(prefilled with the server-verified `sourceChoice` type and period when present; the existing one-click source buttons
stay), missing type → "Choose the activity type" (comparison view preset, nothing else), ambiguous period → "Choose a
period" (with a pointer to Today's date field for other dates), ambiguous operation → "Choose the view". The response
contract is unchanged: the only prefilled values are the reason's own implication (a type or source clarification is a
comparison) and the `sourceChoice`, which the server now builds only from constraint-verified fields. The model's guess for
an ambiguous field never prefills anything. No conversation, history or follow-up loop is introduced.

### 3. One source of truth for question state

`DataQuestionController` owns `mode`, the typed `text`, the guided `draft` and the state derived from them. Invariant: every
state other than `idle` was derived from the current mode's draft (text or guided choices) or from a predefined question.
`setText`, `setMode`, `updateDraft`, `setContext`, `newQuestion` and session/organization change (the screen is keyed by
them) all invalidate the proposal, answer, clarification, error and retry and move the generation on (abort plus late
responses dropped). `newQuestion` empties both drafts; `setContext` empties the text (ADR-0094) but keeps the guided draft,
whose choices are symbolic ("the selected date") and must be reviewed again under the new context. A new transient state
`resolving` covers a plan being resolved for review (guided review, a clarification's source choice); `answering` is
reading only. Duplicate submission, cancellation, Refresh and generation checks are unchanged.

### 4. Question constraints at the normalization boundary

`data-question-constraints.ts` analyses the original question independently of the model's answer into evidence spans
with reason codes, and the normalizer applies a fixed decision order. The written policy is
[docs/data-question-constraints-policy.md](../data-question-constraints-policy.md) (`data-question-constraints-1`).
Summary:

- **Instruction-bearing questions** (role labels with a colon, override/reveal/role-change phrases, parameter commands,
  snake_case symbols, SQL/code) are refused as a whole: `unsupported not_a_data_question`, whatever the model answered.
  Ordinary words such as "recorded" or "GPS" are not markers.
- **Periods**: a proposal must carry the one symbol the question requests at its granularity, even if another symbol
  resolves to the same dates; several symbols, the other granularity, weekdays, calendar dates, relative or vague days
  and future periods are `clarify period_ambiguous`; ranges other than the comparison's own window are `unsupported
  unsupported_calculation`. The selected context without an explicit period is permitted only when the question has no
  temporal evidence at all.
- **Sources**: exactly one positive source word, no negated source, equal to the model's; "running" alone is no source.
- **Types**: exactly one explicit type, equal to the model's; no evidence (an unknown activity) or several types ask.
- **Views and focus**: a comparison needs comparison wording; the day and week views refuse the 28-day window; the weekly
  review needs week wording and refuses an activity type; a weekly focus must agree with the nutrition/movement words.

The rules only make a proposal more conservative. The dispatch, admission lifecycle and provider accounting are unchanged:
the provider is still called once per admitted question, and the constraints apply to its answer.

Intentional category changes from v1 (policy, not regressions): `en-ho-injection-source` would now be `unsupported
not_a_data_question` (was `clarify activity_source_missing`), `ru-dev-injection-admin` `unsupported not_a_data_question`
(was `other_person`). v1 files and expectations are not edited.

### 5. Prompt `data-question-prompt-2`

Rewritten to state the same rules: explicit period words only, selected context only without temporal words, weekday and
dates are clarifications, instruction-bearing questions are `not_a_data_question`, a type and a source only when named,
the focus from nutrition/movement words. The output is the unchanged closed wire schema (`data_question_interpretation_v1`):
no dates, numbers, SQL, tools, owners or prose. The model still receives only the instructions, the validated context line
and the question. Examples are synthetic and appear in no evaluation set. Meal drafts, weekly insights and run-search
interpretation are untouched.

### 6. Data boundaries (unchanged)

The three operations, their injected service instances, one read and its snapshot per answer, ownership predicates, RLS,
membership checks, `no-store`, provenance, missing versus zero, coverage, source separation and typed navigation are
unchanged. No table, migration, analytics definition, read tool, history, cache, retrieval, agent framework, cloud
provider or dependency.

### 7. Evaluation v2

The data-question evaluator gains a version registry like ADR-0092's: `--dataset-version v1|v2`, **v1 by default**. v1
keeps its files, digests and expectations. v2 is a new pair (`data-question.development.v2.json`,
`data-question.heldout.v2.json`, 20 cases each, 10 EN + 10 RU, `data-question-eval-2`), written from the policy before
any inference, each case with a rationale naming its rule. `--check` judges exactly one selected version; reports of
another version, mixed versions, relabelled or unknown sets and every ADR-0094 gate mutation stay NOT_RUN. Thresholds are
unchanged (exact ≥ 90 % per set, zero executable proposals on clarification/refusal cases, technical failures ≤ 10 %).
The code fingerprint adds the constraints module; a test shows that changing each fingerprinted policy module invalidates
saved evidence. ADR-0094's saved reports are kept and are now NOT_RUN (stale fingerprint and prompt) when rechecked.

## Measurement

One bounded real-model run on v2 after deterministic verification, frozen first
(`docs/reports/artifacts/ask-my-data-v2-2026-11-20/freeze-before-inference.json`: prompt `cdff4340…`, fingerprint
`17284f1f…`, v2 digests `73e7e265…`/`895036a4…`, `qwen3:8b` `500a1f06…`, Ollama 0.40.16, product defaults).

**Result (2026-11-20, 40 of 40 calls, sequential, no retries, no warm-up): PASS, evidence valid.** Development 20/20 =
100 % exact, held-out 19/20 = 95 %; 0 executable proposals on clarification/refusal cases; 0 technical failures; every
request checked against the profile. The one miss ("Show my check-in, meals and activities") was a conservative
`clarify operation_ambiguous`. Nothing was tuned afterwards; v1 was not rerun. This is a synthetic engineering gate on sets
written from the same policy the code enforces, and the constraints decide most non-plan cases by themselves; it is not
evidence of quality on real questions. **Interpretation stays off by default**; enabling it is a separate decision.
Details: [the report](../reports/ask-my-data-v2-2026-11-20.md).

## Alternatives considered

- **Extending the clarification contract with a partial draft.** Rejected for this slice: it changes a public shape for a
  small gain; the reason plus the existing `sourceChoice` already route to the right field.
- **A general parser or a second model call to validate the first.** Rejected: unbounded and not reviewable.
- **Extracting the benign part of an instruction-bearing question.** Rejected: the instruction region is untrusted; the
  whole question is refused.
- **Keeping the selected date when an explicit other period is named.** Rejected: that is the measured failure.
- **Free date input in the builder.** Rejected: Today's date field already selects any supported date.

## Consequences and limitations

- English and Russian lexicons only; phrasings outside them get conservative clarifications (for example "the manual runs
  I recorded" names two sources).
- The constraints are bounded word rules with masking, not parsing; negation is seen within three words.
- An instruction-bearing question still costs one provider call (accounting unchanged by design).
- Chromium on one workstation only; no physical Safari, hosted CI, real GPS or production run.
