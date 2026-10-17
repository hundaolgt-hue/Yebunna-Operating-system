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
import { getAgent, systemPrompt, remember, toolsFor, resolveAgent, specialists, skillCatalog, skillByName } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now, slugify, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { logActivity, toolTracker } from './activity.js';
import { demoPlan, demoOutput, demoReview, demoSummary } from './demo.js';
import { connectedServices } from './connections.js';
import { limited, isLimitError } from './limits.js';
import { notifyFounder } from './telegram.js';

export { bus };

const MAX_PARALLEL = Number(process.env.MAX_PARALLEL_TASKS || 3);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 1);
const ceo = () => getAgent('ceo');
// The CEO manages; it inspects work but never produces specialist deliverables itself.
const CEO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const controllers = new Map(); // missionId -> AbortController
const taskRuns = new Map(); // taskId -> AbortController of the run in progress
const STALL_MS = Math.max(5, Number(process.env.STALL_MINUTES || 20)) * 60_000;

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
// blocked = the CEO is working out how to unblock it; founder = waiting on something only the founder can do
const OPEN = ['queued', 'in_progress', 'review', 'approval', 'blocked', 'founder'];
const MAX_UNBLOCKS = 2; // CEO attempts per task before it goes to the founder

// What every brief must contain before a bot may start (the CEO's briefing standard).
const briefingStandard = () => `BRIEFING STANDARD: a bot starts only when its task is abundantly clear. Each brief is a complete
prompt for a specialist who knows nothing else, containing:
1. Objective and why it matters for the business.
2. Context and inputs: teammates' files by path (missions/...), the founder's references (references/...),
   facts, numbers, decisions already made.
3. Approach: the steps you expect, in order, and the quality bar ("excellent" looks like ...).
4. Skills: pick the best skills for the task from the catalog below, by exact name; the bot opens and
   follows them. If nothing in the catalog fits, name the capability needed and tell the bot to search for
   a skill with find-skills (skills.sh, \`npx skills find <topic>\`), install it into .skills/ and use it.
5. Acceptance criteria: at least 3 checkable criteria you will review against.
6. Deliverable: exact files, formats, sizes, language. Boundaries: no spending, posting or publishing
   unless the founder asked.

SKILL CATALOG (installed; name: what it does → file):
${skillCatalog() || '- (no skills installed yet)'}`;

/** Tasks whose brief isn't clear enough to start (too short, no acceptance criteria). */
function unclearTasks(tasks) {
  return tasks
    .filter((t) => String(t.brief || '').length < 300 || !Array.isArray(t.acceptance) || t.acceptance.length < 2)
    .map((t) => `"${t.title || t.key}"`);
}

/**
 * Direct assignments, routines and meeting action items skip planning, so the CEO briefs them
 * first: one run turns the short request into complete briefs (skills, acceptance criteria).
 */
async function ceoBrief(m, specs) {
  const raw = await complete({
    system: systemPrompt(ceo()),
    messages: [
      {
        role: 'user',
        content: `Before these tasks start, turn each one into a complete brief.
Mission: ${m.goal}
Deadline: ${fmt(m.deadline)}
Tasks (keep each task's key, agent and due_in_hours):
${JSON.stringify(specs.map(({ key, agent, title, brief, deliverable, due_in_hours, size, skillId }) => ({ key, agent, title, brief, deliverable, due_in_hours, size, skill: skillId && state.skills[skillId]?.name })), null, 1)}

${briefingStandard()}

Reply with ONLY JSON: {"tasks": [{"key": "...", "brief": "...", "inputs": [...], "skills": [...], "acceptance": [...], "deliverable": "...", "size": "small" | "medium" | "large"}]}`,
      },
    ],
    tools: CEO_TOOLS,
    maxTurns: 15,
    effort: 'medium',
    agentId: 'ceo',
    kind: 'plan',
    signal: signal(m),
    demo: () => JSON.stringify({ tasks: specs.map((s) => ({ key: s.key, acceptance: ['Matches the brief', 'Saved as files', 'Checked before hand-in'] })) }),
  });
  const byKey = Object.fromEntries((extractJson(raw).tasks || []).map((t) => [t.key, t]));
  return specs.map((s) => {
    const b = byKey[s.key] || {};
    return { ...s, brief: b.brief || s.brief, inputs: b.inputs || s.inputs, skills: b.skills || s.skills, acceptance: b.acceptance || s.acceptance, deliverable: b.deliverable || s.deliverable, size: s.size || b.size };
  });
}

