// Yebunna OS — client entry: router, sidebar, live event stream, countdown clocks.
import { S, $, $$, api, esc, markdown, view, setAgents, due, missionDue, sortedMissions } from './core.js';
import { renderHome } from './views/home.js';
import { renderMission } from './views/mission.js';
import { renderBoard } from './views/board.js';
import { renderTeam, renderAgent } from './views/team.js';
import { renderMeetings, renderMeeting } from './views/meetings.js';
import { renderSkills } from './views/skills.js';
import { renderRoutines } from './views/routines.js';
import { renderFiles } from './views/files.js';
import { renderSettings } from './views/settings.js';

const parseRoute = () => {
  const [path, query = ''] = S.route.split('?');
  return { parts: path.split('/'), query: new URLSearchParams(query) };
};

function renderSidebar() {
  const { parts } = parseRoute();
  const top = parts[0] || '';
  const current = top === 'm' ? parts[1] : null;
  $('#mission-list').innerHTML =
    sortedMissions()
      .slice(0, 40)
      .map((m) => `<a class="mission-link ${m.id === current ? 'active' : ''}" href="#/m/${m.id}"><span class="dot ${m.status}"></span><span class="t">${esc(m.title)}</span></a>`)
      .join('') || '<div class="mission-link" style="color:var(--faint)">No missions yet</div>';

  const busy = new Set(Object.values(S.tasks).filter((t) => t.status === 'in_progress').map((t) => t.agentId));
  $('#bot-list').innerHTML = S.agents
    .map((a) => `<a class="bot-link ${top === 'chat' && parts[1] === a.id ? 'active' : ''}" href="#/chat/${a.id}" title="${esc(a.role)}">
      <span class="avatar-wrap"><span class="avatar sm" style="background:${a.color}">${esc(a.name[0])}</span><span class="presence ${busy.has(a.id) ? 'busy' : ''}"></span></span>
      <span class="t">${esc(a.name)}</span></a>`)
    .join('');

  const pendingApprovals = Object.values(S.tasks).filter((t) => t.status === 'approval').length + Object.values(S.missions).filter((m) => m.status === 'awaiting_approval').length;
  const liveMeetings = Object.values(S.meetings).filter((m) => m.status === 'live' || m.status === 'minutes').length;
  const badges = { board: pendingApprovals, meetings: liveMeetings };
  $$('[data-nav]').forEach((a) => {
    const nav = a.dataset.nav;
    a.classList.toggle('active', (nav === 'home' && (top === '' || top === 'm')) || nav === top || (nav === 'team' && top === 'chat'));
    const b = $('.badge', a);
    if (b) {
      b.textContent = badges[nav] || '';
      b.hidden = !badges[nav];
    }
  });
  const p = S.provider;
  if (p) {
    $('#engine').innerHTML =
      p.name === 'demo'
        ? '<span class="dot"></span> Offline demo · log in to Claude Code to go live'
        : `<span class="dot live"></span> Claude${p.model !== 'default' ? ` · ${esc(p.model)}` : ''} · your subscription`;
  }
}

function render(focusId) {
  const { parts, query } = parseRoute();
  renderSidebar();
  delete view().dataset.mission;
  delete view().dataset.meeting;
  switch (parts[0]) {
    case 'm':
      return renderMission(parts[1], focusId);
    case 'board':
      return renderBoard();
    case 'team':
      return renderTeam();
    case 'chat':
      return renderAgent(parts[1]);
    case 'meetings':
      return parts[1] ? renderMeeting(parts[1]) : renderMeetings();
    case 'skills':
      return renderSkills();
    case 'routines':
      return renderRoutines();
    case 'files':
      return renderFiles(query.get('f'));
    case 'settings':
      return renderSettings();
    default:
      return renderHome();
  }
}

