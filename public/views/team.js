import {
  S, $, $$, api, esc, markdown, avatar, toast, view, composer, wireComposer, thinking, speakBtn,
  openDialog, onSubmit, ago,
} from '../core.js';

// ---------------------------------------------------------------- team grid

export function renderTeam() {
  view().innerHTML = `<div class="page">
    <div class="page-head"><h2>Team</h2><p>Your AI company. Each bot has its own role, memory and skills.</p>
      <span class="spacer"></span><button class="btn" data-new-bot>✨ Create a bot</button></div>
    <div class="team-grid">${S.agents.map(agentCard).join('')}</div>
  </div>`;
  $('[data-new-bot]', view()).addEventListener('click', () => newBotDialog());
  $$('[data-assign]', view()).forEach((b) => b.addEventListener('click', () => assignDialog(b.dataset.assign)));
  $$('[data-edit-bot]', view()).forEach((b) => b.addEventListener('click', () => editBotDialog(b.dataset.editBot)));
}

function agentCard(a) {
  const mine = Object.values(S.tasks).filter((t) => t.agentId === a.id);
  const done = mine.filter((t) => t.status === 'done');
  const onTime = done.length ? Math.round((done.filter((t) => !t.late).length / done.length) * 100) : null;
  const current = mine.find((t) => t.status === 'in_progress');
  const skills = Object.values(S.skills).filter((s) => s.agentId === a.id && s.status === 'active').length;
  const stat =
    a.id === 'ceo'
      ? [Object.keys(S.missions).length, 'missions', Object.keys(S.meetings).length, 'meetings', Object.keys(S.tasks).length, 'delegated']
      : [done.length, 'delivered', onTime === null ? '—' : `${onTime}%`, 'on time', skills, 'skills'];
  return `<div class="agent-card">
    <div class="top">${avatar(a.id, 'lg')}<div><div class="name">${esc(a.name)}${a.web ? '<span class="web-badge">🌐 web</span>' : ''}${a.custom ? '<span class="web-badge">custom</span>' : ''}</div><div class="role">${esc(a.role)}</div></div></div>
    <div class="tags">${a.specialties.map((s) => `<span class="tag-s">${esc(s)}</span>`).join('')}</div>
    <div class="stats">${[0, 2, 4].map((i) => `<div><b>${stat[i]}</b><span>${stat[i + 1]}</span></div>`).join('')}</div>
    <div class="now">${current ? `<span class="dot running inline"></span>Working on: ${esc(current.title)}` : `<span style="color:var(--faint)">Available · ${(S.memory[a.id] || []).length} memories</span>`}</div>
    <div class="send-row"><a class="btn" href="#/chat/${a.id}">Open</a><button class="btn-ghost" data-edit-bot="${a.id}">✎ Edit</button>${a.id !== 'ceo' ? `<button class="btn-ghost" data-assign="${a.id}">Assign</button>` : ''}</div>
  </div>`;
}

// ---------------------------------------------------------------- dialogs

const ROLE_PRESETS = [
  ['Researcher', 'Deep research on markets, competitors and trends', true],
  ['Copywriter', 'Writes sales pages, emails and social posts', true],
  ['Data Analyst', 'Turns numbers into insights and dashboards', false],
  ['Community Manager', 'Grows and engages the community', true],
  ['QA Tester', 'Reviews deliverables for bugs, gaps and quality', false],
];

export function newBotDialog() {
  openDialog(
    'Create a bot',
    `<form class="form" data-form>
      <div class="presets">${ROLE_PRESETS.map(([r, d, w], i) => `<button type="button" class="chip" data-preset="${i}">${esc(r)}</button>`).join('')}</div>
      <label>Name<input name="name" required maxlength="40" placeholder="e.g. Quill" /></label>
      <label>Main job<input name="role" required maxlength="80" placeholder="e.g. Copywriter" /></label>
      <label>Description<textarea name="description" rows="3" placeholder="How it works, what it's great at, its personality"></textarea></label>
      <label>Specialties <small>(comma separated)</small><input name="specialties" placeholder="Sales pages, Email, Hooks" /></label>
      <label class="check"><input type="checkbox" name="web" /> Can search the web</label>
      <div class="row-btns end"><button class="btn" type="submit">Create bot</button></div>
    </form>`,
    (dlg, close) => {
      const form = $('[data-form]', dlg);
      $$('[data-preset]', dlg).forEach((b) =>
        b.addEventListener('click', () => {
          const [role, desc, web] = ROLE_PRESETS[b.dataset.preset];
          form.elements.role.value = role;
          form.elements.description.value = desc;
          form.elements.web.checked = web;
          form.elements.name.focus();
        }),
      );
      onSubmit(form, async (d) => {
        const a = await api('/api/agents', { method: 'POST', body: { ...d, specialties: d.specialties.split(',').map((s) => s.trim()).filter(Boolean) } });
        close();
        toast(`${a.name} joined the team.`);
        location.hash = `#/chat/${a.id}`;
      });
    },
  );
}

