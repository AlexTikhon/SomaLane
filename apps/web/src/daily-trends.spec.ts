import { describe, expect, it } from 'vitest';

import {
  chartDescription,
  chartGeometry,
  coverageLine,
  isTrendsMetric,
  missingExplanation,
  NOT_RECORDED,
  nutritionFigures,
  rangeLabel,
  summaryLines,
  tableRows,
  trendMetricOptions,
} from './daily-trends.js';
import { NUTRITION_A, NUTRITION_B, NUTRITION_C, nutritionOf, nutritionTrends, sparseTrends, trendsFixture } from './daily-trends-fixtures.js';

const END = '2026-11-09';
const NUTRITION_METRICS = ['foodEnergyKcal', 'proteinG', 'carbohydrateG', 'fatG'] as const;
const FORBIDDEN = /balance|deficit|surplus|target|goal|recommend|predict|estimate|average|too (much|little)|healthy|should/iu;

describe('trends wording', () => {
  it('offers the seven series in order, the four nutrition series after the daily records', () => {
    expect(trendMetricOptions.map((option) => option.label)).toEqual(['Weight', 'Sleep', 'Steps', 'Food energy', 'Protein', 'Carbohydrate', 'Fat']);
    expect(isTrendsMetric('steps')).toBe(true);
    expect(isTrendsMetric('proteinG')).toBe(true);
    expect(isTrendsMetric('activeEnergyKcal')).toBe(false);
  });

  it('names the range with its actual length, and says why it is shorter at the lower bound', () => {
    expect(rangeLabel(trendsFixture(END).range)).toBe('28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026');
    expect(rangeLabel(trendsFixture('2000-01-10', {}, END).range)).toBe(
      '10 days, Sat, 1 Jan 2000 to Mon, 10 Jan 2000 (shortened from 28: records start on 1 January 2000)',
    );
    expect(rangeLabel(trendsFixture('2000-01-01', {}, END).range)).toBe('1 day, Sat, 1 Jan 2000 (shortened from 28: records start on 1 January 2000)');
  });

  it('states coverage against the actual range length, the missing dates as unknown and not zero', () => {
    const trends = sparseTrends();
    expect(coverageLine(trends, 'weightKg')).toBe('Recorded on 2 of 28 days. The other 26 days have no value: unknown, not zero.');
    expect(coverageLine(trends, 'steps')).toBe('Recorded on 3 of 28 days. The other 25 days have no value: unknown, not zero.');
    expect(coverageLine(trends, 'foodEnergyKcal')).toBe(
      'Recorded on 1 of 28 days. Energy is recorded on 2 of 5 logged entries. The other 27 days have no value: unknown, not zero.',
    );
    expect(coverageLine(trendsFixture(END), 'foodEnergyKcal')).toBe(
      'Recorded on 0 of 28 days. No meal entry was logged in this range. The other 28 days have no value: unknown, not zero.',
    );
    const short = trendsFixture('2000-01-01', { '2000-01-01': { steps: 0 } }, END);
    expect(coverageLine(short, 'steps')).toBe('Recorded on all 1 day.');
  });

  it('summarizes weight only as first, last and difference with two dates, and never for one measurement', () => {
    expect(summaryLines(sparseTrends(), 'weightKg')).toEqual([
      'First recorded weight 72.35 kg on Tue, 13 Oct 2026; last recorded 72.3 kg on Sun, 8 Nov 2026.',
      'Difference between those two dates: −0.05 kg (2 dates have a weight).',
    ]);
    expect(summaryLines(trendsFixture(END, { '2026-11-01': { weightKg: 70 } }), 'weightKg')).toEqual([
      'A change needs a weight on at least two dates; only 1 date in this range has one.',
    ]);
    expect(summaryLines(trendsFixture(END), 'weightKg')).toEqual(['No weight was recorded in this range.']);
    expect(summaryLines(trendsFixture(END, { '2026-11-01': { weightKg: 70 }, '2026-11-02': { weightKg: 70.5 } }), 'weightKg')[1]).toBe(
      'Difference between those two dates: +0.5 kg (2 dates have a weight).',
    );
  });

  it('defines the sleep average over recorded dates with its rounding, and the step total with its days', () => {
    expect(summaryLines(sparseTrends(), 'sleepMinutes')).toEqual([
      'Average 7 h 15 min over the 2 dates with a recorded duration, rounded to the nearest minute (halves up).',
    ]);
    expect(summaryLines(sparseTrends(), 'steps')).toEqual(['Recorded total 13,042 steps on 3 days; the total covers only those days.']);
    expect(summaryLines(trendsFixture(END, { '2026-11-01': { steps: 0 } }), 'steps')).toEqual(['Recorded total 0 steps on 1 day; the total covers only those days.']);
    expect(summaryLines(trendsFixture(END), 'sleepMinutes')).toEqual(['No sleep duration was recorded in this range.']);
  });

  it('gives food energy both coverage levels and never calls it a complete diary', () => {
    expect(summaryLines(sparseTrends(), 'foodEnergyKcal')).toEqual([
      'Food energy recorded: 760.9 kcal from 2 of 5 logged entries, on 1 day.',
      'Meal entries were logged on 2 of 28 days; 1 of those days has no food energy recorded.',
      'The total covers only what you logged with an energy value; it is not a complete food diary.',
    ]);
    const titleOnly = trendsFixture(END, { '2026-11-01': { nutrition: nutritionOf(2) } });
    expect(summaryLines(titleOnly, 'foodEnergyKcal')).toEqual(['2 entries logged on 1 day, none with food energy recorded.']);
    const complete = trendsFixture(END, { '2026-11-01': { nutrition: nutritionOf(2, { energyKcal: [2, 0] }) } });
    expect(summaryLines(complete, 'foodEnergyKcal')).toContain('The total covers only what you logged with an energy value; it is not a complete food diary.');
    expect(missingExplanation('foodEnergyKcal')).toMatch(/not a complete food diary/u);
    expect(missingExplanation('steps')).toMatch(/unknown, not zero/u);
  });
});

