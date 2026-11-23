import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { showcaseBuild } from './showcase.js';

// Builds the showcase's production output for the browser check (run by `npm run test:e2e:showcase` before Playwright
// starts; nothing builds while a server runs). The same build as `npm run build:showcase` (vite.showcase.config.ts),
// with the explicit local application address and its own output directory. Only operating-system variables and these
// two settings reach Vite, so a developer's SHOWCASE_APP_URL or .env cannot change what is tested.

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const webRoot = resolve(repositoryRoot, 'apps', 'web');
const keep = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|LANG|LC_ALL|TERM|USER|USERNAME|LOGNAME|SHELL)$/iu;
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => keep.test(entry[0]) && typeof entry[1] === 'string'));

const result = spawnSync(
  process.execPath,
  [resolve(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.showcase.config.ts', '--logLevel', 'warn'],
  { cwd: webRoot, env: { ...environment, SHOWCASE_APP_URL: showcaseBuild.appUrl, SHOWCASE_OUT_DIR: showcaseBuild.outDir }, stdio: 'inherit', windowsHide: true },
);
if (result.status !== 0) {
  console.error(`showcase build failed (${result.error?.message ?? `exit ${String(result.status)}`})`);
  process.exit(1);
}
for (const file of ['index.html', 'showcase-snapshot.json']) {
  if (!existsSync(resolve(showcaseBuild.outDir, file))) {
    console.error(`showcase build: ${file} is missing from ${showcaseBuild.outDir}`);
    process.exit(1);
  }
}
console.log(`showcase build: ${showcaseBuild.outDir} (application link ${showcaseBuild.appUrl})`);
