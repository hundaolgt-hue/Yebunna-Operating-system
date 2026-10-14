// Yebunna OS — client. No framework: a tiny hash router, a live event stream
// from the server, and render functions that produce HTML strings.
import { markdown, esc } from './markdown.js';

const S = {
  agents: [],
  agentById: {},
  provider: null,
  missions: {},
  tasks: {},
  chats: {},
  expanded: new Set(),
  chatBusy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

// ---------------------------------------------------------------- helpers

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

function avatar(agentId, size = '') {
  const a = S.agentById[agentId];
  if (!a) return '';
  return `<div class="avatar ${size}" style="background:${a.color}" title="${esc(a.name)} · ${esc(a.role)}">${esc(a.name[0])}</div>`;
}

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 1000))}s`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

function due(t) {
  const deadline = Date.parse(t.deadline);
  if (t.status === 'done') {
    const diff = deadline - Date.parse(t.completedAt);
    return diff >= 0 ? { text: `delivered ${span(diff)} early`, cls: 'early' } : { text: `delivered ${span(diff)} late`, cls: 'late' };
  }
  if (t.status === 'failed') return { text: 'stopped', cls: '' };
  const left = deadline - Date.now();
  if (left < 0) return { text: `overdue ${span(left)}`, cls: 'late' };
  return { text: `due in ${span(left)}`, cls: left < 30 * 60000 ? 'soon' : '' };
}

function missionDue(m) {
  if (m.status === 'done') {
    const diff = Date.parse(m.deadline) - Date.parse(m.completedAt);
    return diff >= 0 ? `finished ${span(diff)} early` : `finished ${span(diff)} late`;
  }
  const left = Date.parse(m.deadline) - Date.now();
  return left >= 0 ? `deadline in ${span(left)}` : `deadline passed ${span(left)} ago`;
}

const STATUS_LABEL = { queued: 'Queued', in_progress: 'Working', review: 'CEO review', done: 'Done', failed: 'Failed' };
const MISSION_LABEL = { planning: 'CEO planning', running: 'Team working', reporting: 'Writing report', done: 'Complete', failed: 'Needs attention', cancelled: 'Cancelled' };

const missionTasks = (m) => m.taskIds.map((id) => S.tasks[id]).filter(Boolean);
const sortedMissions = () => Object.values(S.missions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---------------------------------------------------------------- composer

const SEND_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function composer({ placeholder, controls = '', hint = '' }) {
  return `<form class="composer" data-composer>
    <textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
    <div class="composer-bar">${controls}<span class="spacer"></span>${hint ? `<span class="mention-hint">${hint}</span>` : ''}
      <button class="send" type="submit" disabled aria-label="Send">${SEND_ICON}</button>
    </div>
  </form>`;
}

function wireComposer(root, onSubmit) {
  const form = $('[data-composer]', root);
  const ta = $('textarea', form);
  const btn = $('.send', form);
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
    btn.disabled = !ta.value.trim();
  };
  ta.addEventListener('input', resize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await onSubmit(text, form);
      ta.value = '';
    } catch (err) {
      toast(err.message);
    }
    resize();
  });
  return { ta, form, resize };
}

// ---------------------------------------------------------------- home

const DEADLINES = [
  ['1h', 'in 1 hour', 1],
  ['4h', 'in 4 hours', 4],
  ['24h', 'in 24 hours', 24],
  ['3d', 'in 3 days', 72],
  ['7d', 'in 1 week', 168],
  ['30d', 'in 30 days', 720],
  ['custom', 'custom…', 0],
];
const SUGGESTIONS = [
  'Launch a Notion template business for freelancers',
  'Create and sell an AI prompt pack for real-estate agents',
  'Ship a micro-SaaS that turns podcasts into blog posts',
  'Build a $49 online course on personal finance for students',
];

function renderHome() {
  const agents = S.agents;
  view.innerHTML = `<div class="home">
    <div class="hero"><img src="/logo.svg" alt="" /><h1>Yebunna</h1></div>
    <p class="hero-sub">Tell the CEO what to build. The team plans it, splits the work, and delivers by the deadline.</p>
    ${composer({
      placeholder: 'What should the company build?',
      controls: `<label class="pill-select" title="Mission deadline">⏱
          <select data-deadline>${DEADLINES.map(([v, l]) => `<option value="${v}" ${v === '24h' ? 'selected' : ''}>Due ${l}</option>`).join('')}</select>
        </label>
        <label class="pill-select" data-custom hidden><input type="datetime-local" /></label>`,
    })}
    <div class="suggestions">${SUGGESTIONS.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <a class="team-strip" href="#/team">
      <div class="avatars">${agents.map((a) => avatar(a.id)).join('')}</div>
      <span>${agents.length} agents ready · CEO + ${agents.length - 1} specialists</span>
    </a>
  </div>`;

  const sel = $('[data-deadline]');
  const custom = $('[data-custom]');
  const customInput = $('input', custom);
  sel.addEventListener('change', () => {
    custom.hidden = sel.value !== 'custom';
    if (!custom.hidden && !customInput.value) {
      const d = new Date(Date.now() + 48 * 36e5);
      customInput.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
  });

  const { ta, resize } = wireComposer(view, async (goal) => {
    const deadline =
      sel.value === 'custom'
        ? new Date(customInput.value).toISOString()
        : new Date(Date.now() + DEADLINES.find(([v]) => v === sel.value)[2] * 36e5).toISOString();
    const m = await api('/api/missions', { method: 'POST', body: { goal, deadline } });
    S.missions[m.id] = m;
    location.hash = `#/m/${m.id}`;
  });
  view.querySelectorAll('[data-suggest]').forEach((b) =>
    b.addEventListener('click', () => {
      ta.value = b.dataset.suggest;
      resize();
      ta.focus();
    }),
  );
  ta.focus();
}

