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
