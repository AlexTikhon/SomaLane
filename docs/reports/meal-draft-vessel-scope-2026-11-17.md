# Meal draft: one vessel-scope analysis for proposals and conflicts (closeout, 2026-11-17)

**Current and authoritative** for the vessel scope of "Draft from text" ([ADR-0092](../adr/0092-meal-draft-from-text.md),
Amendment 7), with the follow-up of 2026-11-18 (overlapping constructions, at the end). **The model evidence below is
stale** since that follow-up changed a fingerprinted file (`eb22d827…` → `9a069010…`); the model gate FAILs with
`FINGERPRINT_MISMATCH` until a new 40-call run. The policy is [docs/meal-draft-vessel-scope-policy.md](../meal-draft-vessel-scope-policy.md); the
machine-readable acceptance matrix is
[`apps/api/evaluation/meal-draft.challenge.v1.json`](../../apps/api/evaluation/meal-draft.challenge.v1.json). It
supersedes the vessel parts of [meal-draft-container-relation-2026-11-17.md](meal-draft-container-relation-2026-11-17.md)
and [meal-draft-container-scope-2026-11-16.md](meal-draft-container-scope-2026-11-16.md), which stay as history.
Workstation evidence only (Windows 11, Node.js 24.11.1, CPU); no hosted CI run and no physical device.

## Why

Over one day, five follow-ups corrected the vessel rules of the grounding (adjacency, clause classification, Russian
food qualifiers, unknown qualifiers, per-mention attribution). Each fix was local, and the mechanism that carried them
had become three overlapping ones: a global context test, a statement-wide attribution of every number on a line or
sentence, and mention-specific "protected" exclusions. They disagreed. The last reproduction showed it plainly: in
"Whole pot blorped\n900 kcal, protein 80 g, the whole pan has 1200 kcal. In total I ate protein 20 g." the confirmed
construction later on the line attributed the whole line to a vessel, only the first figure next to the unresolved
clause was protected, so protein 80 dropped out of the conflict scan and 20 was **proposed**. With the protein first
("Protein 80 g, 900 kcal, …") the same text was withheld: the result depended on which nutrient came first.

## Design

