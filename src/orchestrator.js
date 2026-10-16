// The CEO loop: plan → (optional founder approval) → delegate with deadlines →
// agents work in the shared workspace (in parallel where dependencies allow,
// earliest deadline first) → CEO review → (optional founder approval) → mission
// report. A watchdog escalates anything that misses its deadline, and every
// finished task is filed in the workspace and summarised into the agent's memory.
//
// Robustness rules: a mission never silently stops. Follow-ups and questions that
// fail don't kill the mission, runs that hit their step budget are finished or
// retried, a failed CEO review doesn't fail the deliverable, and the final report
// falls back to a written summary if the CEO can't produce one.
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, systemPrompt, remember, toolsFor, resolveAgent, specialists } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now, slugify, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { logActivity, toolTracker } from './activity.js';
import { demoPlan, demoOutput, demoReview, demoSummary } from './demo.js';

export { bus };

const MAX_PARALLEL = Number(process.env.MAX_PARALLEL_TASKS || 3);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 1);
const ceo = () => getAgent('ceo');
// The CEO manages; it inspects work but never produces specialist deliverables itself.
const CEO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
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
  const track = toolTracker('ceo', { type: 'mission', id: m.id });
  try {
    return await complete({ ...opts, signal: signal(m) }, (ev) => {
      if (ev.type === 'turn') {
        // Text before a tool call was working-out-loud: keep it under Thoughts.
        if (!opts.json && item.text) item.reasoning += `${item.text}\n`;
        if (!opts.json) item.text = '';
        return emitMission(m);
      }
      const field = ev.type === 'reasoning' ? 'reasoning' : 'text';
      if (field === 'reasoning') track(ev.text);
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
  logActivity('ceo', `started a mission: ${m.title}`, { type: 'mission', id: m.id });
  return m;
}

// ---- public API -------------------------------------------------------------

export function createMission({ goal, deadline, source }) {
  const m = newMission({ goal, deadline, source });
  addThread(m, { role: 'user', kind: 'text', text: goal });
  plan(m).catch((e) => {
    fail(m, e);
    drainQueue(m);
  });
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

/**
 * A follow-up or a question in a running mission. If it fails, the mission keeps
 * going — the failure is reported in the thread instead of stopping everything.
 */
export function sendToMission(m, { text, mode }) {
  addThread(m, { role: 'user', kind: 'text', text, mode });
  if (m.status === 'planning') {
    // The CEO is mid-plan: queue it and handle it as soon as the plan is done.
    (m.queue ||= []).push({ text, mode });
    addThread(m, { role: 'ceo', kind: 'review', text: "Noted — I'll handle that as soon as I finish the current plan." });
    return;
  }
  handleMessage(m, { text, mode });
}

/** Run any follow-ups that arrived while the CEO was planning. */
function drainQueue(m) {
  const next = m.queue?.shift();
  if (next) handleMessage(m, next);
}

function handleMessage(m, { text, mode }) {
  const before = m.status;
  const run = mode === 'ask' ? answer(m, text) : plan(m, text);
  run.catch((e) => {
    if (m.status === 'cancelled') return;
    console.error(`mission ${m.id} follow-up failed:`, e.message);
    for (const item of m.thread) item.streaming = false;
    addThread(m, { role: 'ceo', kind: 'escalation', text: `I couldn't handle that ${mode === 'ask' ? 'question' : 'follow-up'}: ${e.message}. The rest of the mission continues — try again in a moment.` });
    m.status = ['planning', 'failed'].includes(before) ? (missionTasks(m).length ? 'running' : 'failed') : before;
    emitMission(m);
    schedule(m);
    drainQueue(m);
  });
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
      // Interrupted mid-plan: drop the half-written plan message and plan again.
      m.thread = m.thread.filter((it) => !(it.kind === 'plan' && !it.taskIds?.length));
      addThread(m, { role: 'ceo', kind: 'review', text: 'The app restarted while I was planning — planning again.' });
      plan(m).catch((e) => fail(m, e));
    }
  }
}

// ---- CEO: planning & delegation --------------------------------------------

function addTasks(m, item, specs) {
  const deadlineMs = Date.parse(m.deadline);
  const keyToId = {};
  const dropped = [];
  const valid = [];
  specs.forEach((s, i) => {
    // The CEO may name a bot by id, name or role — resolve it, never to the CEO itself.
    const agent = resolveAgent(s.agent);
    if (!agent || agent.id === 'ceo') return dropped.push(s.title || s.agent);
    valid.push({ ...s, agent: agent.id, key: s.key || `t${i}` });
  });
  if (!valid.length) throw new Error(`No valid assignments in the plan${dropped.length ? ` (could not match: ${dropped.join(', ')})` : ''}.`);
  for (const s of valid) keyToId[s.key] = newId('task');

  for (const s of valid) {
    const due = Math.min(deadlineMs, Date.now() + Math.max(0.1, Number(s.due_in_hours) || 1) * 36e5);
    const t = {
      id: keyToId[s.key],
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
    logActivity(t.agentId, `was assigned “${t.title}” (due ${new Date(t.deadline).toLocaleString()})`, { type: 'task', id: t.id, missionId: m.id });
  }
  return dropped;
}

async function plan(m, instruction) {
  m.status = 'planning';
  emitMission(m);
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [] });

  const existing = missionTasks(m)
    .map((t) => `- [${t.status}] ${t.title} → ${getAgent(t.agentId)?.name}`)
    .join('\n');
  const team = specialists()
    .map((a) => `- "${a.id}" = ${a.name}, ${a.role}: ${a.specialties.join(', ')}`)
    .join('\n');
  const prompt = `Founder's goal: ${m.goal}
Current time: ${fmt(now())}
Mission deadline: ${fmt(m.deadline)} (${hoursLeft(m).toFixed(1)} hours from now)
${existing ? `\nTasks already delegated:\n${existing}\n` : ''}
${instruction ? `New instruction from the founder: ${instruction}\nPlan ONLY the additional work this instruction needs.` : 'Break this goal into the work needed to ship it.'}

You are the manager: you do NOT do the work yourself. Delegate every piece of work to the specialist
whose role and specialties fit it best. Spread the work across the team — each task goes to exactly one
specialist, and no specialist should get work outside their role when a better-suited teammate exists.
Your specialists (use the quoted id in "agent"):
${team}

Give each task a realistic deadline in hours from now that fits inside the mission deadline, leaving time
for dependencies. Keep it to ${instruction ? '1–3' : '4–8'} focused tasks. Use depends_on (task keys) when a
task needs another's output. Each brief must say exactly what to produce and which files to save.

Reply with ONLY a JSON object, no other text:
{"summary": "<2–4 sentence message to the founder explaining who does what>",
 "tasks": [{"key": "t1", "agent": "<specialist id>", "title": "<short imperative>", "brief": "<what to do and why>",
            "deliverable": "<the concrete artifact to hand back>", "due_in_hours": <number>, "depends_on": ["<key>"]}]}`;

  let parsed;
  for (let attempt = 1; ; attempt++) {
    const raw = await streamInto(m, item, {
      system: systemPrompt(ceo()),
      messages: [{ role: 'user', content: attempt === 1 ? prompt : `${prompt}\n\nYour previous reply was not valid JSON. Reply with the JSON object only.` }],
      effort: 'high',
      json: true,
      kind: 'plan',
      demo: () => demoPlan(m.goal, hoursLeft(m), instruction),
    });
    try {
      parsed = extractJson(raw);
      if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) throw new Error('The plan had no tasks.');
      break;
    } catch (e) {
      if (attempt >= 2) throw new Error(`I couldn't produce a usable plan (${e.message})`);
    }
  }
  const dropped = addTasks(m, item, parsed.tasks);
  item.text = String(parsed.summary || 'Plan ready. Delegating now.') + (dropped.length ? `\n\n_(Skipped ${dropped.length} item(s) I couldn't match to a teammate.)_` : '');

  if (state.settings.approvePlans) {
    item.needsApproval = true;
    m.status = 'awaiting_approval';
    emitMission(m);
    return drainQueue(m);
  }
  m.status = 'running';
  emitMission(m);
  schedule(m);
  drainQueue(m);
}

