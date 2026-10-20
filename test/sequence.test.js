// One task at a time, in plan order, across missions; founder changes edit the task they are about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-seq-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const { createMission, createMissionWithTasks, amendTask, missionTasks, sendToMission, cancelMission } = await import('../src/orchestrator.js');
const { ceoChat } = await import('../src/ceochat.js');
const { state } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 60_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (fn()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('only one bot works at a time, tasks start in plan order, oldest mission first', async () => {
  let most = 0;
  const started = [];
  const onEvent = (ev) => {
    if (ev.type !== 'task') return;
    const busy = Object.values(state.tasks).filter((t) => ['in_progress', 'review'].includes(t.status));
    most = Math.max(most, busy.length);
    if (ev.task.status === 'in_progress' && started.at(-1) !== ev.task.title) started.push(ev.task.title);
  };
  bus.on('event', onEvent);
  const spec = (agent, title) => ({ agent, title, brief: title, deliverable: 'a file', due_in_hours: 1, size: 'small' });
  const a = createMissionWithTasks({ goal: 'Product A', deadline: inHours(4), specs: [spec('research', 'A1'), spec('product', 'A2')] });
  await sleep(5);
  const b = createMissionWithTasks({ goal: 'Product B', deadline: inHours(4), specs: [spec('marketing', 'B1')] });
  await until(() => [a, b].every((m) => m.status === 'done'), 'both missions');
  bus.off('event', onEvent);
  assert.equal(most, 1, 'never two bots at once');
  assert.deepEqual(started, ['A1', 'A2', 'B1']);
});

test('a change to a queued task edits its brief instead of adding work', async () => {
  const m = createMissionWithTasks({
    goal: 'Product C',
    deadline: inHours(4),
    specs: [
      { agent: 'research', title: 'Research C', brief: 'Research it', deliverable: 'notes', due_in_hours: 1, size: 'small' },
      { agent: 'marketing', title: 'Write 3 ad hooks', brief: 'Hooks for C', deliverable: 'hooks', due_in_hours: 2, size: 'small' },
    ],
  });
  const hooks = missionTasks(m)[1];
  await until(() => hooks.status === 'queued' && hooks.acceptance?.length, 'the brief');
  amendTask(hooks, 'Make them Amharic only');
  assert.equal(missionTasks(m).length, 2, 'no new task');
  assert.match(hooks.brief, /FOUNDER CHANGE: Make them Amharic only/);
  await until(() => m.status === 'done', 'the mission');
});

test('telling the CEO to change finished work redoes that task; it does not start a mission', async () => {
  const before = Object.keys(state.missions).length;
  const done = Object.values(state.tasks).find((t) => t.title === 'Write 3 ad hooks');
  const reply = await ceoChat('Change the ad hooks: use the word ProfitCheck in each', { via: 'app' });
  assert.match(reply, /Updated “Write 3 ad hooks”/);
  assert.equal(Object.keys(state.missions).length, before, 'no new mission');
  assert.match(done.feedback, /ProfitCheck/);
  await until(() => done.status === 'done' && state.missions[done.missionId].status === 'done', 'the redo');
  const fresh = await ceoChat('Build a new product: a cash-flow template for cafes', { via: 'app' });
  assert.match(fresh, /New mission/);
  assert.equal(Object.keys(state.missions).length, before + 1);
});

test('the CEO never starts a second mission for a product that already has one', async () => {
  const m = Object.values(state.missions).find((x) => x.goal === 'Product C');
  m.product = 'SiteCalc Villa';
  const before = Object.keys(state.missions).length;
  const reply = await ceoChat('SiteCalc Villa also needs a short FAQ for buyers', { via: 'app' });
  assert.equal(Object.keys(state.missions).length, before, 'no new mission');
  assert.match(reply, /Added to “Product C”/);
  await until(() => m.status === 'done', 'the added work');
});

test('a cancelled mission stays cancelled even with a follow-up waiting', async () => {
  const m = createMission({ goal: 'Product D', deadline: inHours(4) });
  sendToMission(m, { text: 'Also add a TikTok video', mode: 'delegate' }); // queued: the CEO is planning
  assert.equal(m.queue.length, 1);
  cancelMission(m);
  await sleep(3000);
  assert.equal(m.status, 'cancelled');
  assert.ok(missionTasks(m).every((t) => t.status === 'failed'), 'nothing runs');
});

test('several changes to a running task are all kept', async () => {
  // Earlier missions run first (one task at a time); none may get stuck.
  await until(() => Object.values(state.missions).every((x) => ['done', 'cancelled', 'failed'].includes(x.status)), 'earlier missions to finish', 240_000);
  const m = createMissionWithTasks({ goal: 'Product E', deadline: inHours(4), specs: [{ agent: 'design', title: 'Make 3 ad stills', brief: 'stills', deliverable: 'png', due_in_hours: 1, size: 'small' }] });
  const t = missionTasks(m)[0];
  await until(() => t.status === 'in_progress', 'the task to start');
  amendTask(t, 'Use a dark background');
  amendTask(t, 'Add the price 1,500 ብር');
  await until(() => m.status === 'done', 'the mission');
  assert.match(t.brief, /dark background/);
  assert.match(t.brief, /1,500 ብር/);
});
