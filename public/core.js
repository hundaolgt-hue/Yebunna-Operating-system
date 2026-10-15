// Shared client state and UI helpers.
import { markdown, esc } from './markdown.js';

export { markdown, esc };

export const S = {
  agents: [],
  agentById: {},
  provider: null,
  workspace: '',
  missions: {},
  tasks: {},
  meetings: {},
  skills: {},
  routines: {},
  memory: {},
  settings: {},
  chats: {},
  expanded: new Set(),
  chatBusy: false,
  route: '',
  activity: [],
  packs: [],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const view = () => $('#view');

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

export function setAgents(list) {
  S.agents = list;
  S.agentById = Object.fromEntries(list.map((a) => [a.id, a]));
}

export function avatar(agentId, size = '') {
  if (agentId === 'founder') return `<div class="avatar ${size}" style="background:#3f3f46;color:#fff" title="You">You</div>`;
  const a = S.agentById[agentId];
  if (!a) return `<div class="avatar ${size}" style="background:#444">?</div>`;
  return `<div class="avatar ${size}" style="background:${a.color}" title="${esc(a.name)} · ${esc(a.role)}">${esc(a.name[0])}</div>`;
}
export const agentName = (id) => (id === 'founder' ? 'You' : S.agentById[id]?.name || 'Unknown bot');

export function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 1000))}s`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}
export const ago = (iso) => `${span(Date.now() - Date.parse(iso))} ago`;

export function due(t) {
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

export function missionDue(m) {
  if (m.status === 'done') {
    const diff = Date.parse(m.deadline) - Date.parse(m.completedAt);
    return diff >= 0 ? `finished ${span(diff)} early` : `finished ${span(diff)} late`;
  }
  const left = Date.parse(m.deadline) - Date.now();
  return left >= 0 ? `deadline in ${span(left)}` : `deadline passed ${span(left)} ago`;
}

export const STATUS_LABEL = { queued: 'Queued', in_progress: 'Working', review: 'CEO review', approval: 'Your approval', done: 'Done', failed: 'Failed' };
export const MISSION_LABEL = {
  planning: 'CEO planning',
  awaiting_approval: 'Plan needs your OK',
  running: 'Team working',
  reporting: 'Writing report',
  done: 'Complete',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
};

export const missionTasks = (m) => m.taskIds.map((id) => S.tasks[id]).filter(Boolean);
export const sortedMissions = () => Object.values(S.missions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const fileUrl = (p, download) => `/api/file?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;

export function thinking(item, key) {
  if (!item.reasoning && !(item.streaming && !item.text)) return '';
  const live = item.streaming && !item.text;
  return `<details class="thinking" ${live ? 'open' : ''}>
    <summary><span class="${live ? 'shimmer' : ''}">${live ? 'Thinking' : 'Thoughts & tool use'}</span> ›</summary>
    <div class="thoughts" data-stream="${key}:reasoning">${esc(item.reasoning || '…')}</div>
  </details>`;
}

export const speakBtn = () => `<button class="icon-btn speak" data-speak title="Read aloud">🔊</button>`;

export function agentOptions(selected, { includeCeo = false, includeAny = false } = {}) {
  return [
    includeAny ? `<option value="any" ${selected === 'any' ? 'selected' : ''}>Any bot</option>` : '',
    ...S.agents
      .filter((a) => includeCeo || a.id !== 'ceo')
      .map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)} — ${esc(a.role)}</option>`),
  ].join('');
}

// ---------------------------------------------------------------- composer + voice

const SEND_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MIC_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0014 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function composer({ placeholder, controls = '', hint = '' }) {
  return `<form class="composer" data-composer>
    <textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
    <div class="composer-bar">${controls}<span class="spacer"></span>${hint ? `<span class="mention-hint">${hint}</span>` : ''}
      ${Recognition ? `<button class="mic" type="button" data-mic title="Voice: dictate your message">${MIC_ICON}</button>` : ''}
      <button class="send" type="submit" disabled aria-label="Send">${SEND_ICON}</button>
    </div>
  </form>`;
}

/** Hook up dictation: speech → text appended into a textarea (works in Chrome/Edge). */
export function attachMic(btn, ta, onChange) {
  if (!btn || !Recognition) return;
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) return rec.stop();
    rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const base = ta.value ? `${ta.value.trim()} ` : '';
    rec.onresult = (e) => {
      let text = '';
      for (const r of e.results) text += r[0].transcript;
      ta.value = base + text;
      onChange?.();
    };
    rec.onerror = (e) => toast(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice: ${e.error}`);
    rec.onend = () => {
      rec = null;
      btn.classList.remove('rec');
    };
    rec.start();
    btn.classList.add('rec');
  });
}

export function wireComposer(root, onSubmit) {
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
  attachMic($('[data-mic]', form), ta, resize);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || form.dataset.sending) return;
    // Clear right away (live updates may re-render the page while the message is in flight);
    // the text comes back only if sending fails.
    form.dataset.sending = '1';
    ta.value = '';
    resize();
    try {
      await onSubmit(text, form);
    } catch (err) {
      toast(err.message);
      const box = form.isConnected ? ta : document.querySelector('#view [data-composer] textarea');
      if (box && !box.value) box.value = text;
    } finally {
      delete form.dataset.sending;
    }
    resize();
  });
  return { ta, form, resize };
}

// Read-aloud for any AI message (speechSynthesis).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-speak]');
  if (!btn) return;
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    return;
  }
  const text = btn.closest('.body, .utterance, .speakable')?.querySelector('.md')?.innerText;
  if (text) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 1.05 }));
});

// ---------------------------------------------------------------- dialogs

/** Open a modal dialog. Lives outside #view so live updates never wipe a form. */
export function openDialog(title, bodyHtml, onMount) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="modal-body">${bodyHtml}</div>`;
  document.body.append(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  $('[data-close]', dlg).addEventListener('click', close);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.showModal();
  onMount?.(dlg, close);
  return { dlg, close };
}

/** Collect a form's named fields into an object (checkbox groups → arrays). */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if ('group' in el.dataset) {
        out[el.name] ||= [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else out[el.name] = el.value;
  }
  return out;
}

export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn && (btn.disabled = true);
    try {
      await handler(formData(form));
    } catch (err) {
      toast(err.message);
    }
    btn && (btn.disabled = false);
  });
}

// ---------------------------------------------------------------- activity feed

const refLink = (ref) =>
  !ref ? null : ref.type === 'task' ? `#/m/${ref.missionId}/${ref.id}` : ref.type === 'mission' ? `#/m/${ref.id}` : ref.type === 'chat' ? `#/chat/${ref.agentId}` : ref.type === 'meeting' ? `#/meetings/${ref.id}` : null;

/** What the bots are doing, newest first. */
export function activityList(items, { limit = 60, empty = 'No activity yet.' } = {}) {
  const list = [...items].reverse().slice(0, limit);
  if (!list.length) return `<div class="empty small">${empty}</div>`;
  return `<ul class="activity">${list
    .map((a) => {
      const link = refLink(a.ref);
      const body = `${avatar(a.agentId, 'sm')}<span><b>${esc(agentName(a.agentId))}</b> ${esc(a.text)}<small>${ago(a.at)}</small></span>`;
      return `<li>${link ? `<a href="${link}">${body}</a>` : body}</li>`;
    })
    .join('')}</ul>`;
}