/** The specialists, with what each can use, for the CEO's decisions. */
function teamList() {
  return specialists()
    .map((a) => {
      const linked = connectedServices(a.id);
      const extra = [...linked, ...(a.computer ? ['a web browser (computer use)'] : []), ...(state.settings.terminal ? ['terminal'] : [])];
      return `- "${a.id}" = ${a.name}, ${a.role}: ${a.specialties.join(', ')}${extra.length ? ` · can use: ${extra.join(', ')}` : ''}`;
    })
    .join('\n');
}

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
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [], text: intro || 'Assigned.' });
  const keyed = specs.map((s, i) => ({ ...s, key: s.key || `t${i}` }));
  addTasks(m, item, keyed);
  // The CEO briefs the work before anyone starts (skills, steps, acceptance criteria).
  m.status = 'planning';
  emitMission(m);
  const note = addThread(m, { role: 'ceo', kind: 'review', text: '📝 Writing the brief: the skills to use, the steps and the acceptance criteria…' });
  ceoBrief(m, keyed)
    .then((briefed) => {
      for (const b of briefed) {
        const t = missionTasks(m).find((x) => x.key === b.key);
        if (t) Object.assign(t, taskBriefFields(b));
      }
      note.text = '📝 Brief ready — the team is starting.';
    })
    .catch((e) => {
      if (isLimitError(e) || m.status === 'cancelled') throw e;
      note.text = `📝 I couldn't write a full brief (${e.message}); starting with the request as given.`;
    })
    .then(() => {
      if (m.status !== 'planning') return;
      m.status = 'running';
      emitMission(m);
      schedule(m);
      drainQueue(m);
    })
    .catch((e) => fail(m, e));
  return m;
}

