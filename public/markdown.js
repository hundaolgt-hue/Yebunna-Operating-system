// Small, safe Markdown renderer for agent output: escapes all HTML first, then
// supports headings, lists, tables, code fences, quotes, rules, bold/italic,
// inline code and http(s) links.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[([^\]]+)\]\((#\/[\w/?=&.-]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

export function markdown(src) {
  const lines = esc(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><div class="code-head"><span>${fence[1] || 'code'}</span><button data-copy>Copy</button></div><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length, 4);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (isRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    if (/^\s*&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${markdown.inner(buf.join('\n'))}</blockquote>`);
      continue;
    }

    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|&gt;|[-*+]\s|\d+[.)]\s)/.test(lines[i]) && !isRow(lines[i])) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('<br>'))}</p>`);
  }
  return out.join('');
}

// Blockquote bodies are already escaped; render them without escaping twice.
markdown.inner = (escaped) => {
  const unesc = escaped.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
  return markdown(unesc);
};