async function answer(m, question) {
  const item = addThread(m, { role: 'ceo', kind: 'text' });
  const status = missionTasks(m)
    .map((t) => `### ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', late' : ''}], due ${fmt(t.deadline)}${t.file ? `, file ${t.file}` : ''}\n${clip(t.output, 1500)}`)
    .join('\n\n');
  await streamInto(m, item, {
    system: systemPrompt(ceo()),
    messages: [
      {
        role: 'user',
        content: `Mission: ${m.goal}\nDeadline: ${fmt(m.deadline)}\nFiles: ${m.folder}/\n\nTeam progress:\n${status || '(nothing yet)'}\n\nFounder asks: ${question}\n\nAnswer as the CEO (you may read the team's files to check). Do not do specialist work yourself; if new work is needed, say so — the founder can switch the box to "Delegate to team".`,
      },
    ],
    tools: CEO_TOOLS,
    agentId: 'ceo',
    kind: 'chat',
    maxTurns: 30,
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
    runTask(m, t).catch((e) => {
      console.error('task crashed', e);
      t.status = 'failed';
      t.error = e.message;
      emitTask(t);
      schedule(m);
    });
  }

  if (busy === 0 && ready.length === 0 && tasks.every((t) => ['done', 'failed'].includes(t.status))) {
    report(m).catch((e) => fail(m, e));
  }
}

function assignmentPrompt(m, t, agent, previous) {
  const inputs = t.dependsOn
    .map((id) => state.tasks[id])
    .filter(Boolean)
    .map((d) => `### From ${getAgent(d.agentId)?.name}: ${d.title} (file: ${d.file || 'n/a'})\n${clip(d.output, 4000)}`)
    .join('\n\n');
  const skill = t.skillId && state.skills[t.skillId];
  const revision = t.feedback
    ? `\n\nYour previous version was sent back. Feedback: ${t.feedback}\n\nPrevious version:\n${clip(previous, 4000)}\n\nDeliver an improved, complete version.`
    : '';
  const workDir = `${m.folder}/${slugify(agent.name, 20)}`;
  return `Assignment from ${ceo().name} (CEO)
Company goal: ${m.goal}
Your task: ${t.title}
Brief: ${t.brief}
Deliverable: ${t.deliverable}
Deadline: ${fmt(t.deadline)} (now: ${fmt(now())})
Your folder in the shared workspace: ${workDir}/  (mission folder: ${m.folder}/)
${skill ? `\nUse your skill "${skill.name}":\n${skill.path ? `Read ${skill.path} and follow it.` : skill.body}\n` : ''}${inputs ? `\nInputs from teammates:\n${inputs}` : ''}${revision}

Do the work now — you, not someone else. Check your skills list and use any that fit. Save real artifacts
(code, data, spreadsheets, copy, assets) as files ONLY inside ${workDir}/ — never create other folders
under missions/ and never save duplicate copies elsewhere. Teammates' files are in ${m.folder}/ (read them,
don't copy them). Check your files (e.g. run them) before you finish. Your FINAL message must be the complete deliverable in Markdown (it is filed automatically),
ending with a short "Files" list of everything you saved.`;
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
  const ref = { type: 'task', id: t.id, missionId: m.id };
  logActivity(agent.id, `started “${t.title}”`, ref);
  const track = toolTracker(agent.id, ref);

  const onEvent = (ev) => {
    if (ev.type === 'turn') {
      // Text before a tool call was working-out-loud: move it to Thoughts, keep the answer clean.
      if (t.output) t.reasoning += `${t.output}\n`;
      t.output = '';
      return emitTask(t);
    }
    const field = ev.type === 'reasoning' ? 'reasoning' : 'output';
    if (field === 'reasoning') track(ev.text);
    t[field] += ev.text;
    emitDelta('task', t.id, m.id, field, ev.text);
  };
  const run = (content, maxTurns) =>
    complete(
      {
        system: systemPrompt(agent),
        messages: [{ role: 'user', content }],
        effort: 'high',
        tools: toolsFor(agent),
        agentId: agent.id,
        kind: 'task',
        maxTurns,
        signal: signal(m),
        demo: () => demoOutput(t.agentId, t, m.goal),
      },
      onEvent,
    );

  try {
    const prompt = assignmentPrompt(m, t, agent, previous);
    try {
      await run(prompt, agent.computer ? 150 : 100);
    } catch (e) {
      if (e.code !== 'max_turns') throw e;
      // Out of steps: hand in what we have, or take one short "wrap it up" pass.
      if ((e.partial || t.output).length < 400) {
        logActivity(agent.id, `ran long on “${t.title}” — wrapping up`, ref);
        t.output = '';
        await run(`${prompt}\n\nIMPORTANT: you already worked on this and ran out of steps. Do NOT start over or explore further. Check the files you already saved in ${m.folder}/, fix only what is essential, and write the final deliverable now.`, 25);
      }
    }
    if (!t.output.trim()) throw new Error('The bot finished without writing a deliverable.');

    t.status = 'review';
    emitTask(t);
    logActivity('ceo', `is reviewing “${t.title}” from ${agent.name}`, ref);
    const review = await ceoReview(m, t);
    t.review = review;
    if (review.verdict === 'revise' && t.revisions < MAX_REVISIONS) {
      t.revisions += 1;
      t.feedback = review.feedback;
      t.status = 'queued';
      addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `Sent **${t.title}** back to ${agent.name}: ${review.feedback}` });
      logActivity('ceo', `sent “${t.title}” back to ${agent.name}`, ref);
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
    logActivity(agent.id, `could not finish “${t.title}”: ${e.message}`, ref);
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
  logActivity(t.agentId, `delivered “${t.title}”${t.late ? ' (late)' : ''}`, { type: 'task', id: t.id, missionId: m.id });
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
    agentId: t.agentId,
    kind: 'memory',
    demo: () => `Did "${t.title}" for "${m.goal}" — delivered ${t.late ? 'late' : 'on time'}.`,
  });
  remember(t.agentId, text.replace(/^[-*\s]+/, ''), `task:${t.id}`);
}

