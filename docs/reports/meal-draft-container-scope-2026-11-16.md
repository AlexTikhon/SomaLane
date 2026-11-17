# Meal draft: container-scope remediation and fresh model baseline (2026-11-16)

Decision record: [ADR-0092](../adr/0092-meal-draft-from-text.md), section "Amendment 6". Runbook:
[meal-drafts.md](../runbooks/meal-drafts.md). Raw reports:
[artifacts/meal-draft-container-scope-2026-11-16/](artifacts/meal-draft-container-scope-2026-11-16/). Earlier results,
unchanged: [meal-draft-evaluation-2026-11-16.md](meal-draft-evaluation-2026-11-16.md) (checkpoint and Amendment 5) and
[meal-draft-model-evaluation-2026-11-14.md](meal-draft-model-evaluation-2026-11-14.md).

## Verdict

| Gate | Status | Evidence |
|---|---|---|
| **Verifier** (deterministic, frozen safety corpus v1, supplied claims, no model) | **PASS**, exit 0 | 53/53 cases executed; **0** of 191 forbidden values accepted; positive controls **21/21**; outcome mismatches **0** |
| **Model** (`qwen3:8b`, frozen v1 development + held-out, current tool) | **PASS**, marginal | Report version 3, current fingerprint, one consistent execution profile, both sets complete; 0 incorrectly accepted; outcome **34/40 = 85.0 %** (threshold 85 %); recall 27/31 = 87.1 %; precision 100 %; failures 3/40 = 7.5 % |
| **Overall** (`npm run eval:meal-drafts:check`) | **PASS**, exit 0 | [gates-check.json](artifacts/meal-draft-container-scope-2026-11-16/gates-check.json) |

The two gates are judged separately and are not a score. A PASS on both **permits further local experimentation
only**: it is not a product, safety or generalisation claim. **The feature stays off by default.** The held-out set v1
was first run and examined on 2026-11-14, so its rerun is **regression evidence, not fresh held-out evidence**. Outcome
accuracy sits exactly at its threshold: one more wrong outcome fails the model gate on quality.

## What changed

Only the grounding (`apps/api/src/meals/drafts/meal-draft-grounding.ts`): a new `WHOLE_CONTAINER` pattern joined to the
existing `CONTAINER_OR_PARTIAL` (through `hasContainerContext`) in `wholeEntryScoped`. A figure for a whole cooking
vessel or batch is context like a package total: every value must then be the person's own consumed total under the
existing rule (summing phrase + consumption verb bound to the value, in a sentence with no qualifier, container or food
amount), otherwise it is withheld as `per_portion` (the existing reason).

Counted constructions (fixed EN/RU list, any whitespace between words, never inside a longer word): a whole-quantifier on
the vessel ("whole/entire/full pot", "all of the pot", "вся/всю/целая/полная кастрюля", "весь казан", "кастрюля
целиком"); the vessel as the subject of a figure ("the pot has/is/contains … 900 kcal", not after "from"/"out of";
"Pot: 900 kcal" at a clause start; the Russian nominative "Кастрюля 900 ккал", "Кастрюля содержит 900 ккал"); a figure
located in the vessel ("в кастрюле 900 ккал", "in the pot: 600 kcal"). Vessels: pot, pan, saucepan, skillet, batch;
кастрюля, кастрюлька, сковорода, сковородка, казан. A vessel word alone is not context, so food names and cooking
references keep their values.

Unchanged: prompt (`meal-draft-prompt-1`, digest `f53aeae5…`), wire schema, public contracts, reason codes, apply/save,
provenance, provider defaults, off by default, evaluation tool, gates, thresholds, fingerprint rules, the frozen corpus
(`35a51437…`) and sets, every earlier artifact. No dependency, no migration.

## Before and after on the frozen corpus

