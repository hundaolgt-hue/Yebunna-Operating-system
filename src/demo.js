// Offline demo engine: scripted but plausible agent behaviour, streamed word by
// word, so the OS can be explored without an API key.
import { SPECIALISTS, getAgent } from './agents.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

export async function* demoStream(text, signal) {
  yield { type: 'reasoning', text: 'Considering the brief, the team and the deadline…' };
  await sleep(500, signal);
  const parts = text.match(/\S+\s*/g) || [];
  for (const part of parts) {
    await sleep(12 + Math.random() * 18, signal);
    yield { type: 'text', text: part };
  }
}

const PLAYBOOK = {
  research: ['Validate demand and map competitors', 'Personas, pain points, top 5 competitors and a positioning gap.', 8],
  product: ['Define the MVP and roadmap', 'PRD with problem, MVP scope, user stories and success metrics.', 14],
  design: ['Create brand identity and key screens', 'Name options, palette, typography, landing page wireframe.', 20],
  engineer: ['Build the MVP foundation', 'Architecture, stack, data model and starter code.', 40],
  sales: ['Design pricing and revenue model', 'Pricing tiers, unit economics and a 12-month revenue model.', 30],
  marketing: ['Plan the launch campaign', 'Landing page copy, launch timeline, channels and 5 social posts.', 55],
  support: ['Prepare onboarding and help center', 'Welcome email sequence, FAQ and support macros.', 65],
};
const DEPS = {
  product: ['research'],
  design: ['product'],
  engineer: ['product'],
  sales: ['research'],
  marketing: ['design', 'sales'],
  support: ['product'],
};

export function demoPlan(goal, hoursLeft, instruction) {
  const pick = instruction
    ? [SPECIALISTS.find((a) => instruction.toLowerCase().includes(a.name.toLowerCase()))?.id || 'marketing']
    : Object.keys(PLAYBOOK);
  const tasks = pick.map((id) => {
    const [title, deliverable, pct] = PLAYBOOK[id];
    return {
      key: id,
      agent: id,
      title: instruction ? `Follow-up: ${instruction.slice(0, 60)}` : title,
      brief: `${title} for: "${goal}". Keep it specific to this product and ready to use.`,
      deliverable,
      due_in_hours: Math.max(0.25, +((hoursLeft * pct) / 100).toFixed(2)),
      depends_on: instruction ? [] : (DEPS[id] || []).filter((d) => pick.includes(d)),
    };
  });
  return JSON.stringify({
    summary: instruction
      ? `On it. I've handed this follow-up to the right owner with a tight deadline.`
      : `Here's the plan. **Nova** validates demand first; **Orion** turns that into an MVP spec; then **Pixel**, **Forge** and **Ledger** build brand, product and pricing in parallel; **Echo** plans the launch and **Harbor** gets onboarding ready. Every task has a deadline inside your overall deadline — I'll review each deliverable before it counts as done.`,
    tasks,
  });
}

export function demoOutput(agentId, task, goal) {
  const a = getAgent(agentId);
  return `## ${task.title}

**Owner:** ${a.name} (${a.role})
**Product:** ${goal}

### Key findings
- The target customer is a solo creator or small team who wants results in under a week.
- The main pain is time: they currently stitch together 3–5 tools to get this done.
- Competitors are either too expensive (enterprise) or too shallow (free templates).

### Deliverable
| Item | Decision | Why |
|---|---|---|
| Positioning | "The fastest way to ${goal.toLowerCase().slice(0, 40)}" | Speed is the #1 stated pain |
| Primary channel | Communities + short video | Low CAC, high intent |
| Success metric | 100 paying customers in 60 days | Validates willingness to pay |

### Next steps
1. Share this with the team.
2. Revisit after the first 50 customer conversations.

> _Demo mode — install Claude Code and log in with your Claude subscription to have the team do the real work._`;
}

export function demoReview() {
  return JSON.stringify({ verdict: 'approve', feedback: 'Clear, specific and on time. Approved.' });
}

export function demoSummary(mission, tasks) {
  const lines = tasks.map((t) => `- **${getAgent(t.agentId).name}** — ${t.title}: ${t.status === 'done' ? (t.late ? 'delivered late' : 'delivered on time') : t.status}`);
  return `## Mission report

**Goal:** ${mission.goal}

### What the team delivered
${lines.join('\n')}

### My read
We have a validated angle, a scoped MVP, a brand, a pricing model and a launch plan. The biggest risk is distribution — I'd spend the first week on 30 customer conversations before writing more code.

### Next 3 moves
1. Ship the landing page and start the waitlist.
2. Pre-sell 10 founding licences at the launch price.
3. Build only the features the first 10 buyers ask for.`;
}

export function demoChat(agentId, message) {
  const a = getAgent(agentId);
  return `${a.name} here (${a.role}). On "${message.slice(0, 80)}": my take is to start small, measure, and iterate weekly. In demo mode I can't think for real — log in to Claude Code and I'll give you a proper answer.`;
}
