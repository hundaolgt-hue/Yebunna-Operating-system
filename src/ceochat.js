// Talking to the CEO (Telegram and the CEO chat in the app, one conversation): the founder
// chats, asks questions, changes work already assigned, adds work, or starts a new product,
// and the CEO acts on it. A change to an assigned task edits that task; only a new product
// becomes a new mission. Guards make sure a slip by the model never starts a duplicate mission.
import { getAgent, systemPrompt, remember } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, now } from './store.js';
import { bus } from './bus.js';
import { logActivity } from './activity.js';
import { limited, isLimitError } from './limits.js';
import { resolveTask, missionFor, isRoutine } from './matching.js';

const CEO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

const LIVE = ['planning', 'running', 'reporting', 'awaiting_approval', 'failed'];
const clip = (x, n) => (String(x).length > n ? `${String(x).slice(0, n)}…` : String(x));

function companyState(waiting) {
  const missions = Object.values(state.missions)
    .filter((m) => LIVE.includes(m.status) || (m.status === 'done' && Date.now() - Date.parse(m.completedAt || 0) < 14 * 864e5))
    .sort((a, b) => isRoutine(a) - isRoutine(b) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8)
    .map((m) => {
      const tasks = m.taskIds.map((id) => state.tasks[id]).filter(Boolean);
      const said = m.thread.filter((i) => i.role === 'user').slice(-3).map((i) => clip(i.text, 120));
      return `- mission ${m.id} — product: ${m.product || m.title} [${m.status}]
  goal: ${clip(m.goal, 200)}${said.length > 1 ? `\n  founder's latest instructions: ${said.slice(1).join(' | ')}` : ''}
${tasks.map((t, i) => `  - T${i + 1} (task ${t.id}): ${t.title} → ${getAgent(t.agentId)?.name} [${t.status}]`).join('\n')}`;
    });
  return `Missions (one mission = one product; newest first):\n${missions.join('\n') || '- none'}
Files the founder sent in the last 24 h:\n${(state.telegram?.uploads || []).filter((u) => Date.now() - Date.parse(u.at) < 864e5).map((u) => `- ${u.path}`).join('\n') || '- none'}
Waiting on the founder:\n${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n') || '- nothing'}${state.limit ? `\nPAUSED on the usage limit until ${state.limit.resetAt}.` : ''}`;
}

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

/** The conversation the CEO sees: the last messages, whatever missions were started in between. */
const recentContext = (history) => history.slice(-10);

/**
 * One turn of the founder talking to the CEO. Returns the CEO's reply (plain text for a phone),
 * after carrying out any actions it decided on.
 * focus: optional { missionId } when the founder replied to a message about a mission.
 */
let turns = Promise.resolve();
/** One message at a time (app and Telegram share the conversation): each sees the previous reply. */
export function ceoChat(text, opts = {}) {
  const run = turns.catch(() => {}).then(() => ceoTurn(text, opts));
  turns = run;
  return run;
}

async function ceoTurn(text, { via = 'telegram', focus = null, attachments = [], replay = false } = {}) {
  const { waitingItems, answerItem } = await import('./telegram.js');
  const { createMission, sendToMission, amendTask } = await import('./orchestrator.js');
  const { addRule } = await import('./playbook.js');
  const ceo = getAgent('ceo');
  const history = (state.chats.ceo ||= []);
  if (attachments.length) text = `${text}\n\n(Attached — saved in the workspace: ${attachments.join(', ')})`;
  if (!replay) history.push({ role: 'user', content: text, via, at: now() });
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });

  // Paused on the usage limit: keep the message and act on it as soon as the limit resets.
  const later = () => {
    (state.ceoPending ||= []).push({ text, via, focus });
    const msg = `⏸ We're paused on your Claude usage limit${state.limit?.resetAt ? ` until ${new Date(state.limit.resetAt).toLocaleString()}` : ''}. I've kept your message and will act on it as soon as the limit resets (/resume to try now).`;
    history.push({ role: 'assistant', content: msg, via, at: now() });
    save();
    return msg;
  };
  if (limited()) return later();

  const waiting = waitingItems();
  const focused = focus?.missionId && state.missions[focus.missionId];
  const where = via === 'app' ? 'in the app' : `on Telegram, on their phone${via === 'voice' ? ' (a voice note transcript: allow for small transcription errors)' : ''}`;
  const system = `${systemPrompt(ceo)}

You are chatting with the founder ${where}. Reply in at most ~60 words, plain text, "-" bullets at most.
Never repeat what the founder said or what you already told them. Reply in the founder's language.

COMPANY RIGHT NOW
${companyState(waiting)}
${focused ? `\nThe founder is replying about mission ${focused.id} (${focused.title}).` : ''}

CLASSIFY THE MESSAGE FIRST, then act. To act, end your reply with exactly one block:
\`\`\`actions
[ ...one or more of:
  {"type": "edit", "mission": "<mission id>", "task": "<task id from the list>", "text": "<the change, complete and specific>"},
  {"type": "add", "mission": "<mission id>", "text": "<new work for that product, with every detail>"},
  {"type": "mission", "goal": "<a NEW product: the work, with every detail the founder gave>", "deadline_hours": <number>},
  {"type": "answer", "item": <number from Waiting on the founder>, "text": "<the founder's answer>"},
  {"type": "approve", "item": <number>},
  {"type": "changes", "item": <number>, "text": "<what should change>"},
  {"type": "rule", "rule": "do" | "dont", "text": "<a standing rule for all future work>"},
  {"type": "remember", "text": "<a standing fact or preference>"}
]
\`\`\`
- Change, correction, more detail or a comment on work already assigned (running, queued or done) → "edit"
  that task. This is the default whenever an existing task covers it. NEVER start a mission or add a task for it.
- Work for the same product that no task covers → "add" to that product's mission.
- A different product → "mission" (you never do the work yourself). Name the exact paths of files the
  founder sent for it and how to use them.
- "always … / never … / from now on …" → "rule".
- Answers or approvals of something waiting → "answer" / "approve" / "changes".
- Questions and status → just answer (you may read the team's files). No block.
- If the message names or concerns a product in the list, it is NEVER a new mission: "edit" or "add".
- Use the task id (or T-number) and mission id from the list. If unclear which task or product, ask in one line.`;

  let reply;
  try {
    reply = await complete({
      system,
      messages: recentContext(history).map(({ role, content }) => ({ role, content })),
      tools: CEO_TOOLS,
      agentId: 'ceo',
      kind: 'chat',
      effort: 'medium',
      maxTurns: 10,
      demo: () => `On it.\n\n\`\`\`actions\n${JSON.stringify([demoAction(text, focused)])}\n\`\`\``,
    });
  } catch (e) {
    if (isLimitError(e)) return later();
    const msg = `⚠️ I couldn't reply: ${e.message}`;
    history.push({ role: 'assistant', content: msg, via, at: now() });
    save();
    return msg;
  }

  // Carry out the actions.
  const blocks = [...reply.matchAll(/```actions[^\n]*\n?([\s\S]*?)```/g)];
  const done = [];
  let missionId = null;
  if (blocks.length) {
    let actions = [];
    for (const block of blocks) {
      try {
        actions.push(...parseActions(block[1]));
      } catch {
        done.push("⚠️ I couldn't read my own action list — nothing was started from it. Say it again?");
      }
    }
    for (const a of actions.filter((x) => x && typeof x === 'object').slice(0, 8)) {
      try {
        // Guard: work about a product that already has a mission goes to that mission.
        const existing = a.type === 'mission' && a.goal && !/\b(new|another|next|different)\s+(product|template|idea)\b/i.test(text) && (focused || missionFor(`${a.goal} ${text}`));
        if (existing) {
          a.type = 'add';
          a.mission = existing.id;
          a.text = String(a.goal);
        }
        if (a.type === 'mission' && a.goal) {
          const hours = Math.min(24 * 60, Math.max(1, Number(a.deadline_hours) || 24));
          const m = createMission({ goal: String(a.goal).trim(), deadline: new Date(Date.now() + hours * 36e5).toISOString(), source: 'chat' });
          done.push(`▶️ New mission “${m.title}” (due in ${hours}h).`);
          missionId = m.id;
        } else if (a.type === 'edit') {
          const mission = state.missions[a.mission] || focused || null;
          const t = resolveTask(a.task, mission) || resolveTask(a.task);
          if (!a.text) throw new Error('no change given');
          if (t) {
            amendTask(t, String(a.text));
            done.push(`✏️ Updated “${t.title}”.`);
          } else {
            // The task wasn't found: let the mission's planner place the change (it edits, never duplicates).
            const m = mission || missionFor(`${a.text} ${text}`);
            if (!m) throw new Error("I couldn't tell which task that changes. Which one?");
            sendToMission(m, { text: String(a.text), mode: 'delegate' });
            done.push(`📨 Passed to “${m.title}”.`);
          }
        } else if (a.type === 'add' || a.type === 'followup') {
          const m = state.missions[a.mission] || focused || missionFor(`${a.text} ${text}`);
          if (!m || !a.text) throw new Error('unknown mission');
          if (m.status === 'cancelled') m.status = 'done';
          sendToMission(m, { text: String(a.text), mode: 'delegate' });
          done.push(`📨 Added to “${m.title}”.`);
        } else if (['answer', 'approve', 'changes'].includes(a.type)) {
          const item = waiting[Number(a.item) - 1];
          if (!item) throw new Error('no such waiting item');
          const answerText = a.type === 'approve' ? 'approve' : String(a.text || '');
          done.push(await answerItem(item.ref, a.type === 'changes' && !answerText ? 'Please revise.' : answerText));
        } else if (a.type === 'rule' && a.text) {
          const r = addRule({ type: a.rule === 'dont' ? 'dont' : 'do', text: a.text, why: 'Founder, via Telegram', source: 'founder' });
          done.push(r ? `📌 New team rule: ${r.type === 'do' ? 'DO' : "DON'T"} ${r.text}` : '📌 That rule is already in the playbook.');
        } else if (a.type === 'remember' && a.text) {
          remember('ceo', String(a.text), 'telegram');
          done.push('🧠 Noted.');
        }
      } catch (e) {
        done.push(`⚠️ Couldn't do “${a.type}”: ${e.message}`);
      }
    }
  }
  const clean = reply.replace(/```actions[\s\S]*?```/g, '').trim();
  const full = [clean, ...done].filter(Boolean).join('\n\n') || 'OK.';
  history.push({ role: 'assistant', content: full, via, at: now(), ...(missionId ? { missionId } : {}) });
  if (history.length > 200) history.splice(0, history.length - 200);
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });
  logActivity('ceo', done.length ? 'acted on your message' : 'replied to you', { type: 'chat', agentId: 'ceo' });
  return full;
}

/** Demo mode: a running task the message names (by title word) is edited; otherwise like a real CEO's default. */
function demoAction(text, focused) {
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const open = Object.values(state.tasks).filter((t) => !['failed'].includes(t.status) && ['running', 'planning', 'awaiting_approval', 'done'].includes(state.missions[t.missionId]?.status));
  const hit = /^(change|edit|update|make it|fix|instead)\b/i.test(text) && open.find((t) => words.some((w) => t.title.toLowerCase().includes(w)));
  if (hit) return { type: 'edit', task: hit.id, text };
  if (focused) return { type: 'add', mission: focused.id, text };
  return { type: 'mission', goal: text, deadline_hours: 24 };
}
