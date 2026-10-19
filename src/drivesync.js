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
import path from 'node:path';
import { WORKSPACE, now } from './store.js';
import { driveOutputRoot } from './connections.js';

// Working files that are never published.
const SKIP_DIRS = new Set(['frames', 'tmp', 'temp', 'cache', '.cache', 'node_modules', '.git', '__pycache__', '.venv', 'venv']);
const MAX_FILES = 300;

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

/** The mission's folder in Drive: "<date> <product>", fixed once chosen so it never duplicates. */
function missionDir(root, m) {
  m.driveFolder ||= cleanName(`${m.createdAt.slice(0, 10)} ${m.product || m.title}`, 70);
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
 * Copy a finished task to Drive as a new version, replacing the previous one.
 * Returns the Drive folder (relative to the output root), or null when Drive isn't connected.
 */
export function publishTask(m, t, agentName) {
  const root = driveOutputRoot();
  if (!root) return null;
  t.version = (t.version || 0) + 1;
  const n = String(m.taskIds.indexOf(t.id) + 1).padStart(2, '0');
  t.driveFolder ||= cleanName(`${n} ${t.title} (${agentName})`, 80);
  const dir = path.join(missionDir(root, m), t.driveFolder);
  fs.rmSync(dir, { recursive: true, force: true }); // the old version goes
  fs.mkdirSync(dir, { recursive: true });
  const at = t.completedAt || now();
  const src = t.workDir && path.join(WORKSPACE, t.workDir);
  for (const rel of src ? workFiles(src) : []) {
    const to = path.join(dir, path.dirname(rel), versioned(path.basename(rel), t.version, at));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
  fs.writeFileSync(path.join(dir, versioned('Handover.md', t.version, at)), `# ${t.title}\n\n_${agentName} · version ${t.version} · ${stamp(at).replace('_', ' ')}_\n\n${t.output}\n`);
  return path.join(m.driveFolder, t.driveFolder);
}

/** Write the mission report to Drive as a new version, replacing the previous one. */
export function publishReport(m, text) {
  const root = driveOutputRoot();
  if (!root) return null;
  const dir = missionDir(root, m);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^00 Mission report_v\d+_/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  m.reportVersion = (m.reportVersion || 0) + 1;
  const at = m.completedAt || now();
  fs.writeFileSync(path.join(dir, versioned('00 Mission report.md', m.reportVersion, at)), `# Mission report: ${m.product || m.title}\n\n_version ${m.reportVersion} · ${stamp(at).replace('_', ' ')}_\n\n${text}\n`);
  return m.driveFolder;
}
