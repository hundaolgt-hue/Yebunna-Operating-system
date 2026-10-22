// Talking to the CEO (Telegram and the CEO chat in the app: one conversation). The founder asks,
// changes work, adds work, stops work, or starts a new product, and the CEO acts on it.
//
// What keeps the conversation on track:
// - FOCUS: the CEO always knows which mission and task the founder is working on right now,
//   and reads an ambiguous message against that, not against every task in the company.
// - ONE MESSAGE = ONE ACTION: a message does one thing (unless the founder listed several), so
//   a stray idea never sets off a chain of tasks. Finished work is only redone when the founder
//   names it.
// - STOP / UNDO: "stop", "no, I didn't ask for that", "undo" stop the work or put it back as it
//   was. Every action is logged so it can be undone.
// - LEARNING: a correction becomes a standing "don't" rule for the CEO, so the same mistake is
//   not made again. Rules the founder sets ("from now on…") are kept too.
// - SHORT MEMORY: long conversations are compacted into a short summary plus the last few
//   messages; "Fresh start" archives the whole conversation (rules and facts stay).
import { getAgent, systemPrompt, remember } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, now } from './store.js';
import { bus } from './bus.js';
import { logActivity } from './activity.js';
import { limited, isLimitError, onApi, pauseReason } from './limits.js';
import { resolveTask, missionFor, isRoutine, overlap, listsSeveral } from './matching.js';

const CEO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const LIVE = ['planning', 'running', 'reporting', 'awaiting_approval', 'failed'];
const KEEP_RECENT = 8; // messages the CEO sees in full
const COMPACT_AT = 20; // older messages are summarised once the conversation is this long
const UNDO_WINDOW_MS = 3 * 3600_000; // "no, undo that" reaches back this far
const clip = (x, n) => (String(x).length > n ? `${String(x).slice(0, n)}…` : String(x));
const tasksOf = (m) => m.taskIds.map((id) => state.tasks[id]).filter(Boolean);

// ---- focus: what the founder is working on right now --------------------------------

const focus = () => state.ceoFocus || null;
function setFocus(missionId, taskId = null) {
  if (!missionId || !state.missions[missionId]) return;
  state.ceoFocus = { missionId, taskId: taskId && state.tasks[taskId] ? taskId : null, at: now() };
}
const focusMission = () => (focus()?.missionId && state.missions[focus().missionId]) || null;
const focusTask = () => (focus()?.taskId && state.tasks[focus().taskId]) || null;

// ---- what the CEO sees ------------------------------------------------------------