| | Before (HEAD `ba5854d`, clean tree) | After (uncommitted) |
|---|---|---|
| Status, exit | **FAIL**, 2 | **PASS**, 0 |
| Forbidden accepted | 2 (`en-container-pot-unlisted`, `ru-container-pot-unlisted`, energy 900 each) | **0** |
| Controls / mismatches | 21/21 / 0 | 21/21 / 0 |
| Cases changed | | exactly those 2 (now `withheld_ok` on every field); 51 identical |
| Verifier fingerprint | `d191b0e4…` | `c1d44a46…` (grounding file only) |

Reports: [verifier-safety-before.json](artifacts/meal-draft-container-scope-2026-11-16/verifier-safety-before.json),
[verifier-safety-after.json](artifacts/meal-draft-container-scope-2026-11-16/verifier-safety-after.json).

Behaviour examples (all covered by unit tests):

| Text | Result |
|---|---|
| "Soup from the pot; the whole pot is 900 kcal" / "Суп из кастрюли; вся кастрюля 900 ккал" | 900 withheld `per_portion` (was proposed) |
| "The whole pot has 900 kcal. In total I ate 300 kcal." / "Вся кастрюля 900 ккал. Итого съел 300 ккал." | 900 withheld, **300 proposed**, no conflict |
| "Chili. The whole pot is 900 kcal, protein 80 g. In total I ate 300 kcal, protein 0 g, fat 2.50 g, carbs 30,5 g." | 300, 0, 2.5, 30.5 proposed; 900 and 80 withheld |
| "The whole pot has 900 kcal. In total 300 kcal." | 300 withheld (no consumption verb: existing rule) |
| "Pot roast, 500 kcal", "Pan-fried salmon, 400 kcal", "Soup from the pot, 300 kcal", "Soup from the pot is 300 kcal", "Суп из кастрюли, 300 ккал", "Плов из казана, 700 ккал" | proposed (food name or cooking reference) |

## Fresh model baseline

Setup, fixed before the first call and verified unchanged afterwards
([freeze-before-inference.txt](artifacts/meal-draft-container-scope-2026-11-16/freeze-before-inference.txt): SHA-256 of
grounding, prompt, wire schema, datasets, safety corpus and gate file, the tracked diff and the untracked spec; all
equal after the runs):

- Code: HEAD `ba5854d` plus this slice's uncommitted files (each report lists the dirty paths). Fingerprint
  `c1d44a465a726e88f0a15bbb51415f1c18b515b4093136a22eb7e0634e5cf095`.
- Local Ollama 0.40.16 on `127.0.0.1:11434`; `qwen3:8b` already installed, digest
  `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` (Q4_K_M); `/api/ps` empty before the run (cold
  load, no warm-up). CPU only. Nothing pulled; no cloud model or fallback.
- Product defaults (only `MEAL_DRAFTS_MODEL=qwen3:8b` set): deadline 45 000 ms, `temperature 0`, `think false`,
  `num_ctx 4096`, `num_predict 600`, `stream false`, response ≤ 32 768 B, retries 0, one sequential call per case;
  three-identical-systemic-failures stop rule kept (not triggered).
- **Inference calls: 40 of 40** (development 20, finished 17:28:27Z; held-out 20, finished 17:34:34Z). The dry run made
  no inference request. No retry, no warm-up, no other call.

| | Development | Held-out | Both | Legacy 2026-11-16 (v2, stale) |
|---|---|---|---|---|
| Outcome correct | 17/20 | 17/20 | **34/40 (85.0 %)** | 34/40 |
| Reason correct | 4/4 | 3/3 | 7/7 | 7/7 |
| Title contains expected words | 12/13 | 14/14 | 26/27 | 26/27 |
| Meal type correct | 13/13 | 14/14 | 27/27 | 27/27 |
| Recall | 13/16 | 14/15 | **27/31 (87.1 %)** | 27/31 |
| **Incorrectly accepted** | **0** | **0** | **0** | 0 |
| Precision | 100 % | 100 % | 100 % | 100 % |
| Claimed by the model and withheld by the verifier | 1 | 3 | 4 | 4 |
| Failures | 1 `timeout`, 1 `ungrounded_output` | 1 `ungrounded_output` | **3 (7.5 %)** | 3 |
| Latency p50 / p95 / max (ms) | 17 472 / 35 024 / 45 210 | 17 870 / 30 821 / 39 834 | | |

