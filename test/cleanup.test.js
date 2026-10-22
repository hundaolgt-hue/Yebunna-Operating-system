// When the disk runs low the app deletes the team's temp files — never deliverables, never a running task's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-clean-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const { state, WORKSPACE } = await import('../src/store.js');
const { cleanTemp } = await import('../src/disk.js');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('temp folders go, deliverables and running tasks stay', () => {
  const mk = (rel, bytes = 1000) => {
    const f = path.join(WORKSPACE, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(bytes));
  };
  mk('missions/m1/01-video/frames/f001.png');
  mk('missions/m1/01-video/ad-9x16.mp4');
  mk('missions/m1/02-render/frames/f001.png');
  state.tasks = { t2: { id: 't2', status: 'in_progress', workDir: 'missions/m1/02-render' } };
  const freed = cleanTemp();
  assert.ok(freed >= 1000);
  assert.ok(!fs.existsSync(path.join(WORKSPACE, 'missions/m1/01-video/frames')), 'old frames deleted');
  assert.ok(fs.existsSync(path.join(WORKSPACE, 'missions/m1/01-video/ad-9x16.mp4')), 'the video stays');
  assert.ok(fs.existsSync(path.join(WORKSPACE, 'missions/m1/02-render/frames/f001.png')), "a running render's frames stay");
});
