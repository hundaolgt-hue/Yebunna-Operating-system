// The CEO loop: plan → delegate with deadlines → agents work (in parallel where
// dependencies allow, earliest deadline first) → CEO reviews each deliverable →
// final mission report. A watchdog escalates anything that misses its deadline.
import { EventEmitter } from 'node:events';
import { getAgent, systemPrompt, SPECIALISTS } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId } from './store.js';
import { demoPlan, demoOutput, demoReview, demoSummary } from './demo.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const MAX_PARALLEL = Number(process.env.MAX_PARALLEL_TASKS || 3);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 1);
const CEO = getAgent('ceo');
const controllers = new Map(); // missionId -> AbortController
const now = () => new Date().toISOString();

// ---- events -----------------------------------------------------------------

function emitMission(m) {
  save();
  bus.emit('event', { type: 'mission', mission: m });
}
function emitTask(t) {
  save();
  bus.emit('event', { type: 'task', task: t });
}
function emitDelta(target, id, missionId, field, text) {
  bus.emit('event', { type: 'delta', target, id, missionId, field, text });
}

function addThread(m, item) {
  const entry = { id: newId('msg'), at: now(), text: '', reasoning: '', ...item };
  m.thread.push(entry);
  emitMission(m);
  return entry;
}

/** Stream a completion into a thread item, so the UI shows it live. */
async function streamInto(m, item, opts) {
  item.streaming = true;
  const text = await complete({ ...opts, signal: signal(m) }, (ev) => {
    const field = ev.type === 'reasoning' ? 'reasoning' : 'text';
    if (opts.json && field === 'text') return; // raw JSON is not shown
    item[field] += ev.text;
    emitDelta('thread', item.id, m.id, field, ev.text);
  });
  item.streaming = false;
  return text;
}

function signal(m) {
  if (!controllers.has(m.id)) controllers.set(m.id, new AbortController());
  return controllers.get(m.id).signal;
}

const hoursLeft = (m) => Math.max(0.25, (Date.parse(m.deadline) - Date.now()) / 36e5);
const fmt = (iso) => new Date(iso).toUTCString();
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s || '');
const missionTasks = (m) => m.taskIds.map((id) => state.tasks[id]).filter(Boolean);

// ---- public API -------------------------------------------------------------

export function createMission({ goal, deadline }) {
  const m = {
    id: newId('mis'),
    title: goal.length > 60 ? `${goal.slice(0, 57)}…` : goal,
    goal,
    deadline,
    createdAt: now(),
    status: 'planning',
    taskIds: [],
    thread: [],
  };
  state.missions[m.id] = m;
  addThread(m, { role: 'user', kind: 'text', text: goal });
  plan(m).catch((e) => fail(m, e));
  return m;
}

export function sendToMission(m, { text, mode }) {
  addThread(m, { role: 'user', kind: 'text', text, mode });
  const run = mode === 'ask' ? answer(m, text) : plan(m, text);
  run.catch((e) => fail(m, e));
}

export function cancelMission(m) {
  controllers.get(m.id)?.abort();
  controllers.delete(m.id);
  for (const t of missionTasks(m)) {
    if (!['done', 'failed'].includes(t.status)) {
      t.status = 'failed';
      t.error = 'Mission cancelled';
      emitTask(t);
    }
  }
  m.status = 'cancelled';
  addThread(m, { role: 'ceo', kind: 'escalation', text: 'Mission cancelled. All open tasks were stopped.' });
}

export function deleteMission(m) {
  cancelMission(m);
  for (const id of m.taskIds) delete state.tasks[id];
  delete state.missions[m.id];
  save();
  bus.emit('event', { type: 'mission.deleted', id: m.id });
}

/** After a restart, put interrupted work back in the queue and carry on. */
export function resumeAll() {
  for (const m of Object.values(state.missions)) {
    for (const t of missionTasks(m)) {
      if (t.status === 'in_progress' || t.status === 'review') t.status = 'queued';
    }
    for (const item of m.thread) item.streaming = false;
    if (m.status === 'running' || m.status === 'reporting') {
      m.status = 'running';
      schedule(m);
    } else if (m.status === 'planning') {
      fail(m, new Error('Server restarted while planning — send a follow-up to re-plan.'));
    }
  }
}

// ---- CEO: planning & delegation --------------------------------------------

