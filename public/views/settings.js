import { S, $$, api, esc, view, toast, Recognition } from '../core.js';

export function renderSettings() {
  const p = S.provider || {};
  const st = S.settings;
  const mode = st.usageMode || (st.economy ? 'economy' : 'balanced');
  view().innerHTML = `<div class="page narrow">
    <div class="page-head"><h2>Settings</h2></div>
    <section class="settings">
      <h3>Approvals</h3>
      <p class="side-text">Choose what needs your sign-off before it counts. Bots never handle your passwords or 2FA codes.</p>
      <label class="setting"><span><b>Approve plans before work starts</b><small>The CEO's plan waits for your OK before any bot begins.</small></span>
        <label class="switch"><input type="checkbox" data-set="approvePlans" ${st.approvePlans ? 'checked' : ''}/><span></span></label></label>
      <label class="setting"><span><b>Approve every deliverable</b><small>After the CEO's review, each deliverable waits for your Approve / Request changes.</small></span>
        <label class="switch"><input type="checkbox" data-set="approveDeliverables" ${st.approveDeliverables ? 'checked' : ''}/><span></span></label></label>
    </section>
    <section class="settings">
      <h3>Computer use</h3>
      <p class="side-text">Bots with computer use control a real web browser: they open sites, click, type, fill forms and read pages — like Grok Bot. Each bot has its own browser profile, so sites you log into for it stay logged in. Bots never type your passwords or buy, send, publish or delete anything unless the task says so.</p>
      <div class="kv"><span>Bots with computer use</span><b>${S.agents.filter((a) => a.computer).length} of ${S.agents.length}</b></div>
      <div class="row-btns"><button class="btn" data-computer="1">🖥 Turn on for all bots</button><button class="btn-ghost" data-computer="0">Turn off for all</button></div>
      <label class="setting"><span><b>Show the browser window</b><small>Watch bots work and take over when a site needs you. Turn off to run invisibly in the background.</small></span>
        <label class="switch"><input type="checkbox" data-set-inv="browserHeadless" ${!st.browserHeadless ? 'checked' : ''}/><span></span></label></label>
      <label class="setting"><span><b>Browser</b><small>Edge is built into Windows. Chrome must be installed to use it.</small></span>
        <select class="select-sm" data-browser>${[['msedge', 'Microsoft Edge'], ['chrome', 'Google Chrome'], ['firefox', 'Firefox']].map(([v, l]) => `<option value="${v}" ${st.browser === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="setting"><span><b>Terminal (run commands)</b><small>All bots can run commands in the workspace folder — e.g. Python to build, recalculate and check spreadsheets. Needs Git for Windows (and Python for Python scripts).</small></span>
        <label class="switch"><input type="checkbox" data-set="terminal" ${st.terminal ? 'checked' : ''}/><span></span></label></label>
    </section>
    <section class="settings">
      <h3>Usage</h3>
      <p class="side-text">Bots run on your Claude plan, so their work counts toward the same limits as your own chats. Every mission is many separate runs (plan, each task, each review, memory notes, the report). This shows where your usage goes.</p>
      <label class="setting"><span><b>Usage mode</b><small>${esc(MODES[mode][1])}</small></span>
        <select class="select-sm" data-usage-mode>${Object.entries(MODES).map(([v, [l]]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="setting"><span><b>Opus for large tasks</b><small>Large tasks (code, spreadsheet models, deep research, long browser work) always run on Opus at full effort, whatever the usage mode — e.g. Economy for everything else, Opus for the heavy work. Pick “Large” when you assign a task yourself to send it to Opus.</small></span>
        <label class="switch"><input type="checkbox" data-set="opusForLarge" ${st.opusForLarge ? 'checked' : ''}/><span></span></label></label>
      <p class="faint small">The CEO sizes every task small, medium or large. The deadline only sets the order work is done in; it never makes a bot work longer or use more.</p>
      ${usageTable()}
    </section>
    <section class="settings">
      <h3>Engine</h3>
      <div class="kv"><span>Running on</span><b>${p.name === 'demo' ? 'Offline demo (Claude Code not found)' : `Claude via Claude Code ${esc(p.cli || '')}`}</b></div>
      <div class="kv"><span>Model</span><b>${esc(MODES[mode][0])}${mode !== 'economy' ? ` · big model: ${esc(p.model === 'default' ? 'your Claude Code default' : p.model || '')}` : ''}</b></div>
      <div class="kv"><span>Billing</span><b>${p.name === 'demo' ? '—' : 'Your Claude subscription (no API key)'}</b></div>
      <div class="kv"><span>Workspace</span><code>${esc(S.workspace)}</code></div>
      <p class="faint small">Change the model or parallelism in the <code>.env</code> file (see README) and restart.</p>
    </section>
    <section class="settings">
      <h3>Voice</h3>
      <div class="kv"><span>Dictation (🎙 in every message box)</span><b>${Recognition ? 'Available in this browser' : 'Not supported here — use Chrome or Edge'}</b></div>
      <div class="kv"><span>Read aloud (🔊 on replies)</span><b>${'speechSynthesis' in window ? 'Available' : 'Not supported'}</b></div>
    </section>
  </div>`;
  const put = (body) =>
    api('/api/settings', { method: 'PUT', body })
      .then((s) => ((S.settings = s), toast('Saved.')))
      .catch((e) => toast(e.message));
  $$('[data-set-inv]').forEach((el) => el.addEventListener('change', () => put({ [el.dataset.setInv]: !el.checked })));
  $$('[data-browser]').forEach((el) => el.addEventListener('change', () => put({ browser: el.value })));
  $$('[data-usage-mode]').forEach((el) => el.addEventListener('change', () => put({ usageMode: el.value }).then(renderSettings)));
  $$('[data-computer]').forEach((b) =>
    b.addEventListener('click', () =>
      api('/api/agents/computer', { method: 'POST', body: { enabled: b.dataset.computer === '1' } })
        .then(() => toast(b.dataset.computer === '1' ? 'Computer use is on for every bot.' : 'Computer use is off for every bot.'))
        .catch((e) => toast(e.message)),
    ),
  );
  $$('[data-set]').forEach((el) =>
    el.addEventListener('change', () =>
      api('/api/settings', { method: 'PUT', body: { [el.dataset.set]: el.checked } })
        .then((s) => ((S.settings = s), toast('Saved.')))
        .catch((e) => toast(e.message)),
    ),
  );
}

const MODES = {
  balanced: ['Balanced (recommended)', 'Your big model only plans missions and does large tasks. Normal tasks, chats, meetings and reports use Sonnet; CEO reviews and memory notes use Haiku. Small tasks get a small step budget.'],
  quality: ['Quality', 'Everything runs on your Claude Code default model at full effort. Best results, uses your limit fastest.'],
  economy: ['Economy', 'No big model: Sonnet for most work, Haiku for small tasks, reviews, meetings and notes, with low effort. Uses the least.'],
};

const n = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x || 0));
const KIND = { task: 'Tasks', chat: 'Chats', plan: 'CEO planning', review: 'CEO reviews', report: 'Reports', meeting: 'Meetings', memory: 'Memory notes', skill: 'Skills', other: 'Other' };

function usageTable() {
  const days = S.usage?.days || {};
  const today = days[new Date().toISOString().slice(0, 10)];
  const week = Object.entries(days)
    .filter(([d]) => Date.now() - Date.parse(d) < 7 * 864e5)
    .reduce((a, [, v]) => ({ runs: a.runs + v.runs, output: a.output + v.output, cost: a.cost + (v.cost || 0) }), { runs: 0, output: 0, cost: 0 });
  if (!today && !week.runs) return '<p class="faint small">No bot runs recorded yet.</p>';
  const rows = (obj, label) =>
    Object.entries(obj || {})
      .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0) || b[1].output - a[1].output)
      .map(([k, v]) => `<tr><td>${esc(label(k))}</td><td class="num">${v.runs}</td><td class="num">${n(v.turns)}</td><td class="num">${n(v.input + v.cached)}</td><td class="num">${n(v.output)}</td><td class="num">$${(v.cost || 0).toFixed(2)}</td></tr>`)
      .join('');
  const head = '<tr><th></th><th class="num">runs</th><th class="num">steps</th><th class="num">read</th><th class="num">written</th><th class="num">≈ API $</th></tr>';
  return `<div class="kv"><span>Today</span><b>${today ? `${today.runs} runs · ${n(today.output)} tokens written · ≈ $${(today.cost || 0).toFixed(2)} API-equivalent` : '—'}</b></div>
    <div class="kv"><span>Last 7 days</span><b>${week.runs} runs · ${n(week.output)} tokens written · ≈ $${week.cost.toFixed(2)}</b></div>
    ${today ? `<details><summary class="faint small" style="cursor:pointer;margin-top:8px">Today by bot, by kind of work and by model</summary>
      <table class="usage-table">${head}${rows(today.byBot, (id) => S.agentById[id]?.name || id)}</table>
      <table class="usage-table">${head}${rows(today.byKind, (k) => KIND[k] || k)}</table>
      ${today.byModel ? `<table class="usage-table">${head}${rows(today.byModel, (k) => k)}</table>` : ''}
      <p class="faint small">“≈ API $” is what the same work would cost on the pay-per-use API — not a charge on your plan, just a relative measure of how much limit each part uses.</p></details>` : ''}`;
}
