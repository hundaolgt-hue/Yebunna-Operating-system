import {
  S, $, $$, api, esc, markdown, avatar, toast, due, missionDue, STATUS_LABEL, MISSION_LABEL,
  missionTasks, thinking, composer, wireComposer, view, speakBtn, fileUrl,
} from '../core.js';

function taskCard(t, focusId) {
  const a = S.agentById[t.agentId] || { name: 'Removed bot', role: '' };
  const open = S.expanded.has(t.id);
  const d = due(t);
  const working = t.status === 'in_progress';
  return `<div class="task ${focusId === t.id ? 'focus' : ''}" id="task-${t.id}">
    <div class="task-head" data-toggle="${t.id}">
      ${avatar(t.agentId)}
      <div class="task-title">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${esc(a.name)} · ${esc(a.role)}${t.revisions ? ` · revision ${t.revisions}` : ''}${t.skillId && S.skills[t.skillId] ? ` · skill: ${esc(S.skills[t.skillId].name)}` : ''}</div>
      </div>
      <div class="task-side">
        <span class="status ${t.status}">${STATUS_LABEL[t.status]}</span>
        <span class="due ${d.cls}" data-due="${t.id}">${d.text}</span>
      </div>
    </div>
    ${open ? `<div class="task-body speakable">
      <dl class="brief">
        <dt>Brief</dt><dd>${esc(t.brief)}</dd>
        <dt>Deliverable</dt><dd>${esc(t.deliverable)}</dd>
        <dt>Deadline</dt><dd>${new Date(t.deadline).toLocaleString()}</dd>
        ${t.file ? `<dt>File</dt><dd><a class="link" href="#/files?f=${encodeURIComponent(t.file)}">${esc(t.file)}</a> · <a class="link" href="${fileUrl(t.file, true)}">download</a></dd>` : ''}
      </dl>
      ${t.reasoning || working ? thinking({ reasoning: t.reasoning, streaming: working, text: t.output }, `task:${t.id}`) : ''}
      <div class="md ${working ? 'cursor' : ''}" data-stream="task:${t.id}:output">${t.output ? markdown(t.output) : `<span class="${working ? 'shimmer' : ''}" style="color:var(--faint)">${t.status === 'queued' ? 'Waiting for dependencies or a free slot…' : working ? `${esc(a.name)} is working…` : ''}</span>`}</div>
      ${t.error ? `<div class="review-note" style="color:var(--bad)">${esc(t.error)}</div>` : ''}
      ${t.review ? `<div class="review-note">${avatar('ceo', 'sm')} <b>${esc(S.agentById.ceo?.name)}:</b> ${esc(t.review.feedback)}</div>` : ''}
      ${t.status === 'approval' ? `<form class="approval" data-decide="${t.id}">
          <div class="approval-title">🔐 Waiting for your sign-off</div>
          <input name="feedback" placeholder="What should change? (only needed to request changes)" />
          <div class="row-btns"><button class="btn" name="approve" value="1">Approve</button><button class="btn-ghost" name="approve" value="0">Request changes</button></div>
        </form>` : ''}
      <div class="row-btns end">
        ${t.output ? speakBtn() : ''}
        ${t.status === 'done' ? `<button class="btn-ghost" data-save-skill="${t.id}" title="Turn this into a reusable process">💾 Save as skill</button>` : ''}
      </div>
    </div>` : ''}
  </div>`;
}

function threadItem(m, item, focusId) {
  if (item.role === 'user') {
    return `<div class="msg-user">${item.mode === 'ask' ? '<span class="tag">Question for the CEO</span>' : item.mode === 'delegate' ? '<span class="tag">Follow-up</span>' : ''}${esc(item.text)}</div>`;
  }
  if (item.kind === 'escalation') {
    const error = item.text.startsWith('Something broke');
    return `<div class="msg-escalation ${error ? 'error' : ''}">${markdown(item.text)}</div>`;
  }
  if (item.kind === 'review') return `<div class="msg-review">${markdown(item.text)}</div>`;

  const ceo = S.agentById.ceo;
  const planning = item.kind === 'plan' && item.streaming;
  const body = planning
    ? `<span class="shimmer">${esc(ceo.name)} is breaking the goal into tasks and assigning owners…</span>`
    : `<div class="md ${item.streaming ? 'cursor' : ''}" data-stream="thread:${item.id}:text">${markdown(item.text)}</div>`;
  const tasks = item.taskIds?.length ? `<div class="tasks">${item.taskIds.map((id) => S.tasks[id] && taskCard(S.tasks[id], focusId)).join('')}</div>` : '';
  const approve = item.needsApproval && m.status === 'awaiting_approval'
    ? `<div class="approval"><div class="approval-title">🔐 Approve this plan before the team starts?</div>
        <div class="row-btns"><button class="btn" data-approve-plan>Approve plan</button><button class="btn-ghost danger" data-cancel>Reject</button></div></div>`
    : '';
  return `<div class="msg-ai">${avatar('ceo')}<div class="body">
    <div class="msg-head"><b>${esc(ceo.name)}</b> ${esc(ceo.role)} ${item.text && !item.streaming ? speakBtn() : ''}</div>
    ${item.kind === 'summary' ? '<div class="summary-badge">📋 Mission report</div>' : ''}
    ${thinking(item, `thread:${item.id}`)}
    ${body}${tasks}${approve}
  </div></div>`;
}

