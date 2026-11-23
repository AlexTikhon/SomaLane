import { isEmptyDailyTrends, type DailyTrends, type DailyTrendsMetric, type DailyTrendsNutritionMetric } from '@running-tracker/contracts';

import {
  chartDescription,
  chartGeometry,
  computedLine,
  coverageLine,
  isNutritionTrendsMetric,
  missingExplanation,
  nutritionFigures,
  summaryLines,
  tableRows,
  trendMetricSpecs,
  type TrendChartGeometry,
} from './daily-trends.js';

// The content of one loaded Trends range (ADR-0084; recorded nutrition since ADR-0096), from the response alone: pure,
// with no request, controller or session. TrendsScreen renders it with the Meal log editor behind a nutrition row; the
// public read-only showcase (ADR-0099) renders it with a read-only meal list instead.

/** Opens the Meal log on a nutrition row's date, with the range end and series of the answer the row belongs to. */
export type OpenMealLog = (localDate: string, back: { endDate: string; metric: DailyTrendsNutritionMetric }) => void;

/** A simple line chart of one series: a point per recorded date, a line only between consecutive recorded dates. */
export function TrendChart({ description, geometry }: { description: string; geometry: TrendChartGeometry }) {
  const { missing, plot, points, segments, xLabels, yTicks } = geometry;
  return (
    <figure className="trends-chart">
      <svg aria-label={description} role="img" viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
        <line className="trends-chart__grid" x1={plot.left} x2={plot.right} y1={plot.top} y2={plot.top} />
        <line className="trends-chart__axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
        {yTicks.map((tick) => (
          <text className="trends-chart__tick" dominantBaseline="middle" key={`${tick.y}`} textAnchor="end" x={plot.left - 8} y={tick.y}>
            {tick.label}
          </text>
        ))}
        {xLabels.map((label) => (
          <text className="trends-chart__tick" key={label.text + label.anchor} textAnchor={label.anchor} x={label.x} y={geometry.height - 6}>
            {label.text}
          </text>
        ))}
        {missing.map((gap) => (
          <line className="trends-chart__gap" data-missing-date={gap.localDate} key={gap.localDate} x1={gap.x} x2={gap.x} y1={plot.bottom + 5} y2={plot.bottom + 11} />
        ))}
        {segments
          .filter((segment) => segment.length > 1)
          .map((segment) => (
            <polyline
              className="trends-chart__line"
              data-segment={`${segment[0]!.localDate}..${segment.at(-1)!.localDate}`}
              fill="none"
              key={segment[0]!.localDate}
              points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}
            />
          ))}
        {points.map((point) => (
          <circle className="trends-chart__point" cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} data-date={point.localDate} key={point.localDate} r={5}>
            <title>{point.label}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="trends-chart__key">
        Each dot is a recorded value. A line joins only dates next to each other that both have a value; a short mark under the
        axis is a date with no value.
      </figcaption>
    </figure>
  );
}

/** The words of a nutrition row's second action and of the table's note about it. */
export interface MealActionWords {
  aria: (dateLabel: string) => string;
  note: string;
  text: string;
}

/** The application's: the Meal log editor. The showcase passes its own words for a read-only list. */
const editorWords: MealActionWords = {
  aria: (dateLabel) => `Open Meal log on ${dateLabel}`,
  note: 'Newest first. Open shows the date on Today; Meal log lists that date’s entries to edit or delete, with a way back here.',
  text: 'Meal log',
};

/** A loaded range for one metric: coverage, summary, chart and the table of every date. */
export function TrendsContent({
  mealAction = editorWords,
  metric,
  onOpenDay,
  onOpenMealLog,
  timeZone,
  trends,
}: {
  /** The words of a nutrition row's second action; by default the application's Meal log editor. */
  mealAction?: MealActionWords;
  metric: DailyTrendsMetric;
  onOpenDay: (localDate: string) => void;
  onOpenMealLog?: OpenMealLog | undefined;
  timeZone: string;
  trends: DailyTrends;
}) {
  const words = mealAction;
  const spec = trendMetricSpecs[metric];
  const rows = tableRows(trends, metric);
  const geometry = chartGeometry(trends, metric);
  const nutrition = isNutritionTrendsMetric(metric) ? metric : null;
  const manual = metric === 'steps' || nutrition !== null;
  // The way back is the range of this answer (not the date being typed), so a row can only return to the range it showed.
  const openMealLog = nutrition !== null && onOpenMealLog !== undefined ? (localDate: string) => onOpenMealLog(localDate, { endDate: trends.range.endDate, metric: nutrition }) : null;
  return (
    <div className="trends-content">
      {isEmptyDailyTrends(trends) && <p className="today-empty">Nothing is recorded for these dates yet.</p>}
      {trends.range.includesToday && <p className="today-note">The range ends today; Refresh shows what was added since.</p>}

      <section aria-labelledby="trends-series-title" className="today-card trends-card">
        <h2 id="trends-series-title">{spec.title}</h2>
        <p>
          {manual && <span className="review-badge">Manually entered</span>} {spec.source}
        </p>
        {nutrition !== null && (
          <dl aria-label={`${spec.label} over the range`} className="trends-figures">
            {nutritionFigures(trends, nutrition).map((figure) => (
              <div key={figure.label}>
                <dt>{figure.label}</dt>
                <dd>{figure.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="trends-coverage">{coverageLine(trends, metric)}</p>
        <ul className="trends-summary">
          {summaryLines(trends, metric).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {geometry.points.length > 0 ? (
          <TrendChart description={chartDescription(trends, metric)} geometry={geometry} />
        ) : (
          <p className="today-missing">No value to draw for this series in this range.</p>
        )}
        <p className="today-note">{missingExplanation(metric)}</p>
      </section>

      <section aria-labelledby="trends-table-title" className="today-card trends-card">
        <h2 id="trends-table-title">Every date</h2>
        <p className="today-note">
          {openMealLog === null ? 'Newest first. Open a date to see everything recorded for it on Today.' : words.note}
        </p>
        <table className="trends-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">{spec.label}</th>
              <th scope="col"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                className={row.recorded ? (row.coverage === 'partial' ? 'trends-table__partial' : undefined) : 'trends-table__missing'}
                data-coverage={row.coverage ?? undefined}
                data-date={row.localDate}
                key={row.localDate}
              >
                <th scope="row">{row.dateLabel}</th>
                <td>
                  <span className="trends-table__value">{row.value}</span>
                  {row.detail !== null && <span className="trends-table__detail">{row.detail}</span>}
                </td>
                <td>
                  <div className="trends-table__actions">
                    <button aria-label={`Open Today on ${row.dateLabel}`} onClick={() => onOpenDay(row.localDate)} type="button">
                      Open
                    </button>
                    {openMealLog !== null && (
                      <button aria-label={words.aria(row.dateLabel)} onClick={() => openMealLog(row.localDate)} type="button">
                        {words.text}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="today-meta">{computedLine(trends, timeZone)}</p>
    </div>
  );
}
