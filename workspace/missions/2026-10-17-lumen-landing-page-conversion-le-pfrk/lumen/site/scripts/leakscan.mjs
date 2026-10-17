// Fails if dist/ or src/ contains a platform-name, phone, refund word or hard-coded link outside config.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const textExt = new Set(['.html', '.js', '.css', '.ts', '.json', '.svg', '.txt']);
const rules = [
  ['platform name', /ye[\s_-]?buna/i],
  ['phone', /0?9\s?1\s?2\s?7\s?3\s?6\s?7\s?5\s?4|251\s?9\s?1\s?2\s?7\s?3\s?6\s?7\s?5\s?4/],
  ['refund/guarantee word', /refund|money[- ]back|guarantee|ገንዘብ ተመላሽ|ዋስትና/i],
  ['hard-coded checkout-ish link', /https?:\/\/(?!connect\.facebook\.net|www\.w3\.org|fonts\.)[^\s"')]+/i],
];
let bad = 0;
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'scripts') continue;
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!textExt.has(extname(p))) continue;
    const t = readFileSync(p, 'utf8');
    for (const [name, re] of rules) { const m = t.match(re); if (m) { bad++; console.log(`LEAK [${name}] ${p}: ${m[0].slice(0, 80)}`); } }
  }
}
for (const d of process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'dist', 'index.html']) {
  try { statSync(d).isDirectory() ? walk(d) : (() => { const t = readFileSync(d, 'utf8'); for (const [n, re] of rules) { const m = t.match(re); if (m) { bad++; console.log(`LEAK [${n}] ${d}: ${m[0]}`); } } })(); } catch {}
}
console.log(bad ? `FAIL: ${bad} finding(s)` : 'PASS: 0 findings');
process.exit(bad ? 1 : 0);
