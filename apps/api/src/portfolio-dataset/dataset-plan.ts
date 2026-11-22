import { createHash } from 'node:crypto';

import {
  addLocalDays,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  previousActivityTrendsPeriodOf,
  type ActivityType,
  type CreateActivityRequest,
  type CreateMealRequest,
  type MealNutritionField,
  type PointInput,
  type PutDailyMetricsRequest,
  type PutDailyMovementRequest,
} from '@running-tracker/contracts';

import { localDateOf } from '../runs/run-search-period.js';

// The portfolio v1 synthetic dataset (release step 2, docs/runbooks/portfolio-dataset.md): a PURE planner. Every value is
// a function of (dataset version, seed, anchor date, time zone) and of a record's label, never of call order, the clock
// or the database, so the same parameters always give the same plan. Nothing here is real personal data: identities,
// texts and coordinates are generated.
//
// Calendar: the 56 consecutive local dates ending on the anchor. The CURRENT range is anchor-27..anchor (the 28 dates a
// Trends read ending on the anchor shows) and the PREVIOUS range the 28 dates before it (the activity comparison's
// previous period, contracts previousActivityTrendsPeriodOf). Dates are calendar arithmetic (addLocalDays), never 24-hour
// steps, and every instant is the local wall time in the zone, so a range crossing a daylight-saving change is exact.
//
// Offsets: `k` is the number of dates before the anchor (k = 0 is the anchor, k = 55 the first date). The deliberate
// gaps and special values are fixed functions of k (documented in the runbook); the numbers vary with the seed.

export const PORTFOLIO_DATASET_VERSION = 'portfolio-dataset-v1';
export const PORTFOLIO_DEFAULT_SEED = 'somalane-portfolio-v1';
export const PORTFOLIO_DEFAULT_TIME_ZONE = 'Europe/Warsaw';
export const PORTFOLIO_DATASET_DAYS = 56;
export const PORTFOLIO_RANGE_DAYS = 28;

/** The demo identities of scripts/demo-plan.mjs, so the existing "Demo runner"/"Demo coach" buttons sign in as them. */
export const portfolioIdentities = Object.freeze({
  coach: 'dddddddd-dddd-4ddd-8ddd-dddddddd0002',
  coachExternalIdentity: 'demo-coach',
  organization: 'dddddddd-dddd-4ddd-8ddd-dddddddd0000',
  runner: 'dddddddd-dddd-4ddd-8ddd-dddddddd0001',
  runnerExternalIdentity: 'demo-runner',
});

export interface DatasetParameters {
  anchorDate: string;
  seed: string;
  timeZone: string;
}

export interface PlannedCheckIn {
  k: number;
  localDate: string;
  loggedAtMs: number;
  request: PutDailyMetricsRequest;
}

export interface PlannedMovement {
  k: number;
  localDate: string;
  loggedAtMs: number;
  request: PutDailyMovementRequest;
}

export interface PlannedManualActivity {
  activityId: string;
  k: number;
  localDate: string;
  loggedAtMs: number;
  request: CreateActivityRequest;
}

export interface PlannedImport {
  activityId: string;
  /** The synthetic file as uploaded (UTF-8 text). */
  document: string;
  /** Independently specified expectations of the server's summary (the planner's own arithmetic). */
  expected: { distanceM: number; distanceToleranceM: number; durationS: number; startedAt: string };
  idempotencyKey: string;
  importedAtMs: number;
  k: number;
  kind: 'gpx' | 'tcx';
  localDate: string;
  type: ActivityType;
}

export interface PlannedRun {
  /** Batches of at most 100 points (POINT_BATCH_MAX_SIZE), in sequence order. */
  batches: PointInput[][];
  finishCommandId: string;
  finishedAtMs: number;
  k: number;
  localDate: string;
  /** Length of the planned polyline on a sphere (haversine): the expectation the PostGIS summary is checked against. */
  plannedDistanceM: number;
  /** Seconds from the first to the last point. */
  plannedDurationS: number;
  pointCount: number;
  runId: string;
  share: { canReadHistory: boolean; canReadLive: boolean; granteeUserId: string } | null;
  startedAt: string;
}

