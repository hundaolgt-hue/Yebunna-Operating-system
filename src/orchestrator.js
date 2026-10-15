// The CEO loop: plan → (optional founder approval) → delegate with deadlines →
// agents work in the shared workspace (in parallel where dependencies allow,
// earliest deadline first) → CEO review → (optional founder approval) → mission
// report. A watchdog escalates anything that misses its deadline, and every
// finished task is filed in the workspace and summarised into the agent's memory.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, systemPrompt, remember, toolsFor } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now, slugify, WORKSPACE } from './store.js';
import { demoPlan, demoOutput, demoReview, demoSummary } from './demo.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const MAX_PARALLEL = Number(process.env.MAX_PARALLEL_TASKS || 3);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 1);
const ceo = () => getAgent('ceo');
const controllers = new Map(); // missionId -> AbortController

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
  try {
    return await complete({ ...opts, signal: signal(m) }, (ev) => {
      const field = ev.type === 'reasoning' ? 'reasoning' : 'text';
      if (opts.json && field === 'text') return; // raw JSON is not shown
      item[field] += ev.text;
      emitDelta('thread', item.id, m.id, field, ev.text);
    });
  } finally {
    item.streaming = false;
  }
}

function signal(m) {
  if (!controllers.has(m.id)) controllers.set(m.id, new AbortController());
  return controllers.get(m.id).signal;
}

const hoursLeft = (m) => Math.max(0.25, (Date.parse(m.deadline) - Date.now()) / 36e5);
const fmt = (iso) => new Date(iso).toUTCString();
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s || '');
export const missionTasks = (m) => m.taskIds.map((id) => state.tasks[id]).filter(Boolean);
const OPEN = ['queued', 'in_progress', 'review', 'approval'];

function newMission({ goal, deadline, source = 'founder' }) {
  const m = {
    id: newId('mis'),
    title: goal.length > 60 ? `${goal.slice(0, 57)}…` : goal,
    goal,
    deadline,
    createdAt: now(),
    status: 'planning',
    source,
    folder: `missions/${now().slice(0, 10)}-${slugify(goal, 32)}-${Math.random().toString(36).slice(2, 6)}`,
    taskIds: [],
    thread: [],
  };
  fs.mkdirSync(path.join(WORKSPACE, m.folder), { recursive: true });
  state.missions[m.id] = m;
  return m;
}

// ---- public API -------------------------------------------------------------

export function createMission({ goal, deadline, source }) {
  const m = newMission({ goal, deadline, source });
  addThread(m, { role: 'user', kind: 'text', text: goal });
  plan(m).catch((e) => fail(m, e));
  return m;
}

/**
 * Create a mission from tasks that are already decided (a direct assignment to one
 * agent, a routine, or a meeting's action items) — no CEO planning step.
 */
export function createMissionWithTasks({ goal, deadline, specs, intro, source = 'founder' }) {
  const m = newMission({ goal, deadline, source });
  addThread(m, { role: 'user', kind: 'text', text: goal });
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [], text: intro || 'Assigned. Work starts now.' });
  addTasks(m, item, specs);
  m.status = 'running';
  emitMission(m);
  schedule(m);
  return m;
}

export function sendToMission(m, { text, mode }) {
  addThread(m, { role: 'user', kind: 'text', text, mode });
  const run = mode === 'ask' ? answer(m, text) : plan(m, text);
  run.catch((e) => fail(m, e));
}

export function approvePlan(m) {
  if (m.status !== 'awaiting_approval') return;
  for (const item of m.thread) if (item.needsApproval) item.needsApproval = false;
  addThread(m, { role: 'user', kind: 'text', text: '✅ Plan approved — go.' });
  m.status = 'running';
  emitMission(m);
  schedule(m);
}

/** Founder signs off a deliverable (or sends it back with feedback). */
export function decideTask(t, { approve, feedback }) {
  const m = state.missions[t.missionId];
  if (!m || t.status !== 'approval') return;
  if (approve) {
    finishTask(m, t);
  } else {
    t.feedback = feedback || 'The founder asked for changes.';
    t.revisions += 1;
    t.status = 'queued';
    addThread(m, { role: 'user', kind: 'text', text: `Changes requested on “${t.title}”: ${t.feedback}` });
  }
  emitTask(t);
  if (m.status === 'running') schedule(m);
}

