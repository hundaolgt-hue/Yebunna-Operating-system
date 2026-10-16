// End-to-end smoke test: boots the server in offline demo mode against throwaway
// data and workspace folders, then drives the main flows through the JSON API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-test-'));
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
      DEMO_MODE: '1',
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

test('meta reports the demo engine and the team', async () => {
  const { status, body } = await api('GET', '/api/meta');
  assert.equal(status, 200);
  assert.equal(body.provider.name, 'demo');
  assert.ok(body.agents.some((a) => a.id === 'ceo'), 'has a CEO');
  assert.ok(body.agents.length >= 8);
});

test('the UI is served', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});

test('bad input is rejected with a clear status', async () => {
  assert.equal((await api('POST', '/api/missions', { goal: '', deadline: inHours(2) })).status, 400);
  assert.equal((await api('POST', '/api/missions', { goal: 'x', deadline: inHours(-1) })).status, 400);
  assert.equal((await api('GET', '/api/missions/nope')).status, 404);
  assert.equal((await api('DELETE', '/api/missions/nope')).status, 404);
  assert.equal((await api('GET', '/api/file?path=../package.json')).status, 403);
});

test('a mission runs from plan to report', async () => {
  const { status, body: mission } = await api('POST', '/api/missions', { goal: 'Launch a coffee subscription app', deadline: inHours(48) });
  assert.equal(status, 201);
  const done = await waitFor(async () => {
    const { body } = await api('GET', '/api/state');
    const m = body.missions.find((x) => x.id === mission.id);
    if (m?.status === 'failed') throw new Error(`mission failed\n${log}`);
    return m?.status === 'done' && m.thread.some((it) => it.kind === 'summary' && it.text) ? { m, tasks: body.tasks.filter((t) => t.missionId === m.id) } : null;
  }, 'mission to finish');
  assert.ok(done.tasks.length >= 4, 'CEO planned several tasks');
  for (const t of done.tasks) {
    assert.equal(t.status, 'done', `task "${t.title}" finished`);
    assert.ok(t.output, `task "${t.title}" has output`);
  }
  const files = (await api('GET', '/api/files')).body.files.map((f) => f.path);
  assert.ok(files.some((f) => f.startsWith(done.m.folder) && f.endsWith('00-mission-report.md')), 'report saved to the workspace');
});

test('plan approval holds work until the founder approves', async () => {
  await api('PUT', '/api/settings', { approvePlans: true });
  try {
    const { body: mission } = await api('POST', '/api/missions', { goal: 'Open a bakery', deadline: inHours(24) });
    const waiting = await waitFor(async () => {
      const m = (await api('GET', '/api/state')).body.missions.find((x) => x.id === mission.id);
      return m?.status === 'awaiting_approval' ? m : null;
    }, 'plan to await approval');
    const tasks = (await api('GET', '/api/state')).body.tasks.filter((t) => t.missionId === waiting.id);
    assert.ok(tasks.every((t) => !['running', 'done'].includes(t.status)), 'nothing started before approval');
    assert.equal((await api('POST', `/api/missions/${mission.id}/approve`)).status, 200);
    await waitFor(async () => {
      const m = (await api('GET', '/api/state')).body.missions.find((x) => x.id === mission.id);
      return m?.status === 'done';
    }, 'approved mission to finish');
  } finally {
    await api('PUT', '/api/settings', { approvePlans: false });
  }
});

test('a mission can be cancelled and deleted', async () => {
  const { body: mission } = await api('POST', '/api/missions', { goal: 'Start a podcast', deadline: inHours(12) });
  assert.equal((await api('POST', `/api/missions/${mission.id}/cancel`)).status, 200);
  const m = (await api('GET', '/api/state')).body.missions.find((x) => x.id === mission.id);
  assert.equal(m.status, 'cancelled');
  assert.equal((await api('DELETE', `/api/missions/${mission.id}`)).status, 200);
  const after = (await api('GET', '/api/state')).body;
  assert.ok(!after.missions.some((x) => x.id === mission.id));
  assert.ok(!after.tasks.some((t) => t.missionId === mission.id), 'its tasks are gone too');
});

test('chat with a bot streams a reply and is saved', async () => {
  const res = await fetch(`${BASE}/api/chats/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Who are our competitors?' }),
  });
  assert.equal(res.status, 200);
  await res.text();
  const history = (await api('GET', '/api/chats/research')).body;
  assert.ok(history.length >= 2, 'question and answer saved');
  assert.equal(history.at(-1).role, 'assistant');
});

test('bots: create, assign a task, add memory, delete', async () => {
  const { status, body: bot } = await api('POST', '/api/agents', { name: 'Tester', role: 'QA Lead', description: 'Finds bugs', specialties: ['testing'] });
  assert.equal(status, 201);
  const { status: s2, body: assigned } = await api('POST', `/api/agents/${bot.id}/assign`, { title: 'Write a test plan', instructions: 'For the app', deadlineHours: 3 });
  assert.equal(s2, 201);
  await waitFor(async () => (await api('GET', '/api/state')).body.missions.find((m) => m.id === assigned.id && m.status === 'done'), 'assigned task');
  assert.equal((await api('POST', `/api/agents/${bot.id}/memory`, { text: 'Prefers checklists' })).status, 201);
  assert.ok((await api('GET', '/api/state')).body.memory[bot.id].some((m) => m.text === 'Prefers checklists'));
  assert.equal((await api('DELETE', `/api/agents/${bot.id}`)).status, 200);
});

test('a meeting produces minutes', async () => {
  const { status, body: mt } = await api('POST', '/api/meetings', { title: 'Pricing', participants: ['sales', 'marketing'], rounds: 1 });
  assert.equal(status, 201);
  const done = await waitFor(async () => {
    const m = (await api('GET', '/api/state')).body.meetings.find((x) => x.id === mt.id);
    return m?.status === 'done' ? m : null;
  }, 'meeting to end');
  assert.ok(done.minutes, 'has minutes');
});

test('skills and routines CRUD', async () => {
  const { status, body: skill } = await api('POST', '/api/skills', { name: 'Weekly report', steps: 'Summarise the week', agents: ['ceo'] });
  assert.equal(status, 201);
  assert.equal((await api('PUT', `/api/skills/${skill.id}`, { name: 'Weekly summary' })).body.name, 'Weekly summary');
  const { status: rs, body: routine } = await api('POST', '/api/routines', { name: 'Daily standup', kind: 'standup', schedule: { type: 'daily', time: '09:00' } });
  assert.equal(rs, 201, JSON.stringify(routine));
  assert.equal((await api('DELETE', `/api/routines/${routine.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/skills/${skill.id}`)).status, 200);
});

test('state is saved to disk', async () => {
  const before = (await api('GET', '/api/state')).body.missions.length;
  await sleep(600); // let the debounced save flush
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
  assert.equal(Object.keys(saved.missions).length, before);
});
