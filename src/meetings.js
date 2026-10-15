// Team meetings (Grok Bot's group chats of 2–6 bots): the CEO moderates, each
// participant speaks in turn and reacts to the others, the founder can jump in,
// and the meeting ends with minutes, decisions and action items that can be
// launched as a mission with deadlines. Standups are meetings where each bot
// reports on its own work.
import { getAgent, systemPrompt } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now } from './store.js';
import { bus, createMissionWithTasks } from './orchestrator.js';
import { logActivity } from './activity.js';
import { demoMeetingTurn, demoMinutes } from './demo.js';

const emit = (mt) => {
  save();
  bus.emit('event', { type: 'meeting', meeting: mt });
};

export function startMeeting({ title, agenda, participants, rounds = 2, kind = 'meeting', deadlineHours = 24, autoLaunch = false, source = 'founder' }) {
  const people = [...new Set(['ceo', ...participants])].filter((id) => getAgent(id)).slice(0, 7);
  if (people.length < 2) throw new Error('A meeting needs at least one bot besides the CEO.');
  const mt = {
    id: newId('mtg'),
    kind,
    title: title || (kind === 'standup' ? `Standup · ${new Date().toLocaleDateString()}` : 'Team meeting'),
    agenda: agenda || 'Each bot: what you finished, what you are doing next, and any blockers.',
    participants: people,
    rounds: Math.min(3, Math.max(1, Number(rounds) || 1)),
    deadlineHours: Number(deadlineHours) || 24,
    autoLaunch: Boolean(autoLaunch),
    status: 'live',
    transcript: [],
    minutes: '',
    decisions: [],
    actionItems: [],
    missionId: null,
    createdAt: now(),
    source,
  };
  state.meetings[mt.id] = mt;
  emit(mt);
  logActivity('ceo', `opened ${kind === 'standup' ? 'a standup' : 'a meeting'}: ${mt.title}`, { type: 'meeting', id: mt.id });
  run(mt, mt.rounds).catch((e) => failMeeting(mt, e));
  return mt;
}

export function addFounderMessage(mt, text) {
  if (mt.status === 'live' || mt.status === 'minutes') throw new Error('The meeting is still talking — wait for the minutes.');
  mt.transcript.push({ id: newId('utt'), agentId: 'founder', text, at: now(), round: currentRound(mt) + 1 });
  mt.status = 'live';
  emit(mt);
  run(mt, 1, true).catch((e) => failMeeting(mt, e));
}

export function launchActionItems(mt) {
  if (mt.missionId) return state.missions[mt.missionId];
  const specs = mt.actionItems.filter((a) => getAgent(a.agent) && a.agent !== 'ceo');
  if (!specs.length) throw new Error('This meeting has no action items to launch.');
  const m = createMissionWithTasks({
    goal: `Action items from “${mt.title}”`,
    deadline: new Date(Date.now() + mt.deadlineHours * 36e5).toISOString(),
    specs: specs.map((a, i) => ({ ...a, key: `a${i}` })),
    intro: `Action items from the meeting are now tasks with deadlines.\n\n${mt.decisions.length ? `**Decisions:**\n${mt.decisions.map((d) => `- ${d}`).join('\n')}` : ''}`,
    source: `meeting:${mt.id}`,
  });
  mt.missionId = m.id;
  emit(mt);
  return m;
}

export function deleteMeeting(mt) {
  delete state.meetings[mt.id];
  save();
  bus.emit('event', { type: 'meeting.deleted', id: mt.id });
}

const currentRound = (mt) => Math.max(0, ...mt.transcript.map((u) => u.round || 0));

function transcriptText(mt) {
  return mt.transcript.map((u) => `${u.agentId === 'founder' ? 'Founder' : getAgent(u.agentId)?.name || u.agentId}: ${u.text}`).join('\n\n');
}

function workContext(agentId) {
  const tasks = Object.values(state.tasks)
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  return tasks.length ? tasks.map((t) => `- [${t.status}${t.late ? ', late' : ''}] ${t.title} (due ${t.deadline})`).join('\n') : '- (no assignments yet)';
}