/** The brief fields a task keeps from a plan or a CEO brief. */
function taskBriefFields(s) {
  const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(String).filter(Boolean).slice(0, 12);
  return {
    ...(s.brief ? { brief: String(s.brief) } : {}),
    ...(s.deliverable ? { deliverable: String(s.deliverable) } : {}),
    inputs: list(s.inputs),
    skills: list(s.skills),
    acceptance: list(s.acceptance),
  };
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
    if (isLimitError(e)) {
      // Keep the follow-up and handle it when the limit resets.
      for (const item of m.thread) item.streaming = false;
      m.thread = m.thread.filter((it) => !(it.kind === 'plan' && !it.taskIds?.length && !it.text));
      (m.queue ||= []).unshift({ text, mode });
      m.waitingLimit = true;
      m.status = ['planning', 'failed'].includes(before) ? (missionTasks(m).length ? 'running' : 'planning') : before;
      return emitMission(m);
    }
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
    if (m.status === 'cancelled') continue;
    for (const t of missionTasks(m)) {
      if (t.status === 'blocked' && t.blocker) {
        t.unblocks = Math.max(0, (t.unblocks || 1) - 1); // the interrupted attempt doesn't count
        setTimeout(() => handleBlocker(m, t, t.blocker), 0);
      }
    }
    if (m.status === 'running' || m.status === 'reporting') {
      m.status = 'running';
      schedule(m);
    } else if (m.status === 'planning' && missionTasks(m).length && !m.thread.some((it) => it.kind === 'plan' && !it.taskIds?.length)) {
      // Interrupted while briefing assigned tasks: just start them.
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
      key: s.key,
      ...taskBriefFields(s),
      size: ['small', 'medium', 'large'].includes(s.size) ? s.size : 'medium',
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
  const team = teamList();
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
for dependencies. Give each task a size — it decides how much of the founder's Claude usage it may spend:
"small" = a quick, short piece (a few posts, a list, a short email, a check, a summary of given input);
"medium" = a normal deliverable (a plan, a document, a page of copy, light research);
"large" = heavy work only (code or a multi-file build, a spreadsheet model, deep multi-source research,
long browser work). Most tasks are small or medium; use large only when the task really needs it. Keep it to ${instruction ? '1–3' : '3–7'} focused tasks. Use depends_on (task keys) when a
task needs another's output: think through the order first, so every task has its inputs when it starts.

${briefingStandard()}

Reply with ONLY a JSON object, no other text:
{"summary": "<2–4 sentence message to the founder: the strategy in one line, then who does what, in what order>",
 "tasks": [{"key": "t1", "agent": "<specialist id>", "title": "<short imperative>",
            "brief": "<the complete brief: objective and why, context, step-by-step approach, quality bar>",
            "inputs": ["<file paths or facts the bot must use>"],
            "skills": ["<exact skill names from the catalog>"],
            "acceptance": ["<checkable criterion>", "..."],
            "deliverable": "<the concrete files/artifact to hand back, with format>", "due_in_hours": <number>, "size": "small" | "medium" | "large", "depends_on": ["<key>"]}]}`;

  let parsed;
  let retry = '';
  for (let attempt = 1; ; attempt++) {
    const raw = await streamInto(m, item, {
      system: systemPrompt(ceo()),
      messages: [{ role: 'user', content: `${prompt}${retry}` }],
      effort: 'high',
      json: true,
      kind: 'plan',
      tools: CEO_TOOLS, // read teammates' files and skills, look up skills on the web
      maxTurns: 25,
      demo: () => demoPlan(m.goal, hoursLeft(m), instruction),
    });
    try {
      parsed = extractJson(raw);
      if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) throw new Error('The plan had no tasks.');
      // Clarity gate: no task starts on a vague brief.
      const thin = unclearTasks(parsed.tasks);
      if (thin.length && attempt < 3) {
        retry = `\n\nYour previous plan is not clear enough to start. These tasks need a complete brief (objective and why, context, steps, skills, at least 3 acceptance criteria, exact deliverable): ${thin.join('; ')}. Reply with the full corrected JSON.`;
        continue;
      }
      break;
    } catch (e) {
      if (attempt >= 3) throw new Error(`I couldn't produce a usable plan (${e.message})`);
      retry = '\n\nYour previous reply was not valid JSON. Reply with the JSON object only.';
    }
  }
  const dropped = addTasks(m, item, parsed.tasks);
  item.text = String(parsed.summary || 'Plan ready. Delegating now.') + (dropped.length ? `\n\n_(Skipped ${dropped.length} item(s) I couldn't match to a teammate.)_` : '');

  if (state.settings.approvePlans) {
    item.needsApproval = true;
    m.status = 'awaiting_approval';
    notifyFounder(`🔐 Plan ready for your OK — “${m.title}”. Open Yebunna OS to approve it, or reply “approve” to this message.`, { type: 'plan', id: m.id });
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
  if (m.status !== 'running' || limited()) return; // paused on the usage limit: resume() reschedules
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
  const skills = (t.skills || []).map((name) => {
    const s = skillByName(name);
    return s ? `- ${s.name} → ${s.path ? `Read ${s.path} and follow it` : 'written skill (in your instructions)'}` : `- ${name} → not installed yet: search for it with find-skills (\`npx skills find ${name}\`), install it into .skills/ and use it; if you can't, do the task without it and say so`;
  });
  return `Assignment from ${ceo().name} (CEO)
Company goal: ${m.goal}
Your task: ${t.title}
Brief: ${t.brief}
Deliverable: ${t.deliverable}${t.inputs?.length ? `\nInputs to use:\n${t.inputs.map((x) => `- ${x}`).join('\n')}` : ''}${skills.length ? `\nSkills the CEO picked for this task (open each SKILL.md before you start, and follow it):\n${skills.join('\n')}` : ''}${t.acceptance?.length ? `\nAcceptance criteria (the CEO reviews against these, so check them yourself before handing in):\n${t.acceptance.map((x) => `- ${x}`).join('\n')}` : ''}
Deadline: ${fmt(t.deadline)} (now: ${fmt(now())})
Your folder in the shared workspace: ${workDir}/  (mission folder: ${m.folder}/)
${skill ? `\nUse your skill "${skill.name}":\n${skill.path ? `Read ${skill.path} and follow it.` : skill.body}\n` : ''}${inputs ? `\nInputs from teammates:\n${inputs}` : ''}${revision}

Do the work now — you, not someone else. Check your skills list and use any that fit. Save real artifacts
(code, data, spreadsheets, copy, assets) as files ONLY inside ${workDir}/ — never create other folders
under missions/ and never save duplicate copies elsewhere. Teammates' files are in ${m.folder}/ (read them,
don't copy them). Check your files (e.g. run them) before you finish. Your FINAL message must be the complete deliverable in Markdown (it is filed automatically),
ending with a short "Files" list of everything you saved.

IF YOU ARE STUCK: first try another way (a different source, tool or approach, a teammate's files). If you
still cannot finish, do NOT guess or fake it: hand in whatever partial work you have, and make the LAST line
of your message exactly:
BLOCKED: <what stops you> | NEED: <exactly what would unblock you, and from whom>
The CEO will unblock you or ask the founder. Use it only for real blockers (missing access or login, a
decision or information only the founder has, a tool that fails every time) — not for small doubts.`;
}

