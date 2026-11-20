# "Ask my data" v2 — temporal-grounding correction (ADR-0095, `data-question-constraints-2`), 2026-11-20

A bounded correction of two confirmed defects in the question constraints of "Ask my data" v2
([original report](ask-my-data-v2-2026-11-20.md)). Each defect let a schema-valid, complete model proposal become an
executable plan the question did not ask for. No prompt, wire schema, contract, decision order, threshold, dataset, dataset
digest, migration, operation, dependency or UI changed; **no inference call was made** (no Ollama call, no model download,
no cloud service). The frozen v1/v2 datasets and the historical artifacts in `artifacts/ask-my-data-2026-11-19/` and
`artifacts/ask-my-data-v2-2026-11-20/` are unchanged. Interpretation stays **off by default**. Changes are uncommitted.

Baseline: HEAD `2ef317c` (ADR-0095 docs), clean working tree.

## Summary

| Defect | Reproduced before the fix (supplied answer: comparison, GPX, run, `selected_date`) | Root cause | After |
|---|---|---|---|
| 1. A relative date became the comparison window | "Compare my GPX runs from 28 days ago", "Сравни мои пробежки GPX 28 дней назад", "… from 4 weeks ago", "… 4 недели назад" → **executable intent** at the selected date (evidence: `window.28_days[28 days]`, no temporal evidence) | `window.28_days` ran first among the ordered, masking phrase rules; it masked "28 days"/"4 weeks", so `temporal.relative_day` (`N days ago`) never saw the whole phrase, and rule 8 then accepted the selected context | `clarify period_ambiguous` (rule 4); evidence `temporal.relative_day[28 days ago]` |
| 2. A coordinated second duration was ignored | "Compare my GPX runs over 28 days versus 14 days", "Compare my GPX running over 28 days and 14 days", "Сравни мои пробежки GPX за 28 дней и 14 дней" → **executable intent** (a standard 28-versus-28 comparison) | `range.n_units` required a preposition (over/for/за…) directly before each number; "… and 14 days" has none, so the only evidence was the 28-day window | `unsupported unsupported_calculation` (rule 3); evidence `range.n_units[14 days]` |

Positive controls are unchanged: "Compare my GPX runs over 28 days" and "Compare my TCX cycling for the 28 days up to
yesterday with the previous 28 days." (and their Russian equivalents) are still accepted with `selected_date` and
`yesterday` respectively.

## Correction

`apps/api/src/data-questions/data-question-constraints.ts` (version `data-question-constraints-2`). The three
order-dependent numeric matchers (the 28-day window, the numeric relative day and the qualified range) are replaced by
one reading per numeric duration, done before the ordered phrase rules: an optional range qualifier, one number or a
coordinated list of numbers, a unit, and an optional "ago"/"back"/"(тому) назад". The whole phrase is classified by
meaning, so no matcher can mask part of a longer temporal phrase:

1. day/week + "ago" → `temporal.relative_day`, whatever the number;
2. otherwise 28 days / 4 weeks → `window.28_days`;
3. otherwise `range.n_units` if it has a qualifier, lists several numbers ("28 or 14 days"), or is coordinated with an
   adjacent duration — only a conjunction (and/or/versus/vs/against/with/to/than/plus/compared to; и/или/либо/против/с/
   до/чем/а/по сравнению с) and determiners or qualifiers between them, in either order, without a repeated preposition;
   a bare number after a duration takes its unit ("over 28 days or 14.");
4. otherwise no evidence (month/year durations fall to `range.month_year` as before).

Only a number directly followed by a unit, or joined to one by a conjunction, is read: "my 14 GPX runs over 28 days",
"28 days and 10 km" carry no range evidence. "по" is not a conjunction ("за 28 дней по вчерашний день" names the end
day). The decision order in the normalizer is unchanged; the constraints still only reject proposals and never create
one. Policy: [docs/data-question-constraints-policy.md](../data-question-constraints-policy.md) §1 and §5.

## Regression tests