export function cancelMission(m) {
  controllers.get(m.id)?.abort();
  controllers.delete(m.id);
  for (const t of missionTasks(m)) {
    if (OPEN.includes(t.status)) {
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
    // Missions from before the shared workspace existed get a folder now.
    m.folder ||= `missions/${m.createdAt.slice(0, 10)}-${slugify(m.goal, 32)}-${m.id.slice(-4)}`;
    fs.mkdirSync(path.join(WORKSPACE, m.folder), { recursive: true });
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

function addTasks(m, item, specs) {
  const deadlineMs = Date.parse(m.deadline);
  const keyToId = {};
  specs = specs.filter((s) => getAgent(s.agent) && s.agent !== 'ceo');
  if (!specs.length) throw new Error('No valid tasks to delegate.');
  specs.forEach((s, i) => (keyToId[s.key || `t${i}`] = newId('task')));

  specs.forEach((s, i) => {
    const due = Math.min(deadlineMs, Date.now() + Math.max(0.1, Number(s.due_in_hours) || 1) * 36e5);
    const t = {
      id: keyToId[s.key || `t${i}`],
      missionId: m.id,
      agentId: s.agent,
      title: String(s.title || 'Untitled task'),
      brief: String(s.brief || ''),
      deliverable: String(s.deliverable || ''),
      skillId: s.skillId || null,
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
  });
}

async function plan(m, instruction) {
  m.status = 'planning';
  emitMission(m);
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [] });

  const existing = missionTasks(m)
    .map((t) => `- [${t.status}] ${t.title} → ${getAgent(t.agentId)?.name}`)
    .join('\n');
  const prompt = `Founder's goal: ${m.goal}
Current time: ${fmt(now())}
Mission deadline: ${fmt(m.deadline)} (${hoursLeft(m).toFixed(1)} hours from now)
${existing ? `\nTasks already delegated:\n${existing}\n` : ''}
${instruction ? `New instruction from the founder: ${instruction}\nPlan ONLY the additional work this instruction needs.` : 'Break this goal into the work needed to ship it.'}

Delegate each task to the single best teammate (never to "ceo"); prefer one whose listed skills match.
Give each a realistic deadline in hours from now that fits inside the mission deadline, leaving time
for dependencies. Keep it to ${instruction ? '1–3' : '4–8'} focused tasks. Use depends_on (task keys)
when a task needs another's output.

Reply with ONLY a JSON object:
{"summary": "<2–4 sentence message to the founder explaining the plan, Markdown allowed>",
 "tasks": [{"key": "t1", "agent": "<agent id>", "title": "<short imperative>", "brief": "<what to do and why>",
            "deliverable": "<the concrete artifact to hand back>", "due_in_hours": <number>, "depends_on": ["<key>"]}]}`;

  const raw = await streamInto(m, item, {
    system: systemPrompt(ceo()),
    messages: [{ role: 'user', content: prompt }],
    effort: 'high',
    json: true,
    demo: () => demoPlan(m.goal, hoursLeft(m), instruction),
  });
  const parsed = extractJson(raw);
  addTasks(m, item, parsed.tasks || []);
  item.text = String(parsed.summary || 'Plan ready. Delegating now.');

  if (state.settings.approvePlans) {
    item.needsApproval = true;
    m.status = 'awaiting_approval';
    emitMission(m);
    return;
  }
  m.status = 'running';
  emitMission(m);
  schedule(m);
}

async function answer(m, question) {
  const item = addThread(m, { role: 'ceo', kind: 'text' });
  const status = missionTasks(m)
    .map((t) => `### ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', late' : ''}], due ${fmt(t.deadline)}\n${clip(t.output, 1500)}`)
    .join('\n\n');
  await streamInto(m, item, {
    system: systemPrompt(ceo()),
    messages: [
      {
        role: 'user',
        content: `Mission: ${m.goal}\nDeadline: ${fmt(m.deadline)}\nFiles: ${m.folder}/\n\nTeam progress:\n${status || '(nothing yet)'}\n\nFounder asks: ${question}\n\nAnswer as the CEO. Do not delegate new work in this reply.`,
      },
    ],
    tools: toolsFor(ceo()),
    agentId: 'ceo',
    demo: () => `Good question. Right now ${missionTasks(m).filter((t) => t.status === 'done').length} of ${m.taskIds.length} tasks are done. My recommendation: keep the scope tight and ship. (Demo mode — log in to Claude Code for a real answer.)`,
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

  const busy = tasks.filter((t) => t.status === 'in_progress' || t.status === 'review').length;
  const ready = tasks
    .filter((t) => t.status === 'queued' && t.dependsOn.every((id) => state.tasks[id]?.status === 'done'))
    .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)); // earliest deadline first
  for (const t of ready.slice(0, Math.max(0, MAX_PARALLEL - busy))) {
    runTask(m, t).catch((e) => console.error('task crashed', e));
  }

  if (busy === 0 && ready.length === 0 && tasks.every((t) => ['done', 'failed'].includes(t.status))) {
    report(m).catch((e) => fail(m, e));
  }
}

async function runTask(m, t) {
  const agent = getAgent(t.agentId);
  if (!agent) {
    t.status = 'failed';
    t.error = 'Agent no longer exists';
    emitTask(t);
    return schedule(m);
  }
  t.status = 'in_progress';
  t.startedAt = t.startedAt || now();
  const previous = t.output;
  t.output = '';
  t.reasoning = '';
  emitTask(t);

  const inputs = t.dependsOn
    .map((id) => state.tasks[id])
    .map((d) => `### From ${getAgent(d.agentId)?.name}: ${d.title} (file: ${d.file || 'n/a'})\n${clip(d.output, 4000)}`)
    .join('\n\n');
  const skill = t.skillId && state.skills[t.skillId];
  const revision = t.feedback
    ? `\n\nYour previous version was sent back. Feedback: ${t.feedback}\n\nPrevious version:\n${clip(previous, 4000)}\n\nDeliver an improved, complete version.`
    : '';
  const workDir = `${m.folder}/${slugify(agent.name, 20)}`;

  try {
    await complete(
      {
        system: systemPrompt(agent),
        messages: [
          {
            role: 'user',
            content: `Assignment from ${ceo().name} (CEO)
Company goal: ${m.goal}
Your task: ${t.title}
Brief: ${t.brief}
Deliverable: ${t.deliverable}
Deadline: ${fmt(t.deadline)} (now: ${fmt(now())})
Your folder in the shared workspace: ${workDir}/  (mission folder: ${m.folder}/)
${skill ? `\nUse your skill "${skill.name}":\n${skill.body}\n` : ''}${inputs ? `\nInputs from teammates:\n${inputs}` : ''}${revision}

Do the work now. Save any real artifacts (code, data, copy, assets) as files in your folder.
Your final reply must be the complete deliverable in Markdown (it is filed automatically), ending
with a short "Files" list of anything you saved.`,
          },
        ],
        effort: 'high',
        tools: toolsFor(agent),
        agentId: agent.id,
        maxTurns: agent.computer ? 60 : 25,
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
    } else if (state.settings.approveDeliverables) {
      t.status = 'approval';
      fileDeliverable(m, t);
      addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `**${t.title}** passed my review and is waiting for your sign-off.` });
    } else {
      finishTask(m, t);
    }
  } catch (e) {
    if (m.status === 'cancelled') return;
    t.status = 'failed';
    t.error = e.message;
  }
  emitTask(t);
  schedule(m);
}

function fileDeliverable(m, t) {
  const agent = getAgent(t.agentId);
  const n = String(m.taskIds.indexOf(t.id) + 1).padStart(2, '0');
  t.file = `${m.folder}/${n}-${slugify(agent?.name || 'agent', 12)}-${slugify(t.title, 40)}.md`;
  fs.mkdirSync(path.join(WORKSPACE, m.folder), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, t.file), `# ${t.title}\n\n_${agent?.name} · ${agent?.role} · ${now()}_\n\n${t.output}\n`);
}

