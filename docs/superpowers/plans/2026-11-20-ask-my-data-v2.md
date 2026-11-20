# Ask my data v2 — implementation plan (ADR-0095)

Short plan; each step test-first (RED, then GREEN).

1. **Constraints and normalizer (API).** Regressions in `data-question-constraints.spec.ts` and
   `data-question-normalizer.spec.ts`: the three measured failures, EN/RU positive controls, word boundaries, whitespace,
   negation, multiple sources/types, ranges, weekdays, dates, focus, view agreement, instruction markers versus ordinary
   words. Then `data-question-constraints.ts` and the decision order in `data-question-normalizer.ts`.
2. **Prompt v2.** Spec: version, digest change, synthetic examples absent from every evaluation set, no dates/numbers.
3. **Evaluation versions.** Specs first: registry, default v1, v2 load/balance/rationale, `--dataset-version`, one version
   per check, mixed/relabelled/unknown NOT_RUN, fingerprint covers each new module, malformed dates NOT_RUN with `--out`.
   Supplied-answer tests: v2 oracle answers exact 20/20; wrong answers never executable; v1 expectations unchanged except
   the two documented policy changes. Then write v2 datasets from the policy and pin digests.
4. **Controller.** Specs first: modes, guided draft, validation, review → plan → execute, zero interpretation calls,
   invalidation on every input, `resolving`, clarification routes, late responses. Then the controller.
5. **View.** Specs first (static markup): builder fields per view, recorded-run type prevention, missing-choice hints,
   clarification actions, mode switch only when available. Then `AskMyDataSection.tsx`, helpers and CSS.
6. **HTTP integration.** Every guided combination through `/plans` and `/answers` with interpretation off, equal to the
   existing services.
7. **Chromium.** Scenarios 10–16 (guided nutrition off, GPX/TCX, recorded-run prevention, edit invalidation,
   clarification → guided, context changes, keyboard + 390 px); adapt 2–9 to the explicit typed mode.
8. **Verification** (sequential): focused suites, `npm run verify` (`VITEST_MAX_WORKERS=2`), DB identity, integration
   (unset), Chromium, `git diff --check`.
9. **Freeze and measure** v2 once (≤ 40 calls), `--check`, no tuning.
10. **Docs**: ADR, policy, product direction, reference, runbook, progress, dated report and artifacts.
