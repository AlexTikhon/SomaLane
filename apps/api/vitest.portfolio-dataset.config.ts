import { defineConfig } from 'vitest/config';

// The portfolio dataset's real-PostgreSQL tests (docs/runbooks/portfolio-dataset.md): only throwaway databases inside
// the isolated dataset server, never the development or shared test database. `npm run test:portfolio-dataset`.
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 300_000,
    include: ['test/portfolio-dataset/**/*.dataset.test.ts'],
    pool: 'forks',
    testTimeout: 300_000,
  },
});