async function run(mt, rounds, followUp = false) {
  const start = currentRound(mt);
  for (let r = start + 1; r <= start + rounds; r++) {
    for (const agentId of mt.participants) {
      if (!state.meetings[mt.id]) return; // deleted mid-meeting
      await speak(mt, agentId, r, followUp);
    }
  }
  await writeMinutes(mt);
  if (mt.autoLaunch && mt.actionItems.length && !mt.missionId) launchActionItems(mt);
}

async function speak(mt, agentId, round, followUp) {
  const agent = getAgent(agentId);
  const names = mt.participants.map((p) => `${getAgent(p)?.name} (${getAgent(p)?.role})`).join(', ');
  const u = { id: newId('utt'), agentId, text: '', reasoning: '', round, at: now(), streaming: true };
  mt.transcript.push(u);
  emit(mt);
  const role =
    agentId === 'ceo'
      ? round === 1 && !followUp
        ? 'You are the moderator: open the meeting, frame the agenda in 2–3 sentences and say what you need from the team.'
        : 'You are the moderator: respond to what was said, settle disagreements and push toward decisions and owners.'
      : mt.kind === 'standup'
        ? 'Give your standup: what you finished, what you are doing next, any blockers. React to teammates if relevant.'
        : 'Contribute your expertise: react to teammates by name, add something new, flag one risk, and say what you would own.';
  await complete(
    {
      system: systemPrompt(agent),
      messages: [
        {
          role: 'user',
          content: `You are in a live ${mt.kind === 'standup' ? 'daily standup' : 'team meeting'}: "${mt.title}".
Agenda: ${mt.agenda}
Participants: ${names}, plus the founder.
Your current assignments:
${workContext(agentId)}

Transcript so far:
${transcriptText(mt) || '(you speak first)'}

It is your turn (round ${round}). ${role}
Speak naturally in 40–120 words, first person, no headings, no lists longer than 3 items. Do not speak for others.`,
        },
      ],
      effort: 'low',
      demo: () => demoMeetingTurn(agentId, mt, round),
    },
    (ev) => {
      const field = ev.type === 'reasoning' ? 'reasoning' : 'text';
      u[field] += ev.text;
      bus.emit('event', { type: 'delta', target: 'meeting', id: u.id, missionId: mt.id, field, text: ev.text });
    },
  );
  u.streaming = false;
  emit(mt);
  logActivity(agentId, `spoke in “${mt.title}”`, { type: 'meeting', id: mt.id });
}

async function writeMinutes(mt) {
  mt.status = 'minutes';
  emit(mt);
  const raw = await complete({
    system: systemPrompt(getAgent('ceo')),
    messages: [
      {
        role: 'user',
        content: `Write the minutes for this meeting.
Title: ${mt.title}
Agenda: ${mt.agenda}

Transcript:
${transcriptText(mt)}

Turn every commitment into an action item owned by one participant (never "ceo"), with a realistic
deadline in hours (within ${mt.deadlineHours}h). Participants' ids: ${mt.participants.filter((p) => p !== 'ceo').join(', ')}.

Reply with ONLY JSON:
{"summary": "<Markdown minutes: context, key points by person, open questions>",
 "decisions": ["<decision>"],
 "action_items": [{"agent": "<id>", "title": "<short imperative>", "brief": "<what and why>", "deliverable": "<artifact>", "due_in_hours": <number>}]}`,
      },
    ],
    effort: 'medium',
    demo: () => demoMinutes(mt),
  });
  const parsed = extractJson(raw);
  mt.minutes = String(parsed.summary || '');
  mt.decisions = (parsed.decisions || []).map(String);
  mt.actionItems = (parsed.action_items || []).filter((a) => getAgent(a.agent) && a.agent !== 'ceo');
  mt.missionId = null;
  mt.status = 'done';
  mt.endedAt = now();
  emit(mt);
}

function failMeeting(mt, e) {
  console.error(`meeting ${mt.id} failed:`, e.message);
  for (const u of mt.transcript) u.streaming = false;
  mt.status = 'failed';
  mt.error = e.message;
  emit(mt);
}

/** Restarted mid-meeting: mark it so the founder can continue it. */
export function resumeMeetings() {
  for (const mt of Object.values(state.meetings)) {
    if (mt.status === 'live' || mt.status === 'minutes') {
      for (const u of mt.transcript) u.streaming = false;
      mt.status = 'failed';
      mt.error = 'Server restarted during the meeting — send a message to continue it.';
    }
  }
}