function route() {
  S.route = location.hash.replace(/^#\/?/, '');
  const { parts } = parseRoute();
  if (parts[0] === 'm' && parts[2]) S.expanded.add(parts[2]);
  render(parts[0] === 'm' ? parts[2] : undefined);
  $('#sidebar').classList.remove('open');
}

// Re-render what an event affects, without wiping in-progress input.
let pending = 0;
function refresh(type) {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    renderSidebar();
    const { parts } = parseRoute();
    const page = parts[0] || '';
    const keep = view().dataset;
    switch (page) {
      case 'm':
        keep.mission = parts[1];
        return renderMission(parts[1]);
      case 'meetings':
        if (parts[1]) {
          keep.meeting = parts[1];
          return renderMeeting(parts[1]);
        }
        return renderMeetings();
      case 'board':
        return renderBoard();
      case 'team':
        return renderTeam();
      case 'skills':
        return renderSkills();
      case 'routines':
        return renderRoutines();
      case 'chat':
        if (!S.chatBusy && ['memory', 'skill', 'skill.deleted', 'agents'].includes(type)) return renderAgent(parts[1]);
        return;
      default:
        return; // home, files, settings: nothing live to redraw
    }
  });
}

// Live token streaming: patch only the node that is streaming.
const dirty = new Set();
let deltaFrame = 0;
function findStreamObj(target, id, parentId) {
  if (target === 'task') return S.tasks[id];
  if (target === 'thread') return S.missions[parentId]?.thread.find((i) => i.id === id);
  if (target === 'meeting') return S.meetings[parentId]?.transcript.find((u) => u.id === id);
}
function applyDelta(e) {
  const obj = findStreamObj(e.target, e.id, e.missionId);
  if (!obj) return;
  obj[e.field] = (obj[e.field] || '') + e.text;
  dirty.add(`${e.target}:${e.id}:${e.field}:${e.missionId}`);
  cancelAnimationFrame(deltaFrame);
  deltaFrame = requestAnimationFrame(() => {
    const scroll = $('.scroll', view());
    const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    for (const key of dirty) {
      const [target, id, field, parentId] = key.split(':');
      const node = view().querySelector(`[data-stream="${target}:${id}:${field}"]`);
      if (!node) continue;
      const src = findStreamObj(target, id, parentId);
      if (field === 'reasoning') node.textContent = src.reasoning;
      else node.innerHTML = markdown(src[field]);
    }
    dirty.clear();
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  });
}

const COLLECTIONS = { mission: 'missions', task: 'tasks', meeting: 'meetings', skill: 'skills', routine: 'routines' };
function onEvent(e) {
  if (e.type === 'delta') return applyDelta(e);
  if (COLLECTIONS[e.type]) {
    const item = e[e.type];
    S[COLLECTIONS[e.type]][item.id] = item;
  } else if (e.type.endsWith('.deleted')) {
    delete S[COLLECTIONS[e.type.split('.')[0]]][e.id];
  } else if (e.type === 'memory') {
    S.memory[e.agentId] = e.memory;
  } else if (e.type === 'settings') {
    S.settings = e.settings;
  } else if (e.type === 'agents') {
    setAgents(e.agents);
  }
  refresh(e.type);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => onEvent(JSON.parse(msg.data));
  es.onerror = () => {
    es.close();
    setTimeout(async () => {
      await loadState().catch(() => {});
      connect();
    }, 2000);
  };
}

async function loadState() {
  const st = await api('/api/state');
  for (const [key, list] of Object.entries({ missions: st.missions, tasks: st.tasks, meetings: st.meetings, skills: st.skills, routines: st.routines })) {
    S[key] = Object.fromEntries(list.map((x) => [x.id, x]));
  }
  S.memory = st.memory;
  S.settings = st.settings;
  refresh('state');
}

// Countdown clocks.
setInterval(() => {
  $$('[data-due]', view()).forEach((el) => {
    const t = S.tasks[el.dataset.due];
    if (!t) return;
    const d = due(t);
    el.textContent = d.text;
    el.className = `due ${d.cls}`;
  });
  const md = $('[data-mission-due]', view());
  const m = S.missions[view().dataset.mission];
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
  S.workspace = meta.workspace;
  setAgents(meta.agents);
  await loadState();
  route();
  connect();
})();
