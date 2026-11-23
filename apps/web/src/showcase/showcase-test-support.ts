import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseShowcaseSnapshot, type ShowcaseSnapshot } from '@running-tracker/contracts/showcase';

// Test support only (never imported by the showcase itself): the committed snapshot, the file the build serves.

export const SNAPSHOT_PATH = resolve(import.meta.dirname, '..', '..', 'showcase', 'public', 'showcase-snapshot.json');

export const snapshotText = (): string => readFileSync(SNAPSHOT_PATH, 'utf8');

/** A fresh, mutable copy of the committed snapshot as plain JSON (not yet validated). */
export const snapshotJson = (): Record<string, unknown> => JSON.parse(snapshotText()) as Record<string, unknown>;

export const committedSnapshot = (): ShowcaseSnapshot => parseShowcaseSnapshot(snapshotJson());
