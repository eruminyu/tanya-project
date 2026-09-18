import {lstatSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteJsonSync, readJsonSync} from '../persistence/atomic-json.js';
import {parseSavedBounds, type SavedBounds} from './window-bounds.js';

/** Separate from the existing pin file and per-account settings. Never persist click-through. */
export class WindowStateStore {
  constructor(private readonly root: string) {}
  read(): SavedBounds | null {
    const value = readJsonSync(join(this.root, 'window-bounds.json'), 2048);
    return value === undefined ? null : parseSavedBounds(value);
  }
  write(value: SavedBounds): void {
    const parsed = parseSavedBounds(value);
    mkdirSync(this.root, {recursive: true});
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('storage_unavailable');
    this.read(); // Preserve corrupt or externally replaced files instead of silently overwriting them.
    atomicWriteJsonSync(join(this.root, 'window-bounds.json'), parsed);
  }
}
