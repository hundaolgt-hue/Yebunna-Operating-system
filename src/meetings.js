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
import { addRule, removeRule, listRules } from './playbook.js';
import { isLimitError } from './limits.js';

const emit = (mt) => {
  save();
  bus.emit('event', { type: 'meeting', meeting: mt });
};

export function startMeeting({ title, agenda, participants, rounds = 2, kind = 'meeting', deadlineHours = 24, autoLaunch = false, source = 'founder', since = null }) {
  // A retrospective includes everyone who worked; other meetings are kept small.
  const people = [...new Set(['ceo', ...participants])].filter((id) => getAgent(id)).slice(0, kind === 'retro' ? 20 : 7);
  if (people.length < 2) throw new Error('A meeting needs at least one bot besides the CEO.');
  const mt = {
    id: newId('mtg'),
    kind,
    title: title || (kind === 'standup' ? `Standup · ${new Date().toLocaleDateString()}` : kind === 'retro' ? `Retrospective · ${new Date().toLocaleDateString()}` : 'Team meeting'),
    since,
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
  logActivity('ceo', `opened ${kind === 'standup' ? 'a standup' : kind === 'retro' ? 'the retrospective' : 'a meeting'}: ${mt.title}`, { type: 'meeting', id: mt.id });
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

/** Tasks finished, failed or stuck since `since` — what a retrospective looks back on. */
export function tasksSince(since) {
  return Object.values(state.tasks).filter((t) => {
    const at = t.completedAt || t.blocker?.at || t.createdAt;
    return at > since && ['done', 'failed', 'founder', 'blocked', 'approval'].includes(t.status);
  });
}

function retroContext(mt, agentId) {
  const mine = tasksSince(mt.since).filter((t) => agentId === 'ceo' || t.agentId === agentId);
  if (!mine.length) return '- (no tasks since the last retrospective)';
  return mine
    .slice(0, 12)
    .map((t) => {
      const m = state.missions[t.missionId];
      const facts = [
        t.status,
        t.late ? 'late' : null,
        t.revisions ? `${t.revisions} revision(s)` : null,
        t.blocker ? `blocked: ${t.blocker.reason}` : null,
        t.error ? `error: ${t.error}` : null,
      ].filter(Boolean);
      return `- ${agentId === 'ceo' ? `${getAgent(t.agentId)?.name}: ` : ''}"${t.title}" (mission: ${m?.title || '?'}) [${facts.join('; ')}]${t.review?.feedback ? ` — CEO review: ${t.review.feedback}` : ''}`;
    })
    .join('\n');
}

function workContext(agentId) {
  const tasks = Object.values(state.tasks)
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  return tasks.length ? tasks.map((t) => `- [${t.status}${t.late ? ', late' : ''}] ${t.title} (due ${t.deadline})`).join('\n') : '- (no assignments yet)';
}

async function run(mt, rounds, followUp = false) {
  // A meeting paused on the usage limit picks up at the round it was in.
  const start = mt.resumeFrom ? mt.resumeFrom - 1 : currentRound(mt);
  mt.resumeFrom = null;
  for (let r = start + 1; r <= start + rounds; r++) {
    for (const agentId of mt.participants) {
      if (!state.meetings[mt.id]) return; // deleted mid-meeting
      if (mt.transcript.some((u) => u.agentId === agentId && u.round === r && !u.streaming && u.text)) continue; // already spoke (resumed meeting)
      await speak(mt, agentId, r, followUp);
    }
  }
  await (mt.kind === 'retro' ? writeRetro(mt) : writeMinutes(mt));
  if (mt.autoLaunch && mt.actionItems.length && !mt.missionId) launchActionItems(mt);
}

async function speak(mt, agentId, round, followUp) {
  const agent = getAgent(agentId);
  const names = mt.participants.map((p) => `${getAgent(p)?.name} (${getAgent(p)?.role})`).join(', ');
  const u = { id: newId('utt'), agentId, text: '', reasoning: '', round, at: now(), streaming: true };
  mt.transcript.push(u);
  emit(mt);
  const role = mt.kind === 'retro'
    ? agentId === 'ceo'
      ? round === 1 && !followUp
        ? 'You moderate the retrospective: in 2–3 sentences, sum up how the last missions went overall (on time? quality? blockers?) and ask each bot to be honest.'
        : 'Close the discussion: name the 2–3 lessons that matter most.'
      : 'Report on YOUR work listed below: what went well (and why), what went wrong or blocked you (and the root cause), and propose ONE concrete rule for future missions — "Do: …" or "Don\'t: …". Be honest and specific; no praise for its own sake.'
    : agentId === 'ceo'
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
          content: `You are in a live ${mt.kind === 'standup' ? 'daily standup' : mt.kind === 'retro' ? 'morning retrospective' : 'team meeting'}: "${mt.title}".
Agenda: ${mt.agenda}
Participants: ${names}, plus the founder.
${mt.kind === 'retro' ? `Work since the last retrospective:\n${retroContext(mt, agentId)}` : `Your current assignments:\n${workContext(agentId)}`}

Transcript so far:
${transcriptText(mt) || '(you speak first)'}

It is your turn (round ${round}). ${role}
Speak in 30–80 words, first person, no headings, at most 3 bullets. Add only what is new: never repeat what was already said. Do not speak for others.`,
        },
      ],
      effort: 'low',
      agentId,
      kind: 'meeting',
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
    agentId: 'ceo',
    kind: 'meeting',
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
  for (const u of mt.transcript) u.streaming = false;
  if (isLimitError(e)) {
    // Usage limit: drop the half-spoken turn and continue when the limit resets.
    mt.transcript = mt.transcript.filter((u) => u.text);
    mt.status = 'paused';
    mt.resumeFrom = Math.max(1, currentRound(mt));
    mt.roundsLeft = Math.max(1, (mt.rounds || 1) - mt.resumeFrom + 1);
    return emit(mt);
  }
  console.error(`meeting ${mt.id} failed:`, e.message);
  mt.status = 'failed';
  mt.error = e.message;
  emit(mt);
}

