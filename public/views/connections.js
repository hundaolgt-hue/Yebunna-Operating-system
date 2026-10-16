import { S, $, $$, api, esc, avatar, toast, view, ago } from '../core.js';

export function renderConnections() {
  const list = S.connections || [];
  view().innerHTML = `<div class="page narrow">
    <div class="page-head"><h2>Connections</h2><p>Give bots access to your accounts. Tokens stay on this PC — they're never shown again, sent to the browser, or written into bot files.</p></div>
    ${!S.settings.terminal ? '<div class="msg-escalation">Vercel and Meta work through the terminal — turn on <b>Settings → Terminal</b> for them to be usable.</div>' : ''}
    ${list.map(card).join('')}
    <p class="faint small">Other sites (Gmail, Canva, Ye-Buna …): turn on computer use and use <b>🔑 Log in to a site</b> on a bot's page.</p>
  </div>`;
  const v = view();
  $$('[data-conn]', v).forEach((form) => {
    const id = form.dataset.conn;
    const allBox = $('[data-all]', form);
    allBox?.addEventListener('change', () => $$('[name=bots]', form).forEach((c) => (c.checked = allBox.checked)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = e.submitter?.value;
      try {
        if (action === 'remove') {
          if (!confirm('Disconnect and forget these credentials?')) return;
          await api(`/api/connections/${id}`, { method: 'DELETE' });
          return toast('Disconnected.');
        }
        const config = {};
        $$('[data-field]', form).forEach((i) => (config[i.name] = i.value));
        const bots = allBox?.checked ? ['*'] : $$('[name=bots]:checked', form).map((c) => c.value);
        await api(`/api/connections/${id}`, { method: 'PUT', body: { config, bots } });
        toast('Saved — testing the connection…');
        const st = await api(`/api/connections/${id}/test`, { method: 'POST' });
        toast(st.ok ? `Connected: ${st.account}` : `Couldn't connect: ${st.error}`);
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function card(c) {
  const st = c.status;
  const badge = st?.ok
    ? `<span class="status done">connected</span>`
    : st && !st.ok
      ? `<span class="status failed">error</span>`
      : c.enabled
        ? `<span class="status review">not tested</span>`
        : `<span class="status">not connected</span>`;
  const all = c.bots.includes('*');
  return `<section class="settings conn">
    <div class="row"><span class="conn-icon">${c.icon}</span><h3>${esc(c.label)}</h3><span class="spacer"></span>${badge}</div>
    <p class="side-text">${esc(c.uses)}</p>
    ${st ? `<p class="small ${st.ok ? 'ok-text' : 'bad-text'}">${st.ok ? `✓ ${esc(st.account)}` : `✕ ${esc(st.error)}`} · checked ${ago(st.at)}</p>` : ''}
    <details ${c.enabled ? '' : 'open'}><summary>${c.enabled ? 'Change settings' : 'How to connect'}</summary>
      <ol class="steps">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p class="small"><a class="link" href="${c.link}" target="_blank" rel="noopener">Open ${esc(new URL(c.link).hostname)} ↗</a></p>
      <form class="form" data-conn="${c.id}">
        ${c.fields
          .map((f) =>
            f.secret
              ? // Never prefilled, so the browser can't swap in a saved password; empty keeps the saved token.
                `<label>${esc(f.label)}<input data-field name="${f.key}" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(c.config[f.key] ? `Saved (${c.config[f.key]}) — paste a new one to replace it` : f.placeholder || '')}" value="" /></label>`
              : `<label>${esc(f.label)}<input data-field name="${f.key}" placeholder="${esc(f.placeholder || '')}" value="${esc(c.config[f.key] || '')}" /></label>`,
          )
          .join('')}
        <div class="field-label">Which bots may use it</div>
        <label class="check"><input type="checkbox" data-all ${all ? 'checked' : ''}/> All bots</label>
        <div class="pick">${S.agents
          .map((a) => `<label class="pick-item"><input type="checkbox" name="bots" value="${a.id}" ${all || c.bots.includes(a.id) ? 'checked' : ''}/>${avatar(a.id, 'sm')}<span>${esc(a.name)}<small>${esc(a.role)}</small></span></label>`)
          .join('')}</div>
        <div class="row-btns end">${c.enabled ? '<button class="btn-ghost danger" value="remove">Disconnect</button>' : ''}<button class="btn" value="save">Save & test</button></div>
      </form>
    </details>
  </section>`;
}
