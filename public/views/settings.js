import { S, $$, api, esc, view, toast, Recognition } from '../core.js';

export function renderSettings() {
  const p = S.provider || {};
  const st = S.settings;
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
      <h3>Engine</h3>
      <div class="kv"><span>Running on</span><b>${p.name === 'demo' ? 'Offline demo (Claude Code not found)' : `Claude via Claude Code ${esc(p.cli || '')}`}</b></div>
      <div class="kv"><span>Model</span><b>${esc(p.model || '')}</b></div>
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
