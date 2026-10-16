// Skill packs: community SKILL.md libraries (the same packs `npx skills add …` installs),
// downloaded with git into the shared workspace and assigned to the bots that should use
// them. Bots see each skill's name, description and path in their instructions and open
// the SKILL.md with the Read tool when a task matches — the same progressive disclosure
// Claude Code uses for skills.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { state, save, now, WORKSPACE } from './store.js';
import { bus } from './bus.js';
import { logActivity } from './activity.js';

const ROOT = path.join(WORKSPACE, '.skills');

const by = (map) => (name) => Object.entries(map).filter(([, names]) => names === '*' || names.includes(name)).map(([agent]) => agent);

export const PACKS = [
  {
    id: 'taste',
    repo: 'Leonxlnx/taste-skill',
    label: 'Taste Skill — anti-slop frontend design',
    include: ['design-taste-frontend'],
    owners: () => ['design', 'engineer'],
  },
  {
    id: 'awwwards',
    repo: 'MengTo/Skills',
    label: 'Build Awwwards-quality sites',
    include: ['build-awwwards-quality-sites'],
    owners: () => ['design', 'engineer'],
  },
  {
    id: 'find-skills',
    repo: 'vercel-labs/skills',
    label: 'Find skills (discover and install more skills)',
    include: ['find-skills'],
    owners: () => ['*'],
  },
  {
    id: 'marketing',
    repo: 'coreyhaines31/marketingskills',
    label: 'Marketing skills (Corey Haines)',
    include: '*',
    owners: by({
      marketing: '*',
      sales: ['pricing', 'offers', 'paywalls', 'revops', 'sales-enablement', 'prospecting', 'cold-email', 'referrals', 'co-marketing'],
      research: ['customer-research', 'competitor-profiling', 'competitors', 'analytics', 'attribution', 'marketing-council', 'ab-testing'],
      product: ['product-marketing', 'onboarding', 'signup', 'paywalls', 'ab-testing', 'cro', 'churn-prevention'],
      support: ['onboarding', 'churn-prevention', 'emails', 'sms', 'community-marketing'],
      design: ['cro', 'popups', 'image', 'video', 'ad-creative', 'site-architecture', 'signup'],
      creative: ['image', 'video', 'ad-creative'],
      engineer: ['schema', 'programmatic-seo', 'free-tools', 'analytics', 'site-architecture', 'ai-seo', 'seo-audit'],
      ceo: ['marketing-plan', 'marketing-council', 'launch'],
    }),
  },
  {
    id: 'social',
    repo: 'charlie947/social-media-skills',
    label: 'Social media skills (Charlie Hills)',
    include: '*',
    owners: by({
      marketing: '*',
      design: ['graphic-designer', 'youtube-thumbnail', 'gemini-carousel', 'gemini-infographic'],
      creative: ['graphic-designer', 'youtube-thumbnail', 'gemini-carousel'],
      research: ['niche-research', 'analytics-dashboard', 'post-scorer'],
    }),
  },
  {
    id: 'superpowers',
    repo: 'obra/superpowers',
    label: 'Subagent-driven development (Superpowers)',
    include: ['subagent-driven-development'],
    owners: () => ['ceo', 'engineer'],
  },
  {
    id: 'pdf',
    repo: 'anthropics/skills',
    label: 'PDF skill (Anthropic)',
    include: ['pdf'],
    owners: () => ['*'],
  },
  {
    id: 'agent-skills',
    repo: 'addyosmani/agent-skills',
    label: 'Agent skills for engineering (Addy Osmani)',
    include: '*',
    owners: by({
      engineer: '*',
      product: ['spec-driven-development', 'planning-and-task-breakdown', 'idea-refine', 'interview-me', 'documentation-and-adrs'],
      ceo: ['planning-and-task-breakdown', 'idea-refine'],
      design: ['frontend-ui-engineering'],
      support: ['documentation-and-adrs'],
    }),
  },
];