describe('recorded nutrition (ADR-0096)', () => {
  it('words the required fixture per metric: coverage against the range and the logged entries, independently', () => {
    const trends = nutritionTrends();
    expect(coverageLine(trends, 'proteinG')).toBe(
      'Recorded on 1 of 28 days. Protein is recorded on 2 of 4 logged entries. The other 27 days have no value: unknown, not zero.',
    );
    expect(coverageLine(trends, 'fatG')).toBe('Recorded on 2 of 28 days. Fat is recorded on 2 of 4 logged entries. The other 26 days have no value: unknown, not zero.');
    expect(coverageLine(trends, 'carbohydrateG')).toBe(
      'Recorded on 2 of 28 days. Carbohydrate is recorded on 2 of 4 logged entries. The other 26 days have no value: unknown, not zero.',
    );
    expect(coverageLine(trends, 'foodEnergyKcal')).toBe(
      'Recorded on 2 of 28 days. Energy is recorded on 2 of 4 logged entries. The other 26 days have no value: unknown, not zero.',
    );
    expect(summaryLines(trends, 'proteinG')).toEqual([
      'Protein recorded: 10.1 g from 2 of 4 logged entries, on 1 day.',
      'Meal entries were logged on 2 of 28 days; 1 of those days has no protein recorded.',
      'The total covers only what you logged with a protein value; it is not a complete food diary.',
    ]);
    expect(summaryLines(trends, 'fatG')[1]).toBe('Meal entries were logged on 2 of 28 days.');
    expect(nutritionFigures(trends, 'proteinG')).toEqual([
      { label: 'Recorded total', value: '10.1 g' },
      { label: 'Days with a value', value: '1 of 28 days' },
      { label: 'Entries with a value', value: '2 of 4 logged entries' },
      { label: 'Days with logged entries', value: '2 of 28 days' },
    ]);
    expect(nutritionFigures(trends, 'foodEnergyKcal')[0]).toEqual({ label: 'Recorded total', value: '100.1 kcal' });
    expect(nutritionFigures(trendsFixture(END), 'fatG')).toEqual([
      { label: 'Recorded total', value: NOT_RECORDED },
      { label: 'Days with a value', value: '0 of 28 days' },
      { label: 'Entries with a value', value: 'No entries logged' },
      { label: 'Days with logged entries', value: '0 of 28 days' },
    ]);
  });

  it('tells apart no entries, entries without the metric, a partial date, full coverage and a recorded zero', () => {
    const trends = nutritionTrends();
    const row = (metric: (typeof NUTRITION_METRICS)[number], date: string) => tableRows(trends, metric).find((entry) => entry.localDate === date)!;
    // Date A's fat: a recorded zero covering 1 of 3 entries, labelled partial.
    expect(row('fatG', NUTRITION_A)).toMatchObject({ coverage: 'partial', detail: 'Partial: 1 of 3 entries with fat', recorded: true, value: '0 g' });
    expect(row('proteinG', NUTRITION_A)).toMatchObject({ coverage: 'partial', detail: 'Partial: 2 of 3 entries with protein', value: '10.1 g' });
    // Date B's protein: logged, not recorded.
    expect(row('proteinG', NUTRITION_B)).toMatchObject({ coverage: 'none', detail: '1 entry logged, no protein recorded', recorded: false, value: NOT_RECORDED });
    expect(row('fatG', NUTRITION_B)).toMatchObject({ coverage: 'all', detail: '1 logged entry with fat', value: '5.3 g' });
    expect(row('foodEnergyKcal', NUTRITION_B)).toMatchObject({ coverage: 'all', detail: '1 logged entry with energy', value: '0 kcal' });
    // Date C: no entries at all.
    for (const metric of NUTRITION_METRICS) expect(row(metric, NUTRITION_C)).toMatchObject({ coverage: 'no-entries', detail: 'No entry logged', value: NOT_RECORDED });
    const all = tableRows(trendsFixture(END, { [END]: { nutrition: nutritionOf(2, { carbohydrateG: [2, 1] }) } }), 'carbohydrateG');
    expect(all[0]).toMatchObject({ coverage: 'all', detail: 'All 2 logged entries with carbohydrate' });
    expect(tableRows(trends, 'steps')[0]!.coverage).toBeNull();
  });

  it('draws recorded zeros on the baseline, leaves missing dates as gaps and names the metric and unit', () => {
    const trends = nutritionTrends();
    const fat = chartGeometry(trends, 'fatG');
    expect(fat.points.map((point) => [point.localDate, point.value])).toEqual([
      [NUTRITION_A, 0],
      [NUTRITION_B, 5.3],
    ]);
    expect(fat.points[0]!.y).toBe(fat.plot.bottom);
    expect(fat.segments.map((segment) => segment.length)).toEqual([2]); // A and B are adjacent: joined
    expect(fat.missing).toHaveLength(26);
    expect(fat.points[1]!.label).toBe('Fat, Tue, 3 Nov 2026: 5.3 g');
    const protein = chartGeometry(trends, 'proteinG');
    expect(protein.segments.map((segment) => segment.length)).toEqual([1]); // B has no protein: nothing to join
    expect(protein.missing.map((gap) => gap.localDate)).toContain(NUTRITION_B);
    expect(chartDescription(trends, 'carbohydrateG')).toBe(
      'Carbohydrate recorded (g), 28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026: 2 of 28 days have a value. The table below lists every date.',
    );
    expect(chartGeometry(trends, 'foodEnergyKcal').yTicks.map((tick) => tick.label)).toEqual(['0', '100.1']);
  });

  it('keeps macro-only and title-only ranges apart from an empty one, and writes no judgement anywhere', () => {
    const macroOnly = trendsFixture(END, { '2026-11-01': { nutrition: nutritionOf(1, { proteinG: [1, 25.5] }) } });
    expect(summaryLines(macroOnly, 'foodEnergyKcal')).toEqual(['1 entry logged on 1 day, none with food energy recorded.']);
    expect(summaryLines(macroOnly, 'proteinG')[0]).toBe('Protein recorded: 25.5 g from 1 of 1 logged entry, on 1 day.');
    const titleOnly = trendsFixture(END, { '2026-11-01': { nutrition: nutritionOf(2) } });
    for (const metric of NUTRITION_METRICS) {
      expect(summaryLines(titleOnly, metric)[0]).toMatch(/^2 entries logged on 1 day, none with .+ recorded\.$/u);
      expect(summaryLines(trendsFixture(END), metric)).toEqual(['No meal entry was logged in this range.']);
      const text = [coverageLine(nutritionTrends(), metric), ...summaryLines(nutritionTrends(), metric), missingExplanation(metric)].join(' ');
      expect(text).not.toMatch(FORBIDDEN);
    }
  });
});

