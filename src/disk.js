// Disk space guard. Bots render videos, download assets and keep browser profiles, so the
// disk can fill up. Every few minutes we check the free space on the workspace drive:
// below DISK_WARN_GB you get a warning (app banner + Telegram); below DISK_PAUSE_GB the
// team pauses (like the usage limit: work goes back in the queue, nothing new starts) and
// carries on by itself once there is room again. Settings → Storage shows what uses space.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { state, save, saveStatus, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { hitLimit, resume } from './limits.js';

const GB = 1024 ** 3;
const WARN = Number(process.env.DISK_WARN_GB || 5) * GB;
const PAUSE = Number(process.env.DISK_PAUSE_GB || 1) * GB;
const RESUME = PAUSE * 1.5; // a little headroom before restarting, so it doesn't flap
// Working files bots leave behind that are safe to delete: render frames, temp and cache folders.
const JUNK_DIRS = new Set(['frames', 'tmp', 'temp', '.tmp', 'cache', '.cache', '__pycache__', 'render-frames', 'renders-tmp']);

/**
 * Delete the team's temporary files (never deliverables): junk folders inside missions/, the
 * browser tool's screenshots and leftover prompt files. Returns the bytes freed.
 */
export function cleanTemp() {
  let freed = 0;
  const size = (p) => {
    let n = 0;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) return st.size;
      for (const e of fs.readdirSync(p)) n += size(path.join(p, e));
    } catch {}
    return n;
  };
  const drop = (p) => {
    const n = size(p);
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      freed += n;
    } catch {}
  };
  // Never touch the folder of a task that is running right now (e.g. frames of a render in progress).
  const busy = Object.values(state.tasks)
    .filter((t) => ['in_progress', 'review'].includes(t.status) && t.workDir)
    .map((t) => path.resolve(WORKSPACE, t.workDir));
  const walk = (dir, depth) => {
    if (depth > 6 || busy.some((b) => path.resolve(dir).startsWith(b))) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (JUNK_DIRS.has(e.name.toLowerCase())) drop(full);
      else walk(full, depth + 1);
    }
  };
  walk(path.join(WORKSPACE, 'missions'), 0);
  if (!Object.values(state.tasks).some((t) => t.status === 'in_progress')) drop(path.join(WORKSPACE, '.browser', 'output'));
  try {
    for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('yebunna-sys-')) drop(path.join(os.tmpdir(), f));
  } catch {}
  return freed;
}
let cleanedAt = 0;

export function freeSpace() {
  try {
    const s = fs.statfsSync(WORKSPACE);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

let warned = false;
export function checkDisk() {
  const d = freeSpace();
  if (!d) return null;
  const status = d.free < PAUSE ? 'critical' : d.free < WARN ? 'low' : 'ok';
  const prev = state.disk?.status;
  state.disk = { ...d, status, at: new Date().toISOString(), saveError: saveStatus.error };
  if (status !== prev) bus.emit('event', { type: 'disk', disk: state.disk });
  // Low on space: first clear the team's own temp files (at most every 30 minutes).
  if (status !== 'ok' && Date.now() - cleanedAt > 30 * 60_000) {
    cleanedAt = Date.now();
    const freed = cleanTemp();
    if (freed > 50 * 1024 ** 2) {
      bus.emit('disk.alert', `🧹 Disk space was low, so I deleted ${(freed / GB).toFixed(1)} GB of the team's temporary files (render frames, caches).`);
      return checkDisk();
    }
  }
  const gb = (d.free / GB).toFixed(1);
  if (status === 'critical' && !(state.limit?.kind === 'disk')) {
    hitLimit(`Only ${gb} GB free on the disk`, new Date(Date.now() + 7 * 864e5).toISOString(), 'disk');
    bus.emit('disk.alert', `💾 The disk is almost full (${gb} GB free). I paused the team so nothing breaks — work resumes by itself when there is room. Free some space: Settings → Storage in Yebunna OS shows what is using it.`);
  } else if (status === 'low' && !warned) {
    warned = true;
    bus.emit('disk.alert', `💾 Disk space is getting low: ${gb} GB free. Settings → Storage in Yebunna OS shows what is using it.`);
  }
  if (status === 'ok') warned = false;
  if (state.limit?.kind === 'disk' && d.free > RESUME) resume('disk space freed');
  return state.disk;
}

/** Sizes of the workspace's top folders and its largest files (for Settings → Storage). */
export function storageReport() {
  const folders = {};
  const big = [];
  const walk = (dir, top) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let sum = 0;
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) sum += walk(full, top);
      else {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        sum += size;
        if (size > 20 * 1024 ** 2) big.push({ path: path.relative(WORKSPACE, full).split(path.sep).join('/'), size });
      }
    }
    return sum;
  };
  for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
    const full = path.join(WORKSPACE, e.name);
    if (e.isDirectory()) {
      if (e.name === 'missions') {
        for (const m of fs.readdirSync(full, { withFileTypes: true })) if (m.isDirectory()) folders[`missions/${m.name}`] = walk(path.join(full, m.name));
      } else folders[e.name] = walk(full);
    } else {
      try {
        folders['(files in the workspace root)'] = (folders['(files in the workspace root)'] || 0) + fs.statSync(full).size;
      } catch {}
    }
  }
  return {
    disk: checkDisk(),
    workspace: WORKSPACE,
    folders: Object.entries(folders)
      .map(([name, size]) => ({ name, size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 25),
    largest: big.sort((a, b) => b.size - a.size).slice(0, 15),
  };
}

setTimeout(checkDisk, 2_000).unref?.();
setInterval(checkDisk, 3 * 60_000).unref();
