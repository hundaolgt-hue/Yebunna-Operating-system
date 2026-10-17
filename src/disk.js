// Disk space guard. Bots render videos, download assets and keep browser profiles, so the
// disk can fill up. Every few minutes we check the free space on the workspace drive:
// below DISK_WARN_GB you get a warning (app banner + Telegram); below DISK_PAUSE_GB the
// team pauses (like the usage limit: work goes back in the queue, nothing new starts) and
// carries on by itself once there is room again. Settings → Storage shows what uses space.
import fs from 'node:fs';
import path from 'node:path';
import { state, save, saveStatus, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { hitLimit, resume } from './limits.js';

const GB = 1024 ** 3;
const WARN = Number(process.env.DISK_WARN_GB || 5) * GB;
const PAUSE = Number(process.env.DISK_PAUSE_GB || 1) * GB;
const RESUME = PAUSE * 2; // some headroom before restarting

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