export interface PlannedMeal {
  k: number;
  localDate: string;
  loggedAtMs: number;
  request: CreateMealRequest;
}

export interface DatasetPlan {
  checkIns: PlannedCheckIn[];
  dates: string[];
  gaps: { checkIn: string[]; meals: string[]; movement: string[]; unlogged: string[] };
  identities: typeof portfolioIdentities;
  imports: PlannedImport[];
  manualActivities: PlannedManualActivity[];
  meals: PlannedMeal[];
  movement: PlannedMovement[];
  parameters: DatasetParameters;
  ranges: { current: { endDate: string; startDate: string }; previous: { endDate: string; startDate: string } };
  runs: PlannedRun[];
  version: typeof PORTFOLIO_DATASET_VERSION;
}

const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Seeds are short printable labels, so they can be written on a command line and in a manifest unchanged. */
export function assertSeed(seed: string): string {
  if (!SEED_PATTERN.test(seed)) throw new RangeError('The seed must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" or "-"');
  return seed;
}

export function assertAnchorDate(anchorDate: string): string {
  if (!DATE_PATTERN.test(anchorDate) || addLocalDays(anchorDate, 0) !== anchorDate) {
    throw new RangeError('The anchor date must be a calendar date written YYYY-MM-DD');
  }
  if (addLocalDays(anchorDate, -(PORTFOLIO_DATASET_DAYS - 1)) < '2000-01-01') {
    throw new RangeError('The anchor date must leave 56 dates on or after 2000-01-01');
  }
  return anchorDate;
}

export function assertTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(`Unknown time zone ${JSON.stringify(timeZone)}`);
  }
}

/** The default anchor: yesterday in the zone, the last COMPLETED date, so an activity comparison is not "in progress". */
export function defaultAnchorDate(nowMs: number, timeZone: string): string {
  return addLocalDays(localDateOf(nowMs, timeZone), -1);
}

/** Refuses an anchor that is today or later in the zone: those dates are not finished (or have not happened). */
export function assertAnchorCompleted(anchorDate: string, timeZone: string, nowMs: number): void {
  const today = localDateOf(nowMs, timeZone);
  if (anchorDate >= today) {
    throw new RangeError(`The anchor date must be a completed date, before today (${today} in ${timeZone})`);
  }
}

export function resolveParameters(
  input: { anchorDate?: string | undefined; seed?: string | undefined; timeZone?: string | undefined },
  nowMs: number,
): DatasetParameters {
  const timeZone = assertTimeZone(input.timeZone ?? PORTFOLIO_DEFAULT_TIME_ZONE);
  const anchorDate = assertAnchorDate(input.anchorDate ?? defaultAnchorDate(nowMs, timeZone));
  assertAnchorCompleted(anchorDate, timeZone, nowMs);
  return { anchorDate, seed: assertSeed(input.seed ?? PORTFOLIO_DEFAULT_SEED), timeZone };
}

// --- Deterministic randomness ----------------------------------------------------------------------------------------

function digestOf(parameters: DatasetParameters, label: string): Buffer {
  return createHash('sha256')
    .update(`${PORTFOLIO_DATASET_VERSION}\n${parameters.seed}\n${parameters.anchorDate}\n${parameters.timeZone}\n${label}`, 'utf8')
    .digest();
}

function makeRandom(parameters: DatasetParameters) {
  const unit = (label: string) => digestOf(parameters, label).readUInt32BE(0) / 2 ** 32;
  const int = (label: string, min: number, max: number) => min + Math.floor(unit(label) * (max - min + 1));
  const pick = <Value>(label: string, values: readonly Value[]): Value => values[int(label, 0, values.length - 1)]!;
  /** An RFC 4122 version-4 shaped UUID (the contracts' canonical form) from the label. */
  const uuid = (label: string) => {
    const hex = digestOf(parameters, `uuid:${label}`).toString('hex').slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = '89ab'[Number.parseInt(hex[16]!, 16) % 4]!;
    const text = hex.join('');
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  };
  return { int, pick, unit, uuid };
}

