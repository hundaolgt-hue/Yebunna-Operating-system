// Model routing: which model, effort and step budget each kind of work gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/yebunna-usage-test';
const { pick } = await import('../src/llm.js');
const { state } = await import('../src/store.js');

test('balanced mode keeps the big model for planning and large tasks only', () => {
  state.settings.usageMode = 'balanced';
  assert.deepEqual(pick('plan', undefined, 'high', 100), { model: '', effort: 'high', maxTurns: 100 });
  assert.deepEqual(pick('task', undefined, 'high', 100, 'large'), { model: '', effort: 'high', maxTurns: 100 });
  assert.deepEqual(pick('task', undefined, 'high', 100, 'medium'), { model: 'sonnet', effort: 'medium', maxTurns: 80 });
  assert.deepEqual(pick('task', undefined, 'high', 100, 'small'), { model: 'sonnet', effort: 'low', maxTurns: 40 });
  assert.equal(pick('review', undefined, 'low', 100).model, 'haiku');
  assert.equal(pick('task', undefined, 'high', 150, 'small').maxTurns, 60, 'computer-use step budget scales');
});

test('an explicit model and a lower requested effort are respected', () => {
  state.settings.usageMode = 'balanced';
  assert.equal(pick('memory', 'haiku', 'low', 10).model, 'haiku');
  assert.equal(pick('task', undefined, 'low', 100, 'large').effort, 'low');
});

test('quality mode changes nothing; economy never uses the big model', () => {
  state.settings.usageMode = 'quality';
  assert.deepEqual(pick('task', undefined, 'high', 100, 'small'), { model: '', effort: 'high', maxTurns: 100 });
  state.settings.usageMode = 'economy';
  for (const kind of ['plan', 'report', 'chat', 'meeting', 'skill', 'review', 'memory']) assert.ok(pick(kind, undefined, 'high', 100).model, kind);
  for (const size of ['small', 'medium', 'large']) assert.ok(pick('task', undefined, 'high', 100, size).model, size);
});

test('old installs with the economy switch on stay in economy', () => {
  delete state.settings.usageMode;
  state.settings.economy = true;
  assert.equal(pick('task', undefined, 'high', 100, 'large').model, 'sonnet');
  state.settings.economy = false;
  assert.equal(pick('task', undefined, 'high', 100, 'medium').model, 'sonnet', 'default is balanced');
});
