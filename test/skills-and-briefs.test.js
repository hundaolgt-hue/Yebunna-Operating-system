// Skill files, core skills and the CEO's briefs: nothing starts until the task is clear.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-skills-'));
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}`;
let server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => (await fetch(BASE + url)).json();
const post = async (url, body) => {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
};
async function waitFor(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A minimal zip (deflate) like the .skill files Claude exports. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO_MODE: '1', IMPORT_CLAUDE_SKILLS: '0', SKILL_PACKS: '0', PORT: String(PORT), DATA_DIR: path.join(TMP, 'd'), WORKSPACE_DIR: path.join(TMP, 'w') },
    stdio: 'ignore',
  });
  await waitFor(() => fetch(BASE + '/api/meta').then((r) => r.ok, () => false), 'server', 15_000);
});
after(() => {
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a .skill file uploads into the library and reaches its bots', async () => {
  const file = zip({
    'higgsfield-motion/SKILL.md': '---\nname: higgsfield-motion\ndescription: Code-rendered launch films.\n---\n# Steps\n',
    'higgsfield-motion/references/a.md': 'reference',
    '../evil.txt': 'nope',
  });
  const res = await fetch(`${BASE}/api/skills/upload?name=higgsfield-motion.skill`, { method: 'POST', body: file });
  assert.equal(res.status, 201);
  const [s] = await res.json();
  assert.equal(s.name, 'higgsfield-motion');
  assert.equal(s.path, '.skills/custom/higgsfield-motion/SKILL.md');
  assert.deepEqual(s.agentIds, ['creative', 'design']);
  assert.ok(fs.existsSync(path.join(TMP, 'w', '.skills/custom/higgsfield-motion/references/a.md')));
  assert.ok(!fs.existsSync(path.join(TMP, 'w', '.skills/custom/evil.txt')) && !fs.existsSync(path.join(TMP, 'w', '.skills/evil.txt')));
  const bad = await fetch(`${BASE}/api/skills/upload?name=x.skill`, { method: 'POST', body: Buffer.from('not a zip') });
  assert.equal(bad.status, 400);
});

test('every built-in bot has a full job description and core skills', async () => {
  const { agents } = await get('/api/meta');
  for (const a of agents) {
    assert.ok(a.persona.length > 400, `${a.name} has a job description`);
    assert.ok(a.coreSkills.length >= 3, `${a.name} has core skills`);
    assert.ok(a.model && a.effort, `${a.name} has a model and effort`);
    if (a.id !== 'ceo') assert.match(a.persona, /YOU OWN:[\s\S]*NOT YOURS:/, `${a.name} has sharp role borders`);
  }
  const vega = agents.find((a) => a.id === 'creative');
  assert.match(vega.persona, /every video/);
  assert.ok(vega.coreSkills.includes('higgsfield-motion') && vega.coreSkills.includes('rapha-motion-video'));
  const nova = agents.find((a) => a.id === 'research');
  assert.match(nova.persona, /Ad Library/);
  assert.equal(nova.computer, true);
});

test('planned tasks carry a complete brief: skills, inputs and acceptance criteria', async () => {
  const { body: m } = await post('/api/missions', { goal: 'Launch a habit tracker', deadline: new Date(Date.now() + 48 * 3600e3).toISOString() });
  const tasks = await waitFor(async () => {
    const st = await get('/api/state');
    const ts = st.tasks.filter((t) => t.missionId === m.id);
    return ts.length ? ts : null;
  }, 'the plan');
  for (const t of tasks) {
    assert.ok(t.brief.length >= 300, 'a full brief');
    assert.ok(t.acceptance.length >= 2, 'acceptance criteria');
  }
});

test('a direct assignment is briefed by the CEO before it starts', async () => {
  const { body: m } = await post('/api/agents/marketing/assign', { title: 'Write 3 ad hooks', deadlineHours: 2 });
  const mission = await get('/api/state').then((s) => s.missions.find((x) => x.id === m.id));
  assert.ok(['planning', 'running', 'done'].includes(mission.status));
  const t = await waitFor(async () => (await get('/api/state')).tasks.find((x) => x.missionId === m.id && x.status === 'done'), 'the task');
  assert.ok(t.acceptance.length >= 2, 'the CEO added acceptance criteria');
  const thread = (await get('/api/state')).missions.find((x) => x.id === m.id).thread;
  assert.ok(thread.some((i) => /Brief ready/.test(i.text)));
});