| File | Added | Before the fix | After |
|---|---|---|---|
| `data-question-constraints.spec.ts` | 52 cases: 10 relative dates (EN/RU, digits and words, "back", "тому назад"); 13 windows kept (qualifiers, hyphenated, ending days, 28 vs previous 28); ending-day symbols; 20 coordinated durations (and/or/vs./against/with/comma, reversed order, number lists, trailing number; и/или/либо/против/с/по сравнению с); 7 unrelated-number controls; bare-duration readings unchanged | **29 failed** (the version pin and every relative/coordinated case) | 84/84 |
| `data-question-normalizer.spec.ts` | Supplied schema-valid comparison answers for every period symbol on 6 relative and 8 coordinated questions; 14 positive controls (EN/RU windows, the TCX ending-yesterday case, today/yesterday/selected-date days, weekly periods); guards never turn a model clarification or refusal into a proposal | (the defect: each question was an executable intent) | 69/69 |
| `data-question-interpretation-service.spec.ts` | 4 questions with the mistaken proposal → bounded `clarify`/`unsupported`, no plan, one provider call, metric and log outcome not `proposal` | — | 15/15 |
| `data-question-evaluation-v2.spec.ts` | The saved ADR-0095 v2 reports are NOT_RUN ("code fingerprint is stale", prompt and dataset digests still current) and PASS only as measured | — | passes |
| `test/data-questions-http.integration.test.ts` | 6 questions (EN/RU) with the mistaken proposal through `POST …/interpretations` (real PostgreSQL, fake provider replaced by a fixed answer) → bounded non-proposal, `no-store`, no `plan`, no service read, no health table, no `data_question.answer` or `proposal` log line; two positive controls still propose | — | see below |

All v2 supplied-answer guard tests (oracle 20/20 per set, exactly one accepted proposal per plan case, no executable
proposal on constraint-decided non-plan cases) and the v1 "exactly two intentional changes" test pass unchanged: no frozen
expectation is decided differently.

## Model evidence

- **Historical measurement (unchanged):** the ADR-0095 run of 2026-11-20, `qwen3:8b`, 40 of 40 calls, development 20/20,
  held-out 19/20, PASS with valid evidence — **for the `data-question-constraints-1` code** (fingerprint `17284f1f…`).
- **Corrected code:** fingerprint `bb97296c…`. The offline check of the saved v2 reports against it answers **NOT_RUN**,
  exit 3, evidence not valid, problems exactly "development: code fingerprint is stale" and "heldout: code fingerprint is
  stale"; the recomputed figures are printed unchanged (20/20, 19/20, 0 executable, 0 technical failures)
  (`artifacts/ask-my-data-v2-temporal-correction-2026-11-20/v2-recheck-current-code.json`, 0 inference calls). The
  provenance checks were not weakened and the historical PASS is not relabelled as current.
- **Status:** there is currently **no valid model evidence for the corrected code**. A new bounded measurement on the
  frozen v2 sets would be needed; it was out of scope (no new inference). Interpretation stays off by default.

## Commands executed and results

| Command | Result |
|---|---|
| Reproduction before the fix (supplied answers through `decideDataQuestion`, scratch script) | all 7 defect questions (plus the two 4-weeks variants) → `accepted`, executable intent |
| Same script after the fix | 4 relative questions → `temporal` / `clarify period_ambiguous`; 3 coordinated → `range` / `unsupported unsupported_calculation`; 3 positive controls → `accepted` |
| New constraints tests against the original module (temporarily restored, then put back) | **29 failed**, 55 passed |
| Focused API: `vitest run src/data-questions src/evaluation/data-question*` | 10 files, **243 passed** (was 157) |
| `npm run verify` with `VITEST_MAX_WORKERS=2` | exit **0**: lint, typecheck, scripts 115, API **2,687**, web **1,409**, contracts **322**, fixtures 14, simulator 3, build |
| Test database identities (read-only `BEGIN READ ONLY … ROLLBACK` probe, before any write) | each role: target `127.0.0.1:5433/running_tracker_test`, server `172.18.0.2:5432`, PostgreSQL 17.5; `current_user` = `session_user` = `running_tracker_runtime` / `running_tracker_owner` / `running_tracker_maintenance` |
| Integration (`VITEST_MAX_WORKERS` unset): `data-questions-http.integration.test.ts` | **24 passed** (+1: the mistaken-proposal test, also run alone by name) |
| Chromium `ask-my-data.spec.ts` (after the builds finished; no rebuild while servers ran) | **16 passed** |
| `eval:data-questions --check --dataset-version v2` on the saved v2 reports | exit **3**, NOT_RUN, "code fingerprint is stale" (both sets), 0 inference calls |
| `git diff --check` | clean |

## Limitations

- English and Russian lexicons only; spelled numbers outside the lexicon ("one", "seventeen") and ellipses such as "over
  28 days or 14 more" give no range evidence.
- Word rules with masking, not parsing (unchanged).
- No model run against the corrected code (by scope); the v2 PASS is historical only.
- Chromium on one workstation only; no physical Safari, hosted CI, real GPS or production verification.
