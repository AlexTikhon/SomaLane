# Meal-draft grounding: vessel-scope policy

Status: **current** (2026-11-17; overlapping constructions added 2026-11-18). Authoritative for how "Draft from text" ([ADR-0092](adr/0092-meal-draft-from-text.md))
decides whether a nutrient value belongs to a whole cooking vessel or batch. It replaces the vessel rules spread over
ADR-0092 Amendment 6, its correction and the follow-ups recorded in
[meal-draft-container-relation-2026-11-17.md](reports/meal-draft-container-relation-2026-11-17.md); those remain as
history. Everything else in the grounding (excerpt location, exact decimals, units, bounds, negations, ranges, hedges,
instructions, the per-portion and package policy, the contract bounds, titles and meal types) is unchanged and governed
by ADR-0092.

This is a **bounded deterministic verifier**, not language understanding. It recognises the constructions listed here
and nothing else. Whatever it cannot classify abstains with an existing reason code (`per_portion` or `conflicting`). A
false abstention costs the person one field to type; a false acceptance puts a number in their diary they did not mean.

The acceptance matrix is machine-readable: [`apps/api/evaluation/meal-draft.challenge.v1.json`](../apps/api/evaluation/meal-draft.challenge.v1.json)
(an engineering challenge and regression set, frozen by digest before the engine was rebuilt; it is **not** independent
held-out evidence).

## 1. Nutrient mentions

A mention is a number token (digits, at most one `.` or `,` decimal separator; never directly after a letter or digit)
that the existing recogniser reads as a statement of one field: energy with an energy unit after it (or "kcal",
"calories", "ккал"… before it), or a macronutrient with a gram unit and the nutrient's name attached on either side
("protein 80 g", "80 g of protein", "белки 80 г", "80 г белка"). Each mention keeps its field, its exact decimal and its
span in the ORIGINAL text (offsets are never shifted by normalisation), so excerpt validation and the proposal use the
same evidence.

## 2. Nutrient lists

Mentions are grouped into **lists**. Two consecutive mentions belong to the same list when the text between them is only
inline whitespace, commas and "and", "plus", "&", "и", "плюс", on one line (a comma directly before a line break also
continues the list). A list ends at anything else: a word, a sentence end (`.` not between digits, `;`, `!`, `?`), a colon,
a parenthesis, or a bare line break. So "900 kcal, protein 80 g, fat 45 g" is one list; "900 kcal, protein 80 g, the
whole pan has 1200 kcal" is two (the words end the first); "Whole pot:\n900 kcal\nprotein 80 g" is two (a bare line break
ends a list).

## 3. Vessel contexts

A **vessel** is one of a fixed list (EN pot, pan, saucepan, skillet, batch; RU кастрюля, кастрюлька, сковорода,
сковородка, казан, in their case forms). A **whole-vessel reference** quantifies it as a whole ("whole/entire/full pot",
"all (of) the pot", "вся/целая/полная кастрюля", "весь казан", "кастрюля целиком"). A vessel word alone ("Pot roast",
"Soup from the pot", "Суп из кастрюли") is never context.

Every context has a span and attaches to whole **lists**, never to an arbitrary line or sentence:

| Context | Recognised when | Attaches to |
|---|---|---|
| **Confirmed construction** | A supported construction relates a vessel to a figure in one statement (ADR-0092 Amendment 6 and its correction): "the whole pot (of chili) is/has/contains … 900 kcal", "whole pot, fat 45.5 g", "Whole pot: 900 kcal", "900 kcal for the whole pot", "the pot is 900 kcal", "Кастрюля: 900 ккал", "в кастрюле 900 ккал", "вся кастрюля 900 ккал" | the list containing the figure it names, with all its coordinated members ("The whole pot is 900 kcal, protein 80 g") |
| **Label** (confirmed) | A clause that is nothing but the whole-vessel reference, an optional preposition and article, an English "of …" or one Russian food noun in the genitive from a closed list ("Whole pot", "(for the whole pot)", "Вся кастрюля", "Полная кастрюля супа"), next to a figure with only punctuation and whitespace between them (sentence ends, line breaks, CRLF, parentheses), in either order | the adjacent list |
| **Unrelated action** | A vessel clause containing an explicit listed action word: cleaning (wash, scrub, clean, rinse, soak; помыть, вымыть, отмыть, почистить, сполоснуть, замочить and their forms), kitchen objects other than food (lid, sink, dishwasher; крышка, раковина, посудомойка), handling (used, put, stored, covered before the vessel; поставить, убрать, накрыть, использовать), or cooking with the vessel as the PLACE (a locative preposition directly before the vessel: "Cooked soup in a full pot", "Сварила суп в полной кастрюле") | the adjacent list, as "no attribution" |
| **Unresolved** | Any other vessel clause next to a figure: an unknown word ("Полная кастрюля окрошки", "Whole pot blorped"), a cooked or prepared whole batch ("I cooked a full pot of soup", "Сварила полную кастрюлю супа"), a consumption of the vessel ("I ate the whole pot") | the adjacent list |

