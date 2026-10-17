// The company roster: built-in agents plus any bots created in the UI. Each has a
// persona, specialties, a toolset, its own memory and its own skills.
import { state, save, newId, now } from './store.js';
import { connectionTools, connectionPrompt } from './connections.js';
import { playbookPrompt } from './playbook.js';
import { PERSONAS, CORE_SKILLS } from './personas.js';

const COMPANY = `You work at Yebunna, a lean AI-native company that builds and sells digital products
(SaaS tools, templates, courses, ebooks, apps, Notion kits, design assets, communities).
You are part of a team of AI agents run by a CEO who delegates work with hard deadlines.
Be concrete, decisive and practical. Produce real, usable work — not descriptions of work.
QUALITY BAR: no generic, padded or sloppy output, ever. Every deliverable is specific to this product,
this buyer and this market; uses real facts, numbers and sources (or clearly labelled estimates); is
checked by you before you hand it in; and would impress a demanding founder. If you can't meet the bar
with what you have, say exactly what is missing instead of filling the gap with filler.
Use Markdown: short headings, bullet lists, tables where useful, and code blocks for code.`;

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
    specialties: ['Market sizing', 'Competitor teardown', 'Customer personas', 'Trend analysis'],
  },
  {
    id: 'product',
    persona: PERSONAS.product,
    coreSkills: CORE_SKILLS.product,
    name: 'Orion',
    role: 'Product Manager',
    color: '#a78bfa',
    specialties: ['PRDs', 'MVP scoping', 'Roadmaps', 'User stories'],
  },
  {
    id: 'engineer',
    persona: PERSONAS.engineer,
    coreSkills: CORE_SKILLS.engineer,
    name: 'Forge',
    role: 'Lead Engineer',
    color: '#34d399',
    specialties: ['Architecture', 'Full-stack code', 'Automation', 'Integrations'],
  },
  {
    id: 'design',
    persona: PERSONAS.design,
    coreSkills: CORE_SKILLS.design,
    name: 'Pixel',
    role: 'Brand & UX Designer',
    color: '#f472b6',
    specialties: ['Brand identity', 'UI/UX flows', 'Design systems', 'Landing pages'],
  },
  {
    id: 'creative',
    persona: PERSONAS.creative,
    coreSkills: CORE_SKILLS.creative,
    tools: [...FILES, ...WEB],
    name: 'Vega',
    role: 'Creative Director',
    color: '#e879f9',
    specialties: ['Creative direction', 'Ad creatives', 'AI images & video', 'Visual storytelling'],
  },
  {
    id: 'landing',
    persona: PERSONAS.landing,
    coreSkills: CORE_SKILLS.landing,
    tools: [...FILES, ...WEB],
    name: 'Lumen',
    role: 'Landing Page & Conversion Lead',
    color: '#4ade80',
    specialties: ['High-converting landing pages', 'Tutorial & ad videos on the page', 'Ye-Buna checkout funnels', 'Meta Pixel & Vercel'],
  },
  {
    id: 'marketing',
    persona: PERSONAS.marketing,
    coreSkills: CORE_SKILLS.marketing,
    tools: [...FILES, ...WEB],
    name: 'Echo',
    role: 'Growth Marketer',
    color: '#fbbf24',
    specialties: ['Copywriting', 'Launch plans', 'SEO & content', 'Social & ads'],
  },
  {
    id: 'sales',
    persona: PERSONAS.sales,
    coreSkills: CORE_SKILLS.sales,
    tools: [...FILES, ...WEB],
    name: 'Ledger',
    role: 'Revenue & Finance Lead',
    color: '#fb923c',
    specialties: ['Pricing', 'Unit economics', 'Financial models', 'Sales funnels'],
  },
  {
    id: 'support',
    persona: PERSONAS.support,
    coreSkills: CORE_SKILLS.support,
    name: 'Harbor',
    role: 'Customer Success Lead',
    color: '#22d3ee',
    specialties: ['Onboarding', 'Help docs & FAQ', 'Email sequences', 'Feedback loops'],
  },
];

// Every built-in can read and write files and search the web; the CEO only checks facts and files.
for (const a of BUILTIN) a.tools ||= [...FILES, ...WEB];

const COLORS = ['#c084fc', '#2dd4bf', '#f87171', '#a3e635', '#818cf8', '#fda4af', '#facc15', '#38bdf8'];

const baseTools = () => FILES;

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
    custom: true,
    createdAt: now(),
  };
  state.customAgents[id] = agent;
  save();
  return agent;
}

/** Edit any bot's name, role, responsibilities/personality, specialties and web access. */
export function updateAgent(id, { name, role, persona, specialties, web, computer, coreSkills }) {
  const patch = {};
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
    .map((s) => `- ${s.name}: ${String(s.summary || '').slice(0, 140)}${s.path ? ` → ${s.path}` : ' (written skill)'}`)
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
    .map((a) => {
      const skills = agentSkills(a.id).map((s) => s.name);
      const shown = skills.slice(0, 8).join(', ') + (skills.length > 8 ? ` +${skills.length - 8} more` : '');
      return `- ${a.id}: ${a.name}, ${a.role} — ${a.specialties.join(', ')}${skills.length ? ` | skills: ${shown}` : ''}`;
    })
    .join('\n');
}

