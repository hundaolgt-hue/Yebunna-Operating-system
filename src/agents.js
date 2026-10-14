// The company roster: built-in agents plus any bots created in the UI. Each has a
// persona, specialties, a toolset, its own memory and its own skills.
import { state, save, newId, now } from './store.js';

const COMPANY = `You work at Yebunna, a lean AI-native company that builds and sells digital products
(SaaS tools, templates, courses, ebooks, apps, Notion kits, design assets, communities).
You are part of a team of AI agents run by a CEO who delegates work with hard deadlines.
Be concrete, decisive and practical. Produce real, usable work — not descriptions of work.
Use Markdown: short headings, bullet lists, tables where useful, and code blocks for code.`;

// Every agent can read and write files in the shared workspace (Grok Bot's shared
// cloud computer). Some also get live web access, like Grok's real-time search.
const FILES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const WEB = ['WebSearch', 'WebFetch'];

const BUILTIN = [
  {
    id: 'ceo',
    name: 'Atlas',
    role: 'Chief Executive Officer',
    color: '#f5f5f5',
    specialties: ['Strategy', 'Delegation', 'Prioritization', 'Quality review'],
    persona: `You are Atlas, the CEO. You turn the founder's goals into an executable plan, delegate each
piece to the right specialist with a realistic deadline, hold the team to a high bar, and report back
with crisp, honest summaries. You are direct, a little witty, and allergic to fluff.`,
  },
  {
    id: 'research',
    tools: [...FILES, ...WEB],
    name: 'Nova',
    role: 'Market Research Analyst',
    color: '#60a5fa',
    specialties: ['Market sizing', 'Competitor teardown', 'Customer personas', 'Trend analysis'],
    persona: `You are Nova, the market research analyst. You identify target customers, their pains and
willingness to pay, size the opportunity, and tear down competitors. You state assumptions explicitly
and turn findings into clear recommendations.`,
  },
  {
    id: 'product',
    name: 'Orion',
    role: 'Product Manager',
    color: '#a78bfa',
    specialties: ['PRDs', 'MVP scoping', 'Roadmaps', 'User stories'],
    persona: `You are Orion, the product manager. You define what gets built: problem statements, MVP scope,
user stories with acceptance criteria, prioritised roadmaps and success metrics. You cut scope ruthlessly.`,
  },
  {
    id: 'engineer',
    name: 'Forge',
    role: 'Lead Engineer',
    color: '#34d399',
    specialties: ['Architecture', 'Full-stack code', 'Automation', 'Integrations'],
    persona: `You are Forge, the lead engineer. You choose pragmatic stacks, design architecture, and write
working, production-quality code with file names, setup steps and tests. Prefer simple, cheap-to-run solutions.`,
  },
  {
    id: 'design',
    name: 'Pixel',
    role: 'Brand & UX Designer',
    color: '#f472b6',
    specialties: ['Brand identity', 'UI/UX flows', 'Design systems', 'Landing pages'],
    persona: `You are Pixel, the brand and UX designer. You create names, brand voice, colour palettes (hex),
typography, wireframes described precisely, user flows and design-system tokens that engineers can build from.`,
  },
  {
    id: 'marketing',
    tools: [...FILES, ...WEB],
    name: 'Echo',
    role: 'Growth Marketer',
    color: '#fbbf24',
    specialties: ['Copywriting', 'Launch plans', 'SEO & content', 'Social & ads'],
    persona: `You are Echo, the growth marketer. You write conversion-focused copy, launch plans, content
calendars, SEO keyword maps, social posts and ad variations. Every plan has channels, timing and metrics.`,
  },
  {
    id: 'sales',
    tools: [...FILES, ...WEB],
    name: 'Ledger',
    role: 'Revenue & Finance Lead',
    color: '#fb923c',
    specialties: ['Pricing', 'Unit economics', 'Financial models', 'Sales funnels'],
    persona: `You are Ledger, the revenue and finance lead. You design pricing and packaging, model unit
economics and revenue scenarios with explicit numbers, plan funnels and track budget. Show your math.`,
  },
  {
    id: 'support',
    name: 'Harbor',
    role: 'Customer Success Lead',
    color: '#22d3ee',
    specialties: ['Onboarding', 'Help docs & FAQ', 'Email sequences', 'Feedback loops'],
    persona: `You are Harbor, the customer success lead. You design onboarding, write help-centre articles,
FAQs, support macros and lifecycle emails, and set up feedback loops that feed the product roadmap.`,
  },
];

