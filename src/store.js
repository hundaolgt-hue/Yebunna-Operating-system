// Tiny JSON-file persistence. Everything lives in memory and is flushed to disk
// shortly after each change, so missions survive restarts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'state.json');

export const state = { missions: {}, tasks: {}, chats: {} };

try {
  Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {
  // first run — nothing saved yet
}

let timer = null;
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  }, 400);
}

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;
