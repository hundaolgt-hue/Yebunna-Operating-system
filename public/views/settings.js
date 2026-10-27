import { S, $$, api, esc, view, toast, Recognition } from '../core.js';

export function renderSettings() {
  const p = S.provider || {};
  const st = S.settings;
  const fb = S.apiFallback || {};
  view().innerHTML = `<div class="page narrow">
    <div class="page-head"><h2>Settings</h2></div>
    <section class="settings">
      <h3>Approvals</h3>
      <p class="side-text">Choose what needs your sign-off before it counts. Bots never handle your passwords or 2FA codes.</p>
      <label class="setting"><span><b>Approve plans before work starts</b><small>The CEO's plan waits for your OK before any bot begins.</small></span>
        <label class="switch"><input type="checkbox" data-set="approvePlans" ${st.approvePlans ? 'checked' : ''}/><span></span></label></label>
      <label class="setting"><span><b>Approve every deliverable</b><small>After the CEO's review, each deliverable waits for your Approve / Request changes.</small></span>
        <label class="switch"><input type="checkbox" data-set="approveDeliverables" ${st.approveDeliverables ? 'checked' : ''}/><span></span></label></label>
      <label class="setting"><span><b>Progress updates on Telegram</b><small>After each finished task: what was done and what comes next. Blockers, sign-offs and the final report are always sent.</small></span>
        <label class="switch"><input type="checkbox" data-set="progressUpdates" ${st.progressUpdates !== false ? 'checked' : ''}/><span></span></label></label>
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
      <p class="side-text">Bots run on your Claude plan. Each bot has its own model and effort, so the big model is only used where it pays off. One bot works at a time (plus the CEO), in order. The task size (small, medium, large) only sets how many steps a bot may take.</p>
      <table class="usage-table"><tr><th>Bot</th><th>Model</th><th>Effort</th></tr>${S.agents
        .map((a) => `<tr><td>${esc(a.name)} <span class="faint">${esc(a.role)}</span></td><td>${pickSel(a.id, 'model', a.model, MODELS)}${a.planModel ? `<br/><small class="faint">planning:</small> ${pickSel(a.id, 'planModel', a.planModel, MODELS)}` : ''}</td><td>${pickSel(a.id, 'effort', a.effort, EFFORTS)}${a.planModel ? `<br/><small class="faint">planning:</small> ${pickSel(a.id, 'planEffort', a.planEffort, EFFORTS)}` : ''}</td></tr>`)
        .join('')}</table>
      <p class="faint small">Memory notes use Haiku. Meetings use each bot's model at low effort.</p>
      ${usageTable()}
    </section>
    <section class="settings">
      <h3>Billing</h3>
      <p class="side-text">How the team's runs are paid for. The API is billed per token by Anthropic (console.anthropic.com), separately from your Claude subscription, so it has a daily cap: past it the team pauses until the next day.</p>
      <label class="setting"><span><b>Run the team on</b><small>${esc(BILLING[fb.mode || 'plan'])}</small></span>
        <select class="select-sm" data-billing>${Object.entries(BILLING_LABEL).map(([v, l]) => `<option value="${v}" ${(fb.mode || 'plan') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${S.apiMode ? `<div class="kv"><span>Right now</span><b>💳 On the API key until ${esc(new Date(S.apiMode.backAt).toLocaleString())}</b></div>` : ''}
      <label class="setting"><span><b>Anthropic API key</b><small>console.anthropic.com → API keys (starts with sk-ant-). Stays on this PC; only bot runs get it.</small></span>
        <span class="row-btns"><input class="select-sm" type="password" data-api-key placeholder="${esc(fb.key || 'sk-ant-…')}" style="width:16em" /><button class="btn-ghost" data-api-test>Save & test</button></span></label>
      <label class="setting"><span><b>Daily cap (USD)</b><small>Spent today on the API: $${(fb.spentToday || 0).toFixed(2)}</small></span>
        <input class="select-sm" type="number" min="1" max="1000" step="1" data-api-cap value="${fb.dailyCapUsd || 10}" style="width:6em" /></label>
      <label class="setting"><span><b>Fallback only: use Sonnet instead of Opus on the API</b><small>In "subscription, API as fallback" mode, bots set to Opus run on Sonnet while on the API. In "API only" mode every bot keeps its own model.</small></span>
        <label class="switch"><input type="checkbox" data-api="noOpus" ${fb.noOpus !== false ? 'checked' : ''}/><span></span></label></label>
    </section>
    <section class="settings">
      <h3>Storage</h3>
      <p class="side-text">Bots save their work, renders and browser profiles in the workspace folder on this PC. If the disk gets nearly full, the team pauses by itself and resumes when there is room again.</p>
      <div data-storage><p class="faint small">Measuring…</p></div>
    </section>
    <section class="settings">
      <h3>Engine</h3>
      <div class="kv"><span>Running on</span><b>${p.name === 'demo' ? 'Offline demo (Claude Code not found)' : `Claude via Claude Code ${esc(p.cli || '')}`}</b></div>
      <div class="kv"><span>Claude runs right now</span><b data-runs>…</b></div>
      <div class="kv"><span>Billing</span><b>${p.name === 'demo' ? '—' : 'Your Claude subscription (no API key)'}</b></div>
      <div class="kv"><span>Workspace</span><code>${esc(S.workspace)}</code></div>
      <p class="faint small">Set each bot's model and effort under Usage above (or Team → Edit).</p>
    </section>
    <section class="settings">
      <h3>Voice</h3>
      <div class="kv"><span>Dictation (🎙 in every message box)</span><b>${Recognition ? 'Available in this browser' : 'Not supported here — use Chrome or Edge'}</b></div>
      <div class="kv"><span>Read aloud (🔊 on replies)</span><b>${'speechSynthesis' in window ? 'Available' : 'Not supported'}</b></div>
    </section>
  </div>`;
  loadStorage();
  api('/api/health')
    .then((h) => {
      const el = document.querySelector('[data-runs]');
      if (el) el.textContent = `${h.runs.running} busy of ${h.runs.max} (your chats go first) · ${h.runs.waiting} waiting${h.telegram.lastError ? ` · Telegram: ${h.telegram.lastError}` : ''}`;
    })
    .catch(() => {});
  const put = (body) =>
    api('/api/settings', { method: 'PUT', body })
      .then((s) => ((S.settings = s), toast('Saved.')))
      .catch((e) => toast(e.message));
  $$('[data-set-inv]').forEach((el) => el.addEventListener('change', () => put({ [el.dataset.setInv]: !el.checked })));
  $$('[data-browser]').forEach((el) => el.addEventListener('change', () => put({ browser: el.value })));
  const putApi = (body) =>
    api('/api/api-fallback', { method: 'PUT', body })
      .then((f) => ((S.apiFallback = f), toast('Saved.')))
      .catch((e) => (toast(e.message), renderSettings()));
  $$('[data-api]').forEach((el) => el.addEventListener('change', () => putApi({ [el.dataset.api]: el.checked })));
  $$('[data-billing]').forEach((el) => el.addEventListener('change', () => putApi({ mode: el.value }).then(renderSettings)));
  $$('[data-api-cap]').forEach((el) => el.addEventListener('change', () => putApi({ dailyCapUsd: Number(el.value) })));
  $$('[data-api-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      const key = document.querySelector('[data-api-key]').value.trim();
      try {
        if (key) S.apiFallback = await api('/api/api-fallback', { method: 'PUT', body: { key } });
        const r = await api('/api/api-fallback/test', { method: 'POST' });
        toast(r.ok ? '✅ The key works.' : `⚠️ ${r.message}`);
        renderSettings();
      } catch (e) {
        toast(e.message);
      }
    }),
  );
  $$('[data-run]').forEach((el) =>
    el.addEventListener('change', () =>
      api(`/api/agents/${el.dataset.run}`, { method: 'PUT', body: { [el.dataset.field]: el.value } })
        .then(() => toast('Saved.'))
        .catch((e) => toast(e.message)),
    ),
  );
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

const BILLING_LABEL = { plan: 'My Claude subscription', auto: 'Subscription, API key as fallback', api: 'API key only' };
const BILLING = {
  plan: 'Every run counts against your Claude plan. At its usage limit the team pauses until it resets.',
  auto: 'Runs count against your plan; while its limit is hit, the team carries on with your API key and switches back when the plan resets.',
  api: 'Every run is billed to your API key, never to the subscription. No plan limits; the daily cap below is the only brake.',
};
const MODELS = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const pickSel = (id, field, value, options) =>
  `<select class="select-sm" data-run="${esc(id)}" data-field="${field}">${options.map((o) => `<option ${o === value ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

const n = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x || 0));
const KIND = { task: 'Tasks', chat: 'Chats', plan: 'CEO planning', review: 'CEO reviews', report: 'Reports', meeting: 'Meetings', minutes: 'Minutes & retros', memory: 'Memory notes', skill: 'Skills', other: 'Other' };

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
      ${today.byBilling ? `<table class="usage-table">${head}${rows(today.byBilling, (k) => (k === 'api' ? 'Billed to the API key' : 'Your Claude plan'))}</table>` : ''}
      <p class="faint small">“≈ API $” is what the same work would cost on the pay-per-use API — not a charge on your plan, just a relative measure of how much limit each part uses.</p></details>` : ''}`;
}

const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.round(b / 1024)} KB`);
const WHAT = { '.browser': 'browser profiles of bots with computer use', '.skills': 'downloaded skill packs' };

async function loadStorage() {
  const box = document.querySelector('[data-storage]');
  if (!box) return;
  try {
    const r = await api('/api/storage');
    const d = r.disk;
    box.innerHTML = `${d ? `<div class="kv"><span>Free on this drive</span><b style="color:${d.status === 'ok' ? 'inherit' : 'var(--bad)'}">${size(d.free)} of ${size(d.total)}</b></div>` : ''}
      <div class="kv"><span>Workspace</span><code>${esc(r.workspace)}</code></div>
      ${r.folders.length ? `<table class="usage-table"><tr><th>Folder</th><th class="num">size</th></tr>${r.folders.map((f) => `<tr><td>${esc(f.name)}${WHAT[f.name] ? ` <span class="faint">— ${WHAT[f.name]}</span>` : ''}</td><td class="num">${size(f.size)}</td></tr>`).join('')}</table>` : ''}
      ${r.largest.length ? `<details><summary class="faint small" style="cursor:pointer;margin-top:8px">Largest files</summary><table class="usage-table">${r.largest.map((f) => `<tr><td><a class="link" href="#/files?f=${encodeURIComponent(f.path)}">${esc(f.path)}</a></td><td class="num">${size(f.size)}</td></tr>`).join('')}</table></details>` : ''}
      <div class="row-btns"><button class="btn" data-clean>🧹 Delete the team's temporary files</button></div>
      <p class="faint small">That removes render frames, temp and cache folders (never deliverables, never a task that is running). To free more, delete old mission folders or large files you don't need (in File Explorer, inside the workspace folder above), or empty Windows' temp files (Settings → System → Storage → Temporary files). If Google Drive for desktop is set to "Mirror files", it keeps a full copy of your Drive on this disk: switch it to "Stream files" (Drive for desktop → Settings → Google Drive) to get that space back.</p>`;
    box.querySelector('[data-clean]')?.addEventListener('click', async () => {
      try {
        const r2 = await api('/api/storage/clean', { method: 'POST' });
        toast(`Freed ${size(r2.freed)}.`);
        loadStorage();
      } catch (e) {
        toast(e.message);
      }
    });
  } catch (e) {
    box.innerHTML = `<p class="faint small">${esc(e.message)}</p>`;
  }
}
