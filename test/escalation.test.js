// Blockers, the founder's answers, retrospectives and the playbook — end to end in demo mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-esc-'));
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}`;
let server;
let log = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
async function waitFor(fn, what, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n--- server log ---\n${log}`);
}
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEMO_MODE: '1', IMPORT_CLAUDE_SKILLS: '0',
      SKILL_PACKS: '0',
      PORT: String(PORT),
      DATA_DIR: path.join(TMP, 'data'),
      WORKSPACE_DIR: path.join(TMP, 'workspace'),
      MAX_PARALLEL_TASKS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  await waitFor(() => fetch(BASE + '/api/meta').then((r) => r.ok, () => false), 'server start', 15_000);
});

after(() => {
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});


const task = async (id) => (await api('GET', '/api/state')).body.tasks.find((t) => t.id === id);

test('a blocked bot reports to the CEO, the CEO asks the founder, the answer unblocks it', async () => {
  const { body: m } = await api('POST', '/api/agents/research/assign', { title: 'Pull Ye-Buna sales numbers', instructions: 'Read the store stats [[demo:blocked]]', deadlineHours: 2, size: 'small' });
  const t = await waitFor(async () => {
    const s = (await api('GET', '/api/state')).body;
    const x = s.tasks.find((k) => k.missionId === m.id);
    return x?.status === 'founder' ? x : null;
  }, 'the task to wait on the founder');
  assert.match(t.blocker.reason, /logged in/);
  assert.ok(t.question, 'the CEO wrote a question for the founder');
  const mission = (await api('GET', '/api/state')).body.missions.find((x) => x.id === m.id);
  assert.ok(mission.thread.some((i) => i.kind === 'escalation' && /Needs you/.test(i.text)), 'escalated in the thread');
  assert.equal((await api('POST', `/api/tasks/${t.id}/answer`, { text: '' })).status, 400);
  assert.equal((await api('POST', `/api/tasks/${t.id}/answer`, { text: 'Logged in — go ahead' })).status, 200);
  const done = await waitFor(async () => ((await task(t.id))?.status === 'done' ? task(t.id) : null), 'the task to finish after the answer');
  assert.ok(!/BLOCKED:/.test(done.output));
  assert.equal((await api('POST', `/api/tasks/${t.id}/answer`, { text: 'again' })).status, 409, 'no longer waiting');
});

test('the retrospective turns recent work into playbook rules that bots follow', async () => {
  const { status, body: mt } = await api('POST', '/api/retro');
  assert.equal(status, 201);
  assert.equal(mt.kind, 'retro');
  assert.ok(mt.participants.includes('research'), 'bots that worked take part');
  const done = await waitFor(async () => {
    const x = (await api('GET', '/api/state')).body.meetings.find((k) => k.id === mt.id);
    return x?.status === 'done' ? x : null;
  }, 'the retrospective to finish');
  assert.match(done.minutes, /New playbook rules/);
  const rules = (await api('GET', '/api/state')).body.rules;
  assert.ok(rules.length >= 1);
  assert.equal((await api('POST', '/api/retro')).status, 409, 'nothing new to review right after');
});

test('playbook rules can be added and deleted; duplicates are ignored', async () => {
  const { status, body: r } = await api('POST', '/api/rules', { type: 'dont', text: 'Publish anything without the founder saying so' });
  assert.equal(status, 201);
  assert.equal((await api('POST', '/api/rules', { type: 'dont', text: 'publish anything without the founder saying so!' })).body.duplicate, true);
  assert.equal((await api('POST', '/api/rules', { text: '  ' })).status, 400);
  await api('DELETE', `/api/rules/${r.id}`);
  assert.ok(!(await api('GET', '/api/state')).body.rules.some((x) => x.id === r.id));
});

test('a morning retrospective routine exists out of the box', async () => {
  const routines = (await api('GET', '/api/state')).body.routines;
  assert.ok(routines.some((r) => r.kind === 'retro' && r.schedule.type === 'daily' && r.enabled));
});

test('Telegram: a wrong token is refused, the bot picker is hidden', async () => {
  assert.equal((await api('PUT', '/api/connections/telegram', { config: { token: 'hello' } })).status, 400);
  const tg = (await api('GET', '/api/connections')).body.find((c) => c.id === 'telegram');
  assert.equal(tg.system, true);
  assert.equal(tg.enabled, false);
});
