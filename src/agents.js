// The company roster: built-in agents plus any bots created in the UI. Each has a
// persona, specialties, a toolset, its own memory and its own skills.
import { state, save, newId, now } from './store.js';
import { connectionTools, connectionPrompt } from './connections.js';
import { playbookPrompt } from './playbook.js';
import { PERSONAS, CORE_SKILLS, RUN_SETTINGS, HOUSEKEEPING, MODELS, EFFORTS } from './personas.js';

const COMPANY = `You work at Yebunna, a lean AI-native company that builds and sells digital products, in a team of
AI agents run by a CEO. Produce real, usable work, not descriptions of work. No generic or padded output:
specific to this product, buyer and market, with real facts and sources (or labelled estimates), checked by
you before hand-in. If something is missing, say exactly what instead of filling the gap.

HOW YOU WRITE (every message: to the founder, the CEO or teammates)
- Telegraphic: results, numbers, decisions, file paths. No preamble, no recap of the brief or the inputs,
  no restating what a teammate wrote, no closing summary, no offers of more help.
- Say each thing once. If it is in a file, give the path instead of repeating it.
- Do the work in files; your messages only point to them.`;

// Every agent can read and write files in the shared workspace (Grok Bot's shared
// cloud computer). Some also get live web access, like Grok's real-time search.
const FILES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const WEB = ['WebSearch', 'WebFetch'];
// Computer use: a real web browser the bot drives (Playwright MCP server named "browser").
export const BROWSER_TOOL = 'mcp__browser';

const BUILTIN = [
  {
    id: 'ceo',
    persona: PERSONAS.ceo,
    coreSkills: CORE_SKILLS.ceo,
    name: 'Atlas',
    role: 'Chief Executive Officer',
    color: '#f5f5f5',
    specialties: ['Strategy', 'Delegation', 'Prioritization', 'Quality review'],
  },
  {
    id: 'research',
    computer: true, // Facebook Ad Library and Ye-Buna in a real browser
    persona: PERSONAS.research,
    coreSkills: CORE_SKILLS.research,
    tools: [...FILES, ...WEB],
    name: 'Nova',
    role: 'Market Research Analyst',
    color: '#60a5fa',
    specialties: ['Demand & supply evidence', 'Competitor teardown', 'Niche scoring', 'Buyer quotes'],
  },
  {
    id: 'product',
    persona: PERSONAS.product,
    coreSkills: CORE_SKILLS.product,
    name: 'Orion',
    role: 'Product Manager',
    color: '#a78bfa',
    specialties: ['Product spec', 'MVP scope', 'Structure & logic', 'Acceptance tests'],
  },
  {
    id: 'engineer',
    persona: PERSONAS.engineer,
    coreSkills: CORE_SKILLS.engineer,
    name: 'Forge',
    role: 'Lead Engineer',
    color: '#34d399',
    specialties: ['Excel & Sheets models', 'Code', 'Automations', 'Verification'],
  },
  {
    id: 'design',
    persona: PERSONAS.design,
    coreSkills: CORE_SKILLS.design,
    name: 'Pixel',
    role: 'Brand & Visual Designer',
    color: '#f472b6',
    specialties: ['Brand system', 'Product mockups', 'Ad stills & thumbnails', 'Posters'],
  },
  {
    id: 'creative',
    persona: PERSONAS.creative,
    coreSkills: CORE_SKILLS.creative,
    tools: [...FILES, ...WEB],
    name: 'Vega',
    role: 'Creative Director (Video)',
    color: '#e879f9',
    specialties: ['Video concepts & scripts', 'Motion graphics', 'AI video (Higgsfield)', 'Tutorial videos'],
  },
  {
    id: 'landing',
    persona: PERSONAS.landing,
    coreSkills: CORE_SKILLS.landing,
    tools: [...FILES, ...WEB],
    name: 'Lumen',
    role: 'Landing Page & Conversion Lead',
    color: '#4ade80',
    specialties: ['Landing page copy & build', 'Ye-Buna checkout', 'Meta Pixel', 'Vercel deploy'],
  },
  {
    id: 'marketing',
    persona: PERSONAS.marketing,
    coreSkills: CORE_SKILLS.marketing,
    tools: [...FILES, ...WEB],
    name: 'Echo',
    role: 'Growth Marketer',
    color: '#fbbf24',
    specialties: ['Ad copy', 'Meta campaign setup', 'Campaign results', 'Test plans'],
  },
  {
    id: 'sales',
    persona: PERSONAS.sales,
    coreSkills: CORE_SKILLS.sales,
    tools: [...FILES, ...WEB],
    name: 'Ledger',
    role: 'Revenue & Finance Lead',
    color: '#fb923c',
    specialties: ['Price & offer', 'Unit economics', 'Break-even', 'Projections'],
  },
  {
    id: 'support',
    persona: PERSONAS.support,
    coreSkills: CORE_SKILLS.support,
    name: 'Harbor',
    role: 'Customer Success Lead',
    color: '#22d3ee',
    specialties: ['Written tutorial', 'FAQ & troubleshooting', 'Buyer replies', 'After-sale emails'],
  },
];

