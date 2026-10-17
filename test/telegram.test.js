// Telegram against a fake Bot API: finding the founder's chat, alerts, and replies that unblock work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-tg-'));
const PORT = 4100 + Math.floor(Math.random() * 800);
const TG_PORT = PORT + 1000;
const BASE = `http://localhost:${PORT}`;
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk';
const CHAT = 4242;
const sent = []; // messages the app sent to the founder
const inbox = []; // updates waiting for getUpdates
const sttCalls = [];
let nextId = 1;
let server;
let fake;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
async function waitFor(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const founderSays = (text, replyTo) =>
  inbox.push({ update_id: nextId++, message: { message_id: nextId++, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });

before(async () => {
  fake = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let p = {};
    try {
      p = raw ? JSON.parse(raw) : {};
    } catch {
      // multipart upload (speech-to-text)
    }
    const method = req.url.split('/').pop();
    const ok = (result) => res.end(JSON.stringify({ ok: true, result }));
    if (req.url === '/stt') {
      sttCalls.push(raw.length);
      return res.end(JSON.stringify({ text: 'Make three Facebook ad images for ProfitCheck' }));
    }
    if (req.url.startsWith(`/file/bot${TOKEN}/`)) return res.end(Buffer.from('OggS-fake-audio'));
    if (!req.url.includes(TOKEN)) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    if (method === 'getMe') return ok({ id: 1, username: 'yebunna_test_bot' });
    if (method === 'getFile') return ok({ file_id: p.file_id, file_size: 1234, file_path: 'voice/file_1.oga' });
    if (method === 'sendMessage') {
      const msg = { message_id: nextId++, chat: { id: p.chat_id }, text: p.text, reply_to: p.reply_to_message_id };
      sent.push(msg);
      return ok(msg);
    }
    if (method === 'getUpdates') {
      const wait = Date.now() + Math.min(2000, (p.timeout || 0) * 1000);
      while (!inbox.some((u) => u.update_id >= (p.offset || 0)) && Date.now() < wait) await sleep(50);
      return ok(inbox.filter((u) => u.update_id >= (p.offset || 0)));
    }
    ok(true);
  }).listen(TG_PORT);
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO_MODE: '1', SKILL_PACKS: '0', PORT: String(PORT), DATA_DIR: path.join(TMP, 'data'), WORKSPACE_DIR: path.join(TMP, 'ws'), TELEGRAM_API: `http://localhost:${TG_PORT}`, TELEGRAM_STT_URL: `http://localhost:${TG_PORT}/stt` },
    stdio: 'ignore',
  });
  await waitFor(() => fetch(BASE + '/api/meta').then((r) => r.ok, () => false), 'server start', 15_000);
});
after(() => {
  server?.kill();
  fake?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Save & test finds the founder chat and says hello', async () => {
  assert.equal((await api('PUT', '/api/connections/telegram', { config: { token: TOKEN } })).status, 200);
  const st1 = (await api('POST', '/api/connections/telegram/test')).body;
  assert.equal(st1.ok, false, 'no chat yet');
  assert.match(st1.error, /press Start/);
  founderSays('/start');
  const st = (await api('POST', '/api/connections/telegram/test')).body;
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.match(st.account, /@yebunna_test_bot → chat 4242/);
  assert.ok(sent.some((m) => /connected/.test(m.text)));
});

test('a blocker only the founder can fix arrives on Telegram, and a reply unblocks it', async () => {
  const { body: m } = await api('POST', '/api/agents/research/assign', { title: 'Check store stats', instructions: 'Read them [[demo:blocked]]', deadlineHours: 2 });
  const alert = await waitFor(() => sent.find((s) => /Needs you/.test(s.text)), 'the Telegram alert');
  assert.match(alert.text, /Check store stats/);
  founderSays('Done, I logged in', alert.message_id);
  await waitFor(() => sent.find((s) => /back in progress/.test(s.text)), 'the confirmation');
  await waitFor(async () => (await api('GET', '/api/state')).body.missions.find((x) => x.id === m.id)?.status === 'done', 'the mission to finish');
});

test('/status lists what the team is doing; strangers are ignored', async () => {
  founderSays('/status');
  await waitFor(() => sent.find((s) => /active missions/i.test(s.text)), 'the status reply');
  const before = sent.length;
  inbox.push({ update_id: nextId++, message: { message_id: nextId++, chat: { id: 999, type: 'private' }, text: '/status' } });
  await sleep(2500);
  assert.equal(sent.length, before, 'no reply to another chat');
});

const missions = async () => (await api('GET', '/api/state')).body.missions;

test('chatting with the CEO: an instruction becomes a mission, and the chat shows in the app', async () => {
  const before = (await missions()).length;
  founderSays('Research the top 5 competitors of ProfitCheck');
  await waitFor(() => sent.find((s) => /Started mission/.test(s.text)), 'the CEO to start a mission');
  const after = await missions();
  assert.equal(after.length, before + 1);
  assert.match(after.find((m) => m.source === 'chat').goal, /competitors/);
  const chat = (await api('GET', '/api/chats/ceo')).body;
  assert.ok(chat.some((m) => m.role === 'user' && m.via === 'telegram'), 'same conversation as the app');
});

test('a voice note is transcribed, echoed back, and acted on', async () => {
  inbox.push({ update_id: nextId++, message: { message_id: nextId++, chat: { id: CHAT, type: 'private' }, voice: { file_id: 'voice-1', duration: 3 } } });
  await waitFor(() => sent.find((s) => /🎙 “Make three Facebook ad images/.test(s.text)), 'the transcript echo');
  assert.equal(sttCalls.length, 1);
  await waitFor(async () => (await missions()).some((m) => /Facebook ad images/.test(m.goal)), 'a mission from the voice note');
});

test('replying to a "mission complete" message sends a comment to that mission', async () => {
  const done = await waitFor(() => sent.find((s) => /Mission complete/.test(s.text)), 'a mission-complete message', 90_000);
  const m = (await missions()).find((x) => done.text.includes(x.title));
  founderSays('Make the copy shorter and add Amharic headlines', done.message_id);
  await waitFor(() => sent.find((s) => /Passed to the team on/.test(s.text)), 'the follow-up confirmation');
  const thread = (await missions()).find((x) => x.id === m.id).thread;
  assert.ok(thread.some((i) => i.role === 'user' && /shorter/.test(i.text)), 'comment landed in the mission');
});
