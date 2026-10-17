// Talking to the CEO from anywhere (Telegram today): the founder chats, asks questions,
// gives instructions or comments, and the CEO acts on them — starts missions, passes
// follow-ups and comments to a running mission, answers or approves what is waiting,
// adds playbook rules. It is the same conversation as the CEO chat in the app.
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
    .slice(0, 10)
    .map((m) => {
      const tasks = m.taskIds.map((id) => state.tasks[id]).filter(Boolean);
      const done = tasks.filter((t) => t.status === 'done').length;
      const late = tasks.filter((t) => t.overdue && t.status !== 'done').length;
      return `- [${m.id}] ${m.title} — ${m.status}, ${done}/${tasks.length} tasks done${late ? `, ${late} overdue` : ''}, due ${m.deadline}`;
    });
  const recent = Object.values(state.missions)
    .filter((m) => m.status === 'done')
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    .slice(0, 3)
    .map((m) => `- [${m.id}] ${m.title} — finished ${m.completedAt}, report in ${m.folder}/00-mission-report.md`);
  return `Active missions:\n${active.join('\n') || '- none'}
Recently finished:\n${recent.join('\n') || '- none'}
Waiting on the founder:\n${waiting.map((w, i) => `${i + 1}. ${w.label}`).join('\n') || '- nothing'}${state.limit ? `\nThe team is PAUSED on the Claude usage limit until ${state.limit.resetAt}.` : ''}`;
}

/**
 * One turn of the founder talking to the CEO. Returns the CEO's reply (plain text for a phone),
 * after carrying out any actions it decided on.
 * focus: optional { missionId } when the founder replied to a message about a mission.
 */
export async function ceoChat(text, { via = 'telegram', focus = null } = {}) {
  const { waitingItems, answerItem } = await import('./telegram.js');
  const { createMission, sendToMission } = await import('./orchestrator.js');
  const { addRule } = await import('./playbook.js');
  const ceo = getAgent('ceo');
  const history = (state.chats.ceo ||= []);
  history.push({ role: 'user', content: text, via, at: now() });
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
  const system = `${systemPrompt(ceo)}

You are chatting with the founder on Telegram, on their phone${via === 'voice' ? ' (they sent a voice note; this is the transcript, so allow for small transcription errors)' : ''}.
Reply like a sharp chief of staff: short (under ~120 words), plain text, no tables or headings; simple "-" bullets are fine.
Reply in the language the founder wrote in.

COMPANY RIGHT NOW
${companyState(waiting)}
${focused ? `\nThe founder is replying about the mission [${focused.id}] ${focused.title}.` : ''}

YOU CAN ACT. To do something, end your message with exactly one block:
\`\`\`actions
[ ...one or more of:
  {"type": "mission", "goal": "<the work, with every detail the founder gave>", "deadline_hours": <number>},
  {"type": "followup", "mission": "<mission id from the list>", "text": "<instruction or comment for the team>"},
  {"type": "answer", "item": <number from Waiting on the founder>, "text": "<the founder's answer>"},
  {"type": "approve", "item": <number>},
  {"type": "changes", "item": <number>, "text": "<what should change>"},
  {"type": "rule", "rule": "do" | "dont", "text": "<a standing rule for all future work>"},
  {"type": "remember", "text": "<a preference or fact to remember>"}
]
\`\`\`
- New work → "mission" (you never do the work yourself). Instructions or comments about a running or
  recent mission → "followup" to that mission.
- "always … / never … / from now on …" → "rule" (and a followup too if it affects a running mission).
- A message that answers or approves something waiting → "answer" / "approve" / "changes".
- Questions and status checks → just answer; you may read the team's files. No block.
- Only use mission ids and item numbers from the lists above. If it is unclear what the founder wants, ask.`;

  let reply;
  try {
    reply = await complete({
      system,
      messages: history.slice(-16).map(({ role, content }) => ({ role, content })),
      tools: CEO_TOOLS,
      agentId: 'ceo',
      kind: 'chat',
      effort: 'medium',
      maxTurns: 20,
      demo: () => `On it — I'll put the team on this.\n\n\`\`\`actions\n${JSON.stringify([focused ? { type: 'followup', mission: focused.id, text } : { type: 'mission', goal: text, deadline_hours: 24 }])}\n\`\`\``,
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
          done.push(`▶️ Started mission “${m.title}” (due in ${hours}h).`);
        } else if (a.type === 'followup') {
          const m = state.missions[a.mission];
          if (!m || !a.text) throw new Error('unknown mission');
          if (m.status === 'cancelled') m.status = 'done';
          sendToMission(m, { text: String(a.text), mode: 'delegate' });
          done.push(`📨 Passed to the team on “${m.title}”.`);
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
  history.push({ role: 'assistant', content: full, via, at: now() });
  if (history.length > 200) history.splice(0, history.length - 200);
  save();
  bus.emit('event', { type: 'chat', agentId: 'ceo' });
  logActivity('ceo', done.length ? 'acted on your Telegram message' : 'replied to you on Telegram', { type: 'chat', agentId: 'ceo' });
  return full;
}