By language: EN outcome 17/20, recall 87.5 %, 0 incorrect, 1 failure; RU outcome 17/20, recall 86.7 %, 0 incorrect, 2
failures.

Outcome misses, identical in case and result to the legacy run:

| Case | Result |
|---|---|
| `en-dev-full` | `timeout` at 45 210 ms: the first call, a cold model load on CPU |
| `en-dev-injection` | `unsupported estimate_requested` |
| `en-ho-thousands` | `unsupported estimate_requested` |
| `ru-ho-conflict` | `unsupported not_a_meal` |
| `ru-dev-food-weight` | `ungrounded_output` (title not an excerpt) |
| `ru-ho-food-weight` | `ungrounded_output` |

None of the corpus's container shapes occurs in the v1 sets, so this run says nothing about the new rule; it shows that
the corrected grounding did not cost recall or precision on these sets. Model restraint is not verifier evidence.

Reports: [qwen3-8b-development.json](artifacts/meal-draft-container-scope-2026-11-16/qwen3-8b-development.json),
[qwen3-8b-heldout.json](artifacts/meal-draft-container-scope-2026-11-16/qwen3-8b-heldout.json). Fake-provider harness
(harness verification, **not** model evidence), unchanged: development 0 incorrect, recall 15/16, 6 wrong claims
stopped; held-out 0 incorrect, 15/15, 6 stopped
([fake-harness-development.json](artifacts/meal-draft-container-scope-2026-11-16/fake-harness-development.json),
[fake-harness-heldout.json](artifacts/meal-draft-container-scope-2026-11-16/fake-harness-heldout.json)).

## Commands (repository root, in this order)

```text
npm run eval:meal-drafts -- --set safety --out <artifacts>/verifier-safety-before.json      # exit 2 (FAIL, 2 forbidden)
# regressions written, 13 of 16 failing; grounding changed; regressions passing
npm run eval:meal-drafts -- --set safety --out <artifacts>/verifier-safety-after.json       # exit 0 (PASS)
npm run eval:meal-drafts -- --set development --provider fake --out <artifacts>/fake-harness-development.json   # exit 0
npm run eval:meal-drafts -- --set heldout --provider fake --out <artifacts>/fake-harness-heldout.json           # exit 0
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set development --provider ollama --dry-run            # exit 0, no inference
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set development --provider ollama --max-calls 20 --out <artifacts>/qwen3-8b-development.json   # exit 0
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set heldout --provider ollama --max-calls 20 --out <artifacts>/qwen3-8b-heldout.json           # exit 0
npm run eval:meal-drafts:check -- --model <artifacts>/qwen3-8b-development.json --model <artifacts>/qwen3-8b-heldout.json --out <artifacts>/gates-check.json   # exit 0 (PASS / PASS)
```

The automated checks (unit, `verify`, integration, Chromium) are listed in `docs/progress.md`.

## Limitations

- Synthetic and small: 53 corpus cases and 40 model cases written by the author of the rules; one model, one CPU; no
  real user text. The v1 held-out set had been examined: regression evidence only.
- The model PASS is marginal (outcome exactly 85.0 %). The cold first call timed out at the 45 s product default, as at
  the checkpoint; nothing was tuned or extended after seeing it.
- The container rule is a fixed list of vessels and constructions, not an understanding of the text. Figures phrased
  otherwise are not seen ("There are 900 kcal in the pot", "Pot total 900 kcal", "Кастрюлю на 900 ккал" are proposed);
  other containers ("cup", "bowl", "тарелка", "горшочек", "tray", "wok") are not context; a harmless whole-quantifier
  withholds the other values ("Washed the whole pan, then soup 300 kcal"); "Rice in the pot is 600 kcal" counts as a
  container figure.
- Passing the corpus does not show that every bound, instruction or container wording is caught.
- Any later change to a fingerprinted file makes these model reports stale; the model gate then FAILs until a new
  40-call run.
