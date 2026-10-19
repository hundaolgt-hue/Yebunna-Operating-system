// The CEO loop: plan → (optional founder approval) → delegate with deadlines →
// agents work in the shared workspace ONE TASK AT A TIME across the company, in the
// order the CEO planned (oldest mission first) → CEO review → (optional founder
// approval) → short handover to the next task → mission report. A watchdog escalates
// anything that misses its deadline. Founder changes to assigned work edit that task
// (new brief or redo) instead of creating new tasks.
//
// Robustness rules: a mission never silently stops. Follow-ups and questions that
// fail don't kill the mission, runs that hit their step budget are finished or
// retried, a failed CEO review doesn't fail the deliverable, and the final report
// falls back to a written summary if the CEO can't produce one.
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, systemPrompt, toolsFor, resolveAgent, specialists, skillCatalog, skillByName } from './agents.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now, slugify, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { logActivity, toolTracker } from './activity.js';
import { demoPlan, demoOutput, demoReview, demoSummary } from './demo.js';
import { connectedServices } from './connections.js';
import { limited, isLimitError } from './limits.js';
import { notifyFounder } from './telegram.js';

export { bus };

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
const briefingStandard = () => `BRIEF STANDARD (complete, no filler): 1) objective and why; 2) inputs: file paths
(missions/..., references/...), facts, decisions made; 3) steps and the quality bar; 4) skills: exact names from
the catalog (none fits → tell the bot to find one with find-skills); 5) 3+ checkable acceptance criteria;
6) exact deliverable (files, format, language). No spending, posting or publishing unless the founder asked.

SKILL CATALOG (name: what it does):
${skillCatalog() || '- (no skills installed yet)'}`;