export function systemPrompt(agent) {
  const memory = (state.memory[agent.id] || []).slice(-15);
  const owned = agentSkills(agent.id);
  // Written skills are included in full: house standards always, plus the latest six others.
  const skills = [...owned.filter((s) => s.house), ...owned.filter((s) => !s.path && !s.house).slice(-6)];
  const core = coreSkillsOf(agent);
  const coreNames = new Set(core.map((c) => c.name.toLowerCase()));
  const library = owned.filter((s) => s.path && !coreNames.has(s.name.toLowerCase())).slice(0, 80); // skill packs: read on demand
  return `${agent.persona}
${
    core.length
      ? `\nYOUR CORE SKILLS: use them on every task where they apply. Before you start, open the SKILL.md of each one
that applies (Read tool), then follow it. They are not optional.
${core.map((c) => (c.skill ? `- ${c.skill.name}: ${String(c.skill.summary).slice(0, 160)} → ${c.skill.path || '(written skill: see below)'}` : `- ${c.name}: not installed on this PC yet; work without it and mention that in your deliverable`)).join('\n')}\n`
      : ''
  }

${COMPANY}
${playbookPrompt()}${agent.tools.includes('WebSearch') ? '\nYou can search the web for current, real-world data. Use it when facts matter, cite sources inline, and never narrate your searching — output only the finished work.\n' : ''}${
    agent.computer
      ? `\nCOMPUTER USE: you control a real web browser through the browser_* tools (navigate, click, type, fill forms,
select, upload, take snapshots and screenshots, manage tabs). Use it when a website has no API, to check how a
page really looks, or to operate web apps. Read the page snapshot before acting. Rules (approval boundaries):
- Never buy anything, send messages or emails, publish or post, delete data, or change account or billing
  settings unless your assignment explicitly tells you to do exactly that.
- Never type passwords, 2FA codes or payment details, and never try to solve CAPTCHAs. If a site needs a
  login, stop and say which site the founder must log into with the "Log in to a site" button on your page.
- Close tabs you opened when you are done, and report what you did in the browser.\n`
      : ''
  }${
    state.settings.terminal
      ? `\nTERMINAL: you can run shell commands (Bash) in the workspace folder — e.g. run Python scripts to build,
recalculate and check spreadsheets (openpyxl/pandas), process data, or test code — so the founder doesn't have
to open the files to verify your work. Check results yourself before you report them. Never run destructive
commands, never touch files outside the workspace, never install software globally (a local
"pip install --user" or a project virtualenv is fine when needed), and never run anything that sends
messages, publishes, or spends money. Clean up after yourself: delete temporary files you created
(rendered frames, caches, test downloads) once the task is done, and keep only the deliverables.\n`
      : ''
  }
Your current directory is the company's shared workspace. Teammates' files live there too
(missions/<mission>/...). Read them when useful. The founder's reference samples (images, videos,
documents) are in references/<date>/: when a task mentions references, samples, examples or "this style",
study them first. Look at images with the Read tool; for a video, extract about 1 frame per second with
ffmpeg into a temp folder, Read the frames, then delete them. Save real artifacts you create (code, copy, data,
docs) as files in the folder your assignment names. Never touch files outside the workspace.

Your team (id: name, role — specialties):
${roster()}
${memory.length ? `\nYour memory (preferences and summaries of past work — verify changing facts at the source):\n${memory.map((m) => `- ${m.text}`).join('\n')}\n` : ''}${
    skills.length
      ? `\nYour skills (follow the matching skill's steps, rules and approval boundaries when it applies):\n${skills.map((s) => `### Skill: ${s.name}\n${s.summary}\n${s.body}`).join('\n\n')}\n`
      : ''
  }${
    library.length
      ? `\nYour skill library. Before starting work, check this list: when a skill matches the task, use the Read tool
to open its SKILL.md (and any files it points to) and follow it. Skills marked with ⚙ may need the terminal.
${library.map((s) => `- ${s.name}: ${String(s.summary).slice(0, 150)} → ${s.path}`).join('\n')}\n`
      : ''
  }${connectionPrompt(agent.id)}${
    agent.id === 'ceo'
      ? '\nAs CEO you never do specialist work yourself (no writing copy, code, designs, research or spreadsheets). Your tools are for checking the team\'s files and facts. When the founder asks for work, it gets delegated to the team.\n'
      : ''
  }`;
}

export function publicAgent(a) {
  const { id, name, role, color, specialties, tools = [], custom = false, edited = false, computer = false, coreSkills = [] } = a;
  return { id, name, role, color, specialties, web: tools.includes('WebSearch'), computer, custom, edited, persona: a.persona, coreSkills };
}
