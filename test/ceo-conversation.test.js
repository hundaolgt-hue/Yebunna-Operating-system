// The CEO conversation: focus, one action per message, stop/undo, lessons, compaction, fresh start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-ceo-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const { createMissionWithTasks, missionTasks } = await import('../src/orchestrator.js');
const { ceoChat, freshStart } = await import('../src/ceochat.js');
const { listRules } = await import('../src/playbook.js');
const { systemPrompt, getAgent } = await import('../src/agents.js');
const { state } = await import('../src/store.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 90_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (fn()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const spec = (agent, title) => ({ agent, title, brief: `${title} for the product`, deliverable: `${title}.pdf`, due_in_hours: 1, size: 'small' });

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let m;
test('a finished mission; the CEO knows the focus and a change redoes only the named task', async () => {
  m = createMissionWithTasks({ goal: 'ProfitCheck Pro launch', deadline: inHours(4), specs: [spec('research', 'Market research'), spec('support', 'Write the buyer PDF guide')] });
  m.product = 'ProfitCheck Pro';
  await until(() => m.status === 'done', 'the mission');
  const [research, pdf] = missionTasks(m);
  const reply = await ceoChat('Edit the PDF guide: add a pricing table on page 2', { via: 'app' });
  assert.match(reply, /Updated “Write the buyer PDF guide”/);
  assert.equal(research.status, 'done', 'the research task was not restarted');
  assert.equal(state.ceoFocus?.taskId, pdf.id, 'the focus is now the PDF task');
  const finishedAt = pdf.completedAt;
  await until(() => pdf.status === 'done' && pdf.completedAt !== finishedAt && m.status === 'done', 'the redo');
  assert.match(pdf.brief, /pricing table/);
});

test('"no, I didn\'t ask for that" undoes the last action and leaves a lesson', async () => {
  const [, pdf] = missionTasks(m);
  const before = listRules().length;
  await ceoChat('Edit the PDF guide: make it blue', { via: 'app' });
  assert.ok(['queued', 'in_progress'].includes(pdf.status), 'the redo started');
  const reply = await ceoChat("No, I didn't ask for that", { via: 'app' });
  assert.match(reply, /Undone: put “Write the buyer PDF guide” back/);
  assert.equal(pdf.status, 'done', 'back as it was');
  assert.doesNotMatch(pdf.brief, /make it blue/, 'the change is gone from the brief');
  assert.equal(listRules().length, before + 1, 'a lesson was kept');
  assert.equal(listRules().at(-1).source, 'correction');
  assert.match(systemPrompt(getAgent('ceo')), /LESSONS FROM THE FOUNDER'S CORRECTIONS/);
  assert.doesNotMatch(systemPrompt(getAgent('support')), /LESSONS FROM THE FOUNDER'S CORRECTIONS/, 'lessons are the CEO\'s');
  await until(() => m.status === 'done', 'the mission settles');
});

test('"stop" stops the running task for good', async () => {
  const m2 = createMissionWithTasks({ goal: 'SiteCalc video', deadline: inHours(4), specs: [spec('creative', 'Render the launch video')] });
  const t = missionTasks(m2)[0];
  await until(() => t.status === 'in_progress', 'the task to start');
  const reply = await ceoChat('stop', { via: 'app' });
  assert.match(reply, /Stopped 1 task/);
  assert.equal(t.status, 'failed');
  assert.ok(t.stopped);
  await until(() => m2.status === 'done', 'the mission closes');
});

test('a long conversation is compacted into a summary and the recent messages', async () => {
  const history = state.chats.ceo;
  for (let i = 0; i < 24; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}`, at: new Date(Date.now() - (30 - i) * 60_000).toISOString() });
  await ceoChat('How is ProfitCheck going?', { via: 'app' });
  await until(() => state.ceoSummary?.text, 'the summary');
  assert.ok(state.chats.ceo.length <= 16, `history trimmed to ${state.chats.ceo.length}`);
  assert.ok(state.chats.ceo.every((h) => h.notice || !/^message \d$/.test(h.content)), 'the old messages are gone');
});

test('Fresh start archives the conversation and keeps rules and missions', () => {
  const rules = listRules().length;
  freshStart();
  assert.equal(state.chats.ceo.length, 1);
  assert.equal(state.ceoSummary, null);
  assert.equal(state.ceoFocus, null);
  assert.equal(state.ceoArchive.length, 1);
  assert.equal(listRules().length, rules);
  assert.ok(state.missions[m.id]);
});

test('when the CEO asks "do you mean T1?", a plain "yes" settles it — no second question', async () => {
  const a = createMissionWithTasks({ goal: 'MachineRent Pro launch', deadline: inHours(4), specs: [spec('support', 'Write the MachineRent Pro tutorial, thank-you and read-me-first PDFs')] });
  a.product = 'MachineRent Pro';
  await until(() => a.status === 'done', 'mission A');
  const b = createMissionWithTasks({ goal: 'SiteCalc Villa launch', deadline: inHours(4), specs: [spec('marketing', 'Write SiteCalc ad hooks')] });
  b.product = 'SiteCalc Villa';
  await until(() => b.status === 'done', 'mission B');
  await ceoChat('SiteCalc Villa: how is it going?', { via: 'app' }); // focus moves to B
  assert.equal(state.ceoFocus?.missionId, b.id);
  const t = missionTasks(a)[0];
  const ask = await ceoChat('change the read me pdf: put 0912736754 as the support number', { via: 'app' });
  assert.match(ask, /I think you mean “Write the MachineRent Pro tutorial/);
  assert.doesNotMatch(ask, /On it\./, 'no claim that the work was sent');
  assert.equal(t.status, 'done', 'nothing changed yet');
  const yes = await ceoChat('yes', { via: 'app' });
  assert.match(yes, /Updated “Write the MachineRent Pro tutorial/);
  assert.match(t.brief, /0912736754/);
  await until(() => a.status === 'done' && t.status === 'done', 'the redo');
  assert.equal(state.ceoFocus?.taskId, t.id);
});