// ---------------------------------------------------------------- mission

function thinking(item, key) {
  if (!item.reasoning && !(item.streaming && !item.text)) return '';
  const live = item.streaming && !item.text;
  return `<details class="thinking" ${live ? 'open' : ''}>
    <summary><span class="${live ? 'shimmer' : ''}">${live ? 'Thinking' : 'Thoughts'}</span> ›</summary>
    <div class="thoughts" data-stream="${key}:reasoning">${esc(item.reasoning || '…')}</div>
  </details>`;
}

function taskCard(t, focusId) {
  const a = S.agentById[t.agentId];
  const open = S.expanded.has(t.id);
  const d = due(t);
  const working = t.status === 'in_progress';
  return `<div class="task ${focusId === t.id ? 'focus' : ''}" id="task-${t.id}">
    <div class="task-head" data-toggle="${t.id}">
      ${avatar(t.agentId)}
      <div class="task-title">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${esc(a.name)} · ${esc(a.role)}${t.revisions ? ` · revision ${t.revisions}` : ''}</div>
      </div>
      <div class="task-side">
        <span class="status ${t.status}">${STATUS_LABEL[t.status]}</span>
        <span class="due ${d.cls}" data-due="${t.id}">${d.text}</span>
      </div>
    </div>
    ${open ? `<div class="task-body">
      <dl class="brief">
        <dt>Brief</dt><dd>${esc(t.brief)}</dd>
        <dt>Deliverable</dt><dd>${esc(t.deliverable)}</dd>
        <dt>Deadline</dt><dd>${new Date(t.deadline).toLocaleString()}</dd>
      </dl>
      ${t.reasoning || working ? thinking({ reasoning: t.reasoning, streaming: working, text: t.output }, `task:${t.id}`) : ''}
      <div class="md ${working ? 'cursor' : ''}" data-stream="task:${t.id}:output">${t.output ? markdown(t.output) : `<span class="${working ? 'shimmer' : ''}" style="color:var(--faint)">${t.status === 'queued' ? 'Waiting for dependencies or a free slot…' : working ? `${esc(a.name)} is working…` : ''}</span>`}</div>
      ${t.error ? `<div class="review-note" style="color:var(--bad)">${esc(t.error)}</div>` : ''}
      ${t.review ? `<div class="review-note">${avatar('ceo', 'sm')} <b>Atlas:</b> ${esc(t.review.feedback)}</div>` : ''}
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
  const tasks = item.taskIds?.length
    ? `<div class="tasks">${item.taskIds.map((id) => S.tasks[id] && taskCard(S.tasks[id], focusId)).join('')}</div>`
    : '';
  return `<div class="msg-ai">${avatar('ceo')}<div class="body">
    <div class="msg-head"><b>${esc(ceo.name)}</b> ${esc(ceo.role)}</div>
    ${item.kind === 'summary' ? '<div class="summary-badge">📋 Mission report</div>' : ''}
    ${thinking(item, `thread:${item.id}`)}
    ${body}${tasks}
  </div></div>`;
}

