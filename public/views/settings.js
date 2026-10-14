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
  $$('[data-set]').forEach((el) =>
    el.addEventListener('change', () =>
      api('/api/settings', { method: 'PUT', body: { [el.dataset.set]: el.checked } })
        .then((s) => ((S.settings = s), toast('Saved.')))
        .catch((e) => toast(e.message)),
    ),
  );
}