async function runTask(m, t) {
  const agent = getAgent(t.agentId);
  if (!agent) {
    t.status = 'failed';
    t.error = 'Agent no longer exists';
    emitTask(t);
    return schedule(m);
  }
  const reviewOnly = t.reviewOnly && t.output; // the limit hit during the CEO review: the work is already done
  t.reviewOnly = false;
  t.status = reviewOnly ? 'review' : 'in_progress';
  t.startedAt = t.startedAt || now();
  const previous = t.output;
  if (!reviewOnly) {
    t.output = '';
    t.reasoning = '';
  }
  emitTask(t);
  const ref = { type: 'task', id: t.id, missionId: m.id };
  logActivity(agent.id, `started “${t.title}”`, ref);
  const track = toolTracker(agent.id, ref);

  // The task's own stop switch (the stall watchdog uses it), tied to the mission's.
  const ctl = new AbortController();
  const stopWithMission = () => ctl.abort();
  signal(m).addEventListener('abort', stopWithMission, { once: true });
  taskRuns.set(t.id, ctl);
  t.lastActivityAt = now();
  t.stalled = false;
  const onEvent = (ev) => {
    t.lastActivityAt = now();
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
        size: t.size,
        maxTurns,
        signal: ctl.signal,
        demo: () => demoOutput(t.agentId, t, m.goal),
      },
      onEvent,
    );

  try {
    const prompt = assignmentPrompt(m, t, agent, previous);
    if (!reviewOnly) try {
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
    const blocker = parseBlocker(t.output);
    if (blocker) {
      t.output = t.output.replace(BLOCKED_LINE, '').trimEnd(); // shown as the blocker box instead
      return handleBlocker(m, t, blocker);
    }

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
      notifyFounder(`🔐 “${t.title}” (${agent.name}) is waiting for your sign-off — mission “${m.title}”. Reply “approve”, or reply with the changes you want.`, { type: 'approval', id: t.id });
    } else {
      finishTask(m, t);
    }
  } catch (e) {
    if (m.status === 'cancelled') return;
    if (t.stalled) {
      t.stalled = false;
      return handleBlocker(m, t, { reason: `No progress for ${Math.round(STALL_MS / 60_000)} minutes — the run was stopped. Last thing it did: ${String(t.reasoning || t.output).trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'nothing yet'}`, need: '' });
    }
    if (isLimitError(e)) {
      // Usage limit: put it back in the queue untouched; it restarts when the limit resets.
      if (t.status === 'review') t.reviewOnly = true;
      else t.output = previous || '';
      t.status = 'queued';
      logActivity(agent.id, `paused “${t.title}” — Claude usage limit reached`, ref);
      return emitTask(t);
    }
    // Any other failure goes to the CEO like a blocker, instead of silently failing the task.
    return handleBlocker(m, t, { reason: `The run failed: ${e.message}`, need: '' });
  } finally {
    taskRuns.delete(t.id);
    signal(m).removeEventListener('abort', stopWithMission);
  }
  emitTask(t);
  schedule(m);
}