// --- Local wall time -------------------------------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(instantMs: number, timeZone: string): { date: string; hour: number; minute: number } {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    });
    partsFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/**
 * The instant at which the zone's clocks show `hour:minute` on `localDate`. Throws for a wall time the zone skipped.
 * The planner only uses times from 06:00 to 22:59, which no daylight-saving rule of the supported zones skips or repeats.
 */
export function zonedInstantMs(localDate: string, hour: number, minute: number, timeZone: string): number {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instantMs: number) => {
    const wall = wallParts(instantMs, timeZone);
    const [y, m, d] = wall.date.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d, wall.hour, wall.minute) - Math.floor(instantMs / 60_000) * 60_000;
  };
  let guess = wallMs - offsetAt(wallMs);
  guess = wallMs - offsetAt(guess);
  const check = wallParts(guess, timeZone);
  if (check.date !== localDate || check.hour !== hour || check.minute !== minute) {
    throw new RangeError(`${localDate} ${String(hour)}:${String(minute)} does not exist in ${timeZone}`);
  }
  return guess;
}

const iso = (ms: number) => new Date(ms).toISOString();

// --- Geometry (synthetic) --------------------------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;
// A generated point in a park-sized area west of central Warsaw, offset per seed by up to ~1 km. Not anyone's route.
const CENTRE = { latitude: 52.2135, longitude: 20.9605 };

export function haversineM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const round7 = (value: number) => Math.round(value * 1e7) / 1e7;

/** Points on an ellipse around `centre`, `stepM` apart along it (approximately), `count` of them. */
function loopPositions(centre: { latitude: number; longitude: number }, radiusNorthM: number, radiusEastM: number, stepM: number, count: number) {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((centre.latitude * Math.PI) / 180);
  const meanRadius = (radiusNorthM + radiusEastM) / 2;
  const angleStep = stepM / meanRadius;
  return Array.from({ length: count }, (_, index) => {
    const angle = index * angleStep;
    return {
      latitude: round7(centre.latitude + (radiusNorthM * Math.sin(angle)) / metresPerDegreeLatitude),
      longitude: round7(centre.longitude + (radiusEastM * Math.cos(angle)) / metresPerDegreeLongitude),
    };
  });
}

function pathLengthM(positions: readonly { latitude: number; longitude: number }[]): number {
  let total = 0;
  for (let index = 1; index < positions.length; index += 1) total += haversineM(positions[index - 1]!, positions[index]!);
  return total;
}

// --- Synthetic files -------------------------------------------------------------------------------------------------

const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
const TCX_NAMESPACE = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';