const packState = () => (state.skillPacks ||= {});
const emit = () => {
  save();
  bus.emit('event', { type: 'packs', packs: listPacks() });
};

export function listPacks() {
  return PACKS.map((p) => ({ id: p.id, repo: p.repo, label: p.label, ...(packState()[p.id] || { status: 'not installed' }) }));
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git is not installed (install Git for Windows)' : e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().split('\n').pop() || `git exited ${code}`))));
  });
}

/** Read name + description from a SKILL.md front matter (handles folded/quoted YAML). */
function frontMatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : '';
  const field = (key) => {
    const line = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    if (!line) return '';
    let value = line[1].trim();
    if (/^[>|]-?$/.test(value)) {
      const rest = fm.slice(fm.indexOf(line[0]) + line[0].length).split('\n').slice(1);
      value = rest.filter((l, i) => /^\s+\S/.test(l) && rest.slice(0, i).every((p) => /^\s+\S/.test(p))).map((l) => l.trim()).join(' ');
    }
    return value.replace(/^["']|["']$/g, '').trim();
  };
  return { name: field('name'), description: field('description') };
}

function findSkillFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSkillFiles(full, out);
    else if (entry.name === 'SKILL.md') out.push(full);
  }
  return out;
}

export async function installPack(id) {
  const pack = PACKS.find((p) => p.id === id);
  if (!pack) throw new Error('Unknown skill pack');
  const st = (packState()[id] = { ...(packState()[id] || {}), status: 'installing', error: null });
  emit();
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const dir = path.join(ROOT, pack.repo.replace('/', '__'));
    if (fs.existsSync(path.join(dir, '.git'))) {
      // Update to the latest version (shallow clones can't always fast-forward with pull).
      await git(['fetch', '--depth', '1', 'origin', 'HEAD'], dir)
        .then(() => git(['reset', '--hard', 'FETCH_HEAD'], dir))
        .catch(() => {});
    }
    else await git(['clone', '--depth', '1', `https://github.com/${pack.repo}.git`, dir], ROOT);
    st.commit = await git(['rev-parse', '--short', 'HEAD'], dir).catch(() => '');

    let count = 0;
    for (const file of findSkillFiles(dir)) {
      const { name, description } = frontMatter(fs.readFileSync(file, 'utf8'));
      if (!name || (pack.include !== '*' && !pack.include.includes(name))) continue;
      const skillId = `pack_${id}_${name}`.replace(/[^\w-]/g, '_');
      const existing = state.skills[skillId];
      state.skills[skillId] = {
        createdAt: now(),
        runs: 0,
        ...existing,
        id: skillId,
        name,
        summary: description,
        body: '',
        path: path.relative(WORKSPACE, file).split(path.sep).join('/'),
        agentId: null,
        agentIds: existing?.ownersEdited ? existing.agentIds : pack.owners(name),
        status: existing?.status === 'draft' ? 'draft' : 'active',
        source: `pack:${id}`,
        pack: id,
        repo: pack.repo,
      };
      bus.emit('event', { type: 'skill', skill: state.skills[skillId] });
      count++;
    }
    Object.assign(st, { status: count ? 'installed' : 'failed', count, at: now(), error: count ? null : 'No matching skills found in the repository' });
    logActivity('ceo', `installed the skill pack “${pack.label}” (${count} skills)`);
  } catch (e) {
    Object.assign(st, { status: 'failed', error: e.message, at: now() });
  }
  emit();
  return st;
}

let installing = null;
/** Install (or update) every pack, one after another. */
export function installAll({ onlyMissing = false } = {}) {
  if (installing) return installing;
  installing = (async () => {
    for (const p of PACKS) {
      if (onlyMissing && packState()[p.id]?.status === 'installed') continue;
      await installPack(p.id).catch(() => {});
    }
  })().finally(() => (installing = null));
  return installing;
}