One analysis of the ORIGINAL text, computed once per claim and handed to both the proposal check and the conflict scan
(it is not cached, so nothing of the person's text outlives the call):

| Module | Responsibility |
|---|---|
| `meal-draft-lexicon.ts` | the shared vocabulary (units, nutrient names, word boundaries, signs), moved unchanged |
| `meal-draft-mentions.ts` | number tokens, exact decimals, `checkMention`, clauses and sentences (moved unchanged), and the new `mentionStructure`: every nutrient mention of every field with its exact decimal and span, grouped into coordinated **lists** |
| `meal-draft-vessel-scope.ts` | the vessel vocabulary, supported constructions and clause classification (moved unchanged), and the new `analyzeVesselScope`: every vessel **context** with its span and the lists it attaches to, and one **attribution** per list (`confirmed`, `unresolved`, `none`) |
| `meal-draft-grounding.ts` | everything else, unchanged; `scopeReason` and `distinctStatedValues` now read the analysis |

- **Lists.** Mentions joined only by inline whitespace, commas and "and/plus/&/и/плюс" on one line (or a comma before a
  line break) form one list; a word, a sentence end, a colon, a parenthesis or a bare line break ends it.
- **Contexts attach to lists, not lines.** A supported construction ("The whole pot is 900 kcal") attaches to the list
  of the figure it names, so its coordinated members come with it ("…, protein 80 g") and nothing else on the line does.
  A vessel clause next to a figure (across punctuation only) attaches to the adjacent list: a label confirms it, an
  explicit action leaves it unattributed, anything else makes it unresolved.
- **Precedence.** Any unresolved context wins (an unresolved clause; a label next to figures on both sides; a
  construction whose own words are also read as an action clause). Otherwise a confirmed context wins. An action alone
  changes nothing.
- **Eligibility.** A mention is proposed only with no attribution, and, whenever the text has a per-portion qualifier,
  label, package, partial amount or any confirmed/unresolved vessel context, only as an explicit consumed total in a
  sentence free of all of those (the existing global rule). The conflict scan leaves out only mentions excluded by the
  per-portion/package rule and mentions attributed to a CONFIRMED vessel. So a mention removed from the conflict scan is
  exactly one that can never be proposed, and an unresolved mention can never disappear from it.

Trade-offs, chosen deliberately: a list does not continue across a bare line break, so values on further lines under a
label heading are ordinary values (withheld for a proposal by the global rule, kept in the conflict scan); a batch that
was cooked is unresolved rather than a confirmed vessel figure, so a consumed total beside it is withheld as
`conflicting`; the per-portion/package policy stays global and therefore asymmetric with vessels (unchanged, and
characterised by tests). Superseded code removed: the per-reading `hasContainerContext`, `VesselReading`, the
statement-wide `statementAround` attribution and the "protected figure" exclusions.

## Acceptance matrix (challenge set v1)

Written with the policy and frozen by digest (`f521a88f…`) **before** the engine was rebuilt; run against the previous
engine first: **8 of 74 claimed fields failed** (7 unsafe acceptances, 1 missed control), the other 57 cases passed.
After: **PASS**, 65 cases, 74 claimed fields, 0 unsafe acceptances, positive controls **23/23**, 0 reason mismatches
(artifact `challenge-after.json`). It fixes reason codes as well as values.

| Category | Cases | Content |
|---|---|---|
| mixed-context | 6 | an unresolved list beside confirmed statements of the same and other fields, before and after, EN/RU, CRLF; the all-confirmed control proposes |
| unresolved-list | 8 | protein, fat, carbs and energy in 2nd, 3rd and 4th position; RU; an unresolved and a confirmed context on the same list; CRLF and decimal commas |
| batch | 5 | "I cooked a full pot of soup.\n900 kcal", "Сварила полную кастрюлю супа\n900 ккал" withheld; a different consumed total beside a batch `conflicting` |
| confirmed-consumed | 7 | "The whole pot has 900 kcal. In total I ate 300 kcal." (900 withheld, 300 proposed); "The whole pot is 900 kcal, protein 80 g. In total I ate 300 kcal, protein 20 g." (both container figures withheld, both totals proposed); RU; two consumed totals conflict; an action after a confirmed figure changes nothing |
| unrelated-action | 8 | "Cooked soup in a full pot. Lunch, 300 kcal." proposes 300; "Washed the whole pan. Protein 25 g. In total I ate protein 20 g." and "Полная кастрюля помыта\n400 ккал. Итого съела 300 ккал." `conflicting`; "Soup, 300 kcal\nWhole pot washed afterwards" proposes 300; the same-line "помыта, 900 ккал" contradiction |
| label | 9 | "Whole pot\n900 kcal", "900 kcal\r\nWhole pot", "Full pot. 900 kcal.", "Soup, 900 kcal (whole pot).", "Soup, 900 kcal (for the whole pot).", "(Whole pot)\n900 kcal", "Полная кастрюля супа\n900 ккал" withheld; consumed total beside a parenthesized label proposed; a label between two figures labels neither |
| unknown-qualifier | 6 | "Полная кастрюля окрошки\n900 ккал", "900 ккал\r\nПолная кастрюля окрошки", "Полная кастрюля салата.\nБелки 80 г." and synthetic qualifiers ("зюмбры", "zindled", "кваклы") withheld |
| positive-control | 8 | food names and sources, all four fields with zero and a decimal comma, a plain conflict, equal decimals and an unresolved duplicate without a manufactured conflict, a repeated excerpt judged at its first occurrence |
| global-policy | 8 | the per-portion and package policy characterised unchanged (an unscoped value beside a package leaves the scan, beside a vessel it does not), a bound, a negation and a per-serving qualifier keep their own reasons beside vessel contexts |

## Generated invariants

`meal-draft-grounding-vessel-invariants.spec.ts` (32 tests; expectations stated from the policy, never computed by the
analyzer) failed **2** against the previous engine (the two permutation sweeps) and passes after:

- every one of the 24 orders of a four-nutrient unresolved list, under 4 unresolved headings per language (unknown and
  synthetic words, prepared batches), LF and CRLF, with and without a confirmed statement on the same line, keeps the
  conflict for each field's consumed total (1,536 checks per language) and never proposes a member;
- every order of a confirmed coordinated list against permuted consumed lists, across a space, LF and CRLF: container
  figures withheld, consumed totals proposed exactly;
- adding a confirmed statement of any field before, between or after never erases an unresolved conflict;
- an action (five per language) placed anywhere keeps a plain conflict and a plain value;
- multiple mentions under one heading; zero and equivalent decimal spellings; duplicates without a manufactured
  conflict; repeated excerpts; bounds, negations, ranges and per-serving qualifiers beside six kinds of vessel context;
- every proposal keeps its original excerpt and exact numeric equality (over 20 proposals checked), and the established
  positive controls still pass.

## Verification (final code)

| Check | Result |
|---|---|
| Focused: `vitest run src/meals src/evaluation` | **581 passed** (21 files); before: 537 on the starting tree |
| New tests against the previous engine (written first) | challenge spec 1 of 7 failed (8 fields), invariants 2 of 32 failed, new `meal-drafts-http` case failed on its first text (20 proposed); controls passed |
| Fingerprint coverage | the closure now lists `meal-draft-lexicon.ts`, `meal-draft-mentions.ts`, `meal-draft-vessel-scope.ts`; four new mutation probes (precedence, action vocabulary, list continuation, a shared unit) each change the digest and turn the model gate into `FINGERPRINT_MISMATCH` |
| `npm run eval:meal-drafts -- --set safety` (unchanged corpus) | exit **0**, verifier **PASS**: 0 of 191 forbidden, controls 21/21, 0 mismatches; **0 of 53 cases changed**; fingerprint `45e1821c…` → `eb22d827…` |
| `npm run eval:meal-drafts -- --set challenge` | exit **0**, PASS (above), reported separately |
| Differential, previous vs final engine | 1,036 texts, 1,378 mention claims, **8 changed** (all intended, listed below) |
| Test database identity (read-only probe, deleted) | runtime, owner and maintenance: `127.0.0.1:5433/running_tracker_test`, server `172.18.0.2:5432`, `current_user` = `session_user` = `running_tracker_runtime` / `running_tracker_owner` / `running_tracker_maintenance`; `db:migrate:test` skipped every migration (0042 newest) |
| `npm run verify` (`VITEST_MAX_WORKERS=2`) | exit **0** (486 s): lint, typecheck, build; scripts 115, API **2,397**, web 1,334, contracts 311, fixtures 14, simulator 3 |
| `npm run test:integration` (`VITEST_MAX_WORKERS` unset; throwaway backup key generated into the session scratchpad and set in the process only) | exit **0**: **79 of 79 files, 1,149 passed** (378 s), `backup-restore` included |
| `npm run test:e2e` (Chromium and OIDC, after the build, nothing edited meanwhile) | exit **0**: **170 passed** (15.8 min), the four meal-draft scenarios included |
| `npm run test:e2e:firefox` | exit **0**: **18 passed** (3.4 min) |
| `git diff --check` | clean |

An earlier Chromium run was stopped by me after about a minute to remove a per-text cache of the analysis (it kept the
last person's text in memory beyond the call); every check above was then rerun from the start on the final code. The
build regenerates `packages/contracts/openapi/openapi.json`, which Git lists as modified although its bytes equal HEAD
(SHA-256 `338b5a3b…`): a stat-only entry, no contract change. No pre-existing failure was found in any suite.

## Model evidence (after the deterministic work was complete and frozen)

> **Stale since 2026-11-18.** Measured at fingerprint `eb22d827…`. The overlapping-constructions follow-up changed
> `meal-draft-vessel-scope.ts` (fingerprint `9a069010…`), and `eval:meal-drafts:check` on these two reports now exits 2:
> the model gate FAILs with `FINGERPRINT_MISMATCH` for both. The reports and artifacts are kept unchanged as history.

Frozen first (`freeze-before-inference.txt`: SHA-256 of the four grounding modules, prompt, wire, Ollama adapter, the
meal-draft configuration, the three v1 sets, the safety corpus, the challenge set, the gate and evaluation code, and the
tracked non-doc diff); recorded again after the runs (`freeze-after-inference.txt`): **identical**. Local Ollama 0.40.16
on loopback, `qwen3:8b` already installed (digest `500a1f06…`), no model loaded beforehand (cold), CPU only; product
defaults with only `MEAL_DRAFTS_MODEL` set (deadline 45 000 ms, temperature 0, think false, num_ctx 4096, num_predict
600, stream false); one call per case, sequential, no retries, no warm-up, stop rule kept (not triggered); nothing pulled,
no cloud, no tuning. **40 of 40 inference calls** (20 development, 20 held-out).

| Gate (`eval:meal-drafts:check`, offline, final code) | Status | Numbers |
|---|---|---|
| Verifier | **PASS** | 0 of 191 forbidden accepted; controls 21/21; mismatches 0 |
| Model | **PASS** (marginal) | evidence valid (fingerprint `eb22d827…`, one profile); both sets complete; **0 incorrectly accepted**; outcome 34/40 = **85.0 %** (threshold 85 %); recall 27/31 = 87.1 %; precision 100 %; failures 3/40 = 7.5 % (1 cold-start `timeout` at 45 135 ms, 2 Russian food-weight `ungrounded_output`); EN and RU each outcome 17/20 |
| Overall | **PASS**, exit 0 | permits further local experimentation only |

Every one of the 40 results (outcome, failure, reason and each field's proposal or withholding) equals the previous
40-call run of 2026-11-17, case for case; the six outcome misses are the same (`en-dev-full` cold timeout,
`en-dev-injection` and `en-ho-thousands` answered `estimate_requested`, `ru-ho-conflict` `not_a_meal`, `ru-dev-food-weight`
and `ru-ho-food-weight` `ungrounded_output`). The verifier withheld 4 wrong model claims. No v1 case contains a vessel
phrase, so this run shows only that the rebuild cost no recall or precision on those sets; it says nothing about the
vessel rules, which only the corpus, the challenge set and the tests exercise. These are **regression measurements on
examined synthetic sets**, not held-out or generalisation evidence, and a model that abstains proves nothing about the
verifier. Outcome accuracy sits exactly at its threshold. **The feature stays off by default.**

Artifacts in `docs/reports/artifacts/meal-draft-vessel-scope-2026-11-17/`: `verifier-safety-before.json`,
`verifier-safety-after.json`, `challenge-after.json`, `freeze-before-inference.txt`, `freeze-after-inference.txt`,
`qwen3-8b-development.json`, `qwen3-8b-heldout.json`, `gates-check.json`.

## Public behaviour

Retained: endpoint, request and response contracts, reason codes (no new code; unresolved and confirmed mentions are
withheld as `per_portion`, possible contradictions as `conflicting`), wire schema, prompt, provider defaults, off by
default, titles, meal types, exact decimal validation, contract bounds, bounds, negations, ranges, units, hedges,
instructions, authorization and access revalidation, admission limits, cancellation, provider lifetimes, apply to the
editable form and ordinary manual save, and privacy (no text, answer or value added to logs or persistence; the analysis
is a per-call value, never cached).

Changed, measured by a differential run of the previous engine against this one over every nutrient mention of 1,036
known texts (the frozen v1 sets, the safety corpus, the challenge set and the literals of every grounding spec; 1,378
mention claims): exactly 8 results changed, all intended.

| Text (claim) | Before | After |
|---|---|---|
| "Whole pot blorped\n900 kcal, protein 80 g, the whole pan has 1200 kcal. In total I ate protein 20 g." (20) | **proposed 20** | `conflicting` |
| "…\n900 kcal, protein 80 g, fat 45 g, carbs 120 g, the whole pan has 1200 kcal. In total I ate fat 15 g." (15) | **proposed 15** | `conflicting` |
| "…\nfat 45 g, 900 kcal, protein 80 g, carbs 120 g, the whole pan has 1200 kcal. In total I ate carbs 40 g." (40) | **proposed 40** | `conflicting` |
| "…\nprotein 80 g, fat 45 g, carbs 120 g, 900 kcal, the whole pan has protein 99 g. In total I ate 300 kcal." (300) | **proposed 300** | `conflicting` |
| "Полная кастрюля окрошки\n900 ккал, белки 80 г, жиры 45 г, углеводы 120 г, вся сковорода содержит 1200 ккал. Итого съела жиры 15 г." (15) | **proposed 15** | `conflicting` |
| "Whole pot blorped\n900 kcal, protein 80 g for the whole pan. In total I ate protein 20 g." (20) | **proposed 20** | `conflicting` |
| "Soup 400 kcal\nWhole pot\n900 kcal. In total I ate 300 kcal." (300) | **proposed 300** | `conflicting` |
| "The whole pot has 900 kcal.\nWhole pot washed afterwards. In total I ate 300 kcal." (300) | `conflicting` | **proposed 300** |

Probing shapes no corpus contains found two more changes, both toward abstention: "In total I ate 300 kcal. Whole pot."
now withholds 300 (`per_portion`: a label next to a figure attributes it, and an attributed value is never proposed), and
"Soup, 300 kcal, the whole pot has 900 kcal. In total I ate 300 kcal." is now `conflicting`. **Correction
(2026-11-18):** that probe claimed only the final 300. The same text claiming a final 900 was **proposed** by this
engine, an unsafe acceptance caused by the left-to-right overlap handling described under Limitations as conservative.
It is fixed by the follow-up below.

## Limitations

- A bounded verifier: English and Russian as listed in the policy, nothing else. Unknown vocabulary is unresolved, never
  an action, so an unlisted harmless verb over-abstains ("Soup, 300 kcal. Whole pot went back on the shelf." withholds
  300).
- Lists end at a bare line break: values on further lines under a label heading are ordinary values (withheld for a
  proposal by the global rule and kept in the conflict scan), which can withhold a consumed total that could have been
  proposed.
- A prepared batch is unresolved, not a confirmed vessel figure, so a different consumed total beside it is withheld as
  `conflicting` rather than proposed.
- Overlapping constructions (corrected 2026-11-18). This engine matched constructions left to right without overlap,
  and an earlier version of this list called that conservative. It was not. In "Soup, 300 kcal,
  the whole pot has 900 kcal" the reading "300 kcal, the whole pot" took the vessel and confirmed 300, which took **300
  out of the conflict scan**, so "… In total I ate 900 kcal." proposed 900 instead of `conflicting`. Since the follow-up
  below, every construction is matched from every position, and readings of one vessel word that attach to different
  lists make all of those lists unresolved.
- Competing constructions are recognised only when they share a vessel word inside the supported constructions. Two
  different vessel words ("the whole pot … the whole pan") are two references, each judged on its own.
- The per-portion/package policy is global and asymmetric with vessels by design (unchanged): an unscoped value beside
  a package statement leaves the conflict scan, one beside a vessel statement elsewhere does not.
- The challenge set and the invariant tests were written by the engineers who wrote the policy; they are engineering
  regression evidence, not independent held-out evidence.

## Changed files (for a whole-diff review)

Runtime (fingerprinted): `apps/api/src/meals/drafts/meal-draft-grounding.ts` (vessel section and token/mention helpers
moved out; `scopeReason`, `wholeEntryScoped`, `distinctStatedValues` read the analysis), `meal-draft-vessel-scope.ts`
(new: vessel vocabulary, constructions and clause classification moved unchanged; the analysis), `meal-draft-mentions.ts`
(new: tokens, decimals, `checkMention`, clauses, sentences moved unchanged; `mentionStructure`), `meal-draft-lexicon.ts`
(new: shared vocabulary moved unchanged). Evaluation (not fingerprinted): `apps/api/src/evaluation/meal-draft-challenge.ts`
(new runner), `meal-draft-evaluation-cli.ts` (`--set challenge`), `apps/api/evaluation/meal-draft.challenge.v1.json`
(new, frozen). Tests: `meal-draft-grounding-vessel-invariants.spec.ts` (new), `meal-draft-challenge.spec.ts` (new),
`meal-draft-gates.spec.ts` (fingerprint coverage, four mutation probes, CLI), `meal-draft-grounding-container-relation.spec.ts`
(the earlier uncommitted follow-ups' tests; one test title reworded after the post-run freeze record, assertions
unchanged, 581 focused tests rerun), `apps/api/test/meal-drafts-http.integration.test.ts` (the earlier follow-ups' cases
and one new case). Docs: the policy, this report and its artifacts, ADR-0092 Amendment 7, the runbook, a supersession
note in the container-relation report, `docs/progress.md`. Not changed: contracts (`openapi.json` is listed by Git only
because the build rewrote identical bytes), the service, the wire schema, the prompt, configuration, the web app, the
frozen sets and corpus, the gate thresholds and every earlier artifact. Uncommitted, not pushed, not deployed.

## Follow-up: overlapping constructions (2026-11-18)

**Defect.** "Soup, 300 kcal, the whole pot has 900 kcal. In total I ate 900 kcal.", claim `{ value: "900", evidence:
"ate 900 kcal" }`: **proposed 900**; required `conflicting`. The constructions were one alternation matched left to
right without overlap. The qualifying reading "300 kcal, the whole pot" matched first, confirmed 300 and took it out of
the conflict scan. The overlapping subject reading "the whole pot has 900 kcal" was never seen, so 900 had no
attribution and equalled the consumed total. The Limitations entry that called this conservative is corrected above.

**Change** (`meal-draft-vessel-scope.ts` only; no other runtime file). The supported constructions are unchanged, but
each is now its own pattern, matched from every position (`constructionContexts`). A reading is the vessel words a
match contains plus the lists it attaches to:

- readings with the same vessel words and lists are one context (span = their union), so equivalent matches create no
  ambiguity ("900 kcal for the whole pot" from "900" and from "kcal"; "вся кастрюля содержит" from "вся" and from
  "кастрюля");
- readings that contain the same vessel word but attach to different lists compete, and each is `unresolved`. By the
  existing precedence, every list they attach to is unresolved: it stays in the conflict scan and is never proposed;
- the action-clause contradiction is kept per reading, and clauses, lists, precedence, proposal eligibility and the
  conflict scan are unchanged. Both operations still read the one analysis.

No text-specific exception was added. Contracts, reason codes, wire, prompt, provider defaults, configuration, frozen
sets, the safety corpus, the challenge set (digest `f521a88f…`, unchanged) and every earlier artifact are unchanged.

**Tests first.** These were added to `meal-draft-grounding-vessel-invariants.spec.ts`, and 6 of the new tests failed
on the previous engine, each with the defect (a value proposed where `conflicting` was required):

- the reproduction;
- the same text with a final 300;
- "I ate 300 kcal, the whole pot has 900 kcal. In total I ate 900 kcal.";
- every field in EN and RU across a space, LF and CRLF, with exact decimals ("fat 15,5 g … fat 45.5 g … fat 45,50 g",
  "300,0 ккал … 900.00 ккал");
- all 24 orders of the first list against rotated orders of the second, for every member as the final total (384 checks
  per language), with no member proposable.

These passed both before and after: an unrelated confirmed statement and an unrelated list stay as they were, equal
values manufacture no conflict, and seven equivalent-overlap shapes keep proposing the consumed total. Two positive
controls were added ("900 kcal for the whole pot. In total I ate 300 kcal."; a confirmed energy + protein + fat list
followed by consumed totals). The new `meal-drafts-http` case ("keeps both lists of competing vessel constructions in
conflict detection", evidence `ate 900 kcal` / `съела 900 ккал` naming the final consumed occurrence, CRLF in RU, plus
the two equivalent-reading controls) failed on the previous engine (900 proposed) and passes now. A mutation that drops
the deduplication and lets any two readings of one vessel compete fails 4 tests, the equivalent-overlap test included.

**Before → after**, by a differential of the previous and the new engine over every nutrient mention of 1,365 texts
(the frozen v1 sets, the safety corpus, the challenge set, the single-quoted literals of every grounding spec and the HTTP
test, and generated EN/RU competing and equivalent shapes), with each claim's evidence widened until it names that
occurrence (2,028 claims): **38 results changed**, all from **proposed** to `conflicting`. Every one is a competing-
construction text whose final consumed total equals the vessel-subject figure: the reproduction and its LF/CRLF forms,
"I ate 300 kcal, the whole pot has 900 kcal…", the protein, fat and carbohydrate forms, the Russian forms, and the
two exact-decimal texts. None of them is in a frozen set, the safety corpus or the challenge set, and no other result
changed. "Soup, 300 kcal, the whole pot has 900 kcal. In total I ate 300 kcal." was already `conflicting` and stays so.

| Check (final code) | Result |
|---|---|
| `vitest run src/meals src/evaluation` | **593 passed** (21 files); 581 before, +12 new |
| `eval:meal-drafts -- --set safety` (unchanged corpus) | before and after exit **0**, verifier **PASS**: 0 of 191 forbidden, controls 21/21, 0 mismatches; **0 of 53 per-case results changed**; fingerprint `eb22d827…` → `9a069010…` |
| `eval:meal-drafts -- --set challenge` (unchanged set) | before and after exit **0**, PASS: 65 cases, 74 fields, 0 unsafe, controls 23/23, 0 reason mismatches; **0 of 65 per-case results changed** |
| `eval:meal-drafts:check` with the saved `qwen3-8b-development.json` and `qwen3-8b-heldout.json` (offline) | exit **2**: model gate FAIL, `FINGERPRINT_MISMATCH` for both reports (`meal-draft-vessel-scope.ts (changed)`); the reports are **stale** |
| Test database identity (read-only probe in the scratchpad, `BEGIN READ ONLY`, nothing written) | runtime, owner and maintenance: `127.0.0.1:5433/running_tracker_test`, server `172.18.0.2:5432`, `current_user` = `session_user` = `running_tracker_runtime` / `running_tracker_owner` / `running_tracker_maintenance`; `db:migrate:test` skipped every migration (0042 newest) |
| `vitest --config vitest.integration.config.ts` `meal-drafts-http` + `meals-access` | **2 files, 86 passed** |
| `npm run verify` (`VITEST_MAX_WORKERS=2`) | exit **0** (432 s): lint, typecheck, build; scripts 115, API **2,409**, web 1,334, contracts 311, fixtures 14, simulator 3 |
| `git diff --check` | clean (and no trailing whitespace in the touched untracked files) |

Not run for this follow-up: the full integration suite (only the two meal files above), the browser suites, and any
model (no Ollama call). `openapi.json` is listed as modified only because the build rewrites it. Its content equals
HEAD. Uncommitted, not pushed.