/** Edit any bot's name, role, responsibilities/personality, specialties and web access. */
export function editBotDialog(agentId) {
  const a = S.agentById[agentId];
  const isCeo = agentId === 'ceo';
  openDialog(
    `Edit ${a.name}`,
    `<form class="form" data-form>
      <div class="grid2">
        <label>Name<input name="name" required maxlength="40" value="${esc(a.name)}" /></label>
        <label>Role / main job<input name="role" required maxlength="80" value="${esc(a.role)}" /></label>
      </div>
      <label>Responsibilities & personality <small>(this is the bot's core instruction — what it owns, how it works, its tone)</small>
        <textarea name="persona" rows="8">${esc(a.persona || '')}</textarea></label>
      <label>Specialties <small>(comma separated — the CEO uses these to decide who gets which task)</small>
        <input name="specialties" value="${esc(a.specialties.join(', '))}" /></label>
      <label class="check"><input type="checkbox" name="web" ${a.web ? 'checked' : ''} /> Can search the web</label>
      ${isCeo ? '<p class="faint small" style="margin:0">The CEO keeps its planning, delegation and review duties whatever you write here.</p>' : ''}
      <div class="row-btns end">
        ${a.edited ? '<button type="button" class="btn-ghost" data-reset>Reset to default</button>' : ''}
        <button class="btn" type="submit">Save changes</button>
      </div>
    </form>`,
    (dlg, close) => {
      const form = $('[data-form]', dlg);
      // Renaming a bot also renames it inside its instructions ("You are Nova…").
      let prevName = a.name;
      form.elements.name.addEventListener('input', () => {
        const next = form.elements.name.value.trim();
        if (prevName && next) form.elements.persona.value = form.elements.persona.value.split(prevName).join(next);
        prevName = next || prevName;
      });
      $('[data-reset]', dlg)?.addEventListener('click', async () => {
        if (!confirm(`Reset ${a.name} to its original role and instructions?`)) return;
        await api(`/api/agents/${agentId}/reset`, { method: 'POST' }).catch((e) => toast(e.message));
        close();
        toast('Bot reset to default.');
      });
      onSubmit(form, async (d) => {
        const updated = await api(`/api/agents/${agentId}`, { method: 'PUT', body: d });
        close();
        toast(`${updated.name} updated — new tasks use the new role.`);
      });
    },
  );
}

export function assignDialog(agentId) {
  const a = S.agentById[agentId];
  const skills = Object.values(S.skills).filter((s) => s.status === 'active' && (s.agentId === agentId || s.agentId === 'any'));
  openDialog(
    `Assign a task to ${a.name}`,
    `<form class="form" data-form>
      <label>Task<input name="title" required placeholder="e.g. Write 5 launch tweets" /></label>
      <label>Instructions<textarea name="instructions" rows="4" placeholder="Context, constraints, what good looks like"></textarea></label>
      <div class="grid2">
        <label>Deadline<select name="deadlineHours"><option value="0.5">30 minutes</option><option value="1">1 hour</option><option value="4" selected>4 hours</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">1 week</option></select></label>
        <label>Use a skill<select name="skillId"><option value="">— none —</option>${skills.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      </div>
      <div class="row-btns end"><button class="btn" type="submit">Assign</button></div>
    </form>`,
    (dlg, close) =>
      onSubmit($('[data-form]', dlg), async (d) => {
        const m = await api(`/api/agents/${agentId}/assign`, { method: 'POST', body: { ...d, skillId: d.skillId || undefined } });
        close();
        location.hash = `#/m/${m.id}`;
      }),
  );
}

// ---------------------------------------------------------------- bot page: chat + memory + skills

