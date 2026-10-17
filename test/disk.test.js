// A full disk must never crash the app: saves fail softly, the team pauses, Settings shows what uses space.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-disk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function boot(env) {
  const port = 4100 + Math.floor(Math.random() * 800);
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DEMO_MODE: '1', IMPORT_CLAUDE_SKILLS: '0', SKILL_PACKS: '0', PORT: String(port), ...env }, stdio: 'ignore' });
  procs.push(p);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/api/meta`).then((r) => r.ok, () => false)) return { base, p };
    await sleep(250);
  }
  throw new Error('server did not start');
}

test('a failed save (e.g. disk full) does not crash the app', async () => {
  const blocker = path.join(TMP, 'not-a-folder');
  fs.writeFileSync(blocker, 'x'); // DATA_DIR inside a file: every save fails
  const { base, p } = await boot({ DATA_DIR: path.join(blocker, 'data'), WORKSPACE_DIR: path.join(TMP, 'ws1') });
  await fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Keep it short' }) });
  await sleep(1500);
  assert.equal(p.exitCode, null, 'still running');
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('below the pause threshold the team pauses, and Storage reports what uses space', async () => {
  const ws = path.join(TMP, 'ws2');
  fs.mkdirSync(path.join(ws, 'missions', 'big-one'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'missions', 'big-one', 'render.bin'), Buffer.alloc(25 * 1024 ** 2));
  const { base } = await boot({ DATA_DIR: path.join(TMP, 'd2'), WORKSPACE_DIR: ws, DISK_PAUSE_GB: '1000000', DISK_WARN_GB: '2000000' });
  let st;
  for (let i = 0; i < 40; i++) {
    st = await (await fetch(`${base}/api/state`)).json();
    if (st.limit) break;
    await sleep(250);
  }
  assert.equal(st.limit?.kind, 'disk');
  assert.equal(st.disk.status, 'critical');
  const r = await (await fetch(`${base}/api/storage`)).json();
  assert.equal(r.folders[0].name, 'missions/big-one');
  assert.equal(r.largest[0].path, 'missions/big-one/render.bin');
  // Work waits instead of failing.
  const m = await (await fetch(`${base}/api/agents/marketing/assign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Write a post', deadlineHours: 2 }) })).json();
  await sleep(1500);
  const t = (await (await fetch(`${base}/api/state`)).json()).tasks.find((x) => x.missionId === m.id);
  assert.equal(t.status, 'queued');
});
