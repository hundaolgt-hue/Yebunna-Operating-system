// Usage limit: reading the reset time, pausing all work, and resuming it automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-limit-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const { parseReset, hitLimit, resume, limited } = await import('../src/limits.js');
const { createMissionWithTasks, parseBlocker } = await import('../src/orchestrator.js');
const { state } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('reset times are read from the messages Claude Code prints', () => {
  const from = Date.parse('2026-10-17T10:00:00Z');
  assert.equal(parseReset('Claude AI usage limit reached|1760720400', from), new Date(1760720400 * 1000).toISOString());
  assert.equal(parseReset("You've hit your limit · resets 3pm (UTC)", from), '2026-10-17T15:00:00.000Z');
  assert.equal(parseReset('5-hour limit reached ∙ resets 9am (UTC)', from), '2026-10-18T09:00:00.000Z', 'already past today → tomorrow');
  assert.equal(parseReset('limit reached, resets 2:30pm (Africa/Addis_Ababa)', from), '2026-10-17T11:30:00.000Z', 'UTC+3');
  assert.equal(parseReset('Usage limit reached. Try later.', from), null);
});

test('a BLOCKED line at the end of a deliverable is recognised', () => {
  assert.deepEqual(parseBlocker('work…\n\nBLOCKED: no login | NEED: founder logs in'), { reason: 'no login', need: 'founder logs in' });
  assert.deepEqual(parseBlocker('work\n**BLOCKED:** API returns 403'), { reason: 'API returns 403', need: '' });
  assert.equal(parseBlocker('We were blocked earlier but solved it.\n\nFiles: a.md'), null);
});

test('while paused nothing starts; on reset the work runs to the end', async () => {
  const resets = [];
  bus.on('limit.reset', () => resets.push(1));
  hitLimit('Claude AI usage limit reached', new Date(Date.now() + 3600e3).toISOString());
  assert.ok(limited());
  assert.equal(state.limit.known, true);
  const m = createMissionWithTasks({
    goal: 'Write a post',
    deadline: new Date(Date.now() + 4 * 3600e3).toISOString(),
    specs: [{ agent: 'marketing', title: 'Write a post', brief: 'A post', deliverable: 'Post', due_in_hours: 2 }],
  });
  await sleep(1500);
  const t = state.tasks[m.taskIds[0]];
  assert.equal(t.status, 'queued', 'not started while paused');
  resume();
  assert.ok(!limited());
  assert.equal(resets.length, 1);
  const end = Date.now() + 60_000;
  while (state.missions[m.id].status !== 'done' && Date.now() < end) await sleep(250);
  assert.equal(t.status, 'done');
  assert.equal(state.missions[m.id].status, 'done');
});

test('with no reset time given, it tries again after the check interval (2h)', () => {
  hitLimit('Usage limit reached', null);
  const wait = Date.parse(state.limit.resetAt) - Date.now();
  assert.ok(wait > 1.9 * 3600e3 && wait <= 2 * 3600e3, String(wait));
  assert.equal(state.limit.known, false);
  resume();
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
