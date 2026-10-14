import { S, $, $$, api, esc, markdown, view, fileUrl, toast } from '../core.js';

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

export async function renderFiles(selected) {
  const v = view();
  const { root, files } = await api('/api/files').catch((e) => (toast(e.message), { files: [] }));
  if (!S.route.startsWith('files')) return;
  const visible = files.filter((f) => !f.path.startsWith('.teach/')).sort((a, b) => b.mtime.localeCompare(a.mtime));
  const groups = {};
  for (const f of visible) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    (groups[dir] ||= []).push(f);
  }
  const file = visible.find((f) => f.path === selected) || (selected ? null : visible[0]);
  const folderFocus = selected && !file ? selected : null;

  v.innerHTML = `<div class="page files-page">
    <div class="page-head"><h2>Files</h2><p>The shared workspace every bot works in: <code>${esc(root || '')}</code></p></div>
    ${
      visible.length
        ? `<div class="files">
      <div class="file-tree">${Object.entries(groups)
        .sort(([a], [b]) => (folderFocus && a.startsWith(folderFocus) ? -1 : folderFocus && b.startsWith(folderFocus) ? 1 : 0))
        .map(
          ([dir, list]) => `<div class="folder ${folderFocus && dir.startsWith(folderFocus) ? 'focus' : ''}"><div class="folder-name">📁 ${esc(dir)}</div>${list
            .map((f) => `<a class="file ${file?.path === f.path ? 'active' : ''}" href="#/files?f=${encodeURIComponent(f.path)}"><span>${esc(f.path.split('/').pop())}</span><small>${fmtSize(f.size)}</small></a>`)
            .join('')}</div>`,
        )
        .join('')}</div>
      <div class="file-view">${file ? `<div class="file-head"><b>${esc(file.path)}</b><span class="spacer"></span><a class="btn-ghost" href="${fileUrl(file.path, true)}">Download</a><a class="btn-ghost" href="${fileUrl(file.path)}" target="_blank" rel="noopener">Open raw</a></div><div class="file-body" data-body><span class="shimmer">Loading…</span></div>` : '<div class="empty">Pick a file.</div>'}</div>
    </div>`
        : '<div class="empty">No files yet — every finished task is saved here automatically.</div>'
    }
  </div>`;

  if (!file) return;
  const body = $('[data-body]', v);
  if (IMG.test(file.path)) {
    body.innerHTML = `<img class="file-img" src="${fileUrl(file.path)}" alt="" />`;
  } else if (file.size > 2e6) {
    body.innerHTML = '<div class="empty">Too large to preview — download it instead.</div>';
  } else {
    const text = await fetch(fileUrl(file.path)).then((r) => r.text());
    body.innerHTML = /\.md$/i.test(file.path) ? `<div class="md">${markdown(text)}</div>` : `<pre class="code"><code>${esc(text)}</code></pre>`;
  }
}
