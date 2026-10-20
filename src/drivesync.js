// Publishing to Google Drive: every approved deliverable is copied into the founder's Drive
// (the folder Google Drive for desktop syncs), organised and version-stamped:
//
//   <Drive>/Yebunna OS/
//     2026-10-19 ProfitCheck Pro/
//       00 Mission report_v1_2026-10-21_1730.md
//       01 Find the winning niche (Nova)/
//         niche-report_v2_2026-10-19_1530.md
//         Handover_v2_2026-10-19_1530.md
//       02 Write the product spec (Orion)/
//
// A new version replaces the old one: the task's Drive folder is emptied and refilled, so
// Drive only ever holds the latest version (Drive keeps deleted files in its trash for 30 days).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE, now, state } from './store.js';
import { driveOutputRoot } from './connections.js';

// Working files that are never published.
const SKIP_DIRS = new Set(['frames', 'tmp', 'temp', 'cache', '.cache', 'node_modules', '.git', '__pycache__', '.venv', 'venv']);
const MAX_FILES = 300;
const MAX_BYTES = 2 * 1024 ** 3; // larger files stay in the workspace (named in the handover)
const RM = { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }; // Drive may hold a file open for a moment

/** A name that is safe on Windows and in Drive, and reads well. */
export function cleanName(s, max = 60) {
  const out = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');
  return out || 'Untitled';
}

/** 2026-10-19_1530 in the PC's local time. */
export function stamp(iso = now()) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** report.md → report_v2_2026-10-19_1530.md */
export const versioned = (file, version, at) => {
  const ext = path.extname(file);
  return `${path.basename(file, ext)}_v${version}_${stamp(at)}${ext}`;
};

/**
 * The mission's folder in Drive: "<date> <product>", fixed once chosen. Two missions never share
 * a folder: a second one with the same name gets " (2)", " (3)" …
 */
function missionDir(root, m) {
  if (!m.driveFolder) {
    const base = cleanName(`${m.createdAt.slice(0, 10)} ${m.product || m.title}`, 64);
    const taken = new Set(Object.values(state.missions).filter((x) => x.id !== m.id && x.driveFolder).map((x) => x.driveFolder.toLowerCase()));
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()) || (fs.existsSync(path.join(root, name)) && i < 100); i++) name = `${base} (${i})`;
    m.driveFolder = name;
  }
  return path.join(root, m.driveFolder);
}

/** Every file a task produced (its work folder), skipping temp folders and hidden files. */
function workFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(path.join(d, e.name), path.join(rel, e.name));
      } else if (e.isFile()) out.push(path.join(rel, e.name));
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Copy a finished task to Drive as a new version, replacing the previous one. The new version is
 * written next to the old one first and swapped in at the end, so a locked or failed copy never
 * leaves Drive with half a version. Returns the Drive folder, or null when Drive isn't connected.
 */
export async function publishTask(m, t, agentName) {
  const root = driveOutputRoot();
  if (!root) return null;
  const version = (t.version || 0) + 1;
  const n = String(m.taskIds.indexOf(t.id) + 1).padStart(2, '0');
  t.driveFolder ||= cleanName(`${n} ${t.title} (${agentName})`, 80);
  const dir = path.join(missionDir(root, m), t.driveFolder);
  const next = `${dir}.new`;
  await fsp.rm(next, RM);
  await fsp.mkdir(next, { recursive: true });
  const at = t.completedAt || now();
  const src = t.workDir && path.join(WORKSPACE, t.workDir);
  const kept = [];
  for (const rel of src ? workFiles(src) : []) {
    const from = path.join(src, rel);
    if (fs.statSync(from).size > MAX_BYTES) {
      kept.push(rel);
      continue;
    }
    const to = path.join(next, path.dirname(rel), versioned(path.basename(rel), version, at));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }
  const note = kept.length ? `\n\n_Too large for Drive, kept on the PC in ${t.workDir}/: ${kept.join(', ')}_` : '';
  await fsp.writeFile(path.join(next, versioned('Handover.md', version, at)), `# ${t.title}\n\n_${agentName} · version ${version} · ${stamp(at).replace('_', ' ')}_\n\n${t.output}${note}\n`);
  await fsp.rm(dir, RM); // the old version goes
  await fsp.rename(next, dir);
  t.version = version;
  return path.join(m.driveFolder, t.driveFolder);
}

/** Write the mission report to Drive as a new version, replacing the previous one. */
export async function publishReport(m, text) {
  const root = driveOutputRoot();
  if (!root) return null;
  const dir = missionDir(root, m);
  await fsp.mkdir(dir, { recursive: true });
  const version = (m.reportVersion || 0) + 1;
  const at = m.completedAt || now();
  const file = versioned('00 Mission report.md', version, at);
  await fsp.writeFile(path.join(dir, file), `# Mission report: ${m.product || m.title}\n\n_version ${version} · ${stamp(at).replace('_', ' ')}_\n\n${text}\n`);
  for (const f of await fsp.readdir(dir)) if (f !== file && /^00 Mission report_v\d+_/.test(f)) await fsp.rm(path.join(dir, f), RM);
  m.reportVersion = version;
  return m.driveFolder;
}