function finishTask(m, t) {
  t.status = 'done';
  t.completedAt = now();
  t.late = Date.parse(t.completedAt) > Date.parse(t.deadline);
  fileDeliverable(m, t);
  memorize(t, m).catch(() => {});
  bus.emit('trigger', { event: 'task_completed', task: t });
}

/** Summarise finished work into the agent's long-term memory. */
async function memorize(t, m) {
  const text = await complete({
    system: 'You write one-line memory notes for an AI teammate. Reply with the note only.',
    messages: [
      {
        role: 'user',
        content: `Write ONE line (max 35 words) the agent should remember from this finished task: key decisions, numbers or preferences worth reusing. Mention the product.\nProduct: ${m.goal}\nTask: ${t.title}\nDeliverable:\n${clip(t.output, 3000)}`,
      },
    ],
    effort: 'low',
    model: 'haiku',
    demo: () => `Did "${t.title}" for "${m.goal}" — delivered ${t.late ? 'late' : 'on time'}.`,
  });
  remember(t.agentId, text.replace(/^[-*\s]+/, ''), `task:${t.id}`);
}

async function ceoReview(m, t) {
  const agent = getAgent(t.agentId);
  const raw = await complete({
    system: systemPrompt(ceo()),
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
    system: systemPrompt(ceo()),
    messages: [
      {
        role: 'user',
        content: `All delegated work for this mission is finished. Write the mission report for the founder.
Goal: ${m.goal}
Deadline: ${fmt(m.deadline)} — now ${fmt(now())}
Workspace folder: ${m.folder}/

${tasks
  .map((t) => `## ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', LATE' : ''}${t.error ? `: ${t.error}` : ''}] file: ${t.file || '-'}\n${clip(t.output, 2500)}`)
  .join('\n\n')}

Structure: a one-paragraph executive summary, the key decisions and assets produced (with owners
and file paths), deadline performance, risks/gaps, and the next 3 moves. Be concise.`,
      },
    ],
    demo: () => demoSummary(m, tasks),
  });
  fs.writeFileSync(path.join(WORKSPACE, m.folder, '00-mission-report.md'), `# Mission report: ${m.goal}\n\n${item.text}\n`);
  m.status = 'done';
  m.completedAt = now();
  emitMission(m);
  bus.emit('trigger', { event: 'mission_completed', mission: m });
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
      text: `⏰ **${getAgent(t.agentId)?.name}** missed the deadline for **${t.title}**. Escalating — this is now top priority.`,
    });
  }
}, 10_000).unref();