/** Tasks whose brief isn't clear enough to start (too short, no acceptance criteria). */
function unclearTasks(tasks) {
  return tasks
    .filter((t) => String(t.brief || '').length < 200 || !Array.isArray(t.acceptance) || t.acceptance.length < 2)
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
      return `- "${a.id}" = ${a.name}, ${a.role}${extra.length ? ` · can use: ${extra.join(', ')}` : ''}`;
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
  if (!source || source === 'founder') state.ceoContextAt = m.createdAt; // a new product: the CEO chat starts fresh
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
  setTimeout(dispatch, 0); // the next mission in line goes on
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

  for (const s of inOrder(valid)) {
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

/** Tasks run one at a time in plan order: make sure each comes after the tasks it depends on. */
function inOrder(specs) {
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const out = [];
  const seen = new Set();
  const visit = (s) => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    for (const k of s.depends_on || []) if (byKey.has(k)) visit(byKey.get(k));
    out.push(s);
  };
  specs.forEach(visit);
  return out;
}

async function plan(m, instruction) {
  m.status = 'planning';
  emitMission(m);
  const item = addThread(m, { role: 'ceo', kind: 'plan', taskIds: [] });

  const existing = missionTasks(m)
    .map((t) => `- id ${t.id} [${t.status}] ${t.title} → ${getAgent(t.agentId)?.name}`)
    .join('\n');
  const prompt = `Product / mission: ${m.goal}
Now: ${fmt(now())} · deadline: ${fmt(m.deadline)} (${hoursLeft(m).toFixed(1)} h left)
${existing ? `\nTasks already assigned in this mission:\n${existing}\n` : ''}
${
    instruction
      ? `The founder says: ${instruction}
First decide what this is. If it changes, corrects or adds detail to work already assigned, put it in "edits"
(by task id) and add NO task for it. Add a task only for genuinely new work no existing task covers. "tasks"
may be empty.`
      : 'Plan the work to ship this product.'
  }

Tasks run ONE AT A TIME, in the order you list them; each starts only after the previous one is reviewed
and handed over. Order them so every task has its inputs. Assign each task to the one specialist who owns
that kind of deliverable (your ownership map). Specialists (use the quoted id in "agent"):
${teamList()}

Each task: a deadline in hours from now inside the mission deadline, and a size (sets its step budget):
"small" (a list, a check, short copy), "medium" (a document, a page, light research), "large" (code, a
spreadsheet model, deep research, video). ${instruction ? '0–3' : '3–6'} tasks.

${briefingStandard()}

Reply with ONLY JSON:
{"summary": "<1–2 short sentences for the founder: what happens, in what order>",
 "edits": [{"task": "<existing task id>", "change": "<the change, complete and specific>"}],
 "tasks": [{"key": "t1", "agent": "<specialist id>", "title": "<short imperative>", "brief": "<the brief>",
            "inputs": ["<paths or facts>"], "skills": ["<exact skill names>"], "acceptance": ["<criterion>", "..."],
            "deliverable": "<files and format>", "due_in_hours": <number>, "size": "small" | "medium" | "large", "depends_on": ["<key>"]}]}`;

  let parsed;
  let retry = '';
  for (let attempt = 1; ; attempt++) {
    const raw = await streamInto(m, item, {
      system: systemPrompt(ceo()),
      messages: [{ role: 'user', content: `${prompt}${retry}` }],
      effort: 'high',
      json: true,
      kind: 'plan',
      agentId: 'ceo',
      tools: CEO_TOOLS, // read teammates' files and skills, look up skills on the web
      maxTurns: 25,
      demo: () => demoPlan(m.goal, hoursLeft(m), instruction),
    });
    try {
      parsed = extractJson(raw);
      parsed.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      parsed.edits = (Array.isArray(parsed.edits) ? parsed.edits : []).filter((e) => state.tasks[e?.task]?.missionId === m.id && e.change);
      if (!parsed.tasks.length && !(instruction && parsed.edits.length)) throw new Error('The plan had no tasks.');
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
  for (const e of parsed.edits) amendTask(state.tasks[e.task], String(e.change), { quiet: true });
  const dropped = parsed.tasks.length ? addTasks(m, item, parsed.tasks) : [];
  const edited = parsed.edits.map((e) => `✏️ Updated **${state.tasks[e.task].title}**: ${e.change}`);
  item.text = [String(parsed.summary || 'Plan ready.'), ...edited].join('\n\n') + (dropped.length ? `\n\n_(Skipped ${dropped.length} item(s) I couldn't match to a teammate.)_` : '');
  if (!parsed.tasks.length) {
    // Only edits: no new plan to approve, the work carries on.
    item.kind = 'review';
    m.status = 'running';
    emitMission(m);
    schedule(m);
    return drainQueue(m);
  }

  if (state.settings.approvePlans) {
    item.needsApproval = true;
    m.status = 'awaiting_approval';
    notifyFounder(`🔐 Plan ready for your OK — “${m.title}”. Open Yebunna OS to approve it, or reply “approve” to this message.`, { type: 'plan', id: m.id });
    emitMission(m);
    dispatch();
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
    .map((t) => `### ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', late' : ''}], due ${fmt(t.deadline)}\n${clip(t.output, 600)}`)
    .join('\n\n');
  await streamInto(m, item, {
    system: systemPrompt(ceo()),
    messages: [
      {
        role: 'user',
        content: `Mission: ${m.goal}\nDeadline: ${fmt(m.deadline)}\nFiles: ${m.folder}/\n\nTeam progress:\n${status || '(nothing yet)'}\n\nFounder asks: ${question}\n\nAnswer as the CEO in a few short lines (you may read the team's files to check). Don't do specialist work; if work is needed, say so — the founder can switch the box to "Delegate to team".`,
      },
    ],
    tools: CEO_TOOLS,
    agentId: 'ceo',
    kind: 'chat',
    maxTurns: 12,
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

  if (tasks.every((t) => ['done', 'failed'].includes(t.status))) {
    report(m).catch((e) => fail(m, e));
  }
  dispatch();
}

const BUSY = ['in_progress', 'review'];
const FINISHED = ['done', 'failed'];

/**
 * One specialist works at a time across the whole company. The next task starts only when the
 * previous one is reviewed and handed over: oldest mission first, tasks in plan order. A mission
 * whose next task waits on the founder (or on the CEO unblocking it) lets the next mission go.
 */
function dispatch() {
  if (limited()) return;
  if (Object.values(state.tasks).some((t) => BUSY.includes(t.status))) return;
  const missions = Object.values(state.missions)
    .filter((m) => m.status === 'running' || m.status === 'planning')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const m of missions) {
    if (m.status === 'planning') return; // an older mission is being planned: it goes first
    const next = missionTasks(m).find((t) => !FINISHED.includes(t.status));
    if (!next || next.status !== 'queued') continue;
    if (!next.dependsOn.every((id) => FINISHED.includes(state.tasks[id]?.status ?? 'done'))) continue;
    next.status = 'in_progress'; // claim it now, so nothing else starts before the run begins
    runTask(m, next).catch((e) => {
      console.error('task crashed', e);
      next.status = 'failed';
      next.error = e.message;
      emitTask(next);
      schedule(m);
    });
    return;
  }
}

/** The short handover a finished task passes on (its final message), for the tasks after it. */
const handoverOf = (t) => clip(String(t.output || '').trim(), 1500);

function assignmentPrompt(m, t, agent) {
  // Everything handed over earlier in this mission, in order (short handovers, not full outputs).
  const before = missionTasks(m).slice(0, m.taskIds.indexOf(t.id));
  const inputs = before
    .filter((d) => d.status === 'done')
    .map((d) => `### ${getAgent(d.agentId)?.name}: ${d.title}\n${handoverOf(d)}`)
    .join('\n\n');
  const skill = t.skillId && state.skills[t.skillId];
  const workDir = `${m.folder}/${slugify(agent.name, 20)}`;
  const revision = t.feedback ? `\n\nCHANGE REQUESTED: ${t.feedback}\nYour earlier files are in ${workDir}/: update them; don't start over unless the change needs it.` : '';
  const named = (t.skills || []).map((name) => ({ name, s: skillByName(name) }));
  const skills = named.map(({ name, s }) => (s ? `- ${s.name} → ${s.path ? `Read ${s.path} and follow it` : 'written skill, below'}` : `- ${name} → not installed: find it with find-skills (\`npx skills find ${name}\`) and install it into .skills/, or work without it and say so`));
  const writtenBodies = [skill, ...named.map((x) => x.s)].filter((s, i, all) => s && !s.path && all.indexOf(s) === i).map((s) => `### Skill: ${s.name}\n${s.body}`);
  return `Task from ${ceo().name} (CEO): ${t.title}
Product: ${m.goal}
Brief: ${t.brief}
Deliverable: ${t.deliverable}${t.inputs?.length ? `\nInputs:\n${t.inputs.map((x) => `- ${x}`).join('\n')}` : ''}${skills.length ? `\nSkills (open each before you start):\n${skills.join('\n')}` : ''}${t.acceptance?.length ? `\nAcceptance criteria (check them yourself before handing in):\n${t.acceptance.map((x) => `- ${x}`).join('\n')}` : ''}
Deadline: ${fmt(t.deadline)} (now ${fmt(now())})
Save files ONLY in ${workDir}/ (mission folder ${m.folder}/; read teammates' files there, don't copy them).
${skill?.path ? `\nUse your skill "${skill.name}": Read ${skill.path} and follow it.\n` : ''}${writtenBodies.length ? `\n${writtenBodies.join('\n\n')}\n` : ''}${inputs ? `\nHANDED OVER BY TEAMMATES (open their files when you need detail):\n${inputs}` : ''}${revision}

Do the work now, in files. Check them (e.g. run them) before you finish.
Your FINAL message is only the handover, at most 150 words, exactly in this form:
RESULT: <one line>
FILES: <paths you saved>
KEY POINTS: <up to 5 short bullets: decisions, numbers, what the next teammate must know>
OPEN: <anything unresolved, or "none">

If you are truly stuck (missing access or login, a decision only the founder can make, a tool that fails
every time), try another way first; then hand in what you have and make the LAST line exactly:
BLOCKED: <what stops you> | NEED: <what would unblock you, and from whom>`;
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
  t.amendPending = null;
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
        effort: 'medium',
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
    const prompt = assignmentPrompt(m, t, agent);
    if (!reviewOnly) try {
      await run(prompt, agent.computer ? 150 : 100);
    } catch (e) {
      if (e.code !== 'max_turns') throw e;
      // Out of steps: hand in what we have, or take one short "wrap it up" pass.
      if ((e.partial || t.output).length < 400) {
        logActivity(agent.id, `ran long on “${t.title}” — wrapping up`, ref);
        t.output = '';
        await run(`${prompt}\n\nIMPORTANT: you already worked on this and ran out of steps. Do NOT start over or explore further. Check the files you already saved in ${m.folder}/, fix only what is essential, and write the handover now.`, 25);
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
    if (t.amendPending) {
      // The founder changed this task while it was being reviewed: redo it with the change.
      t.feedback = t.amendPending;
      t.amendPending = null;
      t.status = 'queued';
    } else if (review.verdict === 'revise' && t.revisions < MAX_REVISIONS) {
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
    if (t.amendPending) {
      // Stopped because the founder changed the task: start again with the change.
      t.feedback = t.amendPending;
      t.amendPending = null;
      t.status = 'queued';
      emitTask(t);
      return schedule(m);
    }
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
  bus.emit('trigger', { event: 'task_completed', task: t });
}

/**
 * The founder changed a task that is already assigned: update it instead of creating new work.
 * Queued → the brief gets the change. Running or in review → it restarts with the change.
 * Done, waiting for sign-off or failed → it is redone with the change. Waiting on the founder →
 * the change is their answer.
 */
export function amendTask(t, change, { quiet = false } = {}) {
  const m = state.missions[t.missionId];
  if (!m) throw new Error('mission not found');
  change = String(change).trim();
  if (!quiet) addThread(m, { role: 'user', kind: 'text', text: `✏️ Change to “${t.title}”: ${change}` });
  if (t.status === 'founder') return answerTask(t, change);
  if (t.status === 'queued') {
    t.brief = `${t.brief}\n\nFOUNDER CHANGE: ${change}`;
  } else if (BUSY.includes(t.status)) {
    t.amendPending = change;
    if (t.status === 'in_progress') taskRuns.get(t.id)?.abort();
  } else if (t.status === 'blocked') {
    t.feedback = `${t.feedback || ''}\nFounder change: ${change}`.trim();
  } else {
    // done, approval or failed: redo it with the change (doesn't count as a CEO revision).
    t.feedback = change;
    t.error = null;
    t.status = 'queued';
  }
  emitTask(t);
  logActivity('ceo', `updated “${t.title}” with the founder's change`, { type: 'task', id: t.id, missionId: m.id });
  if (['done', 'failed'].includes(m.status)) m.status = 'running';
  emitMission(m);
  schedule(m);
  return t;
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
          content: `Review ${agent.name}'s work.
Task: ${t.title}
Expected deliverable: ${t.deliverable}
${t.acceptance?.length ? `Acceptance criteria:\n${t.acceptance.map((x) => `- ${x}`).join('\n')}\n` : ''}
Handover:
${clip(t.output, 3000)}

Spot-check the main file it lists (Read; a quick look, not a full re-read). Approve only if it meets every
criterion and is specific and premium. Otherwise ask for a revision.
Reply with ONLY JSON: {"verdict": "approve" | "revise", "feedback": "<one sentence, exact fix>"}`,
        },
      ],
      effort: 'low',
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: 8,
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
  const content = `All work for this mission is finished. Write the report for the founder.
Product: ${m.goal}
Deadline: ${fmt(m.deadline)} — now ${fmt(now())} · folder ${m.folder}/

${tasks
  .map((t) => `## ${t.title} — ${getAgent(t.agentId)?.name} [${t.status}${t.late ? ', LATE' : ''}${t.error ? `: ${t.error}` : ''}]\n${clip(t.output, 1200)}`)
  .join('\n\n')}

At most 150 words: what shipped (key files), the key numbers and decisions, gaps, the next 3 moves.
Don't retell each task.`;
  let text = '';
  for (let attempt = 1; attempt <= 2 && !text.trim(); attempt++) {
    item.text = '';
    try {
      text = await streamInto(m, item, { system: systemPrompt(ceo()), messages: [{ role: 'user', content }], agentId: 'ceo', kind: 'report', maxTurns: 5, demo: () => demoSummary(m, tasks) });
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
  setTimeout(dispatch, 0); // a failed or paused plan must not hold up other missions
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
