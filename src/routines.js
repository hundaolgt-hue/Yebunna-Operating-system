// Routines: work that runs on a schedule (every N hours, daily, weekly) or after an
// event (a mission or task completes) — Grok Bot's schedules and triggers.
// A routine can assign a task to one bot, run a skill, have the CEO plan a whole
// mission, or call a team standup.
import { getAgent, specialists } from './agents.js';
import { state, save, newId, now } from './store.js';
import { bus, createMission, createMissionWithTasks } from './orchestrator.js';
import { startMeeting } from './meetings.js';
import { runSkill } from './skills.js';

const emit = (r) => {
  save();
  bus.emit('event', { type: 'routine', routine: r });
};

export function nextRun(schedule, from = Date.now()) {
  const at = (d, time = '09:00') => {
    const [h, m] = String(time).split(':').map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  };
  switch (schedule.type) {
    case 'interval':
      return new Date(from + Math.max(1, Number(schedule.hours) || 24) * 36e5).toISOString();
    case 'daily': {
      const d = at(new Date(from), schedule.time);
      if (d.getTime() <= from) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    case 'weekly': {
      const d = at(new Date(from), schedule.time);
      const day = Number(schedule.day ?? 1);
      d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7));
      if (d.getTime() <= from) d.setDate(d.getDate() + 7);
      return d.toISOString();
    }
    default:
      return null; // event triggers have no clock
  }
}

function validate(r) {
  if (!['assignment', 'skill', 'mission', 'standup'].includes(r.kind)) throw new Error('Unknown routine type');
  if ((r.kind === 'assignment' || r.kind === 'skill') && (!getAgent(r.agentId) || r.agentId === 'ceo')) throw new Error('Pick a bot for this routine');
  if (r.kind === 'skill' && !state.skills[r.skillId]) throw new Error('Pick a skill');
  if ((r.kind === 'assignment' || r.kind === 'mission') && !r.instruction?.trim()) throw new Error('Write what the routine should do');
  if (!['interval', 'daily', 'weekly', 'trigger'].includes(r.schedule?.type)) throw new Error('Pick a schedule');
}

export function createRoutine(input) {
  const r = {
    id: newId('rtn'),
    name: String(input.name || 'Routine').slice(0, 80),
    kind: input.kind,
    agentId: input.agentId || null,
    skillId: input.skillId || null,
    instruction: input.instruction || '',
    participants: input.participants || null,
    schedule: input.schedule || { type: 'daily', time: '09:00' },
    deadlineHours: Number(input.deadlineHours) || 4,
    enabled: input.enabled !== false,
    runs: [],
    createdAt: now(),
  };
  validate(r);
  r.nextRunAt = nextRun(r.schedule);
  state.routines[r.id] = r;
  emit(r);
  return r;
}

export function updateRoutine(r, patch) {
  for (const k of ['name', 'kind', 'agentId', 'skillId', 'instruction', 'participants', 'schedule', 'deadlineHours', 'enabled']) {
    if (patch[k] !== undefined) r[k] = patch[k];
  }
  validate(r);
  r.nextRunAt = r.enabled ? nextRun(r.schedule) : null;
  emit(r);
  return r;
}

export function deleteRoutine(r) {
  delete state.routines[r.id];
  save();
  bus.emit('event', { type: 'routine.deleted', id: r.id });
}

export function fireRoutine(r, reason = 'manual') {
  const source = `routine:${r.id}`;
  const deadline = new Date(Date.now() + r.deadlineHours * 36e5).toISOString();
  const run = { at: now(), reason };
  try {
    if (r.kind === 'assignment') {
      const m = createMissionWithTasks({
        goal: `${r.name}: ${r.instruction}`,
        deadline,
        specs: [{ agent: r.agentId, title: r.name, brief: r.instruction, deliverable: 'The routine output, ready to use', due_in_hours: r.deadlineHours }],
        intro: `Routine **${r.name}** fired (${reason}). Assigned to ${getAgent(r.agentId).name}.`,
        source,
      });
      run.ref = { type: 'mission', id: m.id };
    } else if (r.kind === 'skill') {
      const m = runSkill(state.skills[r.skillId], { input: r.instruction, deadlineHours: r.deadlineHours, agentId: r.agentId });
      m.source = source;
      run.ref = { type: 'mission', id: m.id };
    } else if (r.kind === 'mission') {
      const m = createMission({ goal: r.instruction, deadline, source });
      run.ref = { type: 'mission', id: m.id };
    } else if (r.kind === 'standup') {
      const mt = startMeeting({
        kind: 'standup',
        title: `${r.name} · ${new Date().toLocaleDateString()}`,
        participants: r.participants?.length ? r.participants : specialists().map((a) => a.id).slice(0, 6),
        rounds: 1,
        deadlineHours: r.deadlineHours,
        autoLaunch: true,
        source,
      });
      run.ref = { type: 'meeting', id: mt.id };
    }
  } catch (e) {
    run.error = e.message;
  }
  r.runs = [run, ...r.runs].slice(0, 20);
  r.lastRunAt = run.at;
  r.nextRunAt = r.enabled ? nextRun(r.schedule) : null;
  emit(r);
  return run;
}

// Clock: check every 20 seconds for routines that are due.
setInterval(() => {
  const t = Date.now();
  for (const r of Object.values(state.routines)) {
    if (r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= t) fireRoutine(r, 'schedule');
  }
}, 20_000).unref();

// Event triggers. Work started by a routine never fires triggers, so two routines
// can't set each other off in an endless loop.
bus.on('trigger', ({ event, mission, task }) => {
  const m = mission || (task && state.missions[task.missionId]);
  if (m?.source?.startsWith('routine:')) return;
  for (const r of Object.values(state.routines)) {
    if (!r.enabled || r.schedule.type !== 'trigger' || r.schedule.event !== event) continue;
    fireRoutine(r, event === 'mission_completed' ? `mission done: ${m?.title}` : `task done: ${task?.title}`);
  }
});