A vessel clause is the text around the reference up to the nearest sentence end, line break, parenthesis, bracket, comma,
colon, semicolon, equals sign or spaced dash, and it must contain no nutrient mention of its own (a clause that contains
one is judged only by the confirmed constructions). **Unknown vocabulary never makes a clause an action**: only the listed
words do. A food adjective after the vessel ("Full pan of fried rice", "Целая сковорода жареной картошки") is not a
cooking action.

**Overlapping constructions** (2026-11-18). Every supported construction is matched from every position, so one reading
never hides another that overlaps it. A **reading** is the vessel words a match contains and the lists it attaches to:

- readings with the same vessel words and the same lists establish the same attribution and are **one** context, however
  many matches produce them ("900 kcal for the whole pot" is matched from "900" and from the energy word "kcal"; "Вся
  кастрюля содержит 900 ккал" from "Вся" and from the nominative "кастрюля");
- readings that contain the **same vessel word** but attach to **different lists compete**: which figure is the vessel's
  cannot be decided, so every competing reading is **unresolved**. "Soup, 300 kcal, the whole pot has 900 kcal" is both
  "300 kcal, the whole pot" (a figure qualified by the vessel after it) and "the whole pot has 900 kcal" (the vessel as
  the subject): both lists are unresolved, so neither value leaves the conflict scan and neither is proposed;
- a reading of another vessel word, and a list no reading attaches to, are unaffected.

## 4. Attribution of a list (precedence)

A vessel clause next to figures on both sides (across punctuation only) attaches to both lists. Each list collects the
kinds of the contexts attached to it; its mentions all receive the same attribution:

1. any **unresolved** context → **unresolved**;
2. a **confirmed construction whose own words are also read as an action clause** (the same-line construction admits one
   free Russian word: "Полная кастрюля помыта, 900 ккал") → **unresolved** (the same evidence read two ways);
3. a **label** next to figures on BOTH sides → unresolved for both lists (which one it labels is ambiguous);
4. **constructions competing for one vessel reference** (section 3, overlapping constructions) → unresolved for every
   list they attach to;
5. otherwise a **confirmed** context → **confirmed**;
6. otherwise (an action or nothing) → **none**. An action adjacent to a list confirmed by a different statement ("The
   whole pot has 900 kcal.\nWhole pot washed.") changes nothing.

Attribution is local: a confirmed context elsewhere in the text never changes another list's attribution, before or
after it.

## 5. Proposal eligibility

The text has **vessel context** when it contains any confirmed construction, label or unresolved context (an action does
not count). A claimed mention may be proposed only if, besides every other ADR-0092 rule (excerpt, unit, attachment,
exact decimal, sign, bounds, negations, ranges, hedges, instructions, contract bounds):

- its attribution is **none** (a confirmed or unresolved mention is withheld as `per_portion`); and
- when the text has a per-portion qualifier, a nutrition label, a package or partial amount, or vessel context
  ANYWHERE (the existing global policy, unchanged), the mention is an **explicit consumed total**: its sentence has the
  person's summing phrase ("in total", "altogether", "итого", "в сумме"…), the mention is bound to a consumption verb
  before it in that sentence ("In total I ate 300 kcal, protein 20 g"), the sentence carries no qualifier, label,
  package, partial amount, food quantity, vessel context span or attributed mention, and no qualifier floats free of
  values elsewhere. Otherwise `per_portion`.

## 6. Conflict detection

A mention of the claimed field participates in the conflict scan unless its own clause carries a per-portion qualifier,
it is excluded by the global per-portion/package policy (the same consumed-total rule, with vessel context ignored), or
its attribution is **confirmed**. Unresolved mentions always participate, as do mentions with no attribution. Two
participating mentions with different exact decimals withhold the claim as `conflicting`. Equal decimals ("300",
"300.0") are one value and never manufacture a conflict.

Because both operations read one analysis, they cannot infer contradictory scope: a mention removed from the conflict
scan is exactly a confirmed one, and a confirmed one can never be proposed.

## 7. Consequences and limits

- An unresolved list is conservative twice: its values are never proposed, and they keep any consumed total that
  differs from them withheld as `conflicting`. "I cooked a full pot of soup.\n900 kcal. In total I ate 300 kcal."
  withholds 300.
- A confirmed vessel's figures leave the conflict scan, so a consumed total beside them is proposed ("The whole pot has
  900 kcal. In total I ate 300 kcal." and "900 kcal for the whole pot. In total I ate 300 kcal." propose 300).
- Competing constructions leave both lists in the conflict scan: "Soup, 300 kcal, the whole pot has 900 kcal. In total
  I ate 900 kcal." withholds the final 900 as `conflicting`, and so does a final 300.
- A list under a heading on separate lines is not one list: only the line adjacent to a label is attributed to it; the
  other lines are ordinary values (withheld for a proposal by the global policy, and kept in the conflict scan).
- The package and per-portion policy is global and asymmetric with vessels on purpose (it is unchanged): an unscoped
  value beside a package statement leaves the conflict scan; one beside a vessel statement elsewhere does not.
- Supported wording is English and Russian as listed. Any other construction abstains or is treated as an ordinary
  value under the existing rules; nothing is computed, estimated or converted.
