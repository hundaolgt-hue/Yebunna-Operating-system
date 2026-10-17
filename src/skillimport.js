// The founder's own skills: .skill / .zip files uploaded in Skills, and the skills Claude Code
// keeps on this PC (~/.claude/skills, including skills synced from claude.ai). They are copied
// into workspace/.skills/custom/<name>/ and registered in the skill library like a pack, so every
// bot can open them and the CEO can assign them per task. Nothing here is sent anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { state, save, now, WORKSPACE } from './store.js';
import { bus } from './bus.js';

const ROOT = path.join(WORKSPACE, '.skills', 'custom');

// Which bots own a known skill by default (others go to nobody: the CEO assigns them per task).
export const CUSTOM_OWNERS = {
  'higgsfield-motion': ['creative', 'design'],
  'higgsfield-motion-saas': ['creative', 'design'],
  'rapha-motion-video': ['creative', 'design'],
  'amharic-construction-ad-creatives': ['creative', 'design', 'marketing'],
  'viral-short-video-scripting': ['creative', 'marketing'],
  'ye-buna-market-research': ['research', 'ceo'],
  'rapha-product-strategy': ['research', 'product', 'sales', 'ceo'],
  'ye-buna-landing-page': ['landing'],
  'rapha-meta-ads': ['marketing', 'sales'],
  'rapha-excel-model-builder': ['engineer', 'sales', 'product'],
  xlsx: ['engineer', 'sales'],
  pdf: ['*'],
  docx: ['support', 'product'],
  pptx: ['sales', 'ceo'],
  'canvas-design': ['design', 'creative'],
  'theme-factory': ['design'],
  'skill-creator': ['ceo'],
};
// Claude.ai-only skills that mean nothing to a bot here.
const SKIP = new Set(['docs', 'morning', 'import-memory', 'google-workspace', 'learn', 'session-start-hook']);

// ---- zip (stored + deflate), enough for .skill files -------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip / .skill file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip file.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`Unsupported compression in ${name}.`);
    files.push({ name, data });
  }
  return files;
}

const frontMatter = (text) => {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  const get = (k) => {
    const line = m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] || '';
    if (/^[|>]-?\s*$/.test(line)) {
      // YAML block: take the indented lines after it.
      const after = m[1].split(new RegExp(`^${k}:.*$`, 'm'))[1] || '';
      return after.split('\n').filter((l) => /^\s+\S/.test(l)).map((l) => l.trim()).join(' ');
    }
    return line.trim().replace(/^["']|["']$/g, '');
  };
  return { name: get('name'), description: get('description') };
};

/** Register (or refresh) a skill folder that already sits in workspace/.skills/custom/<name>. */
function register(dir, source) {
  const file = path.join(dir, 'SKILL.md');
  const { name, description } = frontMatter(fs.readFileSync(file, 'utf8'));
  const skillName = name || path.basename(dir);
  const id = `custom_${skillName}`.replace(/[^\w-]/g, '_');
  const existing = state.skills[id];
  state.skills[id] = {
    createdAt: now(),
    runs: 0,
    ...existing,
    id,
    name: skillName,
    summary: description,
    body: '',
    path: path.relative(WORKSPACE, file).split(path.sep).join('/'),
    agentId: null,
    agentIds: existing?.ownersEdited ? existing.agentIds : CUSTOM_OWNERS[skillName] || [],
    status: existing?.status === 'draft' ? 'draft' : 'active',
    source,
    pack: null,
    updatedAt: now(),
  };
  bus.emit('event', { type: 'skill', skill: state.skills[id] });
  return state.skills[id];
}

/** Install a .skill / .zip upload. Returns the skills it contained. */
export function installSkillArchive(buf, fileName = 'upload.skill') {
  const files = unzip(buf);
  const skillMds = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.name));
  if (!skillMds.length) throw new Error('No SKILL.md inside — is this a skill file?');
  const installed = [];
  for (const md of skillMds) {
    const prefix = md.name.slice(0, md.name.length - 'SKILL.md'.length); // "" or "name/"
    const { name } = frontMatter(md.data.toString('utf8'));
    const folder = (name || prefix.replace(/\/$/, '').split('/').pop() || path.basename(fileName).replace(/\.\w+$/, '')).replace(/[^\w.-]/g, '_');
    const dir = path.join(ROOT, folder);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of files) {
      if (!f.name.startsWith(prefix)) continue;
      const rel = f.name.slice(prefix.length);
      const out = path.resolve(dir, rel);
      if (!out.startsWith(dir + path.sep)) continue; // no path tricks
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, f.data);
    }
    installed.push(register(dir, `upload:${fileName}`));
  }
  save();
  return installed;
}

/** Where Claude Code keeps skills on this PC (user skills and claude.ai-synced skills). */
function claudeSkillDirs() {
  const base = path.join(os.homedir(), '.claude', 'skills');
  const dirs = [];
  const scan = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, 'SKILL.md'))) dirs.push(full);
      else if (depth < 2) scan(full, depth + 1); // synced/<account>/<skill>/
    }
  };
  scan(base, 0);
  return dirs;
}

/** Copy Claude Code's skills from this PC into the library (new or changed ones only). */
export function importClaudeSkills() {
  const found = claudeSkillDirs();
  const imported = [];
  for (const src of found) {
    const name = path.basename(src);
    if (SKIP.has(name)) continue;
    const dir = path.join(ROOT, name.replace(/[^\w.-]/g, '_'));
    const stamp = fs.statSync(path.join(src, 'SKILL.md')).mtimeMs;
    const id = `custom_${name}`.replace(/[^\w-]/g, '_');
    if (state.skills[id]?.sourceStamp === stamp && fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(src, dir, { recursive: true });
    const s = register(dir, 'claude-code');
    s.sourceStamp = stamp;
    imported.push(s);
  }
  if (imported.length) save();
  return { found: found.length, imported: imported.map((s) => s.name) };
}

/** On start: re-register installed custom skills and pick up new ones from Claude Code. */
export function initCustomSkills() {
  try {
    if (fs.existsSync(ROOT)) {
      for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        const dir = path.join(ROOT, e.name);
        if (e.isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md')) && !state.skills[`custom_${e.name}`.replace(/[^\w-]/g, '_')]) register(dir, 'upload');
      }
    }
    if (process.env.IMPORT_CLAUDE_SKILLS !== '0') importClaudeSkills();
    save();
  } catch (e) {
    console.error('Skill import:', e.message);
  }
}
