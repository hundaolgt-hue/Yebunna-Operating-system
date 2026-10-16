// Tiny JSON-file persistence. Everything lives in memory and is flushed to disk
// shortly after each change, so missions, memory, skills and routines survive restarts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'state.json');

// The shared cloud-computer equivalent: a real folder every agent works in.
export const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace'));
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
  settings: {
    approvePlans: false,
    approveDeliverables: false,
    terminal: true, // let bots run shell commands (Bash, e.g. Python) in the workspace
    browserHeadless: false, // false = you can watch the bot's browser and take over
    browser: process.platform === 'win32' ? 'msedge' : 'chrome', // Edge ships with Windows
  },
};

try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const key of Object.keys(state)) {
    if (saved[key]) state[key] = key === 'settings' ? { ...state.settings, ...saved.settings } : saved[key];
  }
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
export const now = () => new Date().toISOString();
export const slugify = (s, n = 40) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, n) || 'untitled';
