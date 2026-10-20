import { S, $, $$, api, esc, avatar, composer, wireComposer, view, toast } from '../core.js';
import { newMeetingDialog } from './meetings.js';
import { teachDialog } from './skills.js';
import { newBotDialog } from './team.js';

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

export function renderHome() {
  const v = view();
  v.innerHTML = `<div class="home">
    <div class="hero"><img src="/logo.svg" alt="" /><h1>Yebunna</h1></div>
    <p class="hero-sub">Tell the CEO what to build. The team plans it, splits the work, and delivers by the deadline.</p>
    ${composer({
      placeholder: 'What should the company build?',
      controls: `<label class="pill-select" title="Mission deadline">⏱
          <select data-deadline>${DEADLINES.map(([val, l]) => `<option value="${val}" ${val === '24h' ? 'selected' : ''}>Due ${l}</option>`).join('')}</select>
        </label>
        <label class="pill-select" data-custom hidden><input type="datetime-local" /></label>`,
    })}
    <div class="suggestions">${SUGGESTIONS.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div class="quick">
      <button class="quick-card" data-q="meeting"><span>👥</span><b>Team meeting</b><small>Bots discuss, decide and assign action items</small></button>
      <button class="quick-card" data-q="teach"><span>🎥</span><b>Teach a task</b><small>Show it once on your screen — a bot learns the skill</small></button>
      <a class="quick-card" href="#/routines"><span>⏰</span><b>Routines</b><small>Schedules and triggers that run work for you</small></a>
      <button class="quick-card" data-q="bot"><span>✨</span><b>Create a bot</b><small>Name it, give it a job, add it to the team</small></button>
    </div>
    <a class="team-strip" href="#/team">
      <div class="avatars">${S.agents.map((a) => avatar(a.id)).join('')}</div>
      <span>${S.agents.length} bots ready · CEO + ${S.agents.length - 1} specialists</span>
    </a>
  </div>`;

  const sel = $('[data-deadline]', v);
  const custom = $('[data-custom]', v);
  const customInput = $('input', custom);
  sel.addEventListener('change', () => {
    custom.hidden = sel.value !== 'custom';
    if (!custom.hidden && !customInput.value) {
      const d = new Date(Date.now() + 48 * 36e5);
      customInput.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
  });

  const { ta, resize } = wireComposer(v, async (goal) => {
    const deadline =
      sel.value === 'custom'
        ? new Date(customInput.value).toISOString()
        : new Date(Date.now() + DEADLINES.find(([val]) => val === sel.value)[2] * 36e5).toISOString();
    const m = await api('/api/missions', { method: 'POST', body: { goal, deadline } });
    S.missions[m.id] = m;
    if (m.routed) toast(`That's about “${m.title}”, so I added it to that mission.`);
    location.hash = `#/m/${m.id}`;
  });
  $$('[data-suggest]', v).forEach((b) =>
    b.addEventListener('click', () => {
      ta.value = b.dataset.suggest;
      resize();
      ta.focus();
    }),
  );
  $('[data-q=meeting]', v).addEventListener('click', () => newMeetingDialog());
  $('[data-q=teach]', v).addEventListener('click', () => teachDialog());
  $('[data-q=bot]', v).addEventListener('click', () => newBotDialog());
  ta.focus();
}
