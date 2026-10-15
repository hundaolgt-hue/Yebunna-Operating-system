// Skills: reusable processes (steps, decision rules, output requirements and
// approval boundaries) that an agent follows when they apply. Skills come from
// three places, like Grok Bot: written by hand, saved from a task that went well,
// or taught by demonstration ("watch and learn") — the founder records their
// screen while doing the workflow once and the agent drafts the skill from it.
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, specialists, allAgents } from './agents.js';
import { logActivity } from './activity.js';
import { complete, extractJson } from './llm.js';
import { state, save, newId, now, WORKSPACE } from './store.js';
import { bus, createMissionWithTasks } from './orchestrator.js';
import { demoSkill } from './demo.js';

const MAX_FRAMES_FOR_MODEL = 20;

const SKILL_FORMAT = `Reply with ONLY JSON:
{"name": "<short skill name>",
 "summary": "<one sentence: what this skill does and when to use it>",
 "body": "<Markdown with these sections: **When to use**, **Inputs**, **Steps** (numbered, concrete — name the sites, fields, buttons and data involved), **Decision rules**, **Output requirements**, **Approval boundaries** (actions that must wait for the founder: sending, publishing, buying, deleting, changing production systems; passwords/2FA/CAPTCHAs stay with the human)>"}`;

const emit = (s) => {
  save();
  bus.emit('event', { type: 'skill', skill: s });
};

export function createSkill({ name, agentId = 'any', summary = '', body = '', status = 'active', source = 'manual' }) {
  const s = { id: newId('skl'), name: String(name || 'Untitled skill').slice(0, 80), agentId, summary, body, status, source, createdAt: now(), runs: 0 };
  state.skills[s.id] = s;
  emit(s);
  return s;
}

export function updateSkill(s, patch) {
  for (const k of ['name', 'agentId', 'summary', 'body', 'status']) if (patch[k] !== undefined) s[k] = patch[k];
  if (Array.isArray(patch.agentIds)) {
    s.agentIds = patch.agentIds;
    s.ownersEdited = true; // keep the founder's choice when the pack updates
  }
  s.updatedAt = now();
  emit(s);
  return s;
}

export function deleteSkill(s) {
  delete state.skills[s.id];
  save();
  bus.emit('event', { type: 'skill.deleted', id: s.id });
}

/** "Save as skill": turn a task that went well into a reusable process. */
export function skillFromTask(t) {
  const s = createSkill({ name: `Skill from: ${t.title}`, agentId: t.agentId, status: 'drafting', source: `task:${t.id}` });
  (async () => {
    const raw = await complete({
      system: 'You turn successful work into reusable, precise operating procedures for an AI teammate.',
      messages: [
        {
          role: 'user',
          content: `This task was completed well. Extract a reusable skill so it can be repeated reliably for other products.
Task: ${t.title}
Brief: ${t.brief}
Deliverable expected: ${t.deliverable}
Result:
${t.output.slice(0, 8000)}

${SKILL_FORMAT}`,
        },
      ],
      effort: 'medium',
      demo: () => demoSkill(t.title),
    });
    applyDraft(s, extractJson(raw));
  })().catch((e) => failSkill(s, e));
  return s;
}

/**
 * Watch and learn. `frames` are JPEG screenshots captured from the founder's screen
 * share in the browser ({ data: base64, t: ms offset, note }), plus narration notes.
 */
