import { DATA_QUESTION_ACTIVITY_SOURCES, type DataQuestionActivitySource } from '@running-tracker/contracts';

import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmJsonSchema,
  type LlmProvider,
  type LlmStructuredInput,
  type LlmStructuredResult,
} from '../insights/llm-provider.js';
import { sourceNamedIn } from './data-question-normalizer.js';

// A deterministic stand-in for the local model (ADR-0094), for automated tests, the browser suite and demonstrations.
// It is DELIBERATELY NAIVE keyword matching and says nothing about any real model's quality; it must never be reported
// as model evidence. It picks a source only when a source word is present, as the instructions ask a model to.
//
// Control words in the question (removed before it is read): [delay=MS] waits (and honours cancellation), [fail] fails as
// a provider error, [unavailable] as an unreachable runtime, [invalid] answers a shape the wire schema refuses, and
// [implied-source] picks the recorded-run source without any source word (to prove the server's guard).

export const FAKE_DATA_QUESTION_MAX_DELAY_MS = 20_000;

const CONTROL = /\[(?<word>delay|fail|unavailable|invalid|implied-source)(?:=(?<value>\d{1,6}))?\]/gu;

const has = (text: string, pattern: string) => new RegExp(`(?<![\\p{L}])(?:${pattern})`, 'iu').test(text);

const TYPES: ReadonlyArray<[string, string]> = [
  ['run', 'run|running|jog|бег|пробежк'],
  ['walk', 'walk|ходьб|прогулк'],
  ['ride', 'ride|cycling|bike|велосипед|велотрениров'],
  ['hike', 'hike|hiking|поход'],
  ['swim', 'swim|плаван'],
  ['strength', 'strength|gym|силов'],
];

const dayPeriodOf = (text: string) => (has(text, 'yesterday|вчера') ? 'yesterday' : has(text, 'today|сегодня') ? 'today' : 'selected_date');

/** The wire answer for one question, as the naive rules see it. Exported for the specification and the evaluation. */
export function fakeDataQuestionAnswer(question: string): unknown {
  const words = new Set([...question.matchAll(CONTROL)].map((match) => match.groups!.word!));
  const text = question.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();

  if (words.has('invalid')) return { outcome: 'day_overview', period: 'tomorrow', sql: 'select 1' };
  if (has(text, 'wife|husband|partner|friend|client|жен[аы]|муж[аеу]?|друг|подруг|клиент')) return { outcome: 'unsupported', reason: 'other_person' };
  if (has(text, 'delete|remove|edit|share|send|add |удали|добавь|измени|поделись|отправь')) return { outcome: 'unsupported', reason: 'write_action' };
  if (has(text, 'diagnos|should i|recommend|advice|target|диагноз|посоветуй|рекоменд|сколько мне нужно|норм[аы]')) {
    return { outcome: 'unsupported', reason: 'medical_or_coaching' };
  }
  if (has(text, 'estimate|predict|forecast|why|balance|burn|оцени|прогноз|почему|баланс|сожг')) return { outcome: 'unsupported', reason: 'estimation_or_prediction' };

  if (has(text, 'compar|previous 28|сравн')) {
    const type = TYPES.find(([, pattern]) => has(text, pattern))?.[0] ?? null;
    const source: DataQuestionActivitySource | null = words.has('implied-source')
      ? 'recorded_run'
      : (DATA_QUESTION_ACTIVITY_SOURCES.find((candidate) => sourceNamedIn(text, candidate)) ?? null);
    return { activityType: type, outcome: 'activity_comparison', period: dayPeriodOf(text), source };
  }
  if (has(text, 'week|недел')) {
    const period = has(text, 'last|previous|прошл') ? 'previous_week' : has(text, 'this|эт') ? 'current_week' : 'selected_week';
    const focus = has(text, 'nutrition|meal|food|calori|protein|питан|еда|калори|бел') ? 'nutrition' : has(text, 'step|active energy|шаг') ? 'movement' : 'overview';
    return { focus, outcome: 'weekly_review', period };
  }
  if (has(text, 'record|log|day|today|yesterday|день|сегодня|вчера|запис')) return { outcome: 'day_overview', period: dayPeriodOf(text) };
  return { outcome: 'unsupported', reason: 'not_a_data_question' };
}

function delayOf(text: string): number {
  for (const match of text.matchAll(CONTROL)) {
    if (match.groups?.word === 'delay') return Math.min(FAKE_DATA_QUESTION_MAX_DELAY_MS, Number(match.groups.value ?? 0));
  }
  return 0;
}

export class FakeDataQuestionProvider implements LlmProvider {
  public readonly model = 'fake';

  public async generateStructured(input: LlmStructuredInput, _schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    const { signal } = options;
    if (signal?.aborted) throw new LlmProviderError('aborted', false);
    const delayMs = delayOf(input.user);
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new LlmProviderError('aborted', false));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (/\[fail\]/u.test(input.user)) throw new LlmProviderError('provider_error', false);
    if (/\[unavailable\]/u.test(input.user)) throw new LlmProviderError('unavailable', true);
    return { value: fakeDataQuestionAnswer(input.user) };
  }
}
