// Model routing: every bot runs on its own model and effort; the task size sets the step budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/yebunna-usage-test';
const { pick } = await import('../src/llm.js');
const { updateAgent, resetAgent, systemPrompt, getAgent, remember } = await import('../src/agents.js');

test('each bot runs on its own model and effort; the CEO plans on Opus', () => {
  assert.deepEqual(pick('plan', undefined, 'high', 25, 'medium', 'ceo'), { model: 'opus', effort: 'high', maxTurns: 25 });
  assert.deepEqual(pick('review', undefined, 'low', 8, 'medium', 'ceo'), { model: 'sonnet', effort: 'low', maxTurns: 8 });
  assert.deepEqual(pick('task', undefined, 'medium', 100, 'large', 'engineer'), { model: 'opus', effort: 'high', maxTurns: 100 });
  assert.deepEqual(pick('task', undefined, 'medium', 100, 'large', 'creative'), { model: 'opus', effort: 'medium', maxTurns: 100 });
  assert.deepEqual(pick('task', undefined, 'medium', 100, 'small', 'support'), { model: 'haiku', effort: 'low', maxTurns: 40 });
  assert.equal(pick('task', undefined, 'medium', 100, 'medium', 'marketing').model, 'sonnet');
  assert.equal(pick('meeting', undefined, 'medium', 100, 'medium', 'engineer').effort, 'low', 'meetings are low effort');
});

test('an explicit model wins, and edits under Team → Edit change the routing', () => {
  assert.equal(pick('memory', 'haiku', 'low', 10, 'medium', 'engineer').model, 'haiku');
  updateAgent('research', { model: 'opus', effort: 'high' });
  assert.deepEqual(pick('task', undefined, 'medium', 100, 'medium', 'research'), { model: 'opus', effort: 'high', maxTurns: 70 });
  updateAgent('research', { model: 'gpt-9', effort: 'huge' }); // unknown values are ignored
  assert.equal(getAgent('research').model, 'opus');
  resetAgent('research');
  assert.equal(getAgent('research').model, 'sonnet');
});

test("prompts are lean: no team roster for specialists, no notes from past missions", () => {
  remember('design', 'Old product: used teal for SiteCalc', 'task:abc');
  remember('design', 'The founder prefers matte dark backgrounds', 'chat');
  const p = systemPrompt(getAgent('design'));
  assert.doesNotMatch(p, /SiteCalc/, 'past-mission notes are wiped');
  assert.match(p, /matte dark/, 'standing founder facts stay');
  assert.doesNotMatch(p, /Your team \(id/, 'no roster for specialists');
  assert.match(systemPrompt(getAgent('ceo')), /Your team \(id/);
});

test('saving a bot without changing its job description does not freeze it', async () => {
  const { state } = await import('../src/store.js');
  const pixel = getAgent('design');
  updateAgent('design', { persona: pixel.persona, role: pixel.role, specialties: pixel.specialties, computer: true });
  assert.deepEqual(state.agentOverrides.design, { computer: true }, 'only the real change is kept');
  updateAgent('design', { persona: 'You are Pixel. Custom.' });
  assert.equal(getAgent('design').persona, 'You are Pixel. Custom.', 'a real edit still wins');
  resetAgent('design');
});
