// Offline demo engine: scripted but plausible agent behaviour, streamed word by
// word, so the OS can be explored without an API key.
import { specialists, getAgent } from './agents.js';

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
    ? [specialists().find((a) => instruction.toLowerCase().includes(a.name.toLowerCase()))?.id || 'marketing']
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

export function demoMeetingTurn(agentId, meeting, round) {
  const a = getAgent(agentId);
  const lines = {
    ceo: `Let's keep this tight. Agenda: ${meeting.agenda}. I want each of you to give me your angle, one risk, and what you'd own.`,
    research: `From the data: the audience is real and underserved. Risk — we're guessing at willingness to pay. I'll own a 10-interview validation sprint.`,
    product: `I'd scope this to the smallest version that proves value. Risk is scope creep. I'll own the MVP spec.`,
    engineer: `Technically this is a week of work if we stay on a boring stack. I'll own the build and a deploy checklist.`,
    design: `Brand should feel calm and premium. I'll own the landing page and visual identity.`,
    marketing: `Launch through communities first, then short video. I'll own launch copy and a 2-week content calendar.`,
    sales: `Price anchor at $29 with a $19 launch offer. I'll own the pricing page and revenue model.`,
    support: `I'll own onboarding emails and an FAQ so the first 100 buyers succeed.`,
  };
  return round > 1
    ? `Building on what ${meeting.participants.filter((p) => p !== agentId).map((p) => getAgent(p)?.name).slice(0, 2).join(' and ')} said — agreed, and I can start today.`
    : lines[agentId] || `${a.name} here: I can take a piece of this and deliver within the deadline.`;
}

export function demoMinutes(meeting) {
  const items = meeting.participants
    .filter((p) => p !== 'ceo')
    .map((p) => ({ agent: p, title: `Follow-up from “${meeting.title}”`, brief: `Own your part of: ${meeting.agenda}`, deliverable: 'A short, concrete deliverable', due_in_hours: 6 }));
  return JSON.stringify({
    summary: `## Meeting minutes\n\n**Agenda:** ${meeting.agenda}\n\nThe team aligned on a lean plan. Everyone owns one concrete next step.`,
    decisions: ['Ship the smallest valuable version first', 'Validate pricing with real buyers'],
    action_items: items,
  });
}

export function demoSkill(name) {
  return JSON.stringify({
    name,
    summary: `Repeatable process for: ${name}.`,
    body: `**When to use:** whenever this workflow is needed.\n\n**Steps**\n1. Open the source.\n2. Collect the required information.\n3. Produce the output in the agreed format.\n\n**Decision rules**\n- If data is missing, flag it instead of guessing.\n\n**Output requirements**\n- A Markdown summary saved to the workspace.\n\n**Approval boundaries**\n- Ask the founder before sending, publishing, buying or deleting anything.`,
  });
}
