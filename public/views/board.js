import { S, esc, avatar, due, STATUS_LABEL, view } from '../core.js';

export function renderBoard() {
  const cols = ['queued', 'in_progress', 'review', 'approval', 'done', 'failed'];
  const all = Object.values(S.tasks).sort((a, b) => a.deadline.localeCompare(b.deadline));
  view().innerHTML = `<div class="page">
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
              <div class="row"><div class="who">${avatar(t.agentId, 'sm')}${esc(S.agentById[t.agentId]?.name || '?')}</div><span class="due ${d.cls}" data-due="${t.id}">${d.text}</span></div>
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