// Every built-in can read and write files and search the web; the CEO only checks facts and files.
for (const a of BUILTIN) {
  a.tools ||= [...FILES, ...WEB];
  Object.assign(a, RUN_SETTINGS[a.id]);
}

const COLORS = ['#c084fc', '#2dd4bf', '#f87171', '#a3e635', '#818cf8', '#fda4af', '#facc15', '#38bdf8'];

const baseTools = () => FILES;

/**
 * The model and effort a bot runs on for this kind of work. The CEO plans and briefs on its
 * planning model; meetings use the bot's model at low effort; housekeeping uses the smallest model.
 */
export function runSettings(agentId, kind) {
  if (kind === 'memory') return HOUSEKEEPING;
  const a = getAgent(agentId);
  if (!a) return { model: 'sonnet', effort: 'medium' };
  if (kind === 'plan' && a.planModel) return { model: a.planModel, effort: a.planEffort || a.effort || 'high' };
  const model = a.model || 'sonnet';
  return { model, effort: ['meeting', 'retro', 'standup'].includes(kind) ? 'low' : a.effort || 'medium' };
}

/** Built-ins with any edits from the UI applied on top. */
function withOverrides(a) {
  const o = state.agentOverrides[a.id];
  if (!o) return a;
  return {
    ...a,
    ...o,
    tools: o.web === undefined ? a.tools : o.web ? [...baseTools(a), ...WEB] : baseTools(a),
    edited: true,
  };
}

export function allAgents() {
  return [...BUILTIN.map(withOverrides), ...Object.values(state.customAgents)];
}

export function getAgent(id) {
  return allAgents().find((a) => a.id === id);
}

export function specialists() {
  return allAgents().filter((a) => a.id !== 'ceo');
}

/** Create a new bot: pick a name, a main job and a description (Grok Bot's "create your own"). */
export function createAgent({ name, role, description, specialties = [], web = false, computer = false }) {
  const id = newId('bot');
  const agent = {
    id,
    name: String(name).slice(0, 40),
    role: String(role).slice(0, 80),
    color: COLORS[Object.keys(state.customAgents).length % COLORS.length],
    specialties: specialties.map(String).filter(Boolean).slice(0, 6),
    persona: `You are ${name}, the team's ${role}. ${description || ''}`.trim(),
    tools: web ? [...FILES, ...WEB] : FILES,
    computer: Boolean(computer),
    model: 'sonnet',
    effort: 'medium',
    custom: true,
    createdAt: now(),
  };
  state.customAgents[id] = agent;
  save();
  return agent;
}

