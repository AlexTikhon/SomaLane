import {
  apiErrorResponseSchema,
  dailyTrendsSchema,
  DAILY_TRENDS_VERSION,
  isEmptyDailyTrends,
  MEAL_NUTRITION_FIELDS,
  type DailyTrendDay,
  type DailyTrends,
  type MealNutritionField,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// 28-day trends (ADR-0084; recorded nutrition since ADR-0096) over HTTP, with the real runtime role, sessions and
// row-level security.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-20T10:00:00.000Z'; // 11:00 in Warsaw, 2026-11-21 00:00 in Kiritimati (UTC+14)
const ZONE = 'Europe/Warsaw';
const END = '2026-11-20'; // the range 2026-10-24..2026-11-20 contains the Warsaw fall-back date 2026-10-25
const START = '2026-10-24';
const silent = createLogger({ clock: { utcNow: () => new Date(now) }, minLevel: 'error', write: () => undefined });

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(now),
};

interface Authentication {
  cookie: string;
  csrfToken: string;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

const errorCode = (response: request.Response) => apiErrorResponseSchema.parse(response.body).error.code;
const dayOf = (trends: DailyTrends, localDate: string): DailyTrendDay => {
  const day = trends.days.find((entry) => entry.localDate === localDate);
  if (!day) throw new Error(`No ${localDate} in the range`);
  return day;
};

/** A date's expected nutrition: logged entries and, per field, [recorded entries, total]; the rest unknown. */
function nutrition(loggedEntries: number, values: Partial<Record<MealNutritionField, [number, number]>> = {}): DailyTrendDay['nutrition'] {
  const metric = (field: MealNutritionField) => ({ recordedEntries: values[field]?.[0] ?? 0, total: values[field]?.[1] ?? null });
  return { carbohydrateG: metric('carbohydrateG'), energyKcal: metric('energyKcal'), fatG: metric('fatG'), loggedEntries, proteinG: metric('proteinG') };
}
const noFood = nutrition(0);
const unrecorded = { recordedDays: 0, recordedEntries: 0, total: null };

describe('daily trends HTTP API', () => {
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let sessions: SessionManager;
  let app: ReturnType<typeof createApp>;
  let owner: Authentication;
  let stranger: Authentication;
  let grantee: Authentication;
  let outsider: Authentication;
  let inactive: Authentication;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB, ids.userInactive].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ application_name: 'running-tracker-trends-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    sessions = new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    app = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions });
    owner = await login(ids.userOrgA);
    stranger = await login(ids.userStranger);
    grantee = await login(ids.userDual);
    outsider = await login(ids.userOrgB);
    inactive = await login(ids.userInactive);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
  });

  afterAll(async () => {
    for (const table of ['daily_metrics', 'daily_movement', 'meals', 'erasure_ledger']) {
      await ownerPool?.query(`DELETE FROM ${table}`).catch(() => undefined);
    }
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const trendsPath = (orgId: string = ids.orgA) => `/api/orgs/${orgId}/daily-trends`;

  const get = (
    auth: Authentication | null,
    query: Record<string, string> = { endDate: END, timeZone: ZONE },
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ) => {
    const pending = request(options.target ?? app).get(trendsPath(options.orgId)).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function read(endDate: string = END, timeZone: string = ZONE, auth: Authentication = owner, target?: ReturnType<typeof createApp>): Promise<DailyTrends> {
    const response = await get(auth, { endDate, timeZone }, target ? { target } : {}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return dailyTrendsSchema.parse(response.body);
  }

  const checkIn = (
    localDate: string,
    values: { mood?: number; note?: string; sleepMinutes?: number; weightKg?: string },
    options: { orgId?: string; timeZone?: string; userId?: string } = {},
  ) =>
    ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, mood, note)
       VALUES ($1, $2, $3::date, $4, $5::numeric, $6, $7, $8)`,
      [options.orgId ?? ids.orgA, options.userId ?? ids.userOrgA, localDate, options.timeZone ?? ZONE, values.weightKg ?? null, values.sleepMinutes ?? null, values.mood ?? null, values.note ?? null],
    );

  const movement = (localDate: string, values: { energy?: string | null; orgId?: string; steps?: number | null; timeZone?: string; userId?: string }) =>
    ownerPool.query(
      `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, active_energy_kcal) VALUES ($1, $2, $3::date, $4, $5, $6::numeric)`,
      [values.orgId ?? ids.orgA, values.userId ?? ids.userOrgA, localDate, values.timeZone ?? ZONE, values.steps ?? null, values.energy ?? null],
    );

  /** A manual meal entry for a stored calendar date (ADR-0083); values as numeric text, omitted for not recorded. */
  const meal = (
    localDate: string,
    values: { carbohydrate?: string; energy?: string | null; fat?: string; orgId?: string; protein?: string; timeZone?: string; title?: string; userId?: string } = {},
  ) =>
    ownerPool
      .query<{ id: string }>(
        `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, energy_kcal, protein_g, carbohydrate_g, fat_g,
                            idempotency_key, creation_digest)
         VALUES ($1, $2, $3::date, $4, 'lunch', $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, gen_random_uuid(),
                 sha256(gen_random_uuid()::text::bytea))
         RETURNING id`,
        [
          values.orgId ?? ids.orgA,
          values.userId ?? ids.userOrgA,
          localDate,
          values.timeZone ?? ZONE,
          values.title ?? 'SECRET-MEAL-TITLE',
          values.energy ?? null,
          values.protein ?? null,
          values.carbohydrate ?? null,
          values.fat ?? null,
        ],
      )
      .then((result) => result.rows[0]!.id);

  const mutate = (method: 'delete' | 'post' | 'put', path: string, body?: object, auth: Authentication = owner) => {
    const pending = request(app)[method](path).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);
    return body === undefined ? pending : pending.type('application/json').send(body);
  };

  describe('series, missing values and coverage', () => {
    it('answers an empty range: 200, no-store, every date null, no totals, the actual range and app-computed provenance', async () => {
      const trends = await read();
      expect(trends.range).toEqual({
        days: 28,
        endDate: END,
        includesToday: true,
        requestedDays: 28,
        shortenedByLowerBound: false,
        startDate: START,
        timeZone: ZONE,
        today: END,
      });
      expect(trends.days).toHaveLength(28);
      expect(trends.days.every((day) => day.weightKg === null && day.sleepMinutes === null && day.steps === null)).toBe(true);
      for (const day of trends.days) expect(day.nutrition, day.localDate).toEqual(noFood);
      expect(trends.summary).toEqual({
        nutrition: {
          carbohydrateG: unrecorded,
          daysInRange: 28,
          daysWithEntries: 0,
          energyKcal: unrecorded,
          fatG: unrecorded,
          loggedEntries: 0,
          proteinG: unrecorded,
          source: 'manual',
        },
        sleep: { averageMinutes: null, daysRecorded: 0, recordedTotalMinutes: null },
        steps: { daysRecorded: 0, recordedTotal: null, source: 'manual' },
        weight: { changeKg: null, daysRecorded: 0, first: null, last: null },
      });
      expect(trends.provenance).toMatchObject({ persisted: false, snapshot: 'single_read_only_transaction', source: 'computed_by_app', trendsVersion: DAILY_TRENDS_VERSION });
      expect(DAILY_TRENDS_VERSION).toBe('daily-trends-2');
      expect(isEmptyDailyTrends(trends)).toBe(true);
    });

    it('keeps recorded zeros as values and averages and totals over recorded dates only, each series with its own coverage', async () => {
      await checkIn('2026-11-01', { sleepMinutes: 0 });
      await checkIn('2026-11-02', { sleepMinutes: 450 });
      await checkIn('2026-11-03', { mood: 4, note: 'PRIVATE-NOTE-TEXT' }); // no weight or sleep: no value for either series
      await movement('2026-11-01', { steps: 0 });
      await movement('2026-11-04', { steps: 0 });
      await movement('2026-11-05', { energy: '412.5' }); // active energy only: no step count
      await meal('2026-11-01', { energy: '0' });
      const response = await get(owner).expect(200);
      const trends = dailyTrendsSchema.parse(response.body);
      expect(dayOf(trends, '2026-11-01')).toEqual({ localDate: '2026-11-01', nutrition: nutrition(1, { energyKcal: [1, 0] }), sleepMinutes: 0, steps: 0, weightKg: null });
      expect(dayOf(trends, '2026-11-03')).toEqual({ localDate: '2026-11-03', nutrition: noFood, sleepMinutes: null, steps: null, weightKg: null });
      expect(dayOf(trends, '2026-11-05').steps).toBeNull();
      // 0 and 450 over the 2 recorded dates, not over 28: 225 minutes.
      expect(trends.summary.sleep).toEqual({ averageMinutes: 225, daysRecorded: 2, recordedTotalMinutes: 450 });
      expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 0, source: 'manual' });
      expect(trends.summary.nutrition.energyKcal).toEqual({ recordedDays: 1, recordedEntries: 1, total: 0 });
      expect(trends.summary.weight.daysRecorded).toBe(0);
      expect(response.text).not.toMatch(/PRIVATE-NOTE-TEXT|412\.5|mood/u);
    });

    it('keeps day and entry coverage apart: a title-only day, partial entry coverage, and no titles returned', async () => {
      await meal('2026-11-10', { title: 'Apple' });
      await meal('2026-11-10', { title: 'Tea' }); // a title-only day: two entries, no value
      await meal('2026-11-11', { energy: '350.5' });
      await meal('2026-11-11', { energy: '410.4' });
      await meal('2026-11-11', { protein: '20' }); // energy unknown for this entry
      const response = await get(owner).expect(200);
      const trends = dailyTrendsSchema.parse(response.body);
      expect(dayOf(trends, '2026-11-10').nutrition).toEqual(nutrition(2));
      expect(dayOf(trends, '2026-11-11').nutrition).toEqual(nutrition(3, { energyKcal: [2, 760.9], proteinG: [1, 20] }));
      expect(trends.summary.nutrition).toMatchObject({
        daysWithEntries: 2,
        energyKcal: { recordedDays: 1, recordedEntries: 2, total: 760.9 },
        loggedEntries: 5,
        proteinG: { recordedDays: 1, recordedEntries: 1, total: 20 },
      });
      // No title or meal type; the only zone in the answer is the requested one (range.timeZone), never a meal's.
      expect(response.text).not.toMatch(/Apple|Tea|SECRET-MEAL-TITLE|lunch/u);
    });

    it('adds food energy exactly: tenths that binary floating point cannot add exactly, per date and across dates', async () => {
      for (let index = 0; index < 10; index += 1) await meal('2026-11-12', { energy: '0.1' });
      await meal('2026-11-13', { energy: '0.1' });
      await meal('2026-11-14', { energy: '0.2' });
      await meal('2026-11-15', { energy: '19999.9' });
      await meal('2026-11-15', { energy: '19999.9' });
      const trends = await read();
      expect(dayOf(trends, '2026-11-12').nutrition.energyKcal).toEqual({ recordedEntries: 10, total: 1 });
      expect(dayOf(trends, '2026-11-15').nutrition.energyKcal.total).toBe(39999.8);
      // 1 + 0.1 + 0.2 + 39,999.8 = 40,001.1 exactly (floating point would give 40001.100000000006 or similar).
      expect(trends.summary.nutrition.energyKcal).toEqual({ recordedDays: 4, recordedEntries: 14, total: 40001.1 });
      expect(trends.summary.nutrition.loggedEntries).toBe(14);
    });

    it('reports no weight change for a single measurement, and the exact first, last and change for several recorded dates', async () => {
      await checkIn('2026-11-05', { weightKg: '72.35' });
      expect((await read()).summary.weight).toEqual({ changeKg: null, daysRecorded: 1, first: null, last: null });

      await checkIn('2026-10-24', { weightKg: '90.00' });
      await checkIn('2026-11-19', { weightKg: '72.30' });
      expect((await read()).summary.weight).toEqual({
        changeKg: -17.7,
        daysRecorded: 3,
        first: { kg: 90, localDate: '2026-10-24' },
        last: { kg: 72.3, localDate: '2026-11-19' },
      });
    });
  });

  describe('recorded nutrition (ADR-0096)', () => {
    const A = '2026-11-02';
    const B = '2026-11-03';
    const C = '2026-11-04';

    it('answers the required fixture exactly: independent coverage, a recorded zero, a title-only entry and a date without entries', async () => {
      await meal(A, { energy: '100.1', fat: '0', protein: '10.1', title: 'Entry one' });
      await meal(A, { carbohydrate: '20.2', protein: '0', title: 'Entry two' });
      await meal(A, { title: 'Entry three, title only' });
      await meal(B, { carbohydrate: '0', energy: '0', fat: '5.3', title: 'Entry four' });
      const response = await get(owner).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const trends = dailyTrendsSchema.parse(response.body);
      expect(dayOf(trends, A).nutrition).toEqual(nutrition(3, { carbohydrateG: [1, 20.2], energyKcal: [1, 100.1], fatG: [1, 0], proteinG: [2, 10.1] }));
      // A's fat is a recorded zero covering 1 of 3 entries; B's protein is unknown for its only entry; C has no entries.
      expect(dayOf(trends, A).nutrition.fatG).toEqual({ recordedEntries: 1, total: 0 });
      expect(dayOf(trends, B).nutrition).toEqual(nutrition(1, { carbohydrateG: [1, 0], energyKcal: [1, 0], fatG: [1, 5.3] }));
      expect(dayOf(trends, B).nutrition.proteinG).toEqual({ recordedEntries: 0, total: null });
      expect(dayOf(trends, C).nutrition).toEqual(noFood);
      expect(trends.summary.nutrition).toEqual({
        carbohydrateG: { recordedDays: 2, recordedEntries: 2, total: 20.2 },
        daysInRange: 28,
        daysWithEntries: 2,
        energyKcal: { recordedDays: 2, recordedEntries: 2, total: 100.1 },
        fatG: { recordedDays: 2, recordedEntries: 2, total: 5.3 },
        loggedEntries: 4,
        proteinG: { recordedDays: 1, recordedEntries: 2, total: 10.1 },
        source: 'manual',
      });
      expect(response.text).not.toMatch(/Entry (one|two|three|four)|title only|SECRET/u);
    });

    it('adds ten recorded 0.1 values to exactly 1 for every nutrient, on one date and across ten dates', async () => {
      for (let index = 0; index < 10; index += 1) await meal('2026-11-12', { carbohydrate: '0.1', energy: '0.1', fat: '0.1', protein: '0.1' });
      // Ten different dates, 2026-10-31 to 2026-11-09, each with one 0.1 g of fat.
      for (const date of ['2026-10-31', ...Array.from({ length: 9 }, (_, index) => `2026-11-0${String(index + 1)}`)]) await meal(date, { fat: '0.1' });
      const trends = await read();
      for (const field of MEAL_NUTRITION_FIELDS) expect(dayOf(trends, '2026-11-12').nutrition[field], field).toEqual({ recordedEntries: 10, total: 1 });
      expect(trends.summary.nutrition.fatG).toEqual({ recordedDays: 11, recordedEntries: 20, total: 2 });
      expect(trends.summary.nutrition.proteinG).toEqual({ recordedDays: 1, recordedEntries: 10, total: 1 });
    });

    it('keeps a macro-only range and a title-only range distinct from an empty one', async () => {
      await meal('2026-11-05', { protein: '25.5' });
      const macroOnly = await read();
      expect(isEmptyDailyTrends(macroOnly)).toBe(false);
      expect(macroOnly.summary.nutrition).toMatchObject({
        daysWithEntries: 1,
        energyKcal: unrecorded,
        loggedEntries: 1,
        proteinG: { recordedDays: 1, recordedEntries: 1, total: 25.5 },
      });

      await ownerPool.query('DELETE FROM meals');
      await meal('2026-11-05', { title: 'Soup' });
      await meal('2026-11-06', { title: 'Bread' });
      const titleOnly = await read();
      expect(isEmptyDailyTrends(titleOnly)).toBe(false);
      expect(titleOnly.summary.nutrition).toMatchObject({ daysWithEntries: 2, loggedEntries: 2 });
      for (const field of MEAL_NUTRITION_FIELDS) expect(titleOnly.summary.nutrition[field], field).toEqual(unrecorded);
    });

    it('gives every nutrient its own coverage: one entry per nutrient covers that nutrient only', async () => {
      const columns: Record<MealNutritionField, 'carbohydrate' | 'energy' | 'fat' | 'protein'> = {
        carbohydrateG: 'carbohydrate',
        energyKcal: 'energy',
        fatG: 'fat',
        proteinG: 'protein',
      };
      const dates = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
      for (const [index, field] of MEAL_NUTRITION_FIELDS.entries()) await meal(dates[index]!, { [columns[field]]: '7.5' });
      const trends = await read();
      expect(trends.summary.nutrition).toMatchObject({ daysWithEntries: 4, loggedEntries: 4 });
      for (const [index, field] of MEAL_NUTRITION_FIELDS.entries()) {
        expect(trends.summary.nutrition[field], field).toEqual({ recordedDays: 1, recordedEntries: 1, total: 7.5 });
        for (const other of MEAL_NUTRITION_FIELDS) {
          expect(dayOf(trends, dates[index]!).nutrition[other], `${field} on ${other}`).toEqual(other === field ? { recordedEntries: 1, total: 7.5 } : { recordedEntries: 0, total: null });
        }
      }
    });

    it('shortens the range at 2000-01-01 with the actual denominator, and counts nothing outside it', async () => {
      await meal('2000-01-01', { protein: '1' });
      await meal('2000-01-10', { fat: '2' });
      await meal('2000-01-11', { energy: '999' }); // after the end date
      const trends = await read('2000-01-10');
      expect(trends.range).toMatchObject({ days: 10, shortenedByLowerBound: true, startDate: '2000-01-01' });
      expect(trends.summary.nutrition).toMatchObject({
        daysInRange: 10,
        daysWithEntries: 2,
        energyKcal: unrecorded,
        fatG: { recordedDays: 1, recordedEntries: 1, total: 2 },
        loggedEntries: 2,
        proteinG: { recordedDays: 1, recordedEntries: 1, total: 1 },
      });
    });

    it('keeps meal entries on their stored dates across both DST transitions, whatever zone they were saved in or are viewed in', async () => {
      // 2026-03-29 (spring forward, 23 hours in Warsaw) and 2026-10-25 (fall back, 25 hours).
      await meal('2026-03-29', { energy: '300', timeZone: 'Asia/Tokyo' });
      await meal('2026-03-29', { protein: '12', timeZone: 'America/New_York' });
      await meal('2026-03-30', { fat: '3', timeZone: 'Pacific/Kiritimati' });
      await meal('2026-10-25', { carbohydrate: '40', timeZone: 'Pacific/Pago_Pago' });
      await meal('2026-10-25', { energy: '500', timeZone: 'Europe/Warsaw' });
      await meal('2026-10-26', { energy: '600', timeZone: 'Pacific/Pago_Pago' });
      for (const zone of ['Europe/Warsaw', 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Tokyo', 'America/New_York']) {
        const spring = await read('2026-04-10', zone);
        expect(spring.days.filter((day) => day.localDate === '2026-03-29')).toHaveLength(1);
        expect(dayOf(spring, '2026-03-29').nutrition, zone).toEqual(nutrition(2, { energyKcal: [1, 300], proteinG: [1, 12] }));
        expect(dayOf(spring, '2026-03-30').nutrition, zone).toEqual(nutrition(1, { fatG: [1, 3] }));
        expect(spring.summary.nutrition, zone).toMatchObject({ daysWithEntries: 2, loggedEntries: 3 });
        const autumn = await read('2026-11-19', zone);
        expect(autumn.days.filter((day) => day.localDate === '2026-10-25')).toHaveLength(1);
        expect(dayOf(autumn, '2026-10-25').nutrition, zone).toEqual(nutrition(2, { carbohydrateG: [1, 40], energyKcal: [1, 500] }));
        expect(dayOf(autumn, '2026-10-26').nutrition, zone).toEqual(nutrition(1, { energyKcal: [1, 600] }));
        expect(autumn.summary.nutrition.energyKcal, zone).toEqual({ recordedDays: 2, recordedEntries: 2, total: 1100 });
      }
    });
  });

  describe('range and attribution', () => {
    it('includes both end dates and nothing outside them', async () => {
      const endDate = '2026-11-10';
      await movement('2026-10-13', { steps: 1 }); // the day before the first date
      await movement('2026-10-14', { steps: 10 }); // the first date
      await movement('2026-11-10', { steps: 100 }); // the end date
      await movement('2026-11-11', { steps: 1000 }); // after the end date
      await meal('2026-11-11', { energy: '5' });
      await meal('2026-10-13', { protein: '5' });
      await checkIn('2026-10-13', { weightKg: '70' });
      const trends = await read(endDate);
      expect(trends.range).toMatchObject({ days: 28, endDate, includesToday: false, startDate: '2026-10-14', today: END });
      expect(trends.days[0]).toMatchObject({ localDate: '2026-10-14', steps: 10 });
      expect(trends.days.at(-1)).toMatchObject({ localDate: endDate, steps: 100 });
      expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 110, source: 'manual' });
      expect(trends.summary.nutrition.loggedEntries).toBe(0);
      expect(trends.summary.weight.daysRecorded).toBe(0);
    });

    it('shortens the range at 2000-01-01 and uses the actual day count', async () => {
      await movement('2000-01-01', { steps: 0 });
      await checkIn('2000-01-10', { sleepMinutes: 480 });
      await movement('2000-01-11', { steps: 7 });
      const trends = await read('2000-01-10');
      expect(trends.range).toMatchObject({ days: 10, requestedDays: 28, shortenedByLowerBound: true, startDate: '2000-01-01' });
      expect(trends.days.map((day) => day.localDate)).toEqual(Array.from({ length: 10 }, (_, index) => `2000-01-${String(index + 1).padStart(2, '0')}`));
      expect(trends.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 0, source: 'manual' });
      expect(trends.summary.sleep.daysRecorded).toBe(1);
      expect((await read('2000-01-01')).range).toMatchObject({ days: 1, startDate: '2000-01-01' });
      expect((await read('2000-01-28')).range).toMatchObject({ days: 28, shortenedByLowerBound: false, startDate: '2000-01-01' });
    });

    it('keeps every record on its stored date whatever zone it was saved in or the trends are viewed in, across a DST change', async () => {
      // 2026-10-25 is the Warsaw fall-back date (25 hours); a record on it counts once, on that date.
      await checkIn('2026-10-25', { sleepMinutes: 500, weightKg: '71.5' }, { timeZone: 'Asia/Tokyo' });
      await movement('2026-10-25', { steps: 2500, timeZone: 'Pacific/Kiritimati' });
      await meal('2026-10-26', { energy: '600', timeZone: 'Pacific/Pago_Pago' });
      await movement('2026-10-24', { steps: 1, timeZone: 'Pacific/Kiritimati' });
      // At the test clock it is still 2026-11-19 in Pago Pago (UTC-11), so the shared end date is that one.
      for (const zone of ['Europe/Warsaw', 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Tokyo']) {
        const trends = await read('2026-11-19', zone);
        expect(trends.range.timeZone).toBe(zone);
        expect(trends.days.filter((day) => day.localDate === '2026-10-25')).toHaveLength(1);
        expect(dayOf(trends, '2026-10-24')).toMatchObject({ steps: 1 });
        expect(dayOf(trends, '2026-10-25')).toMatchObject({ sleepMinutes: 500, steps: 2500, weightKg: 71.5 });
        expect(dayOf(trends, '2026-10-26')).toMatchObject({ nutrition: nutrition(1, { energyKcal: [1, 600] }), steps: null });
        expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 2501, source: 'manual' });
      }
    });

    it('decides "today" by the server clock in the requested zone and refuses a later end date', async () => {
      // At 2026-11-20T10:00Z it is already 21 November in Kiritimati, still 20 November in Warsaw.
      await movement('2026-11-21', { steps: 21, timeZone: 'Pacific/Kiritimati' });
      await meal('2026-11-21', { protein: '9', timeZone: 'Pacific/Kiritimati' });
      const kiritimati = await read('2026-11-21', 'Pacific/Kiritimati');
      expect(kiritimati.range).toMatchObject({ includesToday: true, startDate: '2026-10-25', today: '2026-11-21' });
      expect(kiritimati.days.at(-1)).toMatchObject({ localDate: '2026-11-21', nutrition: nutrition(1, { proteinG: [1, 9] }), steps: 21 });
      expect((await read(END, ZONE)).range).toMatchObject({ includesToday: true, today: END });
      const refused = await get(owner, { endDate: '2026-11-21', timeZone: ZONE }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(refused.body).toMatchObject({ error: { message: 'The end date cannot be after today (2026-11-20 in Europe/Warsaw)' } });
      expect(refused.headers['cache-control']).toBe('no-store');
    });
  });

  describe('access', () => {
    it("isolates the trends: another member, a run-sharing grantee and another organization never see the owner's data", async () => {
      const date = '2026-11-10';
      await checkIn(date, { sleepMinutes: 420, weightKg: '72' });
      await movement(date, { steps: 8042 });
      await meal(date, { carbohydrate: '80', energy: '700', fat: '20', protein: '30' });
      await checkIn(date, { weightKg: '60' }, { userId: ids.userStranger });
      await movement(date, { steps: 50, userId: ids.userStranger });
      await meal(date, { energy: '50', userId: ids.userStranger });
      await movement(date, { orgId: ids.orgB, steps: 12_000, userId: ids.userOrgB });
      await meal(date, { energy: '900', fat: '9', orgId: ids.orgB, userId: ids.userOrgB });
      // userDual is a member of the owner's organization and holds history and live grants on the owner's runs.
      await checkIn(date, { sleepMinutes: 300 }, { userId: ids.userDual });

      const mine = await read(END, 'UTC');
      expect(dayOf(mine, date)).toEqual({
        localDate: date,
        nutrition: nutrition(1, { carbohydrateG: [1, 80], energyKcal: [1, 700], fatG: [1, 20], proteinG: [1, 30] }),
        sleepMinutes: 420,
        steps: 8042,
        weightKg: 72,
      });
      const theirs = await read(END, 'UTC', stranger);
      expect(dayOf(theirs, date)).toEqual({ localDate: date, nutrition: nutrition(1, { energyKcal: [1, 50] }), sleepMinutes: null, steps: 50, weightKg: 60 });
      const granteeView = await read(END, 'UTC', grantee);
      expect(dayOf(granteeView, date)).toEqual({ localDate: date, nutrition: noFood, sleepMinutes: 300, steps: null, weightKg: null });
      expect(granteeView.summary.steps.daysRecorded).toBe(0);
      expect(granteeView.summary.nutrition.loggedEntries).toBe(0);

      const outsiderOwn = dailyTrendsSchema.parse((await get(outsider, { endDate: END, timeZone: 'UTC' }, { orgId: ids.orgB }).expect(200)).body);
      expect(dayOf(outsiderOwn, date)).toMatchObject({ nutrition: nutrition(1, { energyKcal: [1, 900], fatG: [1, 9] }), steps: 12_000, weightKg: null });
      for (const [auth, orgId] of [
        [outsider, ids.orgA],
        [owner, ids.orgB],
      ] as const) {
        const denied = await get(auth, { endDate: END, timeZone: 'UTC' }, { orgId }).expect(403);
        expect(errorCode(denied)).toBe('ORG_ACCESS_DENIED');
        expect(denied.headers['cache-control']).toBe('no-store');
      }
      const anonymous = await get(null).expect(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });

    it("gives a coach holding run-sharing grants on the owner's run none of the owner's nutrition", async () => {
      // userStranger is a coach of the owner's organization; grant it live and history access to one of the owner's runs.
      await ownerPool.query(
        'INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_live, can_read_history) VALUES ($1, $2, $3, true, true)',
        [ids.orgA, ids.runFinishedBoth, ids.userStranger],
      );
      const role = await ownerPool.query<{ role: string }>('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userStranger]);
      expect(role.rows[0]?.role).toBe('coach');
      await meal('2026-11-10', { carbohydrate: '1', energy: '777.7', fat: '2', protein: '3' });
      const response = await get(stranger, { endDate: END, timeZone: ZONE }).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const coachView = dailyTrendsSchema.parse(response.body);
      expect(coachView.summary.nutrition.loggedEntries).toBe(0);
      expect(coachView.days.every((day) => day.nutrition.loggedEntries === 0)).toBe(true);
      expect(response.text).not.toMatch(/777\.7/u);
      // The owner still sees it.
      expect((await read()).summary.nutrition.energyKcal.total).toBe(777.7);
    });

    it('refuses an inactive member and an unauthenticated request, both no-store', async () => {
      await meal('2026-11-10', { energy: '5' });
      const denied = await get(inactive).expect(403);
      expect(errorCode(denied)).toBe('ORG_ACCESS_DENIED');
      expect(denied.headers['cache-control']).toBe('no-store');
      const anonymous = await get(null).expect(401);
      expect(errorCode(anonymous)).toBe('AUTH_REQUIRED');
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });
  });

  describe('snapshot and freshness', () => {
    it('reads every source in one snapshot, even when writes commit between its statements', async () => {
      await checkIn('2026-11-01', { weightKg: '70' });
      await checkIn('2026-11-02', { weightKg: '71' });
      await movement('2026-11-01', { steps: 1000 });
      const keptMeal = await meal('2026-11-01', { energy: '400' });
      const editedMeal = await meal('2026-11-02', { protein: '10' });
      let interleave: (() => Promise<void>) | null = null;
      const reached: string[] = [];
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyDailyTrendsHooks: {
          afterCheckInsRead: async () => {
            reached.push('after check-ins');
            await interleave?.();
          },
        },
      });
      interleave = async () => {
        // Committed on another connection after the check-ins were read and before movement and meals are.
        await ownerPool.query('DELETE FROM daily_metrics');
        await ownerPool.query('DELETE FROM daily_movement');
        await movement('2026-11-03', { steps: 3000 });
        await ownerPool.query('DELETE FROM meals WHERE id = $1', [keptMeal]);
        // A committed meal edit: protein 10 → 25.5, fat recorded as 0.
        await ownerPool.query('UPDATE meals SET protein_g = 25.5, fat_g = 0 WHERE id = $1', [editedMeal]);
        await meal('2026-11-04', { energy: '100' });
        await meal('2026-11-04', {});
      };
      const during = await read(END, ZONE, owner, hooked);
      expect(reached).toEqual(['after check-ins']);
      expect(during.summary.weight).toMatchObject({ changeKg: 1, daysRecorded: 2 });
      expect(during.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 1000, source: 'manual' });
      expect(during.summary.nutrition).toMatchObject({
        daysWithEntries: 2,
        energyKcal: { recordedDays: 1, recordedEntries: 1, total: 400 },
        fatG: unrecorded,
        loggedEntries: 2,
        proteinG: { recordedDays: 1, recordedEntries: 1, total: 10 },
      });

      interleave = null;
      const next = await read(END, ZONE, owner, hooked);
      expect(next.summary.weight.daysRecorded).toBe(0);
      expect(next.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 3000, source: 'manual' });
      expect(dayOf(next, '2026-11-02').nutrition).toEqual(nutrition(1, { fatG: [1, 0], proteinG: [1, 25.5] }));
      expect(dayOf(next, '2026-11-04').nutrition).toEqual(nutrition(2, { energyKcal: [1, 100] }));
      expect(next.summary.nutrition).toMatchObject({ daysWithEntries: 2, energyKcal: { total: 100 }, loggedEntries: 3, proteinG: { total: 25.5 } });
    });

    it('reflects edits and deletions made through the existing APIs on the next read of the same range', async () => {
      const date = '2026-11-10';
      await mutate('put', `/api/orgs/${ids.orgA}/daily-metrics/${date}`, { sleepMinutes: 420, timeZone: ZONE, weightKg: 72.4 }).expect(201);
      await mutate('put', `/api/orgs/${ids.orgA}/daily-movement/${date}`, { steps: 8042, timeZone: ZONE }).expect(201);
      const created = await mutate('post', `/api/orgs/${ids.orgA}/meals`, {
        carbohydrateG: 50,
        energyKcal: 777.7,
        idempotencyKey: '0b9c4b4e-6d1f-4c39-9d9d-1a2b3c4d5e6f',
        localDate: date,
        mealType: 'lunch',
        proteinG: 30.1,
        timeZone: ZONE,
        title: 'Created through the API',
      }).expect(201);
      const mealId = (created.body as { mealId: string }).mealId;
      await meal(date, { energy: '100' });
      expect(dayOf(await read(), date)).toEqual({
        localDate: date,
        nutrition: nutrition(2, { carbohydrateG: [1, 50], energyKcal: [2, 877.7], proteinG: [1, 30.1] }),
        sleepMinutes: 420,
        steps: 8042,
        weightKg: 72.4,
      });

      await mutate('put', `/api/orgs/${ids.orgA}/daily-metrics/${date}`, { mood: 3, timeZone: ZONE }).expect(200);
      await mutate('put', `/api/orgs/${ids.orgA}/daily-movement/${date}`, { steps: 0, timeZone: ZONE }).expect(200);
      // The edit drops energy and carbohydrate, changes protein and records fat as 0.
      await mutate('put', `/api/orgs/${ids.orgA}/meals/${mealId}`, { fatG: 0, mealType: 'dinner', proteinG: 12.3, title: 'Edited' }).expect(200);
      const edited = await read();
      expect(dayOf(edited, date)).toEqual({
        localDate: date,
        nutrition: nutrition(2, { energyKcal: [1, 100], fatG: [1, 0], proteinG: [1, 12.3] }),
        sleepMinutes: null,
        steps: 0,
        weightKg: null,
      });
      expect(edited.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 0, source: 'manual' });
      expect(edited.summary.nutrition.carbohydrateG).toEqual(unrecorded);

      await mutate('delete', `/api/orgs/${ids.orgA}/daily-metrics/${date}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/daily-movement/${date}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/meals/${mealId}`).expect(204);
      const response = await get(owner).expect(200);
      const deleted = dailyTrendsSchema.parse(response.body);
      expect(dayOf(deleted, date)).toEqual({ localDate: date, nutrition: nutrition(1, { energyKcal: [1, 100] }), sleepMinutes: null, steps: null, weightKg: null });
      expect(deleted.summary.nutrition).toMatchObject({ fatG: unrecorded, loggedEntries: 1, proteinG: unrecorded });
      expect(response.text).not.toMatch(/777\.7|8042|72\.4|Edited|12\.3|Created through/u);
    });

    it('writes nothing: the row counts of every source, the erasure ledger and weekly insights are unchanged after reads', async () => {
      await checkIn('2026-11-10', { weightKg: '72' });
      await meal('2026-11-10', { energy: '1', fat: '0' });
      const counts = async () =>
        (
          await ownerPool.query<{ counts: string }>(
            `SELECT concat_ws(',', (SELECT count(*) FROM daily_metrics), (SELECT count(*) FROM daily_movement), (SELECT count(*) FROM meals),
                                   (SELECT count(*) FROM activities), (SELECT count(*) FROM erasure_ledger), (SELECT count(*) FROM weekly_insights),
                                   (SELECT max(updated_at)::text FROM meals)) AS counts`,
          )
        ).rows[0]!.counts;
      const before = await counts();
      await read();
      await read('2000-01-05', 'UTC');
      await get(owner, { endDate: '2026-11-21', timeZone: ZONE }).expect(400);
      expect(await counts()).toBe(before);
    });
  });

  describe('validation', () => {
    it('refuses invalid, missing, repeated and unknown parameters and organizations with 400 and no-store', async () => {
      const cases: Array<[Record<string, string>, string?]> = [
        [{ endDate: '1999-12-31', timeZone: ZONE }],
        [{ endDate: '2026-02-30', timeZone: ZONE }],
        [{ endDate: '2026-11-5', timeZone: ZONE }],
        [{ endDate: 'today', timeZone: ZONE }],
        [{ timeZone: ZONE }],
        [{ endDate: END }],
        [{}],
        [{ endDate: END, timeZone: '+01:00' }],
        [{ endDate: END, timeZone: 'Mars/Olympus_Mons' }],
        [{ endDate: END, extra: 'x', timeZone: ZONE }],
        [{ days: '7', endDate: END, timeZone: ZONE }],
        [{ endDate: END, metric: 'proteinG', timeZone: ZONE }],
        [{ endDate: END, timeZone: ZONE }, 'not-a-uuid'],
      ];
      for (const [query, orgId] of cases) {
        const refused = await get(owner, query, orgId ? { orgId } : {}).expect(400);
        expect(errorCode(refused), `${JSON.stringify(query)} ${orgId ?? ''}`).toBe('INVALID_REQUEST');
        expect(refused.headers['cache-control']).toBe('no-store');
      }
      for (const query of [`endDate=${END}&endDate=2026-11-19&timeZone=${ZONE}`, `endDate=${END}&timeZone=${ZONE}&timeZone=UTC`]) {
        const repeated = await request(app).get(`${trendsPath()}?${query}`).set('Cookie', owner.cookie).expect(400);
        expect(errorCode(repeated)).toBe('INVALID_REQUEST');
        expect(repeated.headers['cache-control']).toBe('no-store');
      }
    });

    it('marks even a malformed request body error as no-store', async () => {
      const malformed = await request(app).get(trendsPath()).query({ endDate: END, timeZone: ZONE }).set('Cookie', owner.cookie).type('application/json').send('{"broken"');
      expect(malformed.status).toBe(400);
      expect(malformed.headers['cache-control']).toBe('no-store');
    });
  });
});