function syntheticGpx(points: readonly { latitude: number; longitude: number; timeMs: number }[]): string {
  const trackPoints = points
    .map((point) => `<trkpt lat="${point.latitude.toFixed(7)}" lon="${point.longitude.toFixed(7)}"><time>${iso(point.timeMs)}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SomaLane synthetic portfolio dataset" xmlns="${GPX_NAMESPACE}">
<metadata><name>Synthetic track</name></metadata>
<trk><name>Synthetic track</name><trkseg>
${trackPoints}
</trkseg></trk>
</gpx>
`;
}

interface TcxLap {
  distance: string;
  startMs: number;
  total: string;
}

function syntheticTcx(laps: readonly TcxLap[]): string {
  const lapXml = laps
    .map(
      (lap) =>
        `<Lap StartTime="${iso(lap.startMs)}"><TotalTimeSeconds>${lap.total}</TotalTimeSeconds><DistanceMeters>${lap.distance}</DistanceMeters><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod></Lap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="${TCX_NAMESPACE}"><Activities><Activity Sport="Other"><Id>${iso(laps[0]!.startMs)}</Id>
${lapXml}
<Creator><Name>SomaLane synthetic portfolio dataset</Name></Creator></Activity></Activities></TrainingCenterDatabase>
`;
}

/** Sum of decimal strings with at most two fraction digits, rounded half up to a whole number (the TCX summary rule). */
function roundedDecimalSum(values: readonly string[]): number {
  const hundredths = values.reduce((sum, value) => sum + Math.round(Number(value) * 100), 0);
  return Math.floor((hundredths + 50) / 100);
}

// --- Texts (synthetic) -----------------------------------------------------------------------------------------------

const CHECK_IN_NOTES = ['Synthetic note: easy day.', 'Synthetic note: legs felt heavy.', 'Synthetic note: slept well.', 'Synthetic note: busy at work.'];
const RUN_NOTES = ['Synthetic: steady pace.', 'Synthetic: intervals in the park.', 'Synthetic: easy recovery run.'];
const FULL_BREAKFASTS = ['Oat porridge with berries', 'Yoghurt with granola', 'Scrambled eggs on toast', 'Rye bread with cottage cheese'];
const FULL_LUNCHES = ['Chicken and rice bowl', 'Lentil soup with bread', 'Pasta with tomato sauce', 'Buckwheat with vegetables'];
const PARTIAL_LUNCHES = ['Canteen salad', 'Wrap from the kiosk', 'Leftover stew'];
const TITLE_ONLY_DINNERS = ['Dinner at a friend’s place', 'Family dinner', 'Pierogi, amounts not noted'];
const SNACKS = ['Apple', 'Banana', 'Handful of nuts', 'Protein bar'];

// --- The plan --------------------------------------------------------------------------------------------------------

/** The plan's date of offset k (k dates before the anchor). */
function dateOf(parameters: DatasetParameters, k: number): string {
  return addLocalDays(parameters.anchorDate, -k);
}

const tenths = (value: number) => Math.round(value * 10) / 10;

/** Dates with nothing recorded at all, one in each range: an unlogged date is unknown, never "no activity". */
export const UNLOGGED_OFFSETS: ReadonlySet<number> = new Set([10, 38]);

export function planDataset(input: DatasetParameters): DatasetPlan {
  const parameters: DatasetParameters = {
    anchorDate: assertAnchorDate(input.anchorDate),
    seed: assertSeed(input.seed),
    timeZone: assertTimeZone(input.timeZone),
  };
  const random = makeRandom(parameters);
  const zone = parameters.timeZone;
  const at = (localDate: string, hour: number, minute: number) => zonedInstantMs(localDate, hour, minute, zone);

  const current = dailyTrendsRangeOf(parameters.anchorDate);
  const previousPeriod = previousActivityTrendsPeriodOf(parameters.anchorDate).period;
  if (previousPeriod === null || current.days !== PORTFOLIO_RANGE_DAYS || previousPeriod.days !== PORTFOLIO_RANGE_DAYS) {
    throw new RangeError('The anchor date must leave two full 28-date ranges');
  }
  const dates = [...dailyTrendsDatesOf(previousPeriod), ...dailyTrendsDatesOf(current)];
  if (dates.length !== PORTFOLIO_DATASET_DAYS || dates.at(-1) !== parameters.anchorDate || dates[0] !== dateOf(parameters, 55)) {
    throw new Error('The plan calendar is not the 56 dates ending on the anchor');
  }

  const offsets = Array.from({ length: PORTFOLIO_DATASET_DAYS }, (_, index) => PORTFOLIO_DATASET_DAYS - 1 - index);
  const centre = {
    latitude: CENTRE.latitude + (random.unit('centre:lat') - 0.5) * 0.012,
    longitude: CENTRE.longitude + (random.unit('centre:lon') - 0.5) * 0.02,
  };

  // Check-ins: none when k % 7 === 3 (8 dates). Individual values missing by pattern: weight when k % 5 === 2, sleep
  // duration when k % 11 === 6; mood, soreness, sleep quality and a note only on some dates.
  const checkIns: PlannedCheckIn[] = [];
  const weightBase = 71 + random.int('weight:base', 0, 300) / 100;
  for (const k of offsets) {
    if (k % 7 === 3 || UNLOGGED_OFFSETS.has(k)) continue;
    const localDate = dateOf(parameters, k);
    const drift = ((55 - k) * 0.012) - random.int(`weight:${String(k)}`, 0, 60) / 100;
    const request: PutDailyMetricsRequest = {
      mood: k % 3 === 0 ? random.int(`mood:${String(k)}`, 2, 5) : null,
      note: k % 9 === 0 ? random.pick(`note:${String(k)}`, CHECK_IN_NOTES) : null,
      sleepMinutes: k % 11 === 6 ? null : random.int(`sleep:${String(k)}`, 380, 510),
      sleepQuality: k % 2 === 0 ? random.int(`sleepq:${String(k)}`, 2, 5) : null,
      soreness: k % 4 === 1 ? random.int(`soreness:${String(k)}`, 0, 3) : null,
      timeZone: zone,
      weightKg: k % 5 === 2 ? null : Math.round((weightBase - drift) * 100) / 100,
    };
    checkIns.push({ k, localDate, loggedAtMs: at(localDate, 22, 0), request });
  }

  // Manual daily movement: none when k % 6 === 4 (9 dates). Steps only when k % 8 === 5, active energy only when
  // k % 13 === 7, and k === 20 is a recorded zero for both (a sick day: a value, not a gap).
  const movement: PlannedMovement[] = [];
  for (const k of offsets) {
    if (k % 6 === 4 || UNLOGGED_OFFSETS.has(k)) continue;
    const localDate = dateOf(parameters, k);
    const zero = k === 20;
    const steps = zero ? 0 : k % 13 === 7 ? null : random.int(`steps:${String(k)}`, 4_200, 14_500);
    const energy = zero ? 0 : k % 8 === 5 ? null : tenths(random.int(`energy:${String(k)}`, 1_500, 6_800) / 10);
    movement.push({ k, localDate, loggedAtMs: at(localDate, 21, 30), request: { activeEnergyKcal: energy, steps, timeZone: zone } });
  }

  // Manual activities. Runs (all with a distance, so their comparison is defined): k % 7 === 1 or 4 in both ranges, plus
  // k === 13 in the current range. Strength sessions (never a distance) when k % 7 === 6. Walks only in the current
  // range: the anchor (with a distance) and k === 16 (without one).
  const manualActivities: PlannedManualActivity[] = [];
  const addManual = (k: number, type: ActivityType, hour: number, withDistance: boolean, index: number) => {
    const localDate = dateOf(parameters, k);
    const label = `manual:${type}:${String(k)}:${String(index)}`;
    const startMs = at(localDate, hour, random.int(`${label}:minute`, 0, 45));
    let durationS: number;
    let distanceM: number | null = null;
    let rpe: number | null = null;
    let notes: string | null = null;
    if (type === 'run') {
      distanceM = random.int(`${label}:distance`, 40, 110) * 100;
      durationS = Math.round((distanceM / 1_000) * random.int(`${label}:pace`, 290, 360));
      rpe = random.int(`${label}:rpe`, 3, 8);
      notes = random.int(`${label}:hasnote`, 0, 2) === 0 ? random.pick(`${label}:note`, RUN_NOTES) : null;
    } else if (type === 'walk') {
      durationS = random.int(`${label}:duration`, 25, 70) * 60;
      distanceM = withDistance ? Math.round((durationS / 60) * random.int(`${label}:speed`, 75, 95)) : null;
    } else {
      durationS = random.int(`${label}:duration`, 30, 60) * 60;
      rpe = random.int(`${label}:rpe`, 4, 7);
    }
    const request: CreateActivityRequest = {
      distanceM,
      durationS,
      idempotencyKey: random.uuid(`${label}:key`),
      notes,
      rpe,
      startedAt: iso(startMs),
      type,
    };
    manualActivities.push({ activityId: random.uuid(`${label}:id`), k, localDate, loggedAtMs: startMs + (durationS + 600) * 1_000, request });
  };
  for (const k of [...offsets].reverse()) {
    if (UNLOGGED_OFFSETS.has(k)) continue;
    if (k % 7 === 1 || k % 7 === 4 || k === 13) addManual(k, 'run', 7, true, 0);
    if (k % 7 === 6) addManual(k, 'strength', 18, false, 0);
    if (k === 0) addManual(k, 'walk', 17, true, 0);
    if (k === 16) addManual(k, 'walk', 17, false, 0);
  }

  // GPX imports (current range only, so the GPX comparison shows "no entries" for the previous range): a ride on k = 5
  // and a hike on k = 19. Points every 5 s along a synthetic loop.
  const imports: PlannedImport[] = [];
  const addGpx = (k: number, type: ActivityType, speedMS: number, seconds: number) => {
    const localDate = dateOf(parameters, k);
    const label = `gpx:${String(k)}`;
    const startMs = at(localDate, 10, random.int(`${label}:minute`, 0, 50));
    const count = Math.floor(seconds / 5) + 1;
    const loopCentre = { latitude: centre.latitude + 0.004, longitude: centre.longitude - 0.006 };
    const positions = loopPositions(loopCentre, 600 + random.int(`${label}:rn`, 0, 200), 900 + random.int(`${label}:re`, 0, 300), speedMS * 5, count);
    const points = positions.map((position, index) => ({ ...position, timeMs: startMs + index * 5_000 }));
    const plannedDistance = pathLengthM(positions);
    imports.push({
      activityId: random.uuid(`${label}:id`),
      document: syntheticGpx(points),
      expected: {
        distanceM: Math.round(plannedDistance),
        // Vincenty on the WGS84 ellipsoid (the server) against a haversine sphere (here): well under 0.5 %.
        distanceToleranceM: Math.ceil(plannedDistance * 0.005),
        durationS: (count - 1) * 5,
        startedAt: iso(startMs),
      },
      idempotencyKey: random.uuid(`${label}:key`),
      importedAtMs: startMs + (seconds + 3_600) * 1_000,
      k,
      kind: 'gpx',
      localDate,
      type,
    });
  };
  addGpx(19, 'hike', 1.4, 3_600);
  addGpx(5, 'ride', 6, 2_700);

  // TCX imports: a swim in each range (k = 33 and k = 12), two laps each with reported totals whose sums round half up.
  const addTcx = (k: number) => {
    const localDate = dateOf(parameters, k);
    const label = `tcx:${String(k)}`;
    const startMs = at(localDate, 6, 30 + random.int(`${label}:minute`, 0, 20));
    const firstTotal = `${String(random.int(`${label}:t1`, 840, 960))}.${String(random.int(`${label}:t1f`, 0, 9))}`;
    const secondTotal = `${String(random.int(`${label}:t2`, 840, 960))}.${String(random.int(`${label}:t2f`, 0, 9))}`;
    const firstDistance = `${String(random.int(`${label}:d1`, 600, 800))}.${String(random.int(`${label}:d1f`, 0, 99)).padStart(2, '0')}`;
    const secondDistance = `${String(random.int(`${label}:d2`, 600, 800))}.${String(random.int(`${label}:d2f`, 0, 99)).padStart(2, '0')}`;
    const laps: TcxLap[] = [
      { distance: firstDistance, startMs, total: firstTotal },
      { distance: secondDistance, startMs: startMs + (Math.ceil(Number(firstTotal)) + 30) * 1_000, total: secondTotal },
    ];
    imports.push({
      activityId: random.uuid(`${label}:id`),
      document: syntheticTcx(laps),
      expected: {
        distanceM: roundedDecimalSum([firstDistance, secondDistance]),
        distanceToleranceM: 0,
        durationS: roundedDecimalSum([firstTotal, secondTotal]),
        startedAt: iso(startMs),
      },
      idempotencyKey: random.uuid(`${label}:key`),
      importedAtMs: startMs + 4 * 3_600_000,
      k,
      kind: 'tcx',
      localDate,
      type: 'swim',
    });
  };
  addTcx(33);
  addTcx(12);
  imports.sort((a, b) => b.k - a.k);

  // Recorded runs: three finished runs per range (current k = 23, 9, 0; previous k = 44, 37, 30), each recorded through
  // the run lifecycle with one point every 5 s. The anchor's run is shared with the coach (history only).
  const runs: PlannedRun[] = [];
  for (const k of [44, 37, 30, 23, 9, 0]) {
    const localDate = dateOf(parameters, k);
    const label = `run:${String(k)}`;
    const startMs = at(localDate, 8, random.int(`${label}:minute`, 0, 40));
    const seconds = random.int(`${label}:minutes`, 22, 38) * 60;
    const count = seconds / 5 + 1;
    const speed = random.int(`${label}:speed`, 270, 330) / 100;
    const positions = loopPositions(centre, 280 + random.int(`${label}:rn`, 0, 60), 340 + random.int(`${label}:re`, 0, 80), speed * 5, count);
    const points: PointInput[] = positions.map((position, index) => ({
      accuracyM: 4 + (index % 3),
      latitude: position.latitude,
      longitude: position.longitude,
      recordedAt: iso(startMs + index * 5_000),
      segmentId: 0,
      seq: String(index + 1),
    }));
    const batches: PointInput[][] = [];
    for (let index = 0; index < points.length; index += 100) batches.push(points.slice(index, index + 100));
    runs.push({
      batches,
      finishCommandId: random.uuid(`${label}:finish`),
      finishedAtMs: startMs + (seconds + 4) * 1_000,
      k,
      localDate,
      plannedDistanceM: pathLengthM(positions),
      plannedDurationS: seconds,
      pointCount: points.length,
      runId: random.uuid(`${label}:id`),
      share: k === 0 ? { canReadHistory: true, canReadLive: false, granteeUserId: portfolioIdentities.coach } : null,
      startedAt: iso(startMs),
    });
  }

  // Meals: none when k % 5 === 3 (11 dates). A full breakfast (all four values) every logged date; a lunch, full when k
  // is even, partial (energy and protein only) when odd; a title-only dinner when k % 4 === 1; a snack with energy only
  // when k % 3 === 2; recorded zeros ("Black coffee", all four values 0) when k % 6 === 0.
  const meals: PlannedMeal[] = [];
  const addMeal = (k: number, slot: string, request: Omit<CreateMealRequest, 'idempotencyKey' | 'localDate' | 'timeZone'>, hour: number) => {
    const localDate = dateOf(parameters, k);
    meals.push({
      k,
      localDate,
      loggedAtMs: at(localDate, hour, 15),
      request: { ...request, idempotencyKey: random.uuid(`meal:${String(k)}:${slot}:key`), localDate, timeZone: zone },
    });
  };
  for (const k of offsets) {
    if (k % 5 === 3 || UNLOGGED_OFFSETS.has(k)) continue;
    const label = (slot: string, field: string) => `meal:${String(k)}:${slot}:${field}`;
    const value = (slot: string, field: string, min: number, max: number) => random.int(label(slot, field), min * 10, max * 10) / 10;
    addMeal(
      k,
      'breakfast',
      {
        carbohydrateG: value('breakfast', 'carbs', 35, 75),
        energyKcal: value('breakfast', 'energy', 320, 560),
        fatG: value('breakfast', 'fat', 6, 22),
        mealType: 'breakfast',
        proteinG: value('breakfast', 'protein', 12, 32),
        title: random.pick(label('breakfast', 'title'), FULL_BREAKFASTS),
      },
      8,
    );
    if (k % 6 === 0) {
      addMeal(k, 'coffee', { carbohydrateG: 0, energyKcal: 0, fatG: 0, mealType: 'snack', proteinG: 0, title: 'Black coffee' }, 10);
    }
    addMeal(
      k,
      'lunch',
      k % 2 === 0
        ? {
            carbohydrateG: value('lunch', 'carbs', 50, 95),
            energyKcal: value('lunch', 'energy', 520, 820),
            fatG: value('lunch', 'fat', 10, 30),
            mealType: 'lunch',
            proteinG: value('lunch', 'protein', 22, 48),
            title: random.pick(label('lunch', 'title'), FULL_LUNCHES),
          }
        : {
            carbohydrateG: null,
            energyKcal: value('lunch', 'energy', 450, 750),
            fatG: null,
            mealType: 'lunch',
            proteinG: value('lunch', 'protein', 15, 40),
            title: random.pick(label('lunch', 'title'), PARTIAL_LUNCHES),
          },
      13,
    );
    if (k % 3 === 2) {
      addMeal(
        k,
        'snack',
        { carbohydrateG: null, energyKcal: value('snack', 'energy', 90, 250), fatG: null, mealType: 'snack', proteinG: null, title: random.pick(label('snack', 'title'), SNACKS) },
        16,
      );
    }
    if (k % 4 === 1) {
      addMeal(k, 'dinner', { carbohydrateG: null, energyKcal: null, fatG: null, mealType: 'dinner', proteinG: null, title: random.pick(label('dinner', 'title'), TITLE_ONLY_DINNERS) }, 19);
    }
  }

  const loggedDates = (records: readonly { localDate: string }[]) => new Set(records.map((record) => record.localDate));
  const checkInDates = loggedDates(checkIns);
  const movementDates = loggedDates(movement);
  const mealDates = loggedDates(meals);
  const anyRecordDates = new Set([
    ...checkInDates,
    ...movementDates,
    ...mealDates,
    ...manualActivities.map((item) => item.localDate),
    ...imports.map((item) => item.localDate),
    ...runs.map((item) => item.localDate),
  ]);

  return {
    checkIns: [...checkIns].reverse(),
    dates,
    gaps: {
      checkIn: dates.filter((date) => !checkInDates.has(date)),
      meals: dates.filter((date) => !mealDates.has(date)),
      movement: dates.filter((date) => !movementDates.has(date)),
      unlogged: dates.filter((date) => !anyRecordDates.has(date)),
    },
    identities: portfolioIdentities,
    imports,
    manualActivities,
    meals: [...meals].sort((a, b) => (a.localDate === b.localDate ? a.loggedAtMs - b.loggedAtMs : a.localDate < b.localDate ? -1 : 1)),
    movement: [...movement].reverse(),
    parameters,
    ranges: {
      current: { endDate: current.endDate, startDate: current.startDate },
      previous: { endDate: previousPeriod.endDate, startDate: previousPeriod.startDate },
    },
    runs,
    version: PORTFOLIO_DATASET_VERSION,
  };
}

// --- Independently computed expectations -----------------------------------------------------------------------------

const NUTRITION_FIELDS: readonly MealNutritionField[] = ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG'];

export interface NutritionExpectation {
  loggedEntries: number;
  metrics: Record<MealNutritionField, { recordedEntries: number; total: number | null }>;
}

/** What the plan's meals of `dates` add up to, per nutrient: entries recording it and their exact sum (tenths arithmetic). */
export function expectedNutrition(plan: DatasetPlan, dates: readonly string[]): NutritionExpectation {
  const selected = plan.meals.filter((meal) => dates.includes(meal.localDate));
  const metrics = Object.fromEntries(
    NUTRITION_FIELDS.map((field) => {
      const values = selected.map((meal) => meal.request[field]).filter((value): value is number => value !== null && value !== undefined);
      return [field, { recordedEntries: values.length, total: values.length === 0 ? null : values.reduce((sum, value) => sum + Math.round(value * 10), 0) / 10 }];
    }),
  ) as NutritionExpectation['metrics'];
  return { loggedEntries: selected.length, metrics };
}

export interface ManualComparisonSide {
  count: number;
  daysWithEntries: number;
  distanceM: number | null;
  durationS: number | null;
  withDistance: number;
}

/** Manual activities of one type in one range: count, summed durations, and distances rounded once per date. */
export function expectedManualSide(plan: DatasetPlan, type: ActivityType, range: { endDate: string; startDate: string }): ManualComparisonSide {
  const items = plan.manualActivities.filter((item) => item.request.type === type && item.localDate >= range.startDate && item.localDate <= range.endDate);
  const byDate = new Map<string, number[]>();
  for (const item of items) {
    if (item.request.distanceM !== null && item.request.distanceM !== undefined) {
      byDate.set(item.localDate, [...(byDate.get(item.localDate) ?? []), item.request.distanceM]);
    }
  }
  const withDistance = items.filter((item) => item.request.distanceM !== null && item.request.distanceM !== undefined).length;
  const distanceM = byDate.size === 0 ? null : [...byDate.values()].reduce((sum, values) => sum + Math.round(values.reduce((a, b) => a + b, 0)), 0);
  return {
    count: items.length,
    daysWithEntries: new Set(items.map((item) => item.localDate)).size,
    distanceM,
    durationS: items.length === 0 ? null : items.reduce((sum, item) => sum + item.request.durationS, 0),
    withDistance,
  };
}

/** The week (Monday..Sunday) of the weekly review selection: the last complete week inside the current range. */
export function reviewWeekOf(plan: DatasetPlan): { end: string; start: string } {
  const anchor = plan.parameters.anchorDate;
  const weekday = new Date(`${anchor}T00:00:00Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
  const end = weekday === 0 ? anchor : addLocalDays(anchor, -weekday);
  return { end, start: addLocalDays(end, -6) };
}
