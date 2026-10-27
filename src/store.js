// Tiny JSON-file persistence. Everything lives in memory and is flushed to disk
// shortly after each change, so missions, memory, skills and routines survive restarts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Saved data and the workspace live in the app's own folder, wherever the app is started from.
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'));
const FILE = path.join(DATA_DIR, 'state.json');

// The shared cloud-computer equivalent: a real folder every agent works in.
export const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(APP_DIR, 'workspace'));
fs.mkdirSync(WORKSPACE, { recursive: true });

export const state = {
  missions: {},
  tasks: {},
  chats: {},
  memory: {}, // agentId -> [{ id, text, source, at }]
  skills: {}, // id -> skill
  routines: {}, // id -> routine
  meetings: {}, // id -> meeting
  customAgents: {}, // id -> agent created in the UI
  agentOverrides: {}, // id -> edits to a built-in agent (name, role, persona, specialties, web)
  activity: [], // live feed of what bots are doing
  skillPacks: {}, // packId -> install status
  connections: {}, // service -> { enabled, config (secrets stay on this PC), bots, status }
  usage: {}, // usage meter by day
  rules: [], // team playbook learned in retrospectives
  limit: null, // { since, resetAt, known } while paused on the Claude usage limit
  telegram: { sent: [], offset: 0 }, // alerts sent (for matching replies) and the polling offset
  lastRetroAt: null,
  ceoPending: [], // CEO chat messages kept while paused on the usage limit
  ceoFocus: null, // { missionId, taskId, at }: what the founder and the CEO are working on right now
  ceoSummary: null, // { text, upTo }: the older part of the CEO conversation, compacted
  ceoActions: [], // the CEO's last actions, for "undo"
  ceoArchive: [], // conversations archived by "Fresh start"
  apiFallback: null, // { enabled, key (stays on this PC), dailyCapUsd, noOpus } — Settings → Usage
  apiMode: null, // { since, backAt, known } while runs are billed to the API key
  apiSpend: null, // { day, usd } API money spent today
  disk: null, // free space on the workspace drive
  settings: {
    approvePlans: false,
    approveDeliverables: false,
    progressUpdates: true, // a Telegram note after each finished task: done, next
    terminal: true, // let bots run shell commands (Bash, e.g. Python) in the workspace
    browserHeadless: false, // false = you can watch the bot's browser and take over
    browser: process.platform === 'win32' ? 'msedge' : 'chrome', // Edge ships with Windows
  },
};

export const loadInfo = { file: FILE, found: false, recovered: null, readOnly: false };
if (fs.existsSync(FILE)) {
  let saved = null;
  let lastErr = null;
  // A file locked for a moment (antivirus, OneDrive, Drive sync) is retried before giving up.
  for (let attempt = 0; attempt < 5 && !saved; attempt++) {
    try {
      saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      lastErr = e;
      if (e instanceof SyntaxError) break;
      const until = Date.now() + 400;
      while (Date.now() < until); // short synchronous wait: this runs once, at start
    }
  }
  if (saved) {
    for (const key of Object.keys(state)) {
      if (saved[key]) state[key] = key === 'settings' ? { ...state.settings, ...saved.settings } : saved[key];
    }
    for (const k of ['usageMode', 'economy', 'opusForLarge']) delete state.settings[k]; // retired settings
    delete state.ceoContextAt;
    loadInfo.found = true;
  } else {
    // Never overwrite saved data we couldn't read. Keep a copy; if even that fails, don't save at all.
    const copy = path.join(DATA_DIR, `state.unreadable-${Date.now()}.json`);
    try {
      fs.copyFileSync(FILE, copy);
      loadInfo.recovered = copy;
      console.error(`Could not read ${FILE} (${lastErr?.message}). A copy was kept at ${copy}. Starting with an empty setup.`);
    } catch (e) {
      loadInfo.readOnly = true;
      console.error(`Could not read ${FILE} (${lastErr?.message}) and could not back it up (${e.message}). Nothing will be saved this session, so your data is safe. Close programs that may lock it (OneDrive, antivirus), then restart the app.`);
    }
  }
}

let timer = null;
let lastError = 0;
export const saveStatus = loadInfo.readOnly
  ? { ok: false, error: `Your saved data (${FILE}) could not be read, so nothing is saved right now to protect it. Close OneDrive/antivirus locks and restart the app.` }
  : { ok: true, error: null };
export function save() {
  if (timer || loadInfo.readOnly) return;
  timer = setTimeout(() => {
    timer = null;
    const tmp = `${FILE}.tmp`;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE); // the old file stays intact until the new one is complete
      saveStatus.ok = true;
      saveStatus.error = null;
    } catch (e) {
      // Never crash the app over a failed save (e.g. the disk is full): keep running, retry.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      saveStatus.ok = false;
      saveStatus.error = e.code === 'ENOSPC' ? 'The disk is full — your latest changes are not saved yet.' : e.message;
      if (Date.now() - lastError > 60_000) console.error(`Could not save data (${e.code || e.message}). Will retry.`);
      lastError = Date.now();
      setTimeout(save, 30_000).unref?.();
    }
  }, 400);
}

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();
export const slugify = (s, n = 40) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, n) || 'untitled';