function missionLine(m, full) {
  const tasks = tasksOf(m);
  const head = `- mission ${m.id} — product: ${m.product || m.title} [${m.status}]`;
  if (!full) return `${head}: ${tasks.filter((t) => t.status === 'done').length}/${tasks.length} tasks done`;
  const said = m.thread.filter((i) => i.role === 'user').slice(-3).map((i) => clip(i.text, 120));
  return `${head}
  goal: ${clip(m.goal, 240)}${said.length > 1 ? `\n  founder's latest instructions: ${said.slice(1).join(' | ')}` : ''}
${tasks.map((t, i) => `  - T${i + 1} (task ${t.id}): ${t.title} → ${getAgent(t.agentId)?.name} [${t.status}]${t.file ? ` · ${t.file}` : ''}`).join('\n') || '  (no tasks yet)'}`;
}

function companyState(waiting, current) {
  const missions = Object.values(state.missions)
    .filter((m) => LIVE.includes(m.status) || (m.status === 'done' && Date.now() - Date.parse(m.completedAt || 0) < 14 * 864e5))
    .sort((a, b) => isRoutine(a) - isRoutine(b) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8);
  const t = focusTask();
  return `${
    current
      ? `CURRENT FOCUS (what you and the founder are working on; read the message against this first):
${missionLine(current, true)}${t ? `\n  Last task discussed: T${tasksOf(current).indexOf(t) + 1} (task ${t.id}) “${t.title}” [${t.status}]` : ''}\n`
      : 'CURRENT FOCUS: none yet.\n'
  }
Other missions (one mission = one product):
${missions.filter((m) => m !== current).map((m) => missionLine(m, false)).join('\n') || '- none'}
Files the founder sent in the last 24 h:
${(state.telegram?.uploads || []).filter((u) => Date.now() - Date.parse(u.at) < 864e5).map((u) => `- ${u.path}`).join('\n') || '- none'}
Waiting on the founder:
${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n') || '- nothing'}
Your last actions (what "undo" would revert):
${(state.ceoActions || []).slice(-3).map((a) => `- ${a.at.slice(11, 16)} ${a.label}`).join('\n') || '- none'}`;
}

// ---- conversation memory --------------------------------------------------------

const NOTICE = /^\W*(we're paused on your claude usage limit|paused|i couldn't reply|⚠️ i couldn't reply)/i;
const isNotice = (h) => h.notice || (h.role === 'assistant' && NOTICE.test(h.content || ''));

/** The conversation the CEO reads: a summary of everything older, then the last few messages in full. */
function context(history) {
  const real = history.filter((h) => !isNotice(h));
  const recent = real.slice(-KEEP_RECENT);
  const summary = state.ceoSummary?.text;
  const msgs = recent.map(({ role, content }) => ({ role, content }));
  if (summary && msgs.length) msgs[0] = { ...msgs[0], content: `(Earlier in this conversation, in short: ${summary})\n\n${msgs[0].content}` };
  return msgs;
}

/** Compact older messages into a short summary (one small run), so a long chat never drowns the current task. */
async function compact(history) {
  const real = history.filter((h) => !isNotice(h));
  if (real.length < COMPACT_AT) return;
  const older = real.slice(0, -KEEP_RECENT);
  const last = older.at(-1);
  const upTo = last?.at;
  if (!last || state.ceoSummary?.upTo === upTo) return;
  const text = await complete({
    system: 'You keep a short running summary of a founder\'s conversation with their AI chief of staff. Reply with the summary only.',
    messages: [
      {
        role: 'user',
        content: `Previous summary: ${state.ceoSummary?.text || '(none)'}\n\nNew messages:\n${older.slice(-30).map((h) => `${h.role === 'user' ? 'Founder' : 'CEO'}: ${clip(h.content, 500)}`).join('\n')}\n\nWrite the updated summary in at most 120 words: the products discussed, what was decided, what the founder wants and dislikes, what is still open. Drop anything resolved or superseded. No greetings.`,
      },
    ],
    model: 'haiku',
    effort: 'low',
    maxTurns: 1,
    kind: 'memory',
    agentId: 'ceo',
    demo: () => 'The founder is working on their product; earlier requests were handled.',
  });
  state.ceoSummary = { text: text.trim().slice(0, 1200), upTo };
  // Only what came after the summarised part stays in the stored history.
  const cut = history.indexOf(last);
  const keep = history.filter((h, i) => i > cut);
  history.splice(0, history.length, ...keep);
  save();
}

/** Start the conversation over: the old one is archived; rules, facts and missions stay. */
export function freshStart() {
  const history = state.chats.ceo || [];
  if (history.length) {
    (state.ceoArchive ||= []).push({ at: now(), messages: history.slice(-200), summary: state.ceoSummary?.text || '' });
    state.ceoArchive = state.ceoArchive.slice(-3);
  }
  state.chats.ceo = [{ role: 'assistant', content: '🧹 Fresh start. I kept the playbook rules, your standing facts and all missions; the old conversation is archived.', at: now(), notice: true }];
  state.ceoSummary = null;
  state.ceoFocus = null;
  state.ceoActions = [];
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });
}

// ---- actions log (for undo) --------------------------------------------------------

function logAction(entry) {
  (state.ceoActions ||= []).push({ at: now(), ...entry });
  state.ceoActions = state.ceoActions.slice(-20);
}

/** Revert the last thing the CEO did (within a few hours). Returns what was undone, or null. */
async function undoLast() {
  const { cancelMission, undoAmend, undoSince, stopTask } = await import('./orchestrator.js');
  const log = state.ceoActions || [];
  const a = log.at(-1);
  if (!a || Date.now() - Date.parse(a.at) > UNDO_WINDOW_MS) return null;
  log.pop();
  const m = state.missions[a.missionId];
  if (a.type === 'mission' && m) {
    if (['planning', 'running', 'awaiting_approval', 'reporting'].includes(m.status)) cancelMission(m);
    return `cancelled the mission “${m.title}”`;
  }
  if (a.type === 'edit' && state.tasks[a.taskId]) {
    const t = state.tasks[a.taskId];
    return undoAmend(t) ? `put “${t.title}” back as it was` : stopTask(t, 'Undone by the founder') ? `stopped “${t.title}”` : null;
  }
  if (a.type === 'add' && m) {
    const n = undoSince(m, a.at);
    return `removed ${n} change${n === 1 ? '' : 's'} from “${m.title}”`;
  }
  return null;
}

/** "no", "stop", "wrong", "I didn't ask for that", "undo": the founder is correcting the CEO. */
const CORRECTION = /^\W*(no\b(?!\s+(problem|worries|need))|stop\b|wrong|undo|cancel that|not that|that'?s not what|i did ?n[o']?t ask|i never asked|who asked|why did you|revert)/i;
const STOP_ALL = /^\W*(stop( everything| all| it all)?|halt|pause everything)\W*$/i;

/** A list of actions, even when the JSON has small mistakes (a trailing comma, one object). */
function parseActions(src) {
  const body = String(src).trim();
  const tries = [body, body.replace(/,\s*([\]}])/g, '$1')];
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a >= 0 && b > a) tries.push(body.slice(a, b + 1), body.slice(a, b + 1).replace(/,\s*([\]}])/g, '$1'));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : [v];
    } catch {}
  }
  return [extractJson(body)];
}

/** Messages that arrived while the usage limit was hit are acted on once it resets. */
bus.on('limit.reset', async () => {
  const pending = (state.ceoPending || []).splice(0);
  for (const p of pending) {
    try {
      const reply = await ceoChat(p.text, { via: p.via, focus: p.focus, replay: true });
      if (p.via !== 'app') {
        const { notifyFounder } = await import('./telegram.js');
        notifyFounder(`(About your message “${String(p.text).slice(0, 60)}”)\n${reply}`);
      }
    } catch {}
  }
});

// ---- one turn ------------------------------------------------------------------------

let turns = Promise.resolve();
/** One message at a time (app and Telegram share the conversation): each sees the previous reply. */
export function ceoChat(text, opts = {}) {
  const run = turns.catch(() => {}).then(() => ceoTurn(text, opts));
  turns = run;
  return run;
}

async function ceoTurn(text, { via = 'telegram', focus: replyFocus = null, attachments = [], replay = false } = {}) {
  const { waitingItems, answerItem } = await import('./telegram.js');
  const { createMission, sendToMission, amendTask, stopTask, cancelMission } = await import('./orchestrator.js');
  const { addRule } = await import('./playbook.js');
  const ceo = getAgent('ceo');
  const history = (state.chats.ceo ||= []);
  if (attachments.length) text = `${text}\n\n(Attached — saved in the workspace: ${attachments.join(', ')})`;
  if (!replay) history.push({ role: 'user', content: text, via, at: now() });
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });

  // Paused: keep the message and act on it as soon as work resumes.
  const later = () => {
    (state.ceoPending ||= []).push({ text, via, focus: replyFocus });
    const msg = `⏸ ${pauseReason() || 'Paused.'} I've kept your message and will act on it as soon as work resumes (/resume to try now).`;
    history.push({ role: 'assistant', content: msg, via, at: now(), notice: true });
    save();
    return msg;
  };
  if (limited()) return later();

  // A reply to a message about a mission moves the focus there.
  if (replyFocus?.missionId && state.missions[replyFocus.missionId]) setFocus(replyFocus.missionId, focus()?.missionId === replyFocus.missionId ? focus().taskId : null);
  const current = focusMission();
  const done = [];

  // "Stop everything" needs no thinking.
  if (STOP_ALL.test(text)) {
    let n = 0;
    for (const t of Object.values(state.tasks)) if (['queued', 'in_progress', 'review', 'blocked'].includes(t.status) && stopTask(t)) n++;
    const msg = `⏹ Stopped ${n} task${n === 1 ? '' : 's'}. Nothing runs until you say so.`;
    return finish(history, msg, via, [], null);
  }

  const waiting = waitingItems();
  const where = via === 'app' ? 'in the app' : `on Telegram, on their phone${via === 'voice' ? ' (a voice note transcript: allow for small transcription errors)' : ''}`;
  const correcting = CORRECTION.test(text);
  const system = `${systemPrompt(ceo)}

You are chatting with the founder ${where}. Reply in at most ~60 words, plain text, "-" bullets at most.
Never repeat what the founder said or what you already told them. Reply in the founder's language.

${companyState(waiting, current)}

HOW TO ACT. First decide what the ONE thing the founder wants is, then end your reply with exactly one block:
\`\`\`actions
[ ...one or more of:
  {"type": "edit", "mission": "<mission id>", "task": "<task id from the list>", "text": "<the change, complete and specific>"},
  {"type": "add", "mission": "<mission id>", "text": "<new work for that product, with every detail>"},
  {"type": "mission", "goal": "<a NEW product: the work, with every detail the founder gave>", "deadline_hours": <number>},
  {"type": "stop", "task": "<task id>"},
  {"type": "undo"},
  {"type": "answer", "item": <number from Waiting on the founder>, "text": "<the founder's answer>"},
  {"type": "approve", "item": <number>},
  {"type": "changes", "item": <number>, "text": "<what should change>"},
  {"type": "rule", "rule": "do" | "dont", "text": "<a standing rule>"},
  {"type": "remember", "text": "<a standing fact or preference>"}
]
\`\`\`
RULES
- ONE message = ONE action on the work (edit, add, mission or stop), unless the founder listed several things.
- A change, correction, detail or comment about existing work → "edit" THAT task. Prefer the task in the
  current focus, or the task whose title/file the founder names. Never edit or restart a finished task the
  founder did not name.
- New work for the current product that no task covers → "add" to its mission. Only a different product
  → "mission". If the message names a product in the lists, it is never a new mission.
- "stop", "cancel that", "no", "wrong", "I didn't ask for that", "undo" → "undo" (reverts your last action)
  or "stop" (a running task), and NOTHING else. Then add a "rule" of type "dont" (one line, concrete) so
  you don't repeat the mistake, and apologise in five words or fewer.
- "always … / never … / from now on …" → "rule". Answers and approvals → "answer" / "approve" / "changes".
- Questions and status → just answer (you may read the team's files). No block.
- When you can't tell which task or product, ask in one line instead of guessing.${correcting ? '\n\nThe founder is CORRECTING you: undo or stop, add a dont-rule, nothing else.' : ''}`;

  let reply;
  try {
    reply = await complete({
      system,
      messages: context(history),
      tools: CEO_TOOLS,
      agentId: 'ceo',
      kind: 'chat',
      effort: 'medium',
      maxTurns: 10,
      demo: () => `On it.\n\n\`\`\`actions\n${JSON.stringify(demoActions(text, current, correcting, Boolean(replyFocus)))}\n\`\`\``,
    });
  } catch (e) {
    if (isLimitError(e) && onApi() && !replay) return ceoTurn(text, { via, focus: replyFocus, attachments: [], replay: true });
    if (isLimitError(e)) return later();
    const msg = `⚠️ I couldn't reply: ${e.message}`;
    history.push({ role: 'assistant', content: msg, via, at: now(), notice: true });
    save();
    return msg;
  }

  // ---- carry out the actions ----
  let actions = [];
  for (const block of reply.matchAll(/```actions[^\n]*\n?([\s\S]*?)```/g)) {
    try {
      actions.push(...parseActions(block[1]));
    } catch {
      done.push("⚠️ I couldn't read my own action list — nothing was started from it. Say it again?");
    }
  }
  actions = actions.filter((x) => x && typeof x === 'object');
  // A correction is an undo/stop, whatever the model wrote.
  if (correcting && !actions.some((a) => ['undo', 'stop'].includes(a.type))) actions.unshift({ type: 'undo' });
  if (correcting) actions = actions.filter((a) => ['undo', 'stop', 'rule', 'remember'].includes(a.type));
  // One message = one action on the work.
  const allowed = listsSeveral(text) ? 3 : 1;
  let workDone = 0;
  let missionId = null;
  for (const a of actions.slice(0, 8)) {
    try {
      if (['edit', 'add', 'mission', 'stop'].includes(a.type)) {
        if (workDone >= allowed) {
          done.push(`(Not done: “${clip(a.text || a.goal || a.type, 60)}” — one thing per message; send it separately if you want it.)`);
          continue;
        }
        workDone++;
      }
      // Work about a product that already has a mission goes to that mission.
      // (a reply about a mission, or a message that names a product, is never a new mission)
      const existing = a.type === 'mission' && a.goal && !/\b(new|another|next|different)\s+(product|template|idea)\b/i.test(text) && ((replyFocus && current) || missionFor(`${a.goal} ${text}`));
      if (existing) Object.assign(a, { type: 'add', mission: existing.id, text: String(a.goal) });

      if (a.type === 'mission' && a.goal) {
        const hours = Math.min(24 * 60, Math.max(1, Number(a.deadline_hours) || 24));
        const m = createMission({ goal: String(a.goal).trim(), deadline: new Date(Date.now() + hours * 36e5).toISOString(), source: 'chat' });
        logAction({ type: 'mission', missionId: m.id, label: `started mission “${m.title}”` });
        setFocus(m.id);
        missionId = m.id;
        done.push(`▶️ New mission “${m.title}” (due in ${hours}h).`);
      } else if (a.type === 'edit') {
        const mission = state.missions[a.mission] || current || null;
        if (!a.text) throw new Error('no change given');
        let t = resolveTask(a.task, mission) || resolveTask(a.task);
        // Sanity: a finished task the founder didn't name is not redone on a guess.
        // Named = the message shares the task's distinctive words (its title/deliverable), its file name, or its id.
        const named = (x) => overlap(`${x.title} ${x.deliverable || ''}`, text) >= 0.34 || (x.file && text.toLowerCase().includes(x.file.split('/').pop().toLowerCase())) || text.includes(x.id);
        if (t && ['done', 'approval'].includes(t.status) && !named(t) && t !== focusTask()) {
          const better = (mission ? tasksOf(mission) : Object.values(state.tasks)).filter(named).sort((x, y) => (y.status === 'done') - (x.status === 'done'))[0];
          if (better) t = better;
          else if (t.status === 'done' && mission && tasksOf(mission).some((x) => x !== t && !['done', 'failed'].includes(x.status))) t = tasksOf(mission).find((x) => !['done', 'failed'].includes(x.status));
          else throw new Error(`I think you mean “${t.title}” (T${tasksOf(state.missions[t.missionId]).indexOf(t) + 1}), but I'm not sure — say "yes, T${tasksOf(state.missions[t.missionId]).indexOf(t) + 1}" to redo it with this change.`);
        }
        if (t) {
          amendTask(t, String(a.text));
          logAction({ type: 'edit', missionId: t.missionId, taskId: t.id, label: `changed “${t.title}”` });
          setFocus(t.missionId, t.id);
          done.push(`✏️ Updated “${t.title}”.`);
        } else {
          const m = mission || missionFor(`${a.text} ${text}`);
          if (!m) throw new Error("I couldn't tell which task that changes. Which one?");
          sendToMission(m, { text: String(a.text), mode: 'delegate' });
          logAction({ type: 'add', missionId: m.id, label: `passed a change to “${m.title}”` });
          setFocus(m.id);
          done.push(`📨 Passed to “${m.title}”.`);
        }
      } else if (a.type === 'add' || a.type === 'followup') {
        const m = state.missions[a.mission] || current || missionFor(`${a.text} ${text}`);
        if (!m || !a.text) throw new Error('unknown mission');
        if (m.status === 'cancelled') m.status = 'done';
        sendToMission(m, { text: String(a.text), mode: 'delegate' });
        logAction({ type: 'add', missionId: m.id, label: `added work to “${m.title}”` });
        setFocus(m.id);
        done.push(`📨 Added to “${m.title}”.`);
      } else if (a.type === 'stop') {
        const t = resolveTask(a.task, current) || resolveTask(a.task) || focusTask() || (current && tasksOf(current).find((x) => ['in_progress', 'review', 'queued', 'blocked'].includes(x.status)));
        if (!t) throw new Error('nothing to stop');
        if (!stopTask(t)) throw new Error(`“${t.title}” is not running`);
        done.push(`⏹ Stopped “${t.title}”.`);
      } else if (a.type === 'undo') {
        const what = await undoLast();
        done.push(what ? `↩️ Undone: ${what}.` : "↩️ There's nothing recent to undo.");
      } else if (['answer', 'approve', 'changes'].includes(a.type)) {
        const item = waiting[Number(a.item) - 1];
        if (!item) throw new Error('no such waiting item');
        const answerText = a.type === 'approve' ? 'approve' : String(a.text || '');
        done.push(await answerItem(item.ref, a.type === 'changes' && !answerText ? 'Please revise.' : answerText));
      } else if (a.type === 'rule' && a.text) {
        const r = addRule({ type: a.rule === 'dont' ? 'dont' : 'do', text: a.text, why: correcting ? `Founder correction: “${clip(text, 120)}”` : 'Founder', source: correcting ? 'correction' : 'founder' });
        done.push(r ? `📌 ${correcting ? 'Lesson kept' : 'New team rule'}: ${r.type === 'do' ? 'DO' : "DON'T"} ${r.text}` : '📌 Already in the playbook.');
      } else if (a.type === 'remember' && a.text) {
        remember('ceo', String(a.text), 'telegram');
        done.push('🧠 Noted.');
      }
    } catch (e) {
      done.push(`⚠️ Couldn't do “${a.type}”: ${e.message}`);
    }
  }
  // A plain mention of a product in the list moves the focus there, even without an action.
  if (!workDone) {
    const mentioned = missionFor(text);
    if (mentioned && mentioned !== current) setFocus(mentioned.id);
  }
  const clean = reply.replace(/```actions[\s\S]*?```/g, '').trim();
  const result = finish(history, [clean, ...done].filter(Boolean).join('\n\n') || 'OK.', via, done, missionId);
  compact(history).catch(() => {});
  return result;
}

