import { S, $, $$, api, esc, markdown, view, fileUrl, toast } from '../core.js';

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

export async function renderFiles(selected) {
  const v = view();
  const { root, files } = await api('/api/files').catch((e) => (toast(e.message), { files: [] }));
  if (!S.route.startsWith('files')) return;
  // Internal folders (taught recordings, skill packs, browser profiles) stay out of the list…
  const visible = files.filter((f) => !/^\.(teach|skills|browser)\//.test(f.path)).sort((a, b) => b.mtime.localeCompare(a.mtime));
  const groups = {};
  for (const f of visible) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    (groups[dir] ||= []).push(f);
  }
  // …but can still be opened directly (e.g. "View" on a skill).
  const file = files.find((f) => f.path === selected) || (selected && /\.\w+$/.test(selected) ? { path: selected, size: 0 } : selected ? null : visible[0]);
  const folderFocus = selected && !file ? selected : null;

  v.innerHTML = `<div class="page files-page">
    <div class="page-head"><h2>Files</h2><p>The shared workspace every bot works in: <code>${esc(root || '')}</code></p>
      <span class="spacer"></span><label class="btn" title="Sample images, videos or documents for the team">⬆ Upload references<input type="file" multiple hidden data-upload /></label></div>
    <p class="faint small" data-drop-hint>Drop sample images or videos anywhere on this page. They're saved in <code>references/</code>; then tell a bot (or the CEO) to use them, e.g. “Vega, make 3 ads in the style of references/${new Date().toISOString().slice(0, 10)}”.</p>
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

  wireUpload(v);
  if (!file) return;
  const body = $('[data-body]', v);
  if (IMG.test(file.path)) {
    body.innerHTML = `<img class="file-img" src="${fileUrl(file.path)}" alt="" />`;
  } else if (VIDEO.test(file.path)) {
    body.innerHTML = `<video class="file-img" src="${fileUrl(file.path)}" controls playsinline></video>`;
  } else if (file.size > 2e6) {
    body.innerHTML = '<div class="empty">Too large to preview — download it instead.</div>';
  } else {
    const text = await fetch(fileUrl(file.path)).then((r) => r.text());
    body.innerHTML = /\.md$/i.test(file.path) ? `<div class="md">${markdown(text)}</div>` : `<pre class="code"><code>${esc(text)}</code></pre>`;
  }
}

async function upload(files) {
  let last = null;
  for (const f of files) {
    toast(`Uploading ${f.name}…`);
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      last = data.path;
    } catch (e) {
      toast(`${f.name}: ${e.message}`);
      return;
    }
  }
  if (last) {
    toast(files.length > 1 ? `${files.length} files saved in ${last.slice(0, last.lastIndexOf('/'))}/` : `Saved as ${last}`);
    location.hash = `#/files?f=${encodeURIComponent(last)}`;
    renderFiles(last);
  }
}

function wireUpload(v) {
  $('[data-upload]', v)?.addEventListener('change', (e) => upload([...e.target.files]));
  if (v.dataset.dropWired) return;
  v.dataset.dropWired = '1';
  v.addEventListener('dragover', (e) => {
    if (!S.route.startsWith('files')) return;
    e.preventDefault();
  });
  v.addEventListener('drop', (e) => {
    if (!S.route.startsWith('files') || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    upload([...e.dataTransfer.files]);
  });
}
