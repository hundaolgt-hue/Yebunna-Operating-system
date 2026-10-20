// Guards that keep founder changes on the task they are about and stop duplicate work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/yebunna-matching-test';
const { state } = await import('../src/store.js');
const { resolveTask, duplicateTask, missionFor } = await import('../src/matching.js');

state.missions = { a: { id: 'a', status: 'running', product: 'ProfitCheck Pro', goal: 'Launch ProfitCheck Pro', createdAt: '2026-10-19', taskIds: ['t1', 't2'], thread: [] } };
state.tasks = {
  t1: { id: 't1', key: 'k1', missionId: 'a', title: 'Research competitor prices', agentId: 'research' },
  t2: { id: 't2', key: 'k2', missionId: 'a', title: 'Write 3 Amharic ad hooks', agentId: 'marketing', deliverable: 'hooks.md' },
};

test('a task is found by id, key, T-number or title', () => {
  const m = state.missions.a;
  assert.equal(resolveTask('t2')?.id, 't2');
  assert.equal(resolveTask('k1', m)?.id, 't1');
  assert.equal(resolveTask('T2', m)?.id, 't2');
  assert.equal(resolveTask('2', m)?.id, 't2');
  assert.equal(resolveTask('the Amharic ad hooks')?.id, 't2');
  assert.equal(resolveTask('landing page'), null);
});

test('a repeat of an existing task by the same owner is caught', () => {
  const m = state.missions.a;
  assert.equal(duplicateTask(m, { title: 'Write Amharic ad hooks again, shorter' }, 'marketing')?.id, 't2');
  assert.equal(duplicateTask(m, { title: 'Write Amharic ad hooks' }, 'landing'), null, 'another owner is other work');
  assert.equal(duplicateTask(m, { title: 'Build the landing page' }, 'marketing'), null);
});

test('work that names an existing product goes to its mission; a new product does not', () => {
  assert.equal(missionFor('Make the ProfitCheck video shorter')?.id, 'a');
  assert.equal(missionFor('Build a new product: ProfitCheck for cafes'), null);
  assert.equal(missionFor('Construction cost template for villas'), null, 'generic words never match');
});

test('a casual yes approves; anything with a change in it does not', async () => {
  const { isYes } = await import('../src/telegram.js');
  for (const t of ['Yes please', 'looks good, ship it', '👍', 'አዎ', 'approve']) assert.equal(isYes(t), true, t);
  for (const t of ['great but make it shorter', 'ok?', 'no', 'Change the headline']) assert.equal(isYes(t), false, t);
});