/** "BLOCKED: … | NEED: …" on the last lines of a deliverable. */
const BLOCKED_LINE = /^\**BLOCKED:?\**\s*(.+?)(?:\s*\|\s*\**NEED:?\**\s*(.+))?\s*$/im;
export function parseBlocker(text) {
  const tail = String(text || '').trim().split('\n').slice(-4).join('\n');
  const m = tail.match(BLOCKED_LINE);
  return m ? { reason: m[1].trim(), need: (m[2] || '').trim() } : null;
}

/** A bot is stuck: the CEO tries to unblock it; if only the founder can, the founder is asked. */
async function handleBlocker(m, t, blocker) {
  const agent = getAgent(t.agentId);
  const ref = { type: 'task', id: t.id, missionId: m.id };
  t.status = 'blocked';
  t.blocker = { ...blocker, at: now() };
  t.unblocks = (t.unblocks || 0) + 1;
  emitTask(t);
  logActivity(t.agentId, `is blocked on “${t.title}”: ${blocker.reason}`, ref);
  addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `🧱 **${agent?.name}** is blocked on **${t.title}**: ${blocker.reason}${blocker.need ? ` — needs: ${blocker.need}` : ''}. Looking into it.` });

  if (t.unblocks > MAX_UNBLOCKS) {
    return askFounder(m, t, `${agent?.name} is still blocked after ${MAX_UNBLOCKS} tries: ${blocker.reason}${blocker.need ? ` Needs: ${blocker.need}` : ''}`);
  }
  let d;
  try {
    const raw = await complete({
      system: systemPrompt(ceo()),
      messages: [
        {
          role: 'user',
          content: `${agent?.name} (${agent?.role}) is blocked and reported to you.
Mission: ${m.goal}
Task: ${t.title}
Brief: ${t.brief}
Blocker: ${blocker.reason}
What they say would unblock them: ${blocker.need || '(not said)'}
Their partial work:
${clip(t.output, 3000) || '(none)'}

The team (and what each can use):
${teamList()}
Workspace folder for this mission: ${m.folder}/ (you can read files to check)

Decide how to unblock this. Prefer solving it inside the team:
- "retry": the same bot can get past it with your guidance (another approach or source, where a file is, a teammate's output, a tool it already has).
- "reassign": a teammate is better placed (has the access, tool or skill) — name them.
- "founder": ONLY when nobody on the team can do it: a login or password, 2FA, payment, account access or permission, money or publishing approval, a business decision, or information only the founder has.

Reply with ONLY JSON:
{"action": "retry" | "reassign" | "founder", "agent": "<teammate id, for reassign>", "instructions": "<what the bot should do now>", "question": "<for founder: one clear request — exactly what the founder must do or answer>"}`,
        },
      ],
      effort: 'medium',
      tools: CEO_TOOLS,
      agentId: 'ceo',
      kind: 'review',
      maxTurns: 15,
      signal: signal(m),
      demo: () => JSON.stringify({ action: 'founder', question: `Please help ${agent?.name}: ${blocker.need || blocker.reason}` }),
    });
    d = extractJson(raw);
  } catch (e) {
    if (m.status === 'cancelled') return;
    if (isLimitError(e)) return; // stays "blocked"; the CEO picks it up again when the limit resets
    return askFounder(m, t, `${agent?.name} is blocked: ${blocker.reason}${blocker.need ? ` Needs: ${blocker.need}` : ''}`);
  }
  if (m.status === 'cancelled') return;
  const target = d.action === 'reassign' && resolveAgent(d.agent);
  if (d.action === 'founder' || (d.action === 'reassign' && (!target || target.id === 'ceo'))) {
    return askFounder(m, t, String(d.question || d.instructions || blocker.need || blocker.reason));
  }
  if (target && target.id !== t.agentId) {
    addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `Moved **${t.title}** from ${agent?.name} to **${target.name}**: ${d.instructions || ''}` });
    t.agentId = target.id;
  } else {
    addThread(m, { role: 'ceo', kind: 'review', taskId: t.id, text: `Told ${agent?.name} how to get past it: ${d.instructions || 'try another approach.'}` });
  }
  t.feedback = `You (or a teammate) hit a blocker: ${blocker.reason}. CEO's instructions: ${d.instructions || 'try another approach.'} Finish the task.`;
  t.status = 'queued';
  emitTask(t);
  schedule(m);
}