/** The usage limit reset: carry on with paused meetings. */
bus.on('limit.reset', () => {
  for (const mt of Object.values(state.meetings)) {
    if (mt.status !== 'paused') continue;
    mt.status = 'live';
    emit(mt);
    run(mt, mt.roundsLeft || 1).catch((e) => failMeeting(mt, e));
  }
});

/** Retrospective minutes: lessons become playbook rules; rules that hurt are retired. */
async function writeRetro(mt) {
  mt.status = 'minutes';
  emit(mt);
  const current = listRules();
  const raw = await complete({
    system: systemPrompt(getAgent('ceo')),
    messages: [
      {
        role: 'user',
        content: `Write the outcome of this retrospective and update the team playbook.

Facts — work since the last retrospective:
${retroContext(mt, 'ceo')}

Transcript:
${transcriptText(mt)}

Current playbook (id: rule):
${current.map((r) => `- ${r.id}: ${r.type === 'do' ? 'DO' : "DON'T"} ${r.text}`).join('\n') || '(empty)'}

Turn what WORKED into "do" rules and what went WRONG into "don't" rules, so future missions repeat the
good and avoid the bad. Only add rules backed by the facts or the discussion, phrased as short, concrete
instructions any bot can follow (max 25 words). Don't duplicate existing rules. Remove existing rules that
the evidence shows are wrong, harmful or obsolete. Add at most 5 rules.

Reply with ONLY JSON:
{"summary": "<Markdown: how it went, what worked, what didn't, root causes>",
 "decisions": ["<decision>"],
 "rules_add": [{"type": "do" | "dont", "text": "<rule>", "why": "<the evidence>"}],
 "rules_remove": [{"id": "<rule id>", "why": "<reason>"}]}`,
      },
    ],
    effort: 'medium',
    agentId: 'ceo',
    kind: 'meeting',
    demo: () => JSON.stringify({ summary: '## Retrospective\n\nDemo mode: the team reviewed recent work.', decisions: [], rules_add: [{ type: 'do', text: 'Save every deliverable as a file and list it at the end.', why: 'demo' }], rules_remove: [] }),
  });
  const parsed = extractJson(raw);
  const added = (parsed.rules_add || []).slice(0, 5).map((r) => addRule({ type: r.type, text: r.text, why: r.why, source: `retro:${mt.id}` })).filter(Boolean);
  const removed = [];
  for (const r of parsed.rules_remove || []) {
    const rule = current.find((x) => x.id === r.id);
    if (rule && rule.source !== 'founder') {
      removeRule(rule.id);
      removed.push(`${rule.type === 'do' ? 'DO' : "DON'T"} ${rule.text} — ${r.why || ''}`);
    }
  }
  mt.minutes = `${String(parsed.summary || '')}${added.length ? `\n\n### New playbook rules\n${added.map((r) => `- **${r.type === 'do' ? 'Do' : "Don't"}:** ${r.text}${r.why ? ` _(${r.why})_` : ''}`).join('\n')}` : ''}${removed.length ? `\n\n### Retired rules\n${removed.map((r) => `- ~~${r}~~`).join('\n')}` : ''}`;
  mt.decisions = (parsed.decisions || []).map(String);
  mt.actionItems = [];
  mt.status = 'done';
  mt.endedAt = now();
  state.lastRetroAt = mt.createdAt;
  emit(mt);
  logActivity('ceo', `wrapped up the retrospective: ${added.length} new rule(s), ${removed.length} retired`, { type: 'meeting', id: mt.id });
}

/** Morning retrospective: only bots that worked since the last one take part; nothing to review → no meeting. */
export function startRetro({ source = 'founder' } = {}) {
  const since = state.lastRetroAt || new Date(Date.now() - 7 * 864e5).toISOString();
  const tasks = tasksSince(since);
  if (!tasks.length) return null;
  const participants = [...new Set(tasks.map((t) => t.agentId))].filter((id) => id !== 'ceo');
  return startMeeting({
    kind: 'retro',
    agenda: 'Look back at the work since the last retrospective: what went well, what went wrong and why — and turn it into rules for future missions.',
    participants,
    rounds: 1,
    source,
    since,
  });
}

/** Restarted mid-meeting: mark it so the founder can continue it. */
export function resumeMeetings() {
  for (const mt of Object.values(state.meetings)) {
    if (mt.status === 'paused' && !state.limit) {
      mt.status = 'live';
      run(mt, mt.roundsLeft || 1).catch((e) => failMeeting(mt, e));
    } else if (mt.status === 'live' || mt.status === 'minutes') {
      for (const u of mt.transcript) u.streaming = false;
      mt.status = 'failed';
      mt.error = 'Server restarted during the meeting — send a message to continue it.';
    }
  }
}
