// Talking to the CEO (Telegram and the CEO chat in the app, one conversation): the founder
// chats, asks questions, changes work already assigned, adds work, or starts a new product,
// and the CEO acts on it. A change to an assigned task edits that task; only a new product
// becomes a new mission. Each new mission starts the conversation context fresh.
import { getAgent, systemPrompt, remember } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, now } from './store.js';
import { bus } from './bus.js';
import { logActivity } from './activity.js';
import { limited } from './limits.js';

const CEO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

function companyState(waiting) {
  const active = Object.values(state.missions)
    .filter((m) => ['planning', 'running', 'reporting', 'awaiting_approval'].includes(m.status))
    .slice(0, 6)
    .map((m) => {
      const tasks = m.taskIds.map((id) => state.tasks[id]).filter(Boolean);
      return `- mission ${m.id}: ${m.title} — ${m.status}, due ${m.deadline}\n${tasks.map((t) => `  - task ${t.id}: ${t.title} → ${getAgent(t.agentId)?.name} [${t.status}]`).join('\n')}`;
    });
  const recent = Object.values(state.missions)
    .filter((m) => m.status === 'done')
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    .slice(0, 2)
    .map((m) => `- mission ${m.id}: ${m.title} — finished; tasks: ${m.taskIds.map((id) => state.tasks[id]).filter(Boolean).map((t) => `${t.id} ${t.title}`).join('; ')}`);
  return `Active missions (one mission = one product):\n${active.join('\n') || '- none'}
Recently finished:\n${recent.join('\n') || '- none'}
Files the founder sent in the last 24 h:\n${(state.telegram?.uploads || []).filter((u) => Date.now() - Date.parse(u.at) < 864e5).map((u) => `- ${u.path}`).join('\n') || '- none'}
Waiting on the founder:\n${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n') || '- nothing'}${state.limit ? `\nPAUSED on the usage limit until ${state.limit.resetAt}.` : ''}`;
}

/** The part of the conversation that belongs to the current mission: a new mission starts it fresh. */
function currentContext(history) {
  const from = state.ceoContextAt || '';
  return history.filter((h) => String(h.at) >= from).slice(-8);
}

/**
 * One turn of the founder talking to the CEO. Returns the CEO's reply (plain text for a phone),
 * after carrying out any actions it decided on.
 * focus: optional { missionId } when the founder replied to a message about a mission.
 */
export async function ceoChat(text, { via = 'telegram', focus = null, attachments = [] } = {}) {
  const { waitingItems, answerItem } = await import('./telegram.js');
  const { createMission, sendToMission, amendTask } = await import('./orchestrator.js');
  const { addRule } = await import('./playbook.js');
  const ceo = getAgent('ceo');
  const history = (state.chats.ceo ||= []);
  if (attachments.length) text = `${text}\n\n(Attached — saved in the workspace: ${attachments.join(', ')})`;
  const asked = { role: 'user', content: text, via, at: now() };
  history.push(asked);
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });

  if (limited()) {
    const msg = `We're paused on your Claude usage limit until ${new Date(state.limit.resetAt).toLocaleString()}, so I can't think this through right now. I've saved your message — send it again after the reset, or /resume to try now.`;
    history.push({ role: 'assistant', content: msg, via, at: now() });
    save();
    return msg;
  }

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
  {"type": "edit", "task": "<task id>", "text": "<the change, complete and specific>"},
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
- Only use ids and item numbers from the lists above. If unclear which task or product, ask in one line.`;

  let reply;
  try {
    reply = await complete({
      system,
      messages: currentContext(history).map(({ role, content }) => ({ role, content })),
      tools: CEO_TOOLS,
      agentId: 'ceo',
      kind: 'chat',
      effort: 'medium',
      maxTurns: 10,
      demo: () => `On it.\n\n\`\`\`actions\n${JSON.stringify([demoAction(text, focused)])}\n\`\`\``,
    });
  } catch (e) {
    const msg = `⚠️ I couldn't reply: ${e.message}`;
    history.push({ role: 'assistant', content: msg, via, at: now() });
    save();
    return msg;
  }

  // Carry out the actions.
  const block = reply.match(/```actions\s*([\s\S]*?)```/);
  const done = [];
  let missionId = null;
  if (block) {
    let actions = [];
    try {
      let parsed;
      try {
        parsed = JSON.parse(block[1].trim());
      } catch {
        parsed = extractJson(block[1]);
      }
      actions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      done.push("⚠️ I couldn't read my own action list — nothing was started. Say it again?");
    }
    for (const a of actions.slice(0, 6)) {
      try {
        if (a.type === 'mission' && a.goal) {
          const hours = Math.min(24 * 60, Math.max(1, Number(a.deadline_hours) || 24));
          const m = createMission({ goal: String(a.goal).trim(), deadline: new Date(Date.now() + hours * 36e5).toISOString(), source: 'chat' });
          state.ceoContextAt = asked.at; // a new product: the conversation starts fresh from here
          done.push(`▶️ New mission “${m.title}” (due in ${hours}h).`);
          missionId = m.id;
        } else if (a.type === 'edit') {
          const t = state.tasks[a.task];
          if (!t || !a.text) throw new Error('unknown task');
          amendTask(t, String(a.text));
          done.push(`✏️ Updated “${t.title}”.`);
        } else if (a.type === 'add' || a.type === 'followup') {
          const m = state.missions[a.mission];
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
  const clean = reply.replace(/```actions[\s\S]*?```/, '').trim();
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