function renderMission(id, focusId) {
  const m = S.missions[id];
  if (!m) {
    view.innerHTML = `<div class="empty">Mission not found. <a href="#/" style="text-decoration:underline">Start a new one</a>.</div>`;
    return;
  }
  const tasks = missionTasks(m);
  const done = tasks.filter((t) => t.status === 'done').length;
  const active = ['planning', 'running', 'reporting'].includes(m.status);

  const prevScroll = $('.scroll', view);
  const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 80;
  const keepTop = prevScroll?.scrollTop;
  const draft = $('[data-composer] textarea', view)?.value || '';
  const sameView = view.dataset.mission === id;

  view.dataset.mission = id;
  view.innerHTML = `
    <div class="topbar">
      <span class="dot ${m.status}"></span>
      <h2 title="${esc(m.goal)}">${esc(m.title)}</h2>
      <div class="meta">
        <span>${MISSION_LABEL[m.status]}</span>
        <div class="progress" title="${done}/${tasks.length} tasks done"><div style="width:${tasks.length ? (done / tasks.length) * 100 : 0}%"></div></div>
        <span>${done}/${tasks.length}</span>
        <span data-mission-due>${missionDue(m)}</span>
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

  const scroll = $('.scroll', view);
  if (focusId && !sameView) $(`#task-${focusId}`)?.scrollIntoView({ block: 'center' });
  else if (atBottom || !sameView) scroll.scrollTop = scroll.scrollHeight;
  else scroll.scrollTop = keepTop;

  const modeSel = $('[data-mode]', view);
  modeSel.value = S.mode || 'delegate';
  modeSel.addEventListener('change', () => (S.mode = modeSel.value));
  const { ta, resize } = wireComposer(view, (text) =>
    api(`/api/missions/${id}/messages`, { method: 'POST', body: { text, mode: modeSel.value } }),
  );
  if (sameView && draft) {
    ta.value = draft;
    resize();
  }

  view.querySelectorAll('[data-toggle]').forEach((el) =>
    el.addEventListener('click', () => {
      const tid = el.dataset.toggle;
      S.expanded.has(tid) ? S.expanded.delete(tid) : S.expanded.add(tid);
      renderMission(id);
    }),
  );
  $('[data-cancel]', view)?.addEventListener('click', () => api(`/api/missions/${id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message)));
  $('[data-delete]', view)?.addEventListener('click', async () => {
    if (!confirm('Delete this mission and all its work?')) return;
    await api(`/api/missions/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/';
  });
}

// ---------------------------------------------------------------- board

