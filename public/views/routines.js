import { S, $, $$, api, esc, avatar, agentName, toast, view, openDialog, onSubmit, agentOptions, span, ago } from '../core.js';

const KIND = {
  assignment: '📌 Assign a task to a bot',
  skill: '🧩 Run a skill',
  mission: '🚀 CEO plans a mission',
  standup: '☀️ Team standup',
  retro: '🔁 Retrospective (lessons → playbook rules)',
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EVENTS = { mission_completed: 'a mission is completed', task_completed: 'any task is completed' };

function when(s) {
  if (s.type === 'interval') return `Every ${s.hours} hour${Number(s.hours) === 1 ? '' : 's'}`;
  if (s.type === 'daily') return `Daily at ${s.time}`;
  if (s.type === 'weekly') return `Every ${DAYS[s.day]} at ${s.time}`;
  return `When ${EVENTS[s.event] || s.event}`;
}

export function renderRoutines() {
  const list = Object.values(S.routines).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  view().innerHTML = `<div class="page">
    <div class="page-head"><h2>Routines</h2><p>Work that runs by itself — on a schedule or after an event. Leave this app running for routines to fire.</p>
      <span class="spacer"></span><button class="btn" data-new>New routine</button></div>
    ${
      list.length
        ? `<div class="list">${list.map(row).join('')}</div>`
        : '<div class="empty-hero"><div class="big">⏰</div><h3>Nothing scheduled yet</h3><p>Examples: a 9:00 daily standup, a weekly competitor scan by Nova, or “when a mission finishes, have Echo write launch posts”.</p><button class="btn" data-new2>Create a routine</button></div>'
    }
  </div>`;
  const v = view();
  $('[data-new]', v).addEventListener('click', () => routineDialog());
  $('[data-new2]', v)?.addEventListener('click', () => routineDialog());
  $$('[data-run]', v).forEach((b) => b.addEventListener('click', () => api(`/api/routines/${b.dataset.run}/run`, { method: 'POST' }).then((r) => (r.error ? toast(r.error) : toast('Routine started.')))));
  $$('[data-toggle-r]', v).forEach((b) => b.addEventListener('change', () => api(`/api/routines/${b.dataset.toggleR}`, { method: 'PUT', body: { enabled: b.checked } }).catch((e) => toast(e.message))));
  $$('[data-edit]', v).forEach((b) => b.addEventListener('click', () => routineDialog(S.routines[b.dataset.edit])));
  $$('[data-del]', v).forEach((b) => b.addEventListener('click', async () => confirm('Delete this routine?') && api(`/api/routines/${b.dataset.del}`, { method: 'DELETE' })));
}

function row(r) {
  const next = r.nextRunAt ? (Date.parse(r.nextRunAt) > Date.now() ? `next in ${span(Date.parse(r.nextRunAt) - Date.now())}` : 'due now') : r.schedule.type === 'trigger' ? 'waiting for event' : '';
  const runs = r.runs.slice(0, 3).map((run) =>
    run.error
      ? `<span class="run bad" title="${esc(run.error)}">✕ ${ago(run.at)}</span>`
      : `<a class="run" href="${run.ref?.type === 'meeting' ? `#/meetings/${run.ref.id}` : `#/m/${run.ref?.id}`}">✓ ${ago(run.at)}</a>`,
  );
  return `<div class="list-row">
    <label class="switch" title="On/off"><input type="checkbox" data-toggle-r="${r.id}" ${r.enabled ? 'checked' : ''}/><span></span></label>
    <div class="grow"><div class="t">${esc(r.name)}</div>
      <div class="s">${KIND[r.kind]}${r.agentId ? ` · ${esc(agentName(r.agentId))}` : ''}${r.skillId && S.skills[r.skillId] ? ` · ${esc(S.skills[r.skillId].name)}` : ''} · ${when(r.schedule)}${r.enabled && next ? ` · ${next}` : ''}</div>
      ${runs.length ? `<div class="runs">${runs.join('')}</div>` : ''}</div>
    ${r.agentId ? avatar(r.agentId, 'sm') : ''}
    <button class="btn-ghost" data-run="${r.id}">▶ Run now</button>
    <button class="btn-ghost" data-edit="${r.id}">Edit</button>
    <button class="icon-btn" data-del="${r.id}" title="Delete">✕</button>
  </div>`;
}

function routineDialog(r) {
  const s = r?.schedule || { type: 'daily', time: '09:00', day: 1, hours: 24, event: 'mission_completed' };
  const skills = Object.values(S.skills).filter((x) => x.status === 'active');
  openDialog(
    r ? `Edit routine` : 'New routine',
    `<form class="form" data-form>
      <label>Name<input name="name" required value="${esc(r?.name || '')}" placeholder="e.g. Weekly competitor scan" /></label>
      <label>What should happen?<select name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${r?.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label data-for="assignment skill">Bot<select name="agentId">${agentOptions(r?.agentId || 'research')}</select></label>
      <label data-for="skill">Skill<select name="skillId">${skills.map((x) => `<option value="${x.id}" ${r?.skillId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('') || '<option value="">No active skills yet</option>'}</select></label>
      <label data-for="assignment skill mission">Instructions<textarea name="instruction" rows="3" placeholder="What to do each time (for a mission: the goal for the CEO)">${esc(r?.instruction || '')}</textarea></label>
      <div class="grid2">
        <label>When<select name="stype">
          <option value="daily" ${s.type === 'daily' ? 'selected' : ''}>Every day</option>
          <option value="weekly" ${s.type === 'weekly' ? 'selected' : ''}>Every week</option>
          <option value="interval" ${s.type === 'interval' ? 'selected' : ''}>Every N hours</option>
          <option value="trigger" ${s.type === 'trigger' ? 'selected' : ''}>After an event (trigger)</option>
        </select></label>
        <label data-when="daily weekly">At<input type="time" name="time" value="${esc(s.time || '09:00')}" /></label>
        <label data-when="weekly">On<select name="day">${DAYS.map((d, i) => `<option value="${i}" ${Number(s.day) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label data-when="interval">Every (hours)<input type="number" min="1" name="hours" value="${esc(s.hours || 24)}" /></label>
        <label data-when="trigger">When<select name="event">${Object.entries(EVENTS).map(([k, l]) => `<option value="${k}" ${s.event === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Deadline for the work<select name="deadlineHours">${[1, 4, 24, 72].map((h) => `<option value="${h}" ${Number(r?.deadlineHours || 4) === h ? 'selected' : ''}>${h < 24 ? `${h} hour${h > 1 ? 's' : ''}` : `${h / 24} day${h > 24 ? 's' : ''}`}</option>`).join('')}</select></label>
      </div>
      <div class="row-btns end"><button class="btn" type="submit">${r ? 'Save' : 'Create routine'}</button></div>
    </form>`,
    (dlg, close) => {
      const form = $('[data-form]', dlg);
      const sync = () => {
        const kind = form.elements.kind.value;
        const st = form.elements.stype.value;
        $$('[data-for]', form).forEach((el) => (el.hidden = !el.dataset.for.split(' ').includes(kind)));
        $$('[data-when]', form).forEach((el) => (el.hidden = !el.dataset.when.split(' ').includes(st)));
      };
      form.addEventListener('change', sync);
      sync();
      onSubmit(form, async (d) => {
        const schedule = { type: d.stype, time: d.time, day: Number(d.day), hours: Number(d.hours), event: d.event };
        const body = {
          name: d.name,
          kind: d.kind,
          agentId: ['assignment', 'skill'].includes(d.kind) ? d.agentId : null,
          skillId: d.kind === 'skill' ? d.skillId : null,
          instruction: d.instruction,
          schedule,
          deadlineHours: Number(d.deadlineHours),
        };
        await api(r ? `/api/routines/${r.id}` : '/api/routines', { method: r ? 'PUT' : 'POST', body });
        close();
        toast(r ? 'Routine saved.' : 'Routine created.');
      });
    },
  );
}
