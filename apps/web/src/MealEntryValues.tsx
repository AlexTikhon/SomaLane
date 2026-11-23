import type { MealView } from '@running-tracker/contracts';
import type { ReactNode } from 'react';

import { mealSourceLabel, mealTypeLabels, summarizeMeal } from './meal-log.js';

// One logged meal entry as the Meal log shows it (ADR-0083): its type, title, the four values ("Not recorded" when
// unknown, 0 when recorded as 0) and its server-owned source. Pure. The Meal log's card adds its Edit and Delete
// actions as children; the public read-only showcase (ADR-0099) renders it without any.

/** `lunch "Rice bowl"`: how an entry is named in the labels of its controls. */
export function mealEntryLabel(view: Pick<MealView, 'mealType' | 'title'>): string {
  return `${mealTypeLabels[view.mealType].toLowerCase()} "${view.title}"`;
}

export function MealEntryValues({ children, editingNow = false, view }: { children?: ReactNode; editingNow?: boolean; view: MealView }) {
  return (
    <>
      <p className="eyebrow">{mealTypeLabels[view.mealType]}</p>
      <h3>{view.title}</h3>
      <dl aria-label={`Values of ${mealEntryLabel(view)}`}>
        {summarizeMeal(view).map((row) => (
          <div className={row.value === 'Not recorded' ? 'today-rows__missing' : undefined} key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="meal-card__source">
        <span className="review-badge">{mealSourceLabel(view.source)}</span>
        {editingNow && ' Editing now.'}
      </p>
      {children}
    </>
  );
}