/** Edit any bot's name, role, responsibilities/personality, specialties and web access. */
export function updateAgent(id, { name, role, persona, specialties, web, computer, coreSkills, model, effort, planModel, planEffort }) {
  const patch = {};
  for (const [k, v, allowed] of [['model', model, MODELS], ['planModel', planModel, MODELS], ['effort', effort, EFFORTS], ['planEffort', planEffort, EFFORTS]]) {
    if (v !== undefined && allowed.includes(v)) patch[k] = v;
  }
  if (name !== undefined) patch.name = String(name).trim().slice(0, 40) || undefined;
  if (role !== undefined) patch.role = String(role).trim().slice(0, 80) || undefined;
  if (persona !== undefined) patch.persona = String(persona).trim().slice(0, 12000) || undefined;
  if (coreSkills !== undefined) patch.coreSkills = (Array.isArray(coreSkills) ? coreSkills : String(coreSkills).split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  if (specialties !== undefined) patch.specialties = (Array.isArray(specialties) ? specialties : String(specialties).split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (web !== undefined) patch.web = Boolean(web);
  if (computer !== undefined) patch.computer = Boolean(computer);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

  const custom = state.customAgents[id];
  if (custom) {
    const { web: w, ...rest } = patch;
    Object.assign(custom, rest);
    if (w !== undefined) custom.tools = w ? [...FILES, ...WEB] : FILES;
  } else if (BUILTIN.some((a) => a.id === id)) {
    state.agentOverrides[id] = { ...state.agentOverrides[id], ...patch };
  } else {
    return null;
  }
  save();
  return getAgent(id);
}

/** Every tool a bot may use right now: its own tools, plus computer use and the terminal if enabled. */
export function toolsFor(agent) {
  return [
    ...agent.tools,
    ...(agent.computer ? [BROWSER_TOOL] : []),
    ...(state.settings.terminal ? ['Bash'] : []),
    ...connectionTools(agent.id),
  ];
}

/** Turn computer use on or off for every bot at once. */
export function setComputerForAll(enabled) {
  for (const a of allAgents()) updateAgent(a.id, { computer: enabled });
}

/** Undo all edits to a built-in bot. */
export function resetAgent(id) {
  if (!state.agentOverrides[id]) return false;
  delete state.agentOverrides[id];
  save();
  return true;
}

export function deleteAgent(id) {
  if (!state.customAgents[id]) return false;
  delete state.customAgents[id];
  delete state.memory[id];
  save();
  return true;
}

// ---- memory ---------------------------------------------------------------

export function remember(agentId, text, source = 'manual') {
  const list = (state.memory[agentId] ||= []);
  const entry = { id: newId('mem'), text: String(text).trim().slice(0, 600), source, at: now() };
  list.push(entry);
  if (list.length > 60) list.splice(0, list.length - 60);
  save();
  return entry;
}

export function forget(agentId, memId) {
  state.memory[agentId] = (state.memory[agentId] || []).filter((m) => m.id !== memId);
  save();
}

// ---- prompts --------------------------------------------------------------

/** Does this skill belong to this bot? (Library skills can belong to several bots.) */
export const skillOwnedBy = (s, agentId) =>
  s.agentId === agentId || s.agentId === 'any' || (s.agentIds || []).includes(agentId) || (s.agentIds || []).includes('*');

export function agentSkills(agentId) {
  return Object.values(state.skills).filter((s) => s.status === 'active' && skillOwnedBy(s, agentId));
}

/** Find an installed skill by name (case-insensitive). */
export const skillByName = (name) => {
  const want = String(name).trim().toLowerCase();
  return Object.values(state.skills).find((s) => s.name.toLowerCase() === want && s.status !== 'failed') || null;
};

/** A bot's core skills, resolved: [{ name, skill | null }]. */
export function coreSkillsOf(agent) {
  return (agent.coreSkills || []).map((name) => ({ name, skill: skillByName(name) }));
}

/** Every installed skill, for the CEO to pick from when briefing a task. */
export function skillCatalog() {
  return Object.values(state.skills)
    .filter((s) => s.status === 'active' && !s.house)
    .map((s) => `- ${s.name}: ${String(s.summary || '').replace(/\s+/g, ' ').slice(0, 80)}`)
    .join('\n');
}

/** Find a bot from whatever the CEO wrote: id, name, role or a close match. */
export function resolveAgent(ref) {
  if (!ref) return null;
  const want = String(ref).trim().toLowerCase();
  const all = allAgents();
  return (
    all.find((a) => a.id.toLowerCase() === want) ||
    all.find((a) => a.name.toLowerCase() === want) ||
    all.find((a) => a.role.toLowerCase() === want) ||
    all.find((a) => want.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(want)) ||
    all.find((a) => a.role.toLowerCase().includes(want) || want.includes(a.role.toLowerCase())) ||
    null
  );
}

export function roster() {
  return allAgents()
    .map((a) => `- ${a.id}: ${a.name}, ${a.role}`)
    .join('\n');
}

/**
 * Memory that goes into a bot's prompt: only standing facts and preferences the founder gave
 * (never notes about past missions — each mission starts clean; lessons live in the playbook).
 */
export const standingMemory = (agentId) => (state.memory[agentId] || []).filter((m) => !String(m.source).startsWith('task')).slice(-10);

export function systemPrompt(agent) {
  const memory = standingMemory(agent.id);
  const owned = agentSkills(agent.id);
  // House standards are always included in full. Other written skills are listed by name;
  // a task that needs one gets its full text in the assignment.
  const house = owned.filter((s) => s.house);
  const written = owned.filter((s) => !s.path && !s.house);
  const core = coreSkillsOf(agent);
  return `${agent.persona}
${
    core.length
      ? `\nCORE SKILLS: open the SKILL.md of each one that applies (Read) before you start, and follow it.
${core.map((c) => (c.skill ? `- ${c.skill.name} → ${c.skill.path || '(written skill: see below)'}` : `- ${c.name}: not installed; work without it and say so`)).join('\n')}\n`
      : ''
  }
${COMPANY}
${playbookPrompt()}${agent.tools.includes('WebSearch') ? '\nWeb: search when facts matter; cite sources inline; never narrate your searching.\n' : ''}${
    agent.computer
      ? `\nBROWSER (browser_* tools): use it for sites without an API. Read the snapshot before acting. Never buy, send,
publish, post, delete, or change account or billing settings unless the task says exactly that. Never type
passwords, 2FA or payment details, never solve CAPTCHAs: if a login is needed, stop and name the site for the
founder ("Log in to a site"). Close the tabs you opened.\n`
      : ''
  }${
    state.settings.terminal
      ? `\nTERMINAL (Bash, in the workspace): run scripts to build and check your work. Nothing destructive, nothing
outside the workspace, no global installs, nothing that sends, publishes or spends. Delete your temp files.\n`
      : ''
  }
Workspace: your current directory. Teammates' files are in missions/<mission>/. The founder's samples are in
references/<date>/: study them when the task mentions references or a style (images with Read; videos: ffmpeg
~1 frame/s to a temp folder, Read, delete). Never touch files outside the workspace.
${agent.id === 'ceo' ? `\nYour team (id: name, role):\n${roster()}\n` : ''}${memory.length ? `\nStanding facts from the founder:\n${memory.map((m) => `- ${m.text}`).join('\n')}\n` : ''}${
    house.length ? `\n${house.map((s) => `### Standard: ${s.name}\n${s.body}`).join('\n\n')}\n` : ''
  }${written.length ? `\nYour written skills (the task includes the full text when it needs one): ${written.map((s) => s.name).join(', ')}\n` : ''}${connectionPrompt(agent.id)}${
    agent.id === 'ceo' ? "\nYou never do specialist work yourself; your tools are for checking the team's files and facts.\n" : ''
  }`;
}

export function publicAgent(a) {
  const { id, name, role, color, specialties, tools = [], custom = false, edited = false, computer = false, coreSkills = [], model = 'sonnet', effort = 'medium', planModel, planEffort } = a;
  return { id, name, role, color, specialties, web: tools.includes('WebSearch'), computer, custom, edited, persona: a.persona, coreSkills, model, effort, planModel, planEffort };
}