/** Only the founder can unblock this: ask in the thread and on Telegram, then wait. */
function askFounder(m, t, question) {
  t.status = 'founder';
  t.question = question;
  emitTask(t);
  addThread(m, { role: 'ceo', kind: 'escalation', taskId: t.id, text: `🙋 **Needs you** — ${question}\n\nAnswer on the task card (or reply on Telegram) and the team carries on.` });
  logActivity('ceo', `needs the founder for “${t.title}”`, { type: 'task', id: t.id, missionId: m.id });
  notifyFounder(`🙋 Needs you — “${m.title}”\nTask: ${t.title}\n\n${question}\n\nReply to this message with your answer, or answer in Yebunna OS.`, { type: 'task', id: t.id });
  schedule(m);
}

/** The founder answered a blocker: the task goes back to its bot with the answer. */
export function answerTask(t, text) {
  const m = state.missions[t.missionId];
  if (!m || t.status !== 'founder') throw new Error('This task is not waiting for you.');
  addThread(m, { role: 'user', kind: 'text', text: `Re “${t.title}”: ${text}` });
  t.feedback = `You were blocked (${t.blocker?.reason || t.question}). The founder answered: ${text}\nUse this and finish the task.`;
  t.question = null;
  t.unblocks = 0;
  t.status = 'queued';
  emitTask(t);
  if (m.status === 'done' || m.status === 'failed') m.status = 'running';
  emitMission(m);
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
  if (t.reasoning?.length > 20_000) t.reasoning = `…${t.reasoning.slice(-20_000)}`; // keep saved data small
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
${t.acceptance?.length ? `Acceptance criteria:\n${t.acceptance.map((x) => `- ${x}`).join('\n')}\n` : ''}
Deliverable:
${clip(t.output, 8000)}

Approve only if it meets every acceptance criterion and is specific, verified and premium, not generic. Otherwise ask for a revision with precise, actionable feedback.
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
    if (e.message === 'aborted' || isLimitError(e)) throw e;
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
      if (isLimitError(e)) {
        // Write the report when the limit resets (schedule() calls report() again).
        m.thread = m.thread.filter((it) => it !== item);
        m.status = 'running';
        m.waitingLimit = true;
        return emitMission(m);
      }
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
  if (m.source === 'founder') notifyFounder(`✅ Mission complete — “${m.title}”. ${tasks.filter((t) => t.status === 'done').length}/${tasks.length} tasks delivered. The report is in Yebunna OS — reply here with comments or next steps.`, { type: 'mission', id: m.id });
  bus.emit('trigger', { event: 'mission_completed', mission: m });
}