/** The CEO checks a deliverable. If the review itself fails, the work still counts. */
async function ceoReview(m, t) {
  const agent = getAgent(t.agentId);
  try {
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
      agentId: 'ceo',
      kind: 'review',
      signal: signal(m),
      demo: demoReview,
    });
    const r = extractJson(raw);
    return { verdict: r.verdict === 'revise' ? 'revise' : 'approve', feedback: String(r.feedback || '') };
  } catch (e) {
    if (e.message === 'aborted') throw e;
    return { verdict: 'approve', feedback: `Accepted without a full review (${e.message}).` };
  }
}

async function report(m) {
  m.status = 'reporting';
  emitMission(m);
  logActivity('ceo', `is writing the report for “${m.title}”`, { type: 'mission', id: m.id });
  const tasks = missionTasks(m);
  const item = addThread(m, { role: 'ceo', kind: 'summary' });
  const content = `All delegated work for this mission is finished. Write the mission report for the founder.
Goal: ${m.goal}
Deadline: ${fmt(m.deadline)} — now ${fmt(now())}
Workspace folder: ${m.folder}/

${tasks
  .map((t) => `## ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', LATE' : ''}${t.error ? `: ${t.error}` : ''}] file: ${t.file || '-'}\n${clip(t.output, 2500)}`)
  .join('\n\n')}