describe('trends table', () => {
  it('lists every date newest first, a missing value as Not recorded and a recorded zero as zero', () => {
    const rows = tableRows(sparseTrends(), 'steps');
    expect(rows).toHaveLength(28);
    expect(rows[0]).toMatchObject({ localDate: END, recorded: false, value: NOT_RECORDED });
    expect(rows.find((row) => row.localDate === '2026-10-14')).toMatchObject({ dateLabel: 'Wed, 14 Oct 2026', detail: null, recorded: true, value: '0 steps' });
    expect(rows.at(-1)).toMatchObject({ localDate: '2026-10-13', value: '8,042 steps' });
  });

  it('says which entries a food-energy value covers', () => {
    const rows = tableRows(sparseTrends(), 'foodEnergyKcal');
    expect(rows.find((row) => row.localDate === '2026-11-02')).toMatchObject({ detail: 'Partial: 2 of 3 entries with energy', value: '760.9 kcal' });
    expect(rows.find((row) => row.localDate === '2026-10-20')).toMatchObject({ detail: '2 entries logged, no energy recorded', value: NOT_RECORDED });
    expect(rows.find((row) => row.localDate === '2026-10-21')).toMatchObject({ detail: 'No entry logged', value: NOT_RECORDED });
    const all = tableRows(trendsFixture(END, { [END]: { nutrition: nutritionOf(2, { energyKcal: [2, 1] }) } }), 'foodEnergyKcal');
    expect(all[0]!.detail).toBe('All 2 logged entries with energy');
  });
});