async function plan(m, instruction) {
  m.status = 'planning';
  emitMission(m);
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [] });

  const existing = missionTasks(m)
    .map((t) => `- [${t.status}] ${t.title} → ${getAgent(t.agentId).name}`)
    .join('\n');
  const prompt = `Founder's goal: ${m.goal}
Current time: ${fmt(now())}
Mission deadline: ${fmt(m.deadline)} (${hoursLeft(m).toFixed(1)} hours from now)
${existing ? `\nTasks already delegated:\n${existing}\n` : ''}
${instruction ? `New instruction from the founder: ${instruction}\nPlan ONLY the additional work this instruction needs.` : 'Break this goal into the work needed to ship it.'}

Delegate each task to the single best specialist (never to "ceo"). Give each a realistic deadline
in hours from now that fits inside the mission deadline, leaving time for dependencies. Keep it to
${instruction ? '1–3' : '4–8'} focused tasks. Use depends_on (task keys) when a task needs another's output.

Reply with ONLY a JSON object:
{"summary": "<2–4 sentence message to the founder explaining the plan, Markdown allowed>",
 "tasks": [{"key": "t1", "agent": "<agent id>", "title": "<short imperative>", "brief": "<what to do and why>",
            "deliverable": "<the concrete artifact to hand back>", "due_in_hours": <number>, "depends_on": ["<key>"]}]}`;

  const raw = await streamInto(m, item, {
    system: systemPrompt(CEO),
    messages: [{ role: 'user', content: prompt }],
    effort: 'high',
    json: true,
    demo: () => demoPlan(m.goal, hoursLeft(m), instruction),
  });
  const parsed = extractJson(raw);

  const deadlineMs = Date.parse(m.deadline);
  const keyToId = {};
  const specs = (parsed.tasks || []).filter((s) => getAgent(s.agent) && s.agent !== 'ceo');
  if (!specs.length) throw new Error('The CEO did not produce any tasks.');
  for (const s of specs) keyToId[s.key] = newId('task');

  for (const s of specs) {
    const due = Math.min(deadlineMs, Date.now() + Math.max(0.1, Number(s.due_in_hours) || 1) * 36e5);
    const t = {
      id: keyToId[s.key],
      missionId: m.id,
      agentId: s.agent,
      title: String(s.title || 'Untitled task'),
      brief: String(s.brief || ''),
      deliverable: String(s.deliverable || ''),
      deadline: new Date(due).toISOString(),
      dependsOn: (s.depends_on || []).map((k) => keyToId[k]).filter(Boolean),
      status: 'queued',
      output: '',
      reasoning: '',
      revisions: 0,
      createdAt: now(),
    };
    state.tasks[t.id] = t;
    m.taskIds.push(t.id);
    item.taskIds.push(t.id);
    emitTask(t);
  }

  item.text = String(parsed.summary || 'Plan ready. Delegating now.');
  m.status = 'running';
  emitMission(m);
  schedule(m);
}

async function answer(m, question) {
  const item = addThread(m, { role: 'ceo', kind: 'text' });
  const status = missionTasks(m)
    .map((t) => `### ${t.title} — ${getAgent(t.agentId).name} [${t.status}${t.late ? ', late' : ''}], due ${fmt(t.deadline)}\n${clip(t.output, 1500)}`)
    .join('\n\n');
  await streamInto(m, item, {
    system: systemPrompt(CEO),
    messages: [
      {
        role: 'user',
        content: `Mission: ${m.goal}\nDeadline: ${fmt(m.deadline)}\n\nTeam progress:\n${status || '(nothing yet)'}\n\nFounder asks: ${question}\n\nAnswer as the CEO. Do not delegate new work in this reply.`,
      },
    ],
    demo: () => `Good question. Right now ${missionTasks(m).filter((t) => t.status === 'done').length} of ${m.taskIds.length} tasks are done. My recommendation: keep the scope tight and ship. (Demo mode — add an API key for a real answer.)`,
  });
  emitMission(m);
}

// ---- scheduling & execution -------------------------------------------------

function schedule(m) {
  if (m.status !== 'running') return;
  const tasks = missionTasks(m);

  for (const t of tasks) {
    if (t.status !== 'queued') continue;
    const blocker = t.dependsOn.map((id) => state.tasks[id]).find((d) => d?.status === 'failed');
    if (blocker) {
      t.status = 'failed';
      t.error = `Blocked: "${blocker.title}" failed`;
      emitTask(t);
    }
  }

  const active = tasks.filter((t) => t.status === 'in_progress' || t.status === 'review').length;
  const ready = tasks
    .filter((t) => t.status === 'queued' && t.dependsOn.every((id) => state.tasks[id]?.status === 'done'))
    .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)); // earliest deadline first
  for (const t of ready.slice(0, Math.max(0, MAX_PARALLEL - active))) {
    runTask(m, t).catch((e) => console.error('task crashed', e));
  }

  if (active === 0 && ready.length === 0 && tasks.every((t) => ['done', 'failed'].includes(t.status))) {
    report(m).catch((e) => fail(m, e));
  }
}

