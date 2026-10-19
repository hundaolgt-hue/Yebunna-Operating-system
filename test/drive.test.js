// Google Drive publishing: neat folders, version and time stamps, old versions removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-drive-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const DRIVE = path.join(TMP, 'My Drive');
fs.mkdirSync(DRIVE);
const { state, WORKSPACE } = await import('../src/store.js');
const { saveConnection } = await import('../src/connections.js');
const { publishTask, publishReport, cleanName } = await import('../src/drivesync.js');
const { createMissionWithTasks, missionTasks } = await import('../src/orchestrator.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = (...p) => fs.readdirSync(path.join(DRIVE, 'Yebunna OS', ...p)).sort();

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('names are safe for Windows and Drive', () => {
  assert.equal(cleanName('Price: 1,500 ብር / month?'), 'Price 1,500 ብር month');
  assert.equal(cleanName('  ...  '), 'Untitled');
});

test('a task is published as a version; a new version replaces the old one', () => {
  saveConnection('gdrive', { config: { path: DRIVE } });
  const m = { id: 'm1', createdAt: '2026-10-19T09:00:00Z', title: 'x', product: 'ProfitCheck Pro', taskIds: ['t1'] };
  const t = { id: 't1', title: 'Find the winning niche', output: 'RESULT: done', workDir: 'missions/m1/01-niche', completedAt: '2026-10-19T12:30:00Z' };
  const work = path.join(WORKSPACE, t.workDir);
  fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(work, 'niche-report.md'), 'v1');
  fs.writeFileSync(path.join(work, 'frames', 'f001.png'), 'temp');
  fs.writeFileSync(path.join(work, '.scratch'), 'hidden');
  publishTask(m, t, 'Nova');
  assert.deepEqual(ls(), ['2026-10-19 ProfitCheck Pro']);
  assert.deepEqual(ls('2026-10-19 ProfitCheck Pro'), ['01 Find the winning niche (Nova)']);
  const files = ls('2026-10-19 ProfitCheck Pro', '01 Find the winning niche (Nova)');
  assert.equal(files.length, 2, 'the report and the handover; no temp frames or hidden files');
  assert.ok(files.every((f) => /_v1_\d{4}-\d{2}-\d{2}_\d{4}\.md$/.test(f)), files.join(', '));

  fs.writeFileSync(path.join(work, 'niche-report.md'), 'v2');
  t.completedAt = '2026-10-19T15:00:00Z';
  publishTask(m, t, 'Nova');
  const after = ls('2026-10-19 ProfitCheck Pro', '01 Find the winning niche (Nova)');
  assert.ok(after.every((f) => f.includes('_v2_')), 'only version 2 is left');
  const report = after.find((f) => f.startsWith('niche-report_v2_'));
  assert.equal(fs.readFileSync(path.join(DRIVE, 'Yebunna OS', '2026-10-19 ProfitCheck Pro', '01 Find the winning niche (Nova)', report), 'utf8'), 'v2');

  publishReport(m, 'Shipped.');
  publishReport(m, 'Shipped again.');
  const reports = ls('2026-10-19 ProfitCheck Pro').filter((f) => f.startsWith('00 Mission report'));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^00 Mission report_v2_/);
});

test('a finished mission lands in Drive with every task and the report', async () => {
  const m = createMissionWithTasks({
    goal: 'SiteCalc launch copy',
    deadline: new Date(Date.now() + 4 * 3600e3).toISOString(),
    specs: [
      { agent: 'research', title: 'Collect buyer quotes', brief: 'quotes', deliverable: 'quotes', due_in_hours: 1, size: 'small' },
      { agent: 'marketing', title: 'Write ad hooks', brief: 'hooks', deliverable: 'hooks', due_in_hours: 2, size: 'small' },
    ],
  });
  for (const t0 = Date.now(); m.status !== 'done' && Date.now() - t0 < 60_000; ) await sleep(100);
  assert.equal(m.status, 'done');
  const folder = ls().find((f) => f.endsWith('SiteCalc launch copy'));
  assert.ok(folder, ls().join(', '));
  const inside = ls(folder);
  assert.ok(inside.some((f) => /^01 Collect buyer quotes \(Nova\)$/.test(f)));
  assert.ok(inside.some((f) => /^02 Write ad hooks \(Echo\)$/.test(f)));
  assert.ok(inside.some((f) => /^00 Mission report_v1_/.test(f)));
  assert.ok(missionTasks(m).every((t) => t.version === 1));
  assert.ok(state.missions[m.id].thread.some((i) => /Google Drive/.test(i.text)));
});