Structure: a one-paragraph executive summary, the key decisions and assets produced (with owners
and file paths), deadline performance, risks/gaps, and the next 3 moves. Be concise.`;
  let text = '';
  for (let attempt = 1; attempt <= 2 && !text.trim(); attempt++) {
    item.text = '';
    try {
      text = await streamInto(m, item, { system: systemPrompt(ceo()), messages: [{ role: 'user', content }], agentId: 'ceo', kind: 'report', demo: () => demoSummary(m, tasks) });
    } catch (e) {
      if (m.status === 'cancelled') return;
      if (attempt === 2) {
        // Never leave the founder without a report: write a plain one from the results.
        text = `## Mission report\n\n_I couldn't write the full report (${e.message}), so here is the factual summary._\n\n${tasks
          .map((t) => `- **${t.title}** — ${getAgent(t.agentId)?.name}: ${t.status === 'done' ? `delivered${t.late ? ' late' : ''}` : `${t.status}${t.error ? ` (${t.error})` : ''}`}${t.file ? ` · \`${t.file}\`` : ''}`)
          .join('\n')}\n\nAll files are in \`${m.folder}/\`.`;
        item.text = text;
      }
    }
  }
  fs.writeFileSync(path.join(WORKSPACE, m.folder, '00-mission-report.md'), `# Mission report: ${m.goal}\n\n${item.text}\n`);
  m.status = 'done';
  m.completedAt = now();
  emitMission(m);
  logActivity('ceo', `finished “${m.title}” and filed the report`, { type: 'mission', id: m.id });
  bus.emit('trigger', { event: 'mission_completed', mission: m });
}

function fail(m, e) {
  if (m.status === 'cancelled') return;
  console.error(`mission ${m.id} failed:`, e.message);
  for (const item of m.thread) item.streaming = false;
  m.status = 'failed';
  addThread(m, { role: 'ceo', kind: 'escalation', text: `Something broke: ${e.message}. Send a follow-up ("Delegate to team") to try again.` });
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