export async function renderAgent(agentId) {
  const a = S.agentById[agentId];
  if (!a) return renderTeam();
  if (!S.chats[agentId]) S.chats[agentId] = await api(`/api/chats/${agentId}`).catch(() => []);
  if (S.route !== `chat/${agentId}`) return;
  const history = S.chats[agentId];
  const v = view();
  const memory = S.memory[agentId] || [];
  const skills = Object.values(S.skills).filter((s) => s.agentId === agentId || s.agentId === 'any');

  v.innerHTML = `
    <div class="topbar">${avatar(agentId)}<h2>${esc(a.name)} <span class="muted-title">· ${esc(a.role)}</span></h2>
      <div class="meta">
        <button class="btn-ghost" data-edit-bot>✎ Edit role</button>
        ${agentId !== 'ceo' ? '<button class="btn-ghost" data-assign>Assign task</button>' : ''}
        <button class="btn-ghost" data-clear>Clear chat</button>
        ${a.custom ? '<button class="btn-ghost danger" data-del-bot>Delete bot</button>' : ''}
      </div></div>
    <div class="split">
      <div class="split-main">
        <div class="scroll"><div class="thread" data-chat>${
          history.length
            ? history.map((msg) => chatMsg(a, msg)).join('')
            : `<div class="empty">${avatar(agentId, 'lg')}<p>Ask ${esc(a.name)} anything about ${esc(a.specialties.join(', ').toLowerCase())}.<br/>Say “remember …” to add to its memory.</p></div>`
        }</div></div>
        <div class="dock">${composer({ placeholder: `Message ${a.name}…` })}</div>
      </div>
      <aside class="side">
        <section>
          <h4>About</h4>
          <p class="side-text">${esc(a.persona || '')}</p>
          <div class="tags">${a.specialties.map((s) => `<span class="tag-s">${esc(s)}</span>`).join('')}${a.web ? '<span class="tag-s">🌐 web search</span>' : ''}<span class="tag-s">📁 workspace files</span></div>
        </section>
        <section>
          <h4>Memory <span class="count">${memory.length}</span></h4>
          <form class="inline-form" data-mem><input name="text" placeholder="Add something to remember…" /><button class="btn-ghost">Add</button></form>
          <ul class="mem-list">${
            memory.length
              ? [...memory].reverse().map((m) => `<li><span>${esc(m.text)}<small>${m.source.startsWith('task') ? 'from a task' : m.source} · ${ago(m.at)}</small></span><button class="icon-btn" data-forget="${m.id}" title="Forget">✕</button></li>`).join('')
              : '<li class="muted">Nothing yet. Memories are added automatically after each finished task.</li>'
          }</ul>
        </section>
        <section>
          <h4>Skills <span class="count">${skills.length}</span></h4>
          <ul class="mem-list">${skills.map((s) => `<li><a class="link" href="#/skills">${esc(s.name)}</a><span class="status ${s.status === 'active' ? 'done' : 'review'}">${s.status}</span></li>`).join('') || '<li class="muted">No skills yet — teach one in Skills.</li>'}</ul>
        </section>
      </aside>
    </div>`;
  const scroll = $('.scroll', v);
  scroll.scrollTop = scroll.scrollHeight;

  $('[data-assign]', v)?.addEventListener('click', () => assignDialog(agentId));
  $('[data-edit-bot]', v).addEventListener('click', () => editBotDialog(agentId));
  $('[data-clear]', v).addEventListener('click', async () => {
    await api(`/api/chats/${agentId}`, { method: 'DELETE' });
    S.chats[agentId] = [];
    renderAgent(agentId);
  });
  $('[data-del-bot]', v)?.addEventListener('click', async () => {
    if (!confirm(`Delete ${a.name}? Its memory is deleted too.`)) return;
    await api(`/api/agents/${agentId}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/team';
  });
  $('[data-mem]', v).addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.elements.text.value.trim();
    if (text) await api(`/api/agents/${agentId}/memory`, { method: 'POST', body: { text } }).catch((err) => toast(err.message));
  });
  $$('[data-forget]', v).forEach((b) => b.addEventListener('click', () => api(`/api/agents/${agentId}/memory/${b.dataset.forget}`, { method: 'DELETE' })));

  wireComposer(v, async (text) => {
    if (S.chatBusy) throw new Error(`${a.name} is still replying.`);
    S.chatBusy = true;
    const thread = $('[data-chat]', v);
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
    try {
      const res = await fetch(`/api/chats/${agentId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
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
      live.removeAttribute('data-live');
      S.chatBusy = false;
      if (S.route === `chat/${agentId}`) renderAgent(agentId); // pick up memory saved during the chat
    }
  });
}

function chatMsg(a, msg) {
  if (msg.role === 'user') return `<div class="msg-user">${esc(msg.content)}</div>`;
  return `<div class="msg-ai">${avatar(a.id)}<div class="body">
    <div class="msg-head"><b>${esc(a.name)}</b> ${esc(a.role)} ${!msg.streaming && msg.content ? speakBtn() : ''}</div>
    ${thinking({ reasoning: msg.reasoning, streaming: msg.streaming, text: msg.content }, 'chat')}
    <div class="md ${msg.streaming ? 'cursor' : ''}">${markdown(msg.content)}</div>
  </div></div>`;
}
