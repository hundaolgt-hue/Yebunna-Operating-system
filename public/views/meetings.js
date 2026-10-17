import { S, $, $$, api, esc, markdown, avatar, agentName, toast, view, composer, wireComposer, speakBtn, openDialog, onSubmit, ago } from '../core.js';

const STATUS = { live: 'Live', minutes: 'Writing minutes', done: 'Ended', failed: 'Interrupted', paused: 'Paused (usage limit)' };
const ICON = { standup: '☀️', retro: '🔁', meeting: '👥' };
const sorted = () => Object.values(S.meetings).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function renderMeetings() {
  const list = sorted();
  view().innerHTML = `<div class="page">
    <div class="page-head"><h2>Meetings</h2><p>Put 2–6 bots in a room. They discuss, decide, and leave with owned action items and deadlines.</p>
      <span class="spacer"></span><button class="btn-ghost" data-retro>🔁 Retrospective now</button><button class="btn-ghost" data-standup>☀️ Standup now</button><button class="btn" data-new>New meeting</button></div>
    ${playbook()}
    ${
      list.length
        ? `<div class="list">${list
            .map(
              (mt) => `<a class="list-row" href="#/meetings/${mt.id}">
          <span class="dot ${mt.status === 'live' || mt.status === 'minutes' ? 'running' : mt.status === 'failed' ? 'failed' : 'done'}"></span>
          <div class="grow"><div class="t">${ICON[mt.kind] || '👥'} ${esc(mt.title)}</div><div class="s">${esc(mt.agenda)}</div></div>
          <div class="avatars">${mt.participants.map((p) => avatar(p, 'sm')).join('')}</div>
          <span class="s">${STATUS[mt.status]} · ${ago(mt.createdAt)}</span>
        </a>`,
            )
            .join('')}</div>`
        : '<div class="empty">No meetings yet. Start one, or schedule a daily standup in Routines.</div>'
    }
  </div>`;
  $('[data-new]', view()).addEventListener('click', () => newMeetingDialog());
  $('[data-retro]', view()).addEventListener('click', async () => {
    const mt = await api('/api/retro', { method: 'POST' }).catch((e) => toast(e.message));
    if (mt) location.hash = `#/meetings/${mt.id}`;
  });
  $$('[data-del-rule]', view()).forEach((b) => b.addEventListener('click', () => api(`/api/rules/${b.dataset.delRule}`, { method: 'DELETE' }).catch((e) => toast(e.message))));
  $('[data-add-rule]', view())?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('/api/rules', { method: 'POST', body: { type: f.elements.type.value, text: f.elements.text.value } })
      .then(() => toast('Rule added — every bot follows it from now on.'))
      .catch((err) => toast(err.message));
  });
  $('[data-standup]', view()).addEventListener('click', async () => {
    const mt = await api('/api/meetings', {
      method: 'POST',
      body: { kind: 'standup', participants: S.agents.filter((a) => a.id !== 'ceo').slice(0, 6).map((a) => a.id), rounds: 1 },
    }).catch((e) => toast(e.message));
    if (mt) location.hash = `#/meetings/${mt.id}`;
  });
}

function playbook() {
  const rules = S.rules || [];
  return `<section class="settings">
    <h3>Team playbook</h3>
    <p class="side-text">Rules every bot follows in every mission. The morning retrospective turns what worked into “do” rules and what went wrong into “don't” rules, and retires rules that stopped helping. Add your own or delete any.</p>
    ${rules.length ? `<div class="rules">${rules
      .map((r) => `<div class="rule"><span class="tag ${r.type}">${r.type === 'do' ? 'DO' : "DON'T"}</span><div class="grow">${esc(r.text)}<small>${r.source === 'founder' ? 'added by you' : r.source?.startsWith('retro:') ? `from a retrospective${r.why ? ` · ${esc(r.why)}` : ''}` : ''}</small></div><button class="btn-ghost danger" data-del-rule="${r.id}" title="Delete this rule">✕</button></div>`)
      .join('')}</div>` : '<p class="faint small">No rules yet — they appear after the first retrospective.</p>'}
    <form class="row-btns" data-add-rule><select class="select-sm" name="type"><option value="do">Do</option><option value="dont">Don't</option></select><input name="text" required placeholder="e.g. Write Amharic copy first, then English" style="flex:1;min-width:180px" /><button class="btn-ghost">Add rule</button></form>
  </section>`;
}

export function newMeetingDialog() {
  const bots = S.agents.filter((a) => a.id !== 'ceo');
  openDialog(
    'New team meeting',
    `<form class="form" data-form>
      <label>Title<input name="title" required placeholder="e.g. Launch plan for the habit tracker" /></label>
      <label>Agenda<textarea name="agenda" rows="3" required placeholder="What should the team discuss and decide?"></textarea></label>
      <div class="field-label">Invite bots <small>(2–6; ${esc(S.agentById.ceo?.name || 'the CEO')} moderates)</small></div>
      <div class="pick">${bots
        .map((a, i) => `<label class="pick-item"><input type="checkbox" name="participants" data-group value="${a.id}" ${i < 3 ? 'checked' : ''}/>${avatar(a.id, 'sm')}<span>${esc(a.name)}<small>${esc(a.role)}</small></span></label>`)
        .join('')}</div>
      <div class="grid2">
        <label>Rounds of discussion<select name="rounds"><option value="1">1 — quick</option><option value="2" selected>2 — discuss</option><option value="3">3 — debate</option></select></label>
        <label>Action items due within<select name="deadlineHours"><option value="4">4 hours</option><option value="24" selected>1 day</option><option value="72">3 days</option><option value="168">1 week</option></select></label>
      </div>
      <label class="check"><input type="checkbox" name="autoLaunch" /> Start the action items as a mission automatically</label>
      <div class="row-btns end"><button class="btn" type="submit">Start meeting</button></div>
    </form>`,
    (dlg, close) =>
      onSubmit($('[data-form]', dlg), async (d) => {
        if (!d.participants?.length) throw new Error('Invite at least one bot.');
        if (d.participants.length > 6) throw new Error('Invite at most 6 bots.');
        const mt = await api('/api/meetings', { method: 'POST', body: d });
        close();
        location.hash = `#/meetings/${mt.id}`;
      }),
  );
}