async function runTask(m, t) {
  const agent = getAgent(t.agentId);
  t.status = 'in_progress';
  t.startedAt = t.startedAt || now();
  const previous = t.output;
  t.output = '';
  t.reasoning = '';
  emitTask(t);

  const inputs = t.dependsOn
    .map((id) => state.tasks[id])
    .map((d) => `### From ${getAgent(d.agentId).name} (${getAgent(d.agentId).role}): ${d.title}\n${clip(d.output, 4000)}`)
    .join('\n\n');
  const revision = t.feedback
    ? `\n\nThe CEO sent your previous version back. Feedback: ${t.feedback}\n\nPrevious version:\n${clip(previous, 4000)}\n\nDeliver an improved, complete version.`
    : '';

  try {
    await complete(
      {
        system: systemPrompt(agent),
        messages: [
          {
            role: 'user',
            content: `Assignment from Atlas (CEO)
Company goal: ${m.goal}
Your task: ${t.title}
Brief: ${t.brief}
Deliverable: ${t.deliverable}
Deadline: ${fmt(t.deadline)} (now: ${fmt(now())})
${inputs ? `\nInputs from teammates:\n${inputs}` : ''}${revision}

Produce the complete deliverable now.`,
          },
        ],
        effort: 'high',
        tools: agent.tools || [],
        signal: signal(m),
        demo: () => demoOutput(t.agentId, t, m.goal),
      },
      (ev) => {
        const field = ev.type === 'reasoning' ? 'reasoning' : 'output';
        t[field] += ev.text;
        emitDelta('task', t.id, m.id, field, ev.text);
      },
    );

    t.status = 'review';
    emitTask(t);
    const review = await ceoReview(m, t);
    t.review = review;
    if (review.verdict === 'revise' && t.revisions < MAX_REVISIONS) {
      t.revisions += 1;
      t.feedback = review.feedback;
      t.status = 'queued';
      addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `Sent **${t.title}** back to ${agent.name}: ${review.feedback}` });
    } else {
      t.status = 'done';
      t.completedAt = now();
      t.late = Date.parse(t.completedAt) > Date.parse(t.deadline);
    }
  } catch (e) {
    if (m.status === 'cancelled') return;
    t.status = 'failed';
    t.error = e.message;
  }
  emitTask(t);
  schedule(m);
}

async function ceoReview(m, t) {
  const agent = getAgent(t.agentId);
  const raw = await complete({
    system: systemPrompt(CEO),
    messages: [
      {
        role: 'user',
        content: `Review this deliverable from ${agent.name} (${agent.role}).
Task: ${t.title}
Brief: ${t.brief}
Expected deliverable: ${t.deliverable}

Deliverable:
${clip(t.output, 8000)}

Approve if it is complete, specific and usable. Otherwise ask for a revision with precise feedback.
Reply with ONLY JSON: {"verdict": "approve" | "revise", "feedback": "<one or two sentences>"}`,
      },
    ],
    effort: 'low',
    signal: signal(m),
    demo: demoReview,
  });
  try {
    const r = extractJson(raw);
    return { verdict: r.verdict === 'revise' ? 'revise' : 'approve', feedback: String(r.feedback || '') };
  } catch {
    return { verdict: 'approve', feedback: 'Approved.' };
  }
}

async function report(m) {
  m.status = 'reporting';
  emitMission(m);
  const tasks = missionTasks(m);
  const item = addThread(m, { role: 'ceo', kind: 'summary' });
  await streamInto(m, item, {
    system: systemPrompt(CEO),
    messages: [
      {
        role: 'user',
        content: `All delegated work for this mission is finished. Write the mission report for the founder.
Goal: ${m.goal}
Deadline: ${fmt(m.deadline)} — now ${fmt(now())}

${tasks
  .map((t) => `## ${t.title} — ${getAgent(t.agentId).name} [${t.status}${t.late ? ', LATE' : ''}${t.error ? `: ${t.error}` : ''}]\n${clip(t.output, 2500)}`)
  .join('\n\n')}

Structure: a one-paragraph executive summary, the key decisions and assets produced (with owners),
deadline performance, risks/gaps, and the next 3 moves. Be concise.`,
      },
    ],
    demo: () => demoSummary(m, tasks),
  });
  m.status = 'done';
  m.completedAt = now();
  emitMission(m);
}

function fail(m, e) {
  if (m.status === 'cancelled') return;
  console.error(`mission ${m.id} failed:`, e.message);
  for (const item of m.thread) item.streaming = false;
  m.status = 'failed';
  addThread(m, { role: 'ceo', kind: 'escalation', text: `Something broke: ${e.message}` });
}

// ---- deadline watchdog ------------------------------------------------------

setInterval(() => {
  const t0 = Date.now();
  for (const t of Object.values(state.tasks)) {
    if (t.overdue || ['done', 'failed'].includes(t.status) || Date.parse(t.deadline) > t0) continue;
    const m = state.missions[t.missionId];
    if (!m || m.status === 'cancelled') continue;
    t.overdue = true;
    emitTask(t);
    addThread(m, {
      role: 'ceo',
      kind: 'escalation',
      taskId: t.id,
      text: `⏰ **${getAgent(t.agentId).name}** missed the deadline for **${t.title}**. Escalating — this is now top priority.`,
    });
  }
}, 10_000).unref();

export { SPECIALISTS };
