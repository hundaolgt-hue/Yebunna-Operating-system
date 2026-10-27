// API fallback: at the plan's limit, switch to the API key; past the daily cap, pause; at the reset, back to the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-api-'));
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
const { hitLimit, recordApiCost, leaveApi, onApi, limited, resume } = await import('../src/limits.js');
const { state } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inHour = () => new Date(Date.now() + 3600e3).toISOString();

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('without the fallback, the limit pauses the team', () => {
  hitLimit('Claude AI usage limit reached', inHour());
  assert.ok(limited());
  assert.equal(onApi(), false);
  resume();
});

test('with the fallback, the team switches to the API key and restarts', async () => {
  state.apiFallback = { enabled: true, key: 'sk-ant-test-0000000000000000000000', dailyCapUsd: 1, noOpus: true };
  const resets = [];
  const on = (e) => resets.push(e.reason);
  bus.on('limit.reset', on);
  hitLimit('Claude AI usage limit reached', inHour());
  assert.equal(limited(), false, 'not paused');
  assert.equal(onApi(), true, 'on the API key');
  await sleep(1800);
  assert.deepEqual(resets, ['switched to the API key'], 'the queued work restarts');
  bus.off('limit.reset', on);
});

test('past the daily cap it pauses until the plan resets', () => {
  recordApiCost(0.6);
  assert.equal(onApi(), true);
  recordApiCost(0.5);
  assert.equal(onApi(), false, 'stopped using the API');
  assert.ok(limited(), 'paused');
  resume();
  hitLimit('Claude AI usage limit reached', inHour());
  assert.ok(limited(), 'over the cap: no switch to the API today');
  resume();
});

test('at the reset the team goes back to the subscription', () => {
  state.apiSpend = null;
  hitLimit('Claude AI usage limit reached', inHour());
  assert.equal(onApi(), true);
  leaveApi('plan reset');
  assert.equal(onApi(), false);
  assert.equal(limited(), false);
});

test("every wording of the plan's limit is recognised", async () => {
  const { LIMIT_TEXT } = await import('../src/llm.js');
  for (const t of ["You've hit your session limit · resets 3pm", "You've hit your weekly limit", 'Claude AI usage limit reached|1760014800', '5-hour limit reached ∙ resets 9am']) assert.ok(LIMIT_TEXT.test(t), t);
  assert.equal(LIMIT_TEXT.test('Here is the plan for the session.'), false);
});

test('turning the fallback on while already paused switches to the API key at once', async () => {
  const { useApiIfPaused } = await import('../src/limits.js');
  state.apiSpend = null;
  state.apiFallback = { ...state.apiFallback, enabled: false };
  hitLimit("You've hit your session limit", inHour());
  assert.ok(limited());
  state.apiFallback.enabled = true;
  assert.equal(useApiIfPaused(), true);
  assert.equal(limited(), false);
  assert.equal(onApi(), true);
  leaveApi('test');
});

test("Vega always opens every motion skill and studies the Drive 'sample videos' folder", async () => {
  const { saveConnection } = await import('../src/connections.js');
  const { systemPrompt, getAgent } = await import('../src/agents.js');
  const drive = path.join(TMP, 'My Drive');
  fs.mkdirSync(path.join(drive, 'Rapha', 'Sample Videos'), { recursive: true });
  saveConnection('gdrive', { config: { path: drive } });
  const p = systemPrompt(getAgent('creative'));
  assert.match(p, /EVERY one of them/);
  assert.match(p, new RegExp(`SAMPLE VIDEOS.*${path.join('Rapha', 'Sample Videos').replace(/\\/g, '\\\\')}`));
  assert.match(p, /run_in_background/);
});

test('a bot that only mentions the limit does not pause the team', async () => {
  const { LIMIT_NOTICE } = await import('../src/llm.js');
  assert.ok(LIMIT_NOTICE.test("You've hit your session limit · resets 3pm"));
  for (const t of ["We're paused on your Claude usage limit, so I saved your message.", 'Noted. Last time the usage limit reached its cap at 3pm.', 'The video resets 3 times per loop.']) assert.equal(LIMIT_NOTICE.test(t), false, t);
});

test("the claude.ai Meta Ads connector's tools are allowed for bots with the Meta connection", async () => {
  const { saveConnection, connectionTools } = await import('../src/connections.js');
  saveConnection('meta', { config: { token: 'EAA' + 'x'.repeat(40), adAccountId: '123' }, bots: ['marketing'] });
  assert.ok(connectionTools('marketing').includes('mcp__claude_ai_Meta_Ads'));
  assert.ok(!connectionTools('design').includes('mcp__claude_ai_Meta_Ads'));
});

test('API only: every run is on the key, the plan is never consulted, the cap pauses until tomorrow', async () => {
  const { billingMode, apiSpentToday } = await import('../src/limits.js');
  state.apiSpend = null;
  state.limit = null;
  state.apiFallback = { mode: 'api', key: 'sk-ant-test-0000000000000000000000', dailyCapUsd: 1, noOpus: true };
  assert.equal(billingMode(), 'api');
  assert.equal(onApi(), true, 'on the key from the start, with no limit hit');
  hitLimit('Claude AI usage limit reached', inHour()); // a stray plan notice changes nothing
  assert.equal(onApi(), true);
  recordApiCost(1.5);
  assert.ok(limited(), 'past the cap: paused');
  assert.ok(Date.parse(state.limit.resetAt) > Date.now(), 'until tomorrow');
  assert.equal(apiSpentToday(), 1.5);
  resume();
  state.apiFallback = { mode: 'plan', key: '', dailyCapUsd: 10 };
  assert.equal(billingMode(), 'plan');
  assert.equal(onApi(), false);
});

test('the Meta probe runs one bot with Echo\'s setup and returns its report', async () => {
  const { probeMeta } = await import('../src/connections.js');
  const report = await probeMeta();
  assert.match(report, /CONNECTOR TOOL/);
  assert.match(report, /CONCLUSION/);
});

test('a daily cap of 0 means no cap', async () => {
  const { apiCap } = await import('../src/limits.js');
  state.limit = null;
  state.apiSpend = null;
  state.apiFallback = { mode: 'api', key: 'sk-ant-test-0000000000000000000000', dailyCapUsd: 0 };
  assert.equal(apiCap(), Infinity);
  recordApiCost(500);
  assert.equal(limited(), false, 'never paused for spending');
  assert.equal(onApi(), true);
});