export function renderMeeting(id) {
  const v = view();
  const mt = S.meetings[id];
  if (!mt) {
    v.innerHTML = '<div class="empty">Meeting not found. <a class="link" href="#/meetings">Back to meetings</a></div>';
    return;
  }
  const speaking = mt.transcript.find((u) => u.streaming)?.agentId;
  const prev = $('.scroll', v);
  const same = v.dataset.meeting === id;
  const atBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80;
  const keep = prev?.scrollTop;
  const draft = $('[data-composer] textarea', v)?.value || '';
  v.dataset.meeting = id;

  const items = mt.actionItems || [];
  v.innerHTML = `
    <div class="topbar">
      <span class="dot ${mt.status === 'live' || mt.status === 'minutes' ? 'running' : mt.status === 'failed' || mt.status === 'paused' ? 'failed' : 'done'}"></span>
      <h2>${ICON[mt.kind] || '👥'} ${esc(mt.title)}</h2>
      <div class="meta"><span>${STATUS[mt.status]}</span><button class="btn-ghost danger" data-del>Delete</button></div>
    </div>
    <div class="scroll"><div class="thread">
      <div class="room">${mt.participants
        .map((p) => `<div class="seat ${speaking === p ? 'speaking' : ''}">${avatar(p, 'lg')}<span>${esc(agentName(p))}</span><small>${p === 'ceo' ? 'moderator' : esc(S.agentById[p]?.role || '')}</small></div>`)
        .join('')}</div>
      <div class="agenda"><b>Agenda</b> ${esc(mt.agenda)}</div>
      ${mt.transcript
        .map(
          (u) => `<div class="utterance ${u.agentId === 'founder' ? 'me' : ''}">${avatar(u.agentId)}<div class="body">
            <div class="msg-head"><b>${esc(agentName(u.agentId))}</b>${u.round ? `<span class="faint">round ${u.round}</span>` : ''} ${!u.streaming && u.agentId !== 'founder' ? speakBtn() : ''}</div>
            <div class="md ${u.streaming ? 'cursor' : ''}" data-stream="meeting:${u.id}:text">${u.text ? markdown(u.text) : '<span class="shimmer">thinking…</span>'}</div>
          </div></div>`,
        )
        .join('')}
      ${mt.status === 'minutes' ? `<div class="msg-ai">${avatar('ceo')}<div class="body"><span class="shimmer">${esc(S.agentById.ceo?.name)} is writing the minutes and action items…</span></div></div>` : ''}
      ${mt.error ? `<div class="msg-escalation error">${esc(mt.error)}</div>` : ''}
      ${
        mt.status === 'done'
          ? `<div class="minutes speakable">
          <div class="summary-badge">📝 Minutes</div> ${speakBtn()}
          <div class="md">${markdown(mt.minutes)}</div>
          ${mt.decisions.length ? `<h4>Decisions</h4><ul class="plain">${mt.decisions.map((d) => `<li>✅ ${esc(d)}</li>`).join('')}</ul>` : ''}
          ${
            items.length
              ? `<h4>Action items</h4><div class="items">${items
                  .map((a) => `<div class="item">${avatar(a.agent, 'sm')}<div class="grow"><b>${esc(a.title)}</b><small>${esc(agentName(a.agent))} · due in ${a.due_in_hours}h · ${esc(a.deliverable || '')}</small></div></div>`)
                  .join('')}</div>
              <div class="row-btns">${
                mt.missionId
                  ? `<a class="btn" href="#/m/${mt.missionId}">Open the action-item mission →</a>`
                  : '<button class="btn" data-launch>🚀 Start these as a mission</button>'
              }</div>`
              : ''
          }
        </div>`
          : ''
      }
    </div></div>
    <div class="dock">${composer({ placeholder: mt.status === 'done' || mt.status === 'failed' ? 'Say something to the room — the bots respond and the minutes update…' : 'The bots are talking…' })}</div>`;

  const scroll = $('.scroll', v);
  scroll.scrollTop = atBottom || !same ? scroll.scrollHeight : keep;
  const { ta, resize } = wireComposer(v, (text) => api(`/api/meetings/${id}/messages`, { method: 'POST', body: { text } }));
  if (same && draft) {
    ta.value = draft;
    resize();
  }
  $('[data-launch]', v)?.addEventListener('click', async () => {
    const m = await api(`/api/meetings/${id}/launch`, { method: 'POST' }).catch((e) => toast(e.message));
    if (m) location.hash = `#/m/${m.id}`;
  });
  $('[data-del]', v).addEventListener('click', async () => {
    if (!confirm('Delete this meeting?')) return;
    await api(`/api/meetings/${id}`, { method: 'DELETE' });
    location.hash = '#/meetings';
  });
}