export function teachSkill({ agentId, name, notes = '', frames = [] }) {
  if (!frames.length) throw new Error('No screen frames were recorded.');
  const s = createSkill({ name: name || 'Taught workflow', agentId: agentId || 'any', status: 'drafting', source: 'taught' });
  const rel = path.join('.teach', s.id);
  const dir = path.join(WORKSPACE, rel);
  fs.mkdirSync(dir, { recursive: true });
  const saved = frames.map((f, i) => {
    const file = `frame-${String(i + 1).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(String(f.data).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    return { file: `${rel.replace(/\\/g, '/')}/${file}`, t: Number(f.t) || 0, note: String(f.note || '') };
  });
  s.teach = { frames: saved.length, dir: rel.replace(/\\/g, '/'), notes, seconds: Math.round((saved.at(-1)?.t || 0) / 1000) };
  emit(s);

  // Sample evenly so long recordings stay within what the model reads in one go.
  const step = Math.max(1, saved.length / MAX_FRAMES_FOR_MODEL);
  const picked = [];
  for (let i = 0; i < saved.length && picked.length < MAX_FRAMES_FOR_MODEL; i += step) picked.push(saved[Math.floor(i)]);
  if (picked.at(-1) !== saved.at(-1)) picked[picked.length - 1] = saved.at(-1);

  (async () => {
    const agent = getAgent(agentId) || getAgent('ceo');
    const raw = await complete({
      system: `You are ${agent.name}, ${agent.role}. The founder is teaching you a workflow by demonstration.`,
      messages: [
        {
          role: 'user',
          content: `The founder recorded their screen while doing a task once so you can learn it. Use the Read tool to
look at EVERY screenshot below, in order (they are image files in the current directory), then work out
exactly what they did, step by step: which site or app, what they clicked or typed, what data moved where,
and what the end result was.

Skill name suggested by the founder: ${name || '(none — propose one)'}
Founder's notes: ${notes || '(none)'}

Screenshots in order (seconds from start · founder narration at that moment):
${picked.map((f) => `- ${f.file} · ${Math.round(f.t / 1000)}s${f.note ? ` · "${f.note}"` : ''}`).join('\n')}

Write the skill so you could repeat this workflow yourself next time. Where something is ambiguous,
say so in the steps instead of guessing.

${SKILL_FORMAT}`,
        },
      ],
      tools: ['Read'],
      maxTurns: MAX_FRAMES_FOR_MODEL + 5,
      effort: 'high',
      demo: () => demoSkill(name || 'Taught workflow'),
    });
    applyDraft(s, extractJson(raw));
  })().catch((e) => failSkill(s, e));
  return s;
}

/**
 * Build a bot's core skills from its own role, responsibilities and specialties —
 * so what the founder wrote in the bot's description becomes concrete procedures it
 * follows. Re-running replaces the bot's previous role skills.
 */
export async function generateRoleSkills(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('agent not found');
  logActivity(agentId, 'is writing its core skills from its role description');
  const raw = await complete({
    system: 'You write precise, reusable operating procedures (skills) for an AI teammate at a company that builds and sells digital products.',
    messages: [
      {
        role: 'user',
        content: `Write this teammate's core skills — one skill per responsibility or specialty in their description.
Name: ${agent.name}
Role: ${agent.role}
Responsibilities & personality: ${agent.persona}
Specialties: ${agent.specialties.join(', ')}
Tools they have: read/write/edit files in a shared workspace${agent.tools.includes('WebSearch') ? ', web search' : ''}${state.settings.terminal ? ', a terminal (Python etc.)' : ''}${agent.computer ? ', a web browser (computer use)' : ''}.

Write 3 to 5 skills. Each must be concrete and specific to this role (not generic advice): the exact steps,
the decision rules, what the output must contain and where to save it, and approval boundaries.

Reply with ONLY JSON:
{"skills": [{"name": "<short skill name>", "summary": "<when to use it, one sentence>",
 "body": "<Markdown with sections: **When to use**, **Inputs**, **Steps** (numbered), **Decision rules**, **Output requirements**, **Approval boundaries**>"}]}`,
      },
    ],
    effort: 'medium',
    demo: () =>
      JSON.stringify({
        skills: agent.specialties.slice(0, 3).map((sp) => ({ ...JSON.parse(demoSkill(sp)), name: sp })),
      }),
  });
  const list = (extractJson(raw).skills || []).filter((x) => x?.name && x?.body).slice(0, 6);
  if (!list.length) throw new Error('No skills came back — try again.');
  for (const old of Object.values(state.skills)) if (old.source === 'role' && old.agentId === agentId) deleteSkill(old);
  const created = list.map((x) => createSkill({ name: x.name, agentId, summary: String(x.summary || ''), body: String(x.body), status: 'active', source: 'role' }));
  logActivity(agentId, `wrote ${created.length} core skills from its role`);
  return created;
}

/** Build role skills for every bot, a few at a time. */
export async function generateAllRoleSkills() {
  const results = [];
  for (const a of allAgents()) {
    try {
      results.push({ agentId: a.id, ok: true, count: (await generateRoleSkills(a.id)).length });
    } catch (e) {
      results.push({ agentId: a.id, ok: false, error: e.message });
    }
  }
  return results;
}

/** Test a skill: assign it to its agent as a one-task mission. */
export function runSkill(s, { input = '', deadlineHours = 4, agentId } = {}) {
  const owner = agentId || (s.agentId && s.agentId !== 'any' ? s.agentId : (s.agentIds || []).find((a) => a !== '*' && a !== 'ceo'));
  if (!owner || !getAgent(owner) || owner === 'ceo') throw new Error('Choose which bot should run this skill.');
  s.runs = (s.runs || 0) + 1;
  emit(s);
  return createMissionWithTasks({
    goal: `Run skill “${s.name}”${input ? `: ${input}` : ''}`,
    deadline: new Date(Date.now() + deadlineHours * 36e5).toISOString(),
    specs: [{ agent: owner, title: `Run skill: ${s.name}`, brief: input || s.summary || s.name, deliverable: 'Follow the skill and deliver its output', due_in_hours: deadlineHours, skillId: s.id }],
    intro: `Assigned skill **${s.name}** to ${getAgent(owner).name}.`,
    source: `skill:${s.id}`,
  });
}

function applyDraft(s, d) {
  logActivity(s.agentId && s.agentId !== 'any' ? s.agentId : 'ceo', `drafted the skill “${d.name || s.name}” — ready for your review`);
  s.name = String(d.name || s.name).slice(0, 80);
  s.summary = String(d.summary || '');
  s.body = String(d.body || '');
  s.status = 'draft'; // the founder reviews, edits and activates it
  emit(s);
}

function failSkill(s, e) {
  console.error(`skill ${s.id} failed:`, e.message);
  s.status = 'failed';
  s.error = e.message;
  emit(s);
}
