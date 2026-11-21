import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { dailyTrendsMealsSql } from '../src/daily-trends/daily-trends-service.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// EXPLAIN (ANALYZE, BUFFERS) of the Trends meal statement (ADR-0096) under the runtime role, with row-level security and
// the tenant context in force, on synthetic data: five members of one organization with 20,000 entries each (about seven
// a day over eight years, a quarter title-only). The plan is printed for inspection. The assertions guard the properties
// that matter, not a planner choice on a small table: one bounded read of `meals` for the owner's 28 dates (no sequential
// scan of the 100,000-row table, the rows read are exactly the person's range), one aggregate, and at most 29 summary rows
// (28 dates and the range), whatever the range holds. No migration needed.

const PEOPLE = [ids.userOrgA, ids.userDual, ids.userStranger, ids.userPausedOwner, ids.userHistoryActiveOwner];
const MEALS_PER_PERSON = 20_000;
const FIRST = '2026-10-19';
const LAST = '2026-11-15';

interface PlanNode {
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Index Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
  'Relation Name'?: string;
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe('Trends meal statement EXPLAIN under the runtime role (synthetic data)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({ application_name: 'running-tracker-trends-meals-explain-owner', connectionString: integration.migration.connectionString, max: 1 });
    runtimePool = new Pool({ application_name: 'running-tracker-trends-meals-explain-runtime', connectionString: integration.runtime.connectionString, max: 1 });
    const runtimeIdentity = await runtimePool.query<{ database_name: string; role_name: string }>('SELECT current_database() AS database_name, current_user AS role_name');
    expect(runtimeIdentity.rows[0]).toEqual({ database_name: integration.runtime.database, role_name: 'running_tracker_runtime' });
    // Validates the owner connection's database and role before deleting and writing anything.
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query(
      `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, energy_kcal, protein_g, carbohydrate_g, fat_g,
                          idempotency_key, creation_digest)
       SELECT $1, person.id, date '2026-11-15' - (n / 7), 'Europe/Warsaw', 'snack', 'synthetic',
              CASE WHEN n % 4 = 0 THEN NULL ELSE (n % 900) + 0.5 END,
              CASE WHEN n % 4 = 0 OR n % 3 = 0 THEN NULL ELSE (n % 60) END,
              CASE WHEN n % 4 = 0 OR n % 5 = 0 THEN NULL ELSE 0 END,
              CASE WHEN n % 4 = 0 THEN NULL ELSE round((n % 40) / 10.0, 1) END,
              gen_random_uuid(), sha256(gen_random_uuid()::text::bytea)
         FROM unnest($2::uuid[]) AS person(id)
        CROSS JOIN generate_series(0, $3::integer - 1) AS n`,
      [ids.orgA, PEOPLE, MEALS_PER_PERSON],
    );
    await ownerPool.query('ANALYZE meals');
  }, 180_000);

  afterAll(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration).catch(() => undefined);
    await ownerPool?.query('DELETE FROM meals').catch(() => undefined);
    await Promise.all([ownerPool?.end(), runtimePool?.end()]);
  });

  it('reads one person’s 28 dates in one bounded scan, never the whole table, and returns at most 29 rows', async () => {
    const counts = await ownerPool.query<{ owner_rows: number; range_rows: number; total_rows: number }>(
      `SELECT count(*)::integer AS total_rows, (count(*) FILTER (WHERE user_id = $1))::integer AS owner_rows,
              (count(*) FILTER (WHERE user_id = $1 AND local_date BETWEEN $2::date AND $3::date))::integer AS range_rows
         FROM meals`,
      [ids.userOrgA, FIRST, LAST],
    );
    expect(counts.rows[0]).toEqual({ owner_rows: MEALS_PER_PERSON, range_rows: 196, total_rows: MEALS_PER_PERSON * PEOPLE.length });

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
      const parameters = [ids.orgA, ids.userOrgA, FIRST, LAST];
      const json = await client.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; Plan: PlanNode }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dailyTrendsMealsSql}`,
        parameters,
      );
      const text = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${dailyTrendsMealsSql}`, parameters);
      const answer = await client.query<{ local_date: string | null; logged_entries: number }>(dailyTrendsMealsSql, parameters);
      await client.query('ROLLBACK');
      const [first] = json.rows[0]!['QUERY PLAN'];
      const plan = nodes(first!.Plan);
      const scans = plan.filter((node) => node['Relation Name'] === 'meals');
      console.info(
        `daily-trends:meals (${first!['Execution Time'].toFixed(2)} ms, index ${scans.map((node) => node['Index Name'] ?? node['Node Type']).join(', ')})\n` +
          text.rows.map((row) => row['QUERY PLAN']).join('\n'),
      );
      // One read of meals, executed once (no per-date or per-nutrient loop), never a sequential scan of the large table.
      expect(scans).toHaveLength(1);
      expect(scans[0]!['Actual Loops']).toBe(1);
      expect(scans[0]!['Node Type']).not.toBe('Seq Scan');
      // The rows read are the person's 196 entries of the 28 dates, not the table's 100,000.
      expect(scans[0]!['Actual Rows']).toBe(196);
      // At most 29 rows: one per date with an entry and exactly one for the range.
      expect(answer.rows).toHaveLength(29);
      expect(answer.rows.filter((row) => row.local_date === null)).toHaveLength(1);
      expect(answer.rows.at(-1)).toMatchObject({ local_date: null, logged_entries: 196 });
    } finally {
      client.release();
    }
  });
});