function finish(history, full, via, done, missionId) {
  history.push({ role: 'assistant', content: full, via, at: now(), ...(missionId ? { missionId } : {}) });
  if (history.length > 200) history.splice(0, history.length - 200);
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });
  logActivity('ceo', done.length ? 'acted on your message' : 'replied to you', { type: 'chat', agentId: 'ceo' });
  return full;
}

/**
 * Demo mode stands in for the CEO's judgement: a correction undoes; a named task is edited; a reply
 * about a mission, or a message that names the current product, adds to it; "new product" or work
 * that names no known product starts a mission.
 */
function demoActions(text, current, correcting, replied) {
  if (correcting) return [{ type: 'undo' }, { type: 'rule', rule: 'dont', text: 'Start work the founder did not ask for.' }];
  if (/^\W*stop\b/i.test(text)) return [{ type: 'stop' }];
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const pool = current ? tasksOf(current) : Object.values(state.tasks).filter((t) => ['running', 'planning', 'awaiting_approval', 'done'].includes(state.missions[t.missionId]?.status));
  const hit = /^(change|edit|update|make it|fix|instead|redo)\b/i.test(text) && pool.find((t) => t.status !== 'failed' && words.some((w) => t.title.toLowerCase().includes(w)));
  if (hit) return [{ type: 'edit', task: hit.id, text }];
  if (/\b(new|another|next|different)\s+(product|template|idea)\b/i.test(text)) return [{ type: 'mission', goal: text, deadline_hours: 24 }];
  if (current && (replied || missionFor(text) === current || /^\W*(also|and|plus|add)\b/i.test(text))) return [{ type: 'add', mission: current.id, text }];
  return [{ type: 'mission', goal: text, deadline_hours: 24 }];
}