export function renderMission(id, focusId) {
  const v = view();
  const m = S.missions[id];
  if (!m) {
    v.innerHTML = `<div class="empty">Mission not found. <a href="#/" class="link">Start a new one</a>.</div>`;
    return;
  }
  const tasks = missionTasks(m);
  const done = tasks.filter((t) => t.status === 'done').length;
  const active = ['planning', 'running', 'reporting', 'awaiting_approval'].includes(m.status);

  const prevScroll = $('.scroll', v);
  const sameView = v.dataset.mission === id;
  const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 80;
  const keepTop = prevScroll?.scrollTop;
  const draft = $('[data-composer] textarea', v)?.value || '';

  v.dataset.mission = id;
  v.innerHTML = `
    <div class="topbar">
      <span class="dot ${m.status}"></span>
      <h2 title="${esc(m.goal)}">${esc(m.title)}</h2>
      <div class="meta">
        <span>${MISSION_LABEL[m.status]}</span>
        <div class="progress" title="${done}/${tasks.length} tasks done"><div style="width:${tasks.length ? (done / tasks.length) * 100 : 0}%"></div></div>
        <span>${done}/${tasks.length}</span>
        <span data-mission-due>${missionDue(m)}</span>
        ${m.folder ? `<a class="btn-ghost" href="#/files?f=${encodeURIComponent(m.folder)}" title="Files in the shared workspace">📁 Files</a>` : ''}
        ${active ? '<button class="btn-ghost danger" data-cancel>Stop</button>' : '<button class="btn-ghost danger" data-delete>Delete</button>'}
      </div>
    </div>
    <div class="scroll"><div class="thread">${m.thread.map((it) => threadItem(m, it, focusId)).join('')}</div></div>
    <div class="dock">${composer({
      placeholder: m.status === 'planning' ? 'The CEO is planning…' : 'Give the team a follow-up, or ask the CEO…',
      controls: `<label class="pill-select"><select data-mode>
        <option value="delegate">Delegate to team</option>
        <option value="ask">Ask the CEO</option>
      </select></label>`,
    })}</div>`;

  const scroll = $('.scroll', v);
  if (focusId && !sameView) $(`#task-${focusId}`, v)?.scrollIntoView({ block: 'center' });
  else if (atBottom || !sameView) scroll.scrollTop = scroll.scrollHeight;
  else scroll.scrollTop = keepTop;

  const modeSel = $('[data-mode]', v);
  modeSel.value = S.mode || 'delegate';
  modeSel.addEventListener('change', () => (S.mode = modeSel.value));
  const { ta, resize } = wireComposer(v, (text) => api(`/api/missions/${id}/messages`, { method: 'POST', body: { text, mode: modeSel.value } }));
  if (sameView && draft) {
    ta.value = draft;
    resize();
  }

  $$('[data-toggle]', v).forEach((el) =>
    el.addEventListener('click', () => {
      const tid = el.dataset.toggle;
      S.expanded.has(tid) ? S.expanded.delete(tid) : S.expanded.add(tid);
      renderMission(id);
    }),
  );
  $$('[data-decide]', v).forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const approve = e.submitter?.value === '1';
      const feedback = form.elements.feedback.value.trim();
      if (!approve && !feedback) return toast('Say what should change.');
      await api(`/api/tasks/${form.dataset.decide}/decision`, { method: 'POST', body: { approve, feedback } }).catch((err) => toast(err.message));
    }),
  );
  $$('[data-save-skill]', v).forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/tasks/${b.dataset.saveSkill}/skill`, { method: 'POST' })
        .then(() => toast('Drafting a skill from this task — review it in Skills.'))
        .catch((err) => toast(err.message));
    }),
  );
  $('[data-approve-plan]', v)?.addEventListener('click', () => api(`/api/missions/${id}/approve`, { method: 'POST' }).catch((e) => toast(e.message)));
  $$('[data-cancel]', v).forEach((b) => b.addEventListener('click', () => api(`/api/missions/${id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message))));
  $('[data-delete]', v)?.addEventListener('click', async () => {
    if (!confirm('Delete this mission and all its work? (Files stay in the workspace.)')) return;
    await api(`/api/missions/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/';
  });
}
