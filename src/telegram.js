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
  await call(token, 'sendMessage', { chat_id: c.config.chatId, text: `✅ Yebunna OS is connected. I'll message you here when the team needs you.\n\n/status — what the team is doing\n/help — commands` });
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
function waitingItems() {
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

async function answer(ref, text) {
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
  const text = String(msg.text || '').trim();
  if (!text) return;
  const reply = (t) => call(cfg().config.token, 'sendMessage', { chat_id: cfg().config.chatId, text: t, reply_to_message_id: msg.message_id }).catch(() => {});

  if (/^\/(start|help)\b/i.test(text)) return reply('I message you when the team needs something only you can do.\n\nReply to one of my messages to answer it.\n/status — what the team is doing and what waits on you\n/answer <number> <text> — answer an item from /status\n/resume — try again now after a usage-limit pause');
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
    return reply(item ? await answer(item.ref, numbered[2].trim()) : 'No item with that number — send /status to see the list.');
  }
  // A reply to one of our alerts answers that item.
  const repliedTo = msg.reply_to_message?.message_id;
  const sent = repliedTo && tg().sent.find((s) => s.messageId === repliedTo);
  if (sent) return reply(await answer(sent.ref, text));
  // Not a reply: if exactly one thing is waiting, this answers it.
  const waiting = waitingItems();
  if (waiting.length === 1) return reply(await answer(waiting[0].ref, text));
  if (!waiting.length) return reply('Nothing is waiting on you right now. /status shows what the team is doing.');
  return reply(`Several things are waiting on you — reply to the matching message, or use /answer <number> <text>:\n${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n')}`);
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
bus.on('limit.hit', (limit) => {
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