function fail(m, e) {
  if (m.status === 'cancelled') return;
  if (isLimitError(e)) {
    // Hit the usage limit while planning: plan again when it resets.
    for (const item of m.thread) item.streaming = false;
    m.thread = m.thread.filter((it) => !(it.kind === 'plan' && !it.taskIds?.length));
    m.status = 'planning';
    m.waitingLimit = true;
    return emitMission(m);
  }
  console.error(`mission ${m.id} failed:`, e.message);
  for (const item of m.thread) item.streaming = false;
  m.status = 'failed';
  notifyFounder(`⚠️ Mission “${m.title}” stopped: ${e.message}. Open Yebunna OS to retry.`, { type: 'mission', id: m.id });
  addThread(m, { role: 'ceo', kind: 'escalation', text: `Something broke: ${e.message}. Send a follow-up ("Delegate to team") to try again.` });
}

// ---- usage limit: pause and resume ------------------------------------------

bus.on('limit.hit', (limit) => {
  const when = new Date(limit.resetAt).toLocaleString();
  for (const m of Object.values(state.missions)) {
    if (!['running', 'planning', 'reporting'].includes(m.status)) continue;
    if (limit.kind === 'disk') {
      addThread(m, { role: 'ceo', kind: 'review', text: '⏸ Paused — the disk is almost full. Work in progress went back in the queue and restarts by itself once there is free space (Settings → Storage shows what is using it).' });
      continue;
    }
    addThread(m, { role: 'ceo', kind: 'review', text: `⏸ Paused — your Claude usage limit was reached. Work in progress went back in the queue and restarts automatically ${limit.known ? `when the limit resets (${when})` : `at ${when} (I check again every couple of hours)`}.` });
  }
});

bus.on('limit.reset', () => {
  for (const m of Object.values(state.missions)) {
    if (['cancelled', 'done', 'failed'].includes(m.status) && !m.waitingLimit) continue;
    const wasWaiting = m.waitingLimit || missionTasks(m).some((t) => t.status === 'queued' || t.status === 'blocked');
    m.waitingLimit = false;
    if (!wasWaiting && m.status !== 'running') continue;
    if (m.status === 'planning' && !missionTasks(m).length) {
      addThread(m, { role: 'ceo', kind: 'review', text: '▶️ The usage limit has reset — planning now.' });
      plan(m).catch((e) => fail(m, e));
      continue;
    }
    if (m.status === 'planning') m.status = 'running';
    if (wasWaiting) addThread(m, { role: 'ceo', kind: 'review', text: '▶️ The usage limit has reset — the team is back at work.' });
    for (const t of missionTasks(m)) {
      if (t.status === 'blocked' && t.blocker) {
        t.unblocks = Math.max(0, (t.unblocks || 1) - 1);
        handleBlocker(m, t, t.blocker);
      }
    }
    drainQueue(m);
    schedule(m);
  }
});

// ---- stall watchdog: the CEO checks that work is really moving ----------------

setInterval(() => {
  const t0 = Date.now();
  for (const [taskId, ctl] of taskRuns) {
    const t = state.tasks[taskId];
    if (!t || t.status !== 'in_progress' || !t.lastActivityAt) continue;
    if (t0 - Date.parse(t.lastActivityAt) < STALL_MS) continue;
    // No output, thinking or tool use for too long: stop the run; the CEO works out why.
    t.stalled = true;
    logActivity('ceo', `stopped “${t.title}”: no progress for ${Math.round(STALL_MS / 60_000)} minutes`, { type: 'task', id: t.id, missionId: t.missionId });
    ctl.abort();
  }
}, 60_000).unref();

// ---- deadline watchdog ------------------------------------------------------

setInterval(() => {
  const t0 = Date.now();
  for (const t of Object.values(state.tasks)) {
    if (t.overdue || ['done', 'failed', 'founder'].includes(t.status) || Date.parse(t.deadline) > t0) continue;
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
