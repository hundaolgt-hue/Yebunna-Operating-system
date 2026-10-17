// Telegram: the app's line to the founder. It sends alerts when only the founder can
// unblock something (a login, a decision, an approval) and when the usage limit pauses
// or resumes work, and it reads the founder's replies (long polling, no webhook or
// public address needed). Only messages from the founder's own chat are accepted.
import { state, save, now } from './store.js';
import { bus } from './bus.js';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // overridable for tests
const cfg = () => state.connections?.telegram;
const ready = () => {
  const c = cfg();
  return Boolean(c?.enabled && c.config?.token && c.config?.chatId);
};

async function call(token, method, params = {}, timeoutMs = 20_000) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.description || `Telegram HTTP ${res.status}`);
  return body.result;
}

/** Save & test: check the token, find the founder's chat, send a hello. */
export async function testTelegram(c) {
  const { token } = c.config || {};
  if (!token) throw new Error('No bot token saved');
  const me = await call(token, 'getMe');
  if (!c.config.chatId) {
    const updates = await call(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
    const chat = updates.map((u) => u.message?.chat).filter((ch) => ch?.type === 'private').at(-1);
    if (!chat) throw new Error(`Open @${me.username} in Telegram, press Start (or send "hi"), then click Save & test again.`);
    c.config.chatId = String(chat.id);
  }
  await call(token, 'sendMessage', { chat_id: c.config.chatId, text: `✅ Yebunna OS is connected — this is your line to the CEO. Write or send a voice note: ask how things are going, give new work, comment on a mission, or set rules. I'll also message you when the team needs you.\n\n/status — what the team is doing\n/help — commands` });
  restartPolling();
  return `@${me.username} → chat ${c.config.chatId}`;
}

const tg = () => (state.telegram ||= { sent: [], offset: 0 });

/**
 * Message the founder. `ref` ties the message to what it is about ({type:'task'|'approval'|'plan', id}),
 * so a reply to it answers that item. Never throws; does nothing if Telegram isn't connected.
 */
export async function notifyFounder(text, ref = null) {
  if (!ready()) return;
  try {
    const msg = await call(cfg().config.token, 'sendMessage', { chat_id: cfg().config.chatId, text: String(text).slice(0, 4000) });
    if (ref) {
      tg().sent = [{ messageId: msg.message_id, ref, at: now() }, ...tg().sent].slice(0, 200);
      save();
    }
  } catch (e) {
    console.error('Telegram message failed:', e.message);
  }
}

// ---- what the founder can answer ---------------------------------------------------

/** Everything waiting on the founder, oldest first. */
export function waitingItems() {
  const items = [];
  for (const t of Object.values(state.tasks)) {
    if (t.status === 'founder') items.push({ ref: { type: 'task', id: t.id }, label: `🙋 ${t.title}: ${t.question}`, at: t.blocker?.at || t.createdAt });
    if (t.status === 'approval') items.push({ ref: { type: 'approval', id: t.id }, label: `🔐 Sign off “${t.title}”`, at: t.completedAt || t.createdAt });
  }
  for (const m of Object.values(state.missions)) {
    if (m.status === 'awaiting_approval') items.push({ ref: { type: 'plan', id: m.id }, label: `🔐 Approve the plan for “${m.title}”`, at: m.createdAt });
  }
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const YES = /^(approve|approved|yes|ok|okay|go|👍|✅)\.?!?$/i;

export async function answerItem(ref, text) {
  const { answerTask, approvePlan, decideTask } = await import('./orchestrator.js');
  if (ref.type === 'task') {
    const t = state.tasks[ref.id];
    if (t?.status !== 'founder') return 'That one is already handled.';
    answerTask(t, text);
    return `👍 Passed to the team — “${t.title}” is back in progress.`;
  }
  if (ref.type === 'approval') {
    const t = state.tasks[ref.id];
    if (t?.status !== 'approval') return 'That one is already handled.';
    decideTask(t, YES.test(text.trim()) ? { approve: true } : { approve: false, feedback: text });
    return YES.test(text.trim()) ? `✅ Approved “${t.title}”.` : `↩️ Sent “${t.title}” back with your changes.`;
  }
  if (ref.type === 'plan') {
    const m = state.missions[ref.id];
    if (m?.status !== 'awaiting_approval') return 'That plan is already handled.';
    if (!YES.test(text.trim())) return 'Reply “approve” to start the plan, or change it in Yebunna OS.';
    approvePlan(m);
    return `✅ Plan approved — the team is starting “${m.title}”.`;
  }
  return "I couldn't match that reply.";
}

function statusText() {
  const missions = Object.values(state.missions).filter((m) => ['planning', 'running', 'reporting', 'awaiting_approval'].includes(m.status));
  const lines = missions.slice(0, 8).map((m) => {
    const tasks = m.taskIds.map((id) => state.tasks[id]).filter(Boolean);
    const done = tasks.filter((t) => t.status === 'done').length;
    return `• ${m.title} — ${done}/${tasks.length} done${tasks.some((t) => t.status === 'founder') ? ' · needs you' : ''}`;
  });
  const limit = state.limit ? `\n⏸ Paused on the usage limit until ${new Date(state.limit.resetAt).toLocaleString()} (/resume to try now).` : '';
  const waiting = waitingItems();
  return `${lines.length ? `Active missions:\n${lines.join('\n')}` : 'No active missions.'}${limit}${waiting.length ? `\n\nWaiting on you:\n${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n')}\n\nAnswer with: /answer <number> <your answer>` : ''}`;
}

async function onMessage(msg) {
  const reply = (t) => sendLong(t, msg.message_id);

  // Voice notes and audio files: transcribe, show what was heard, then treat it as text.
  let text = String(msg.text || msg.caption || '').trim();
  let via = 'telegram';
  const audio = msg.voice || msg.audio || (msg.video_note ? msg.video_note : null);
  if (audio && !text) {
    typing();
    try {
      text = await transcribe(audio.file_id);
    } catch (e) {
      return reply(`🎙 I couldn't understand the voice note: ${e.message}`);
    }
    if (!text) return reply("🎙 I couldn't hear any words in that voice note.");
    via = 'voice';
    await reply(`🎙 “${text}”`);
  }
  if (!text) return;

  if (/^\/(start|help)\b/i.test(text)) return reply('Talk to me like you talk to your CEO — by text or voice note. Ask how things are going, give new work, comment on a mission, or set rules ("from now on …"). I act on it and keep the team moving.\n\nI also message you when something only you can do is blocking the team; reply to that message to answer it.\n\n/status — what the team is doing and what waits on you\n/answer <number> <text> — answer an item from /status\n/resume — try again now after a usage-limit pause');
  if (/^\/status\b/i.test(text)) return reply(statusText());
  if (/^\/resume\b/i.test(text)) {
    if (!state.limit) return reply('Nothing is paused.');
    const { resume } = await import('./limits.js');
    resume('founder asked');
    return reply('▶️ Trying again now. If the limit is still on, work pauses again and I will tell you when it resets.');
  }
  const numbered = text.match(/^\/answer\s+(\d+)\s+([\s\S]+)/i);
  if (numbered) {
    const item = waitingItems()[Number(numbered[1]) - 1];
    return reply(item ? await answerItem(item.ref, numbered[2].trim()) : 'No item with that number — send /status to see the list.');
  }
  // A reply to one of our alerts answers that item (or, for a mission message, talks to the CEO about it).
  const repliedTo = msg.reply_to_message?.message_id;
  const sent = repliedTo && tg().sent.find((s) => s.messageId === repliedTo);
  if (sent && sent.ref.type !== 'mission') return reply(await answerItem(sent.ref, text));

  // Everything else is a conversation with the CEO, who can act on it.
  typing();
  const keepTyping = setInterval(typing, 4500);
  try {
    const { ceoChat } = await import('./ceochat.js');
    return reply(await ceoChat(text, { via, focus: sent ? { missionId: sent.ref.id } : null }));
  } finally {
    clearInterval(keepTyping);
  }
}

function typing() {
  call(cfg().config.token, 'sendChatAction', { chat_id: cfg().config.chatId, action: 'typing' }).catch(() => {});
}

/** Telegram allows 4096 characters per message: split long replies on paragraph breaks. */
async function sendLong(text, replyTo) {
  const parts = [];
  let rest = String(text);
  while (rest.length > 3900) {
    const cut = Math.max(rest.lastIndexOf('\n\n', 3900), rest.lastIndexOf('\n', 3900), 2000);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  for (const [i, part] of parts.entries()) {
    await call(cfg().config.token, 'sendMessage', { chat_id: cfg().config.chatId, text: part, ...(i === 0 && replyTo ? { reply_to_message_id: replyTo } : {}) }).catch(() => {});
  }
}

// ---- voice notes -------------------------------------------------------------------
// Claude can't hear audio, so voice notes are turned into text first, with (in this order):
//   1. a Groq API key (gsk_…, free tier, Whisper large-v3) or an OpenAI API key (sk-…) saved
//      in the Telegram connection, or
//   2. faster-whisper running locally (pip install faster-whisper) — free, slower, offline.
const STT_URL = process.env.TELEGRAM_STT_URL; // tests only

async function transcribe(fileId) {
  const c = cfg().config;
  const file = await call(c.token, 'getFile', { file_id: fileId });
  if (file.file_size > 20e6) throw new Error('the recording is too long (max ~20 MB)');
  const res = await fetch(`${API}/file/bot${c.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const audio = Buffer.from(await res.arrayBuffer());
  const lang = /^(am|en)$/i.test(c.voiceLang || '') ? c.voiceLang.toLowerCase() : null;
  const key = c.sttKey;
  if (key || STT_URL) {
    const groq = String(key).startsWith('gsk_');
    const url = STT_URL || (groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', groq ? 'whisper-large-v3' : 'whisper-1');
    if (lang) form.append('language', lang);
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error?.message || `speech-to-text HTTP ${r.status}`);
    return String(body.text || '').trim();
  }
  return transcribeLocally(audio, lang);
}

async function transcribeLocally(audio, lang) {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-voice-'));
  const file = path.join(dir, 'voice.ogg');
  fs.writeFileSync(file, audio);
  const script = `import sys\nfrom faster_whisper import WhisperModel\nm = WhisperModel("small", device="cpu", compute_type="int8")\nsegs, _ = m.transcribe(sys.argv[1], language=(sys.argv[2] or None), vad_filter=True)\nprint(" ".join(s.text.strip() for s in segs))`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn(python, ['-c', script, file, lang || ''], { windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', () => reject(new Error('Python is not installed. Add a free Groq API key in Connections → Telegram, or install Python and run: pip install faster-whisper')));
      p.on('close', (code) =>
        code === 0
          ? resolve(out.trim())
          : reject(new Error(/No module named/.test(err) ? 'voice notes need a speech-to-text engine. Add a free Groq API key in Connections → Telegram, or run: pip install faster-whisper' : err.trim().split('\n').pop() || `exit ${code}`)),
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- long polling ----------------------------------------------------------------

let polling = false;
let generation = 0;
export function restartPolling() {
  generation++;
  if (ready()) poll(generation);
}

async function poll(gen) {
  if (polling) return; // the running loop picks up the new generation
  polling = true;
  try {
    while (ready()) {
      const token = cfg().config.token;
      let updates = [];
      try {
        updates = await call(token, 'getUpdates', { offset: tg().offset, timeout: 50, allowed_updates: ['message'] }, 65_000);
      } catch (e) {
        if (/conflict|unauthorized|not found/i.test(e.message)) console.error('Telegram polling:', e.message);
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      for (const u of updates) {
        tg().offset = u.update_id + 1;
        // Only the founder's own chat may talk to the company.
        if (u.message && String(u.message.chat?.id) === String(cfg().config.chatId)) await onMessage(u.message).catch((e) => console.error('Telegram reply failed:', e.message));
      }
      if (updates.length) save();
    }
  } finally {
    polling = false;
    if (gen !== generation && ready()) poll(generation);
  }
}

// ---- alerts the app sends on its own ------------------------------------------------

// A retry that bumps straight into the limit again stays quiet: "resumed" is only sent once
// work has really been running for a few minutes, and a re-hit within that time is not re-announced.
let resumedAt = 0;
let resumeNote = null;
bus.on('disk.alert', (text) => notifyFounder(text));
bus.on('limit.hit', (limit) => {
  if (limit.kind === 'disk') return; // disk.alert already said it
  if (Date.now() - resumedAt < 5 * 60_000) return void clearTimeout(resumeNote);
  notifyFounder(`⏸ Your Claude usage limit was reached. All work is paused and resumes automatically ${limit.known ? `when it resets (${new Date(limit.resetAt).toLocaleString()})` : `at ${new Date(limit.resetAt).toLocaleString()} — I'll keep checking every couple of hours`}.\n/resume tries again sooner.`);
});
bus.on('limit.reset', () => {
  resumedAt = Date.now();
  clearTimeout(resumeNote);
  resumeNote = setTimeout(() => !state.limit && notifyFounder('▶️ The usage limit has reset — the team is back at work.'), 5 * 60_000);
  resumeNote.unref?.();
});

setTimeout(restartPolling, 1000);