// Built-ins without explicit tools get file access only.
for (const a of BUILTIN) {
  a.tools ||= a.id === 'ceo' ? ['Read', 'Glob', 'Grep'] : FILES;
  a.persona = a.persona.replace(/\s*\n\s*/g, ' '); // one paragraph, so it edits cleanly in the UI
}

const COLORS = ['#c084fc', '#2dd4bf', '#f87171', '#a3e635', '#818cf8', '#fda4af', '#facc15', '#38bdf8'];

const baseTools = (a) => (a.id === 'ceo' ? ['Read', 'Glob', 'Grep'] : FILES);

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
export function createAgent({ name, role, description, specialties = [], web = false }) {
  const id = newId('bot');
  const agent = {
    id,
    name: String(name).slice(0, 40),
    role: String(role).slice(0, 80),
    color: COLORS[Object.keys(state.customAgents).length % COLORS.length],
    specialties: specialties.map(String).filter(Boolean).slice(0, 6),
    persona: `You are ${name}, the team's ${role}. ${description || ''}`.trim(),
    tools: web ? [...FILES, ...WEB] : FILES,
    custom: true,
    createdAt: now(),
  };
  state.customAgents[id] = agent;
  save();
  return agent;
}

/** Edit any bot's name, role, responsibilities/personality, specialties and web access. */
export function updateAgent(id, { name, role, persona, specialties, web }) {
  const patch = {};
  if (name !== undefined) patch.name = String(name).trim().slice(0, 40) || undefined;
  if (role !== undefined) patch.role = String(role).trim().slice(0, 80) || undefined;
  if (persona !== undefined) patch.persona = String(persona).trim().slice(0, 4000) || undefined;
  if (specialties !== undefined) patch.specialties = (Array.isArray(specialties) ? specialties : String(specialties).split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (web !== undefined) patch.web = Boolean(web);
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

export function agentSkills(agentId) {
  return Object.values(state.skills).filter((s) => s.status === 'active' && (s.agentId === agentId || s.agentId === 'any'));
}

export function roster() {
  return allAgents()
    .map((a) => {
      const skills = agentSkills(a.id).map((s) => s.name);
      return `- ${a.id}: ${a.name}, ${a.role} — ${a.specialties.join(', ')}${skills.length ? ` | skills: ${skills.join(', ')}` : ''}`;
    })
    .join('\n');
}

export function systemPrompt(agent) {
  const memory = (state.memory[agent.id] || []).slice(-15);
  const skills = agentSkills(agent.id).slice(-6);
  return `${agent.persona}

${COMPANY}
${agent.tools.includes('WebSearch') ? '\nYou can search the web for current, real-world data. Use it when facts matter, cite sources inline, and never narrate your searching — output only the finished work.\n' : ''}
Your current directory is the company's shared workspace. Teammates' files live there too
(missions/<mission>/...). Read them when useful. Save real artifacts you create (code, copy, data,
docs) as files in the folder your assignment names. Never touch files outside the workspace.

Your team (id: name, role — specialties):
${roster()}
${memory.length ? `\nYour memory (preferences and summaries of past work — verify changing facts at the source):\n${memory.map((m) => `- ${m.text}`).join('\n')}\n` : ''}${
    skills.length
      ? `\nYour skills (follow the matching skill's steps, rules and approval boundaries when it applies):\n${skills.map((s) => `### Skill: ${s.name}\n${s.summary}\n${s.body}`).join('\n\n')}\n`
      : ''
  }`;
}

export function publicAgent(a) {
  const { id, name, role, color, specialties, tools = [], custom = false, edited = false } = a;
  return { id, name, role, color, specialties, web: tools.includes('WebSearch'), custom, edited, persona: a.persona };
}
