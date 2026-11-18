# Meal draft: whole-vessel context needs a relationship, and a v1 regression rerun (2026-11-17)

> **Superseded (later on 2026-11-17).** The vessel rules recorded here, including all five update notes below, were
> rebuilt as one analysis shared by proposals and conflict detection (ADR-0092 Amendment 7). Current policy:
> [docs/meal-draft-vessel-scope-policy.md](../meal-draft-vessel-scope-policy.md); current results and model evidence:
> [meal-draft-vessel-scope-2026-11-17.md](meal-draft-vessel-scope-2026-11-17.md). This report stays as history.

A correction of ADR-0092 Amendment 6 (container scope). Deterministic grounding only; the prompt, wire schema, public
contracts, reason codes, provider defaults and the off-by-default setting are unchanged, as are the frozen datasets,
the safety corpus, the gate thresholds and every earlier artifact. Workstation evidence only (Windows 11, Node.js 24.11.1,
CPU); no hosted CI run and no physical device.

> **Update, adjacency follow-up (later on 2026-11-17).** The unsafe-direction gap listed under Limitations is fixed: a
> whole-quantified vessel and a figure with nothing but punctuation or whitespace between them (sentence ends, LF, CRLF),
> in either order, are related again ("Whole pot\n900 kcal", "Full pot. 900 kcal.", "900 kcal\nWhole pot", "Full
> pot.\nProtein 80 g." and the Russian forms withhold the figure; "Whole pot\n900 kcal. In total I ate 300 kcal."
> withholds 900 and proposes 300). Any word between them still separates them: "Cooked soup in a full pot. Lunch, 300
> kcal." proposes 300 and "I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal." stays `conflicting`. A
> consequence: a verb before the vessel does not break adjacency, so "Washed the whole pan. Protein 25 g. In total I ate
> protein 20 g." reads 25 as the pan's figure (withheld) and proposes 20. The verifier gate still **PASSES** on the
> unchanged corpus (0 of 191 forbidden, controls 21/21, no case changed), but the fingerprint moved `e410e3f0…` →
> `f26e9239…`, so **the model reports below are stale**: `--check` on them now FAILs for evidence
> (`FINGERPRINT_MISMATCH`). **There is no current model PASS** until a new 40-call run; none was made for this fix (no
> Ollama call). The verdict table and the rerun below describe the code as frozen before this follow-up.
>
> **Update, clause classification (second follow-up, 2026-11-17).** The adjacency rule above read any vessel phrase next
> to a figure as an attribution, so a cleaning sentence hid a conflict again ("Washed the whole pan. Protein 25 g. In
> total I ate protein 20 g." proposed 20), and parentheses were not punctuation ("Soup, 900 kcal (whole pot).",
> "(Whole pot)\n900 kcal" proposed 900). Across a sentence end, a line break or a parenthesis, a whole vessel is now
> related to an adjacent figure only when its own clause is a **label** (nothing but the vessel with an optional
> preposition, article and English "of …": "Whole pot", "(for the whole pot)", "Вся кастрюля", "(на всю кастрюлю)"); a
> clause describing an action ("Washed the whole pan.", "Whole pot washed afterwards", "Помыла всю сковороду.")
> attributes nothing. Same-line constructions keep the bounded gaps of the correction. Both protein examples now withhold
> 20 as `conflicting` (also in Russian); "Soup, 900 kcal (whole pot).", "Soup, 900 kcal (for the whole pot).", "(Whole
> pot)\n900 kcal" and "Protein 80 g (whole pot)." withhold the figure; "Whole pot\n900 kcal", "Whole pot\n900 kcal. In
> total I ate 300 kcal." (900 withheld, 300 proposed), "Cooked soup in a full pot. Lunch, 300 kcal." (proposed), "I
> washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal." (`conflicting`) and "Soup, 300 kcal\nWhole pot washed
> afterwards" (proposed) are unchanged controls. Verifier **PASS** (0 of 191 forbidden, controls 21/21, no corpus case
> changed); fingerprint `f26e9239…` → `94b3fd4d…`; the saved model reports stay **stale** (`--check` FAILs for evidence).
> No Ollama call.
>
> **Update, Russian food qualifier (third follow-up, 2026-11-17).** The label above accepted the English "of soup" but
> not the Russian genitive, so "Полная кастрюля супа\n900 ккал" proposed 900 (HEAD withheld it as `per_portion`), in
> either order. A label may now end in one dish or food noun from a closed genitive list (`FOOD_QUALIFIER_RU`: "супа",
> "борща", "плова", "каши" and about 40 others); Russian marks the qualifier by case alone and a genitive cannot be told
> from a short participle by its ending ("салата" / "помыта"), so no other word qualifies and "Полная кастрюля помыта" stays
> an action. The reproduction and its label-before/label-after forms across LF, CRLF, sentence ends and parentheses
> withhold the figure (energy and macronutrients); the consumed total beside them is proposed; the paired action texts
> keep their conflicts; "Полная кастрюля супа:\n900 ккал" stays withheld. Verifier **PASS** (0 of 191 forbidden,
> controls 21/21, 0 of 53 cases changed); fingerprint `94b3fd4d…` → `729600b8…`; the saved model reports stay **stale**.
> No Ollama call. Remaining limits: a dish missing from the list is not a qualifier ("Полная кастрюля окрошки\n900 ккал"
> proposes 900, the unsafe direction); on the same line any one word may still follow the Russian vessel before a figure
> (unchanged since HEAD), so "Полная кастрюля помыта, 900 ккал" is withheld as a container figure.
>
> **Update, unknown qualifier (fourth follow-up, 2026-11-17).** The third follow-up treated every word missing from
> `FOOD_QUALIFIER_RU` as an action, so "Полная кастрюля окрошки\n900 ккал", "900 ккал\r\nПолная кастрюля окрошки" and
> "Полная кастрюля салата.\nБелки 80 г." proposed the figure (HEAD withheld all three). A vessel clause beside a figure
> is now a **label** (confirmed attribution), an explicit **action** (a closed list of cleaning words, kitchen objects
> such as "lid"/"крышка", Russian past-tense or infinitive cooking and handling verbs, and English cooking verbs before
> the vessel only), or **unresolved** (anything else). An unresolved clause withholds its figure as `per_portion` for a
> proposal, but conflict detection still counts that figure as a whole-entry value, so "Полная кастрюля окрошки\n900
> ккал. Итого съела 300 ккал." withholds 300 as `conflicting` instead of proposing it. All three regressions are withheld,
> and so are unlisted dishes ("драников", "шулюма") and made-up qualifiers ("зюмбры", "Whole pot blorped"), in both
> orders, across LF, CRLF, sentence ends and parentheses. Unchanged: the action controls ("Washed the whole pan. Protein
> 25 g. In total I ate protein 20 g.", "Полная кастрюля помыта\n400 ккал. Итого съела 300 ккал." → `conflicting`;
> "Cooked soup in a full pot. Lunch, 300 kcal." → 300), the known labels and the consumed total beside a confirmed
> container figure. Three earlier assertions that an unknown word ("стояла", "потом", "супа стояла") is an action now
> expect `per_portion`. Verifier **PASS** (0 of 191 forbidden, controls 21/21, 0 mismatches); fingerprint `729600b8…` →
> `69ac4e55…`; the saved model reports stay **stale**. No Ollama call. Remaining limits: an action word missing from the
> list leaves an unrelated clause unresolved, so its figure is withheld when it could have been proposed (the safe
> direction, but over-abstention), e.g. "Soup, 300 kcal. Whole pot went back on the shelf." withholds 300. Every listed
> action word makes its clause an action, even when the clause also names food ("Сварила полную кастрюлю супа\n900 ккал"
> proposes 900, as "Cooked in a full pot" did before). The classification is wording only, not understanding.
>
> **Update, per-mention attribution and batch preparation (fifth follow-up, 2026-11-17).** Two defects remained. (1)
> Conflict detection decided vessel context for the whole text, so one confirmed vessel statement anywhere took an
> unresolved figure out of the scan: "Whole pot blorped\n900 kcal. The whole pan has protein 80 g. In total I ate 300
> kcal." proposed 300. Vessel context now leaves a value out of the conflict scan only when THAT value is attributed to
> a confirmed vessel: it lies in the statement (same line, same sentence) of a `WHOLE_CONTAINER` construction or of a
> figure beside a label, and it is not a figure beside a vessel clause that is unresolved or an action. Per-portion
> qualifiers, nutrition labels, packages and partial amounts stay global, and so does the proposal policy (vessel
> context anywhere still withholds every value without explicit scope). (2) Every English cooking verb before the
> vessel, and every Russian finite cooking verb, made the clause an unrelated action, so a prepared batch proposed its
> figure. A cooking verb is now an action only when the vessel follows a locative preposition ("in/into/on a full pot",
> "в полной кастрюле"); otherwise ("cooked a full pot of soup", "сварила полную кастрюлю супа") the attribution is
> unresolved. Cleaning and handling words are unchanged.
>
> | Reproduction or control (claim) | Before (HEAD `855a1bc`) | After |
> |---|---|---|
> | "Whole pot blorped\n900 kcal. In total I ate 300 kcal." (300) | withheld `conflicting` | withheld `conflicting` |
> | "Whole pot blorped\n900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal." (300) | **proposed 300** | withheld `conflicting` |
> | "I cooked a full pot of soup.\n900 kcal" (900) | **proposed 900** | withheld `per_portion` |
> | "Сварила полную кастрюлю супа\n900 ккал" (900) | **proposed 900** | withheld `per_portion` |
> | "Cooked soup in a full pot. Lunch, 300 kcal." (300) | proposed 300 | proposed 300 |
> | "Washed the whole pan. Protein 25 g. In total I ate protein 20 g." (20) | withheld `conflicting` | withheld `conflicting` |
> | "The whole pot has 900 kcal. In total I ate 300 kcal." (900 / 300) | `per_portion` / proposed 300 | `per_portion` / proposed 300 |
> | "Полная кастрюля окрошки, 900 ккал. Итого съела 300 ккал." (300) | proposed 300 | withheld `conflicting` |
> | "Полная кастрюля помыта, 900 ккал. Итого съела 300 ккал." (300) | proposed 300 | withheld `conflicting` |
> | "Soup 900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal." (300) | proposed 300 | withheld `conflicting` |
> | "Полная кастрюля супа, 900 ккал. Итого съела 300 ккал." (300) | proposed 300 | proposed 300 |
>
> The last four rows are side effects, all in the direction of abstention. Verifier **PASS** (0 of 191 forbidden,
> controls 21/21, 0 mismatches, **0 of 53 cases changed** against the fourth follow-up's report); fingerprint `69ac4e55…`
> → `45e1821c…`; the saved model reports stay **stale**. No Ollama call. Remaining limits: a confirmed statement
> attributes every figure on its own line and sentence ("The whole pot is 900 kcal, protein 80 g"), so a consumed
> figure written into that same statement is attributed too (as before; it is withheld for a proposal by the global
> policy anyway). A prepared batch with a consumed total beside it ("I cooked a full pot of soup.\n900 kcal. In total I
> ate 300 kcal.") withholds 300 as `conflicting` rather than proposing it, because a batch is treated as unresolved, not
> as a confirmed vessel figure. The cooking/place distinction reads a preposition directly before the vessel reference
> and nothing else.

## Verdict

| Gate | Status | Evidence |
|---|---|---|
| **Verifier** (deterministic, frozen safety corpus v1, supplied claims, no model) | **PASS**, exit 0 | 53/53 cases executed; **0** of 191 forbidden values accepted; positive controls **21/21**; outcome mismatches **0**; no case changed outcome against the run before the change |
| **Model** (`qwen3:8b`, frozen v1 development + held-out, current tool) | **PASS**, marginal | Report version 3, current fingerprint `e410e3f0…`, one consistent execution profile, both sets complete; 0 incorrectly accepted; outcome **34/40 = 85.0 %** (threshold 85 %); recall 27/31 = 87.1 %; precision 100 %; failures 3/40 = 7.5 % |
| **Overall** (`npm run eval:meal-drafts:check`) | **PASS**, exit 0 | [gates-check.json](artifacts/meal-draft-container-relation-2026-11-17/gates-check.json) |

The v1 held-out set has been examined since 2026-11-14: these reruns are **regression evidence, not fresh held-out
evidence**. A PASS permits further local experimentation only; **the feature stays off by default**. The 2026-11-16
model reports are now stale: the same check on them FAILs for evidence (`FINGERPRINT_MISMATCH`, grounding changed).

## The defect

`WHOLE_CONTAINER` (Amendment 6) counted a bare whole-quantified vessel ("whole/entire/full pot", "all of the pot",
"вся/полная кастрюля", "кастрюля целиком") as container context anywhere in the text, with no nutrition figure of its
own. One classification, `hasContainerContext`, decides both whether a value may be proposed (`wholeEntryScoped`) and
which values count for conflict detection (`distinctStatedValues`), so unrelated cooking or cleaning words did two
things:

| Text (claim `300`, evidence `300 kcal`) | Before | After | Why it was wrong |
|---|---|---|---|
| "Cooked soup in a full pot. Lunch, 300 kcal." | withheld `per_portion` | **proposed 300** | "full pot" names a cooking vessel, not a figure for it |
| "I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal." | **proposed 300** | withheld `conflicting` | the bare phrase removed 400 from the conflict scan, so the person's second total disappeared |
| "Soup, 400 kcal. In total I ate 300 kcal." | withheld `conflicting` | withheld `conflicting` (unchanged) | |
| "Сварила суп в полной кастрюле. Обед, 300 ккал." | withheld `per_portion` | **proposed 300** | |
| "Помыла всю сковороду. Суп, 400 ккал. Итого съела 300 ккал." | **proposed 300** | withheld `conflicting` | |

The second row is the unsafe one: an unrelated phrase hid a conflicting value, and a value was proposed that the text
contradicts.

## The correction

A whole-quantified vessel is container context only in an explicit construction that relates it to a figure (a number
with an energy or gram unit, or a nutrient or energy word that opens a statement):

| Construction | Examples (all withheld as before) |
|---|---|
| Subject of a figure (any whitespace, at most two words before the figure) | "The whole pot has 900 kcal.", "The entire pot of chili contains protein 80 g", "Вся кастрюля содержит 900 ккал", "Целая кастрюля — это 900 ккал" |
| Beside a figure in the same clause: same line, at most one `,` `:` `=` or dash; a line break only after an explicit `:` `=` or dash | "Chili; whole pot, fat 45.5 g", "A full pot of soup, 900 kcal", "Whole pot:\n900 kcal", "вся кастрюля 900 ккал", "Полная кастрюля супа, 900 ккал", "Итого съел всю кастрюлю, 900 ккал" |
| After a figure it qualifies, same line, optional "for/in/of" or "на/за/в/во/для" | "900 kcal for the whole pot", "protein 80 g, the whole pot", "900 ккал на всю кастрюлю", "белки 80 г, весь казан" |

A sentence end, a comma followed by other words, or a bare line break separates the vessel from a figure. The
non-quantified vessel constructions of Amendment 6 ("the pot has 900 kcal", "Pot: 900 kcal", "Кастрюля 900 ккал", "в
кастрюле 900 ккал") are unchanged, and so is everything downstream: once a genuine container figure is in the text, every
value outside a consumed-total sentence is still withheld, and the container figure still never conflicts with the
consumed total ("The whole pot has 900 kcal. In total I ate 300 kcal." withholds 900 and proposes 300). Conflict
detection, consumption binding, bounds, negations, ranges and per-portion handling are untouched; no vessel word was
added or removed. Paired controls that differ only in the relationship: "Lunch: a full pot, 300 kcal" (withheld) /
"Lunch in a full pot. Soup, 300 kcal" (proposed); "The whole pan is 400 kcal" / "The whole pan is clean. Soup, 400 kcal";
"Soup, 300 kcal for the whole pot" / "Soup, 300 kcal. For the whole pot I used a lid"; "Вся сковорода 400 ккал" / "Вся
сковорода чистая. Суп, 400 ккал"; "Суп, 300 ккал на всю кастрюлю" / "Суп, 300 ккал. На всю кастрюлю ушла крышка".

## Tests that detect the defect

- `meal-draft-grounding-container-relation.spec.ts` (new, 15 tests): the three reproductions and their Russian
  equivalents; unrelated context before and after values across sentences, `;`, `!`, `,`, LF, CRLF and blank lines, for
  energy and all three macronutrients, with recorded zeros and decimal commas; same-field conflicts kept with unrelated
  context; bounds, negations, ranges and per-portion qualifiers beside unrelated context; the consumption-binding rule;
  the three supported constructions in EN and RU, line-break headings after a colon or dash; five related/unrelated
  pairs; genuine container figures with a consumed total; food-name and cooking-reference controls. Against the unchanged
  grounding: **7 of 15 failed** (the reproductions, the Russian equivalents, both unrelated-context groups, the conflict
  group and the pairs); the 8 passing are the reproduction-3 control and the preservation and negative controls.
- The existing container-scope spec documented the defect as intended ("A whole-quantifier needs no figure of its own":
  "Washed the whole pan, then soup 300 kcal" withheld); that one case moved to its positive controls. Its other 15 tests
  are unchanged and pass.
- `meal-drafts-http` (one new case, injected provider, supplied claims): failed with the committed grounding swapped in
  temporarily (restored, hash compared) and passes with the correction.

## Fresh v1 regression rerun

Setup, fixed before the first call and verified unchanged afterwards
([freeze-before-inference.txt](artifacts/meal-draft-container-relation-2026-11-17/freeze-before-inference.txt): SHA-256 of
grounding, prompt, wire schema, Ollama adapter, datasets, safety corpus and gate file, the tracked diff and the untracked
spec; all equal after the runs). Prompt, wire, datasets, corpus and gate file hash identically to the 2026-11-16 freeze.

- Code: HEAD `ba4ea30` (branch `feat/weekly-review-meal-nutrition`, whose two commits are the unrelated ADR-0093 weekly
  review slice) plus this correction's uncommitted files (each report lists the dirty paths). Fingerprint
  `e410e3f0775ba5766dcd5da0bd8bb8ee239ca101c9e82df33feefa9a3d4c15b3` (was `c1d44a46…`; only the grounding file
  changed). Prompt digest `f53aeae5…` unchanged.
- Local Ollama 0.40.16 on `127.0.0.1:11434`; `qwen3:8b` already installed, digest `500a1f067a9f…` (Q4_K_M); `/api/ps`
  empty before the run (cold load, no warm-up). CPU only. Nothing pulled; no cloud model or fallback.
- Product defaults (only `MEAL_DRAFTS_MODEL=qwen3:8b` set): deadline 45 000 ms, `temperature 0`, `think false`,
  `num_ctx 4096`, `num_predict 600`, `stream false`, response ≤ 32 768 B, retries 0, one sequential call per case;
  three-identical-systemic-failures stop rule kept (not triggered). Nothing tuned after seeing results.
- **Inference calls: 40 of 40** (development 20, held-out 20). The dry run made no inference request. No retry, no
  warm-up, no other call.

| | Development | Held-out | Both | 2026-11-16 (now stale) |
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
| Latency p50 / p95 / max (ms) | 19 402 / 34 943 / 45 396 | 18 012 / 30 931 / 38 897 | | |

Every one of the 40 cases has the same outcome and failure as on 2026-11-16. The six outcome misses: `en-dev-full`
(`timeout` at 45 396 ms, the cold first call), `en-dev-injection` and `en-ho-thousands` (`unsupported`),
`ru-ho-conflict` (`unsupported`), `ru-dev-food-weight` and `ru-ho-food-weight` (`ungrounded_output`). No v1 case
contains a whole-vessel phrase, so this rerun says nothing about the correction itself, which only the tests and the
corpus exercise; it shows the correction cost no recall or precision on these sets. Model restraint is not verifier
evidence.

Reports: [qwen3-8b-development.json](artifacts/meal-draft-container-relation-2026-11-17/qwen3-8b-development.json),
[qwen3-8b-heldout.json](artifacts/meal-draft-container-relation-2026-11-17/qwen3-8b-heldout.json); safety corpus
[before](artifacts/meal-draft-container-relation-2026-11-17/verifier-safety-before.json) and
[after](artifacts/meal-draft-container-relation-2026-11-17/verifier-safety-after.json).

## Commands (repository root, in this order)

```text
npm run eval:meal-drafts -- --set safety --out <artifacts>/verifier-safety-before.json      # exit 0 (PASS; unchanged code)
# regressions written, 7 of 15 failing; grounding changed; all passing
npm run eval:meal-drafts -- --set safety --out <artifacts>/verifier-safety-after.json       # exit 0 (PASS; 0 cases changed)
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set development --provider ollama --dry-run            # exit 0, no inference
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set development --provider ollama --max-calls 20 --out <artifacts>/qwen3-8b-development.json   # exit 0
MEAL_DRAFTS_MODEL=qwen3:8b npm run eval:meal-drafts -- --set heldout --provider ollama --max-calls 20 --out <artifacts>/qwen3-8b-heldout.json           # exit 0
npm run eval:meal-drafts:check -- --model <artifacts>/qwen3-8b-development.json --model <artifacts>/qwen3-8b-heldout.json --out <artifacts>/gates-check.json   # exit 0 (PASS / PASS)
npm run eval:meal-drafts:check -- --model <2026-11-16 artifacts>/qwen3-8b-development.json --model <2026-11-16 artifacts>/qwen3-8b-heldout.json   # exit 2 (stale: FINGERPRINT_MISMATCH)
```

The automated checks (unit, `verify`, integration, Chromium) are listed in `docs/progress.md`.

## Limitations

- Synthetic and small: 53 corpus cases and 40 model cases written by the author of the rules; one model, one CPU; no
  real user text. The v1 held-out set had been examined: regression evidence only.
- The model PASS is marginal (outcome exactly 85.0 %). The cold first call timed out at the 45 s product default again;
  nothing was tuned or extended after seeing it.
- **Fixed by the adjacency follow-up (see the update at the top).** A regression in the unsafe direction, found after the freeze (checked with a probe of the frozen code). Amendment 6
  withheld every value of a text with a bare whole-quantified vessel; this correction proposes a figure that follows such
  a vessel across a sentence end or a bare line break with nothing else between them: "Full pot. 900 kcal." and "Whole
  pot\n900 kcal" (no colon or dash) now propose 900, and both plausibly describe the vessel. "The whole pot of my
  grandmother soup 900 kcal" (other words between) is proposed too, as it was not a supported construction. Neither the
  safety corpus nor the v1 sets contain these shapes, so no gate shows it. A tightening (a figure that follows the
  vessel with only punctuation and whitespace between them is related) was **not** applied: the 40 calls had been made
  on the frozen code, and changing the grounding would make this evidence stale and need a second 40-call run, which was
  outside this task. It is the first follow-up.
- The constructions are wording rules, not understanding. In the safe direction a harmless figure set beside a whole
  vessel is withheld ("Cooked soup in a full pot, 300 kcal"). Amendment 6's limits remain: "There are 900 kcal in the
  pot", "Pot total 900 kcal" and "Кастрюлю на 900 ккал" are proposed; cups, bowls, plates and trays are not containers.
- Passing the corpus does not show that every bound, instruction or container wording is caught.
- Any later change to a fingerprinted file makes these model reports stale; the model gate then FAILs until a new
  40-call run.