function renderBoard() {
  const cols = ['queued', 'in_progress', 'review', 'done', 'failed'];
  const all = Object.values(S.tasks).sort((a, b) => a.deadline.localeCompare(b.deadline));
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>Task board</h2><p>Every delegated task across all missions, earliest deadline first.</p></div>
    <div class="board">${cols
      .map((c) => {
        const items = all.filter((t) => t.status === c);
        return `<div class="col"><div class="col-head"><span>${STATUS_LABEL[c]}</span><span>${items.length}</span></div>
        ${items
          .map((t) => {
            const d = due(t);
            const m = S.missions[t.missionId];
            return `<a class="card" href="#/m/${t.missionId}/${t.id}">
              <div class="row"><div class="who">${avatar(t.agentId, 'sm')}${esc(S.agentById[t.agentId].name)}</div><span class="due ${d.cls}" data-due="${t.id}">${d.text}</span></div>
              <div class="t">${esc(t.title)}</div>
              <div class="m">${esc(m?.title || '')}</div>
            </a>`;
          })
          .join('') || '<div class="empty" style="padding:20px 0">—</div>'}
      </div>`;
      })
      .join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- team

function renderTeam() {
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>Team</h2><p>Your AI company. Chat 1:1 with any agent, or give the CEO a mission.</p></div>
    <div class="team-grid">${S.agents
      .map((a) => {
        const mine = Object.values(S.tasks).filter((t) => t.agentId === a.id);
        const done = mine.filter((t) => t.status === 'done');
        const onTime = done.length ? Math.round((done.filter((t) => !t.late).length / done.length) * 100) : null;
        const current = mine.find((t) => t.status === 'in_progress');
        const stat =
          a.id === 'ceo'
            ? [Object.keys(S.missions).length, 'missions', Object.keys(S.tasks).length, 'delegated', sortedMissions().filter((m) => m.status === 'done').length, 'shipped']
            : [done.length, 'delivered', onTime === null ? '—' : `${onTime}%`, 'on time', mine.filter((t) => ['queued', 'in_progress', 'review'].includes(t.status)).length, 'open'];
        return `<div class="agent-card">
          <div class="top">${avatar(a.id, 'lg')}<div><div class="name">${esc(a.name)}${a.web ? '<span class="web-badge">🌐 web</span>' : ''}</div><div class="role">${esc(a.role)}</div></div></div>
          <div class="tags">${a.specialties.map((s) => `<span class="tag-s">${esc(s)}</span>`).join('')}</div>
          <div class="stats">${[0, 2, 4].map((i) => `<div><b>${stat[i]}</b><span>${stat[i + 1]}</span></div>`).join('')}</div>
          <div class="now">${current ? `<span class="dot running" style="display:inline-block;margin-right:6px"></span>Working on: ${esc(current.title)}` : '<span style="color:var(--faint)">Available</span>'}</div>
          <div class="send-row"><a class="btn" href="#/chat/${a.id}">Chat with ${esc(a.name)}</a></div>
        </div>`;
      })
      .join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- 1:1 chat

async function renderChat(agentId) {
  const a = S.agentById[agentId];
  if (!a) return renderTeam();
  if (!S.chats[agentId]) S.chats[agentId] = await api(`/api/chats/${agentId}`).catch(() => []);
  if (S.route !== `chat/${agentId}`) return;
  const history = S.chats[agentId];

  view.innerHTML = `
    <div class="topbar">${avatar(agentId)}<h2>${esc(a.name)} <span style="color:var(--muted);font-weight:400">· ${esc(a.role)}</span></h2>
      <div class="meta"><button class="btn-ghost" data-clear>Clear chat</button></div></div>
    <div class="scroll"><div class="thread" data-chat>${
      history.length
        ? history.map((msg) => chatMsg(a, msg)).join('')
        : `<div class="empty">${avatar(agentId, 'lg')}<p>Ask ${esc(a.name)} anything about ${esc(a.specialties.join(', ').toLowerCase())}.</p></div>`
    }</div></div>
    <div class="dock">${composer({ placeholder: `Message ${a.name}…` })}</div>`;
  const scroll = $('.scroll', view);
  scroll.scrollTop = scroll.scrollHeight;

  $('[data-clear]', view).addEventListener('click', async () => {
    await api(`/api/chats/${agentId}`, { method: 'DELETE' });
    S.chats[agentId] = [];
    renderChat(agentId);
  });

  wireComposer(view, async (text) => {
    if (S.chatBusy) throw new Error(`${a.name} is still replying.`);
    S.chatBusy = true;
    const thread = $('[data-chat]', view);
    $('.empty', thread)?.remove();
    history.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '', reasoning: '', streaming: true };
    thread.insertAdjacentHTML('beforeend', chatMsg(a, history.at(-1)));
    thread.insertAdjacentHTML('beforeend', `<div data-live>${chatMsg(a, reply)}</div>`);
    const live = $('[data-live]', thread);
    const repaint = () => {
      live.innerHTML = chatMsg(a, reply);
      scroll.scrollTop = scroll.scrollHeight;
    };
    repaint();
    try {
      const res = await fetch(`/api/chats/${agentId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let frame = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          if (!p.startsWith('data:')) continue;
          const ev = JSON.parse(p.slice(5));
          if (ev.type === 'text') reply.content += ev.text;
          else if (ev.type === 'reasoning') reply.reasoning += ev.text;
          else if (ev.type === 'error') reply.content += `\n\n> ⚠️ ${ev.text}`;
        }
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(repaint);
      }
    } finally {
      reply.streaming = false;
      history.push(reply);
      repaint();
      S.chatBusy = false;
    }
  });
}

function chatMsg(a, msg) {
  if (msg.role === 'user') return `<div class="msg-user">${esc(msg.content)}</div>`;
  return `<div class="msg-ai">${avatar(a.id)}<div class="body">
    <div class="msg-head"><b>${esc(a.name)}</b> ${esc(a.role)}</div>
    ${thinking({ reasoning: msg.reasoning, streaming: msg.streaming, text: msg.content }, 'chat')}
    <div class="md ${msg.streaming ? 'cursor' : ''}">${markdown(msg.content)}</div>
  </div></div>`;
}

// ---------------------------------------------------------------- shell

function renderSidebar() {
  const current = S.route?.startsWith('m/') ? S.route.split('/')[1] : null;
  $('#mission-list').innerHTML =
    sortedMissions()
      .map((m) => `<a class="mission-link ${m.id === current ? 'active' : ''}" href="#/m/${m.id}"><span class="dot ${m.status}"></span><span class="t">${esc(m.title)}</span></a>`)
      .join('') || '<div class="mission-link" style="color:var(--faint)">No missions yet</div>';
  const top = S.route?.split('/')[0] || '';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const nav = a.dataset.nav;
    a.classList.toggle('active', (nav === 'home' && top === '') || nav === top || (nav === 'team' && top === 'chat'));
  });
  const p = S.provider;
  if (p) {
    $('#engine').innerHTML =
      p.name === 'demo'
        ? `<span class="dot"></span> Offline demo · log in to Claude Code to go live`
        : `<span class="dot live"></span> Claude${p.model !== 'default' ? ` · ${esc(p.model)}` : ''} · your subscription`;
  }
}

function route() {
  S.route = location.hash.replace(/^#\/?/, '');
  const [page, a, b] = S.route.split('/');
  delete view.dataset.mission;
  if (page === 'm' && b) S.expanded.add(b);
  render(b);
  $('#sidebar').classList.remove('open');
}

function render(focusId) {
  const [page, a] = (S.route || '').split('/');
  renderSidebar();
  if (page === 'm') return renderMission(a, focusId);
  if (page === 'board') return renderBoard();
  if (page === 'team') return renderTeam();
  if (page === 'chat') return renderChat(a);
  return renderHome();
}

// Re-render the parts of the UI affected by a structural change.
let pending = 0;
function refresh() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    renderSidebar();
    const [page] = (S.route || '').split('/');
    if (page === 'm') renderMission(S.route.split('/')[1]);
    else if (page === 'board') renderBoard();
    else if (page === 'team') renderTeam();
  });
}

// Live token streaming: patch only the node that is streaming.
const dirty = new Set();
let deltaFrame = 0;
function applyDelta(e) {
  const obj = e.target === 'task' ? S.tasks[e.id] : S.missions[e.missionId]?.thread.find((i) => i.id === e.id);
  if (!obj) return;
  obj[e.field] = (obj[e.field] || '') + e.text;
  dirty.add(`${e.target}:${e.id}:${e.field}`);
  cancelAnimationFrame(deltaFrame);
  deltaFrame = requestAnimationFrame(() => {
    const scroll = $('.scroll', view);
    const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    for (const key of dirty) {
      const node = view.querySelector(`[data-stream="${key}"]`);
      if (!node) continue;
      const [target, id, field] = key.split(':');
      const src = target === 'task' ? S.tasks[id] : Object.values(S.missions).flatMap((m) => m.thread).find((i) => i.id === id);
      if (field === 'reasoning') node.textContent = src.reasoning;
      else node.innerHTML = markdown(src[field]);
    }
    dirty.clear();
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  });
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === 'delta') return applyDelta(e);
    if (e.type === 'mission') S.missions[e.mission.id] = e.mission;
    else if (e.type === 'task') S.tasks[e.task.id] = e.task;
    else if (e.type === 'mission.deleted') delete S.missions[e.id];
    refresh();
  };
  es.onerror = () => {
    es.close();
    setTimeout(async () => {
      await loadState().catch(() => {});
      connect();
    }, 2000);
  };
}

async function loadState() {
  const { missions, tasks } = await api('/api/state');
  S.missions = Object.fromEntries(missions.map((m) => [m.id, m]));
  S.tasks = Object.fromEntries(tasks.map((t) => [t.id, t]));
  refresh();
}

// Countdown clocks.
setInterval(() => {
  view.querySelectorAll('[data-due]').forEach((el) => {
    const t = S.tasks[el.dataset.due];
    if (!t) return;
    const d = due(t);
    el.textContent = d.text;
    el.className = `due ${d.cls}`;
  });
  const md = $('[data-mission-due]', view);
  const m = S.missions[view.dataset.mission];
  if (md && m) md.textContent = missionDue(m);
}, 1000);

document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.closest('pre').querySelector('code').textContent);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  }
});
$('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
window.addEventListener('hashchange', route);

(async function boot() {
  const meta = await api('/api/meta');
  S.provider = meta.provider;
  S.agents = meta.agents;
  S.agentById = Object.fromEntries(meta.agents.map((a) => [a.id, a]));
  await loadState();
  route();
  connect();
})();