describe('trends chart geometry', () => {
  it('draws a point per recorded date and lines only within runs of consecutive recorded dates', () => {
    const trends = trendsFixture(END, {
      '2026-10-13': { steps: 100 },
      '2026-10-14': { steps: 0 },
      '2026-10-15': { steps: 300 },
      '2026-10-20': { steps: 50 },
      '2026-11-08': { steps: 10 },
      '2026-11-09': { steps: 20 },
    });
    const geometry = chartGeometry(trends, 'steps');
    expect(geometry.points.map((point) => point.localDate)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-20', '2026-11-08', '2026-11-09']);
    expect(geometry.segments.map((segment) => segment.map((point) => point.localDate))).toEqual([
      ['2026-10-13', '2026-10-14', '2026-10-15'],
      ['2026-10-20'],
      ['2026-11-08', '2026-11-09'],
    ]);
    expect(geometry.missing).toHaveLength(22);
    expect(geometry.missing.map((gap) => gap.localDate)).toContain('2026-10-16');
    // One x slot per date, evenly spaced; a missing date keeps its slot.
    expect(geometry.points[0]!.x).toBe(geometry.plot.left);
    expect(geometry.points.at(-1)!.x).toBe(geometry.plot.right);
    // A recorded zero sits on the baseline: a point, not a gap.
    expect(geometry.points[1]!.y).toBe(geometry.plot.bottom);
    expect(geometry.points[2]!.y).toBe(geometry.plot.top);
  });

  it('keeps an all-zero series on the baseline as points, and draws nothing for an empty series', () => {
    const zeros = chartGeometry(trendsFixture(END, { '2026-11-01': { sleepMinutes: 0 }, '2026-11-02': { sleepMinutes: 0 } }), 'sleepMinutes');
    expect(zeros.points.map((point) => point.y)).toEqual([zeros.plot.bottom, zeros.plot.bottom]);
    expect(zeros.yTicks.map((tick) => tick.label)).toEqual(['0 h 00 min', '0 h 01 min']);
    const empty = chartGeometry(trendsFixture(END), 'weightKg');
    expect(empty.points).toEqual([]);
    expect(empty.segments).toEqual([]);
    expect(empty.yTicks).toEqual([]);
    expect(empty.missing).toHaveLength(28);
  });

  it('scales weight around its values, not from zero, and centres a one-date range', () => {
    const weight = chartGeometry(sparseTrends(), 'weightKg');
    expect(weight.points.every((point) => point.y > weight.plot.top && point.y < weight.plot.bottom)).toBe(true);
    expect(weight.yTicks.map((tick) => tick.label)).toEqual(['72.3 kg', '72.4 kg']);
    // Food energy's top label is the largest recorded value in its own precision, never rounded to a whole kcal.
    expect(chartGeometry(sparseTrends(), 'foodEnergyKcal').yTicks.map((tick) => tick.label)).toEqual(['0', '760.9']);
    const single = chartGeometry(trendsFixture('2000-01-01', { '2000-01-01': { weightKg: 70 } }, END), 'weightKg');
    expect(single.points[0]!.x).toBe((single.plot.left + single.plot.right) / 2);
    expect(single.xLabels).toHaveLength(1);
  });

  it('makes room on the left for the longest axis label, so it is never cut off', () => {
    const narrow = chartGeometry(trendsFixture(END, { [END]: { steps: 5 } }), 'steps');
    const wide = chartGeometry(trendsFixture(END, { [END]: { steps: 123_456 } }), 'steps');
    expect(wide.yTicks.map((tick) => tick.label)).toEqual(['0', '123,456']);
    expect(narrow.plot.left).toBe(40);
    expect(wide.plot.left).toBe(18 + '123,456'.length * 10);
    expect(chartGeometry(trendsFixture(END, { [END]: { sleepMinutes: 720 } }), 'sleepMinutes').plot.left).toBe(18 + '12 h 00 min'.length * 10);
  });

  it('describes the chart for assistive technology and points to the table', () => {
    expect(chartDescription(sparseTrends(), 'steps')).toBe(
      'Manually entered steps, 28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026: 3 of 28 days have a value. The table below lists every date.',
    );
  });
});
