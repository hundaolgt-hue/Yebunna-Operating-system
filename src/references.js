// The founder's reference files (sample images, videos, documents): uploaded in Files or sent
// to the Telegram bot, they land in workspace/references/<date>/ where every bot can study them.
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './store.js';

export const MAX_UPLOAD = 500 * 1024 ** 2;

export function safeName(name, fallback = 'file') {
  const clean = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\-() ሀ-፿]+/g, '_')
    .replace(/^\.+/, '')
    .slice(-120);
  return clean || fallback;
}

/** A free path for `name` in references/<today>/ (never overwrites). Returns { full, rel }. */
export function referencePath(name, folder = `references/${new Date().toISOString().slice(0, 10)}`) {
  const dir = path.resolve(WORKSPACE, folder);
  if (!dir.startsWith(WORKSPACE + path.sep)) throw new Error('outside the workspace');
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let full = path.join(dir, base);
  for (let i = 2; fs.existsSync(full); i++) full = path.join(dir, `${stem}-${i}${ext}`);
  return { full, rel: path.relative(WORKSPACE, full).split(path.sep).join('/') };
}
