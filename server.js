// Yebunna OS — HTTP server. Zero dependencies: Node's http module, a JSON API,
// Server-Sent Events for live updates, and the static UI in /public.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAgents, getAgent, publicAgent, systemPrompt, createAgent, updateAgent, resetAgent, deleteAgent, remember, forget, toolsFor, setComputerForAll } from './src/agents.js';
import { state, save, now, WORKSPACE } from './src/store.js';
import { providerInfo, streamChat, complete, detectionReport, warmBrowser } from './src/llm.js';
import { demoChat } from './src/demo.js';
import {
  bus,
  createMission,
  createMissionWithTasks,
  sendToMission,
  cancelMission,
  deleteMission,
  resumeAll,
  approvePlan,
  decideTask,
} from './src/orchestrator.js';
import { startMeeting, addFounderMessage, launchActionItems, deleteMeeting, resumeMeetings } from './src/meetings.js';
import { createSkill, updateSkill, deleteSkill, skillFromTask, teachSkill, runSkill, generateRoleSkills, generateAllRoleSkills } from './src/skills.js';
import { listPacks, installPack, installAll } from './src/skillpacks.js';
import { listConnections, saveConnection, removeConnection, testConnection } from './src/connections.js';
import { logActivity, toolTracker } from './src/activity.js';
import { createRoutine, updateRoutine, deleteRoutine, fireRoutine } from './src/routines.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};
const TEXT = /\.(md|txt|json|csv|tsv|js|mjs|ts|tsx|jsx|py|html|css|scss|yml|yaml|toml|sh|sql|xml|env|ini|log)$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (cond, status, msg) => {
  if (!cond) throw new HttpError(status, msg);
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1e6) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const futureDeadline = (deadline) => {
  const due = Date.parse(deadline);
  need(Number.isFinite(due) && due > Date.now() + 60_000, 400, 'deadline must be in the future');
  return new Date(due).toISOString();
};
const get = (coll, id, what) => {
  const item = state[coll][id];
  need(item, 404, `${what} not found`);
  return item;
};
const inWorkspace = (rel) => {
  const file = path.resolve(WORKSPACE, String(rel || ''));
  need(file === WORKSPACE || file.startsWith(WORKSPACE + path.sep), 403, 'outside the workspace');
  return file;
};

function walk(dir, base = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length > 3000) break;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (!base && ['.skills', '.browser'].includes(entry.name)) continue; // internal: thousands of files
      walk(full, rel, out);
    } else {
      const st = fs.statSync(full);
      out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}

const routes = {
  // ---- meta & live events ----
  'GET /api/meta': (req, res) =>
    send(res, 200, { provider: providerInfo(), agents: allAgents().map(publicAgent), workspace: WORKSPACE }),

  'GET /api/state': (req, res) =>
    send(res, 200, {
      missions: Object.values(state.missions),
      tasks: Object.values(state.tasks),
      meetings: Object.values(state.meetings),
      skills: Object.values(state.skills),
      routines: Object.values(state.routines),
      memory: state.memory,
      settings: state.settings,
      activity: (state.activity || []).slice(-200),
      packs: listPacks(),
      connections: listConnections(),
      usage: state.usage || null,
    }),

  'GET /api/events': (req, res) => {
    const write = sse(res);
    const onEvent = (e) => write(e);
    bus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
  },

  'GET /api/settings': (req, res) => send(res, 200, state.settings),
  'PUT /api/settings': async (req, res) => {
    const body = await readBody(req);
    for (const k of ['approvePlans', 'approveDeliverables', 'terminal', 'browserHeadless', 'economy']) if (k in body) state.settings[k] = Boolean(body[k]);
    if (['chrome', 'msedge', 'firefox'].includes(body.browser)) state.settings.browser = body.browser;
    if (['quality', 'balanced', 'economy'].includes(body.usageMode)) {
      state.settings.usageMode = body.usageMode;
      state.settings.economy = body.usageMode === 'economy';
    }
    save();
    bus.emit('event', { type: 'settings', settings: state.settings });
    send(res, 200, state.settings);
  },

  // ---- missions ----
  'POST /api/missions': async (req, res) => {
    const { goal, deadline } = await readBody(req);
    need(goal?.trim(), 400, 'goal is required');
    send(res, 201, createMission({ goal: goal.trim(), deadline: futureDeadline(deadline) }));
  },
  'POST /api/missions/:id/messages': async (req, res, { id }) => {
    const m = get('missions', id, 'mission');
    const { text, mode } = await readBody(req);
    need(text?.trim(), 400, 'text is required');
    if (m.status === 'cancelled') m.status = 'done';
    sendToMission(m, { text: text.trim(), mode: mode === 'ask' ? 'ask' : 'delegate' });
    send(res, 202, { ok: true });
  },
  'POST /api/missions/:id/approve': (req, res, { id }) => {
    approvePlan(get('missions', id, 'mission'));
    send(res, 200, { ok: true });
  },
  'POST /api/missions/:id/cancel': (req, res, { id }) => {
    cancelMission(get('missions', id, 'mission'));
    send(res, 200, { ok: true });
  },
  'DELETE /api/missions/:id': (req, res, { id }) => {
    deleteMission(get('missions', id, 'mission'));
    send(res, 200, { ok: true });
  },

  // ---- tasks ----
  'POST /api/tasks/:id/decision': async (req, res, { id }) => {
    const t = get('tasks', id, 'task');
    const { approve, feedback } = await readBody(req);
    need(t.status === 'approval', 409, 'This task is not waiting for your approval.');
    decideTask(t, { approve: Boolean(approve), feedback });
    send(res, 200, { ok: true });
  },
  'POST /api/tasks/:id/skill': (req, res, { id }) => {
    const t = get('tasks', id, 'task');
    need(t.output, 400, 'This task has no output yet.');
    send(res, 202, skillFromTask(t));
  },

  // ---- agents / bots ----
  'POST /api/agents': async (req, res) => {
    const body = await readBody(req);
    need(body.name?.trim() && body.role?.trim(), 400, 'name and main job are required');
    const a = createAgent(body);
    bus.emit('event', { type: 'agents', agents: allAgents().map(publicAgent) });
    send(res, 201, publicAgent(a));
  },
  'POST /api/agents/computer': async (req, res) => {
    const { enabled } = await readBody(req);
    setComputerForAll(Boolean(enabled));
    if (enabled) warmBrowser();
    bus.emit('event', { type: 'agents', agents: allAgents().map(publicAgent) });
    send(res, 200, { ok: true });
  },
  // Open the bot's own browser on a site so the founder can log in by hand; the
  // login is kept in that bot's browser profile for future tasks.
  'POST /api/agents/:id/browser-login': async (req, res, { id }) => {
    const agent = getAgent(id);
    need(agent, 404, 'agent not found');
    need(agent.computer, 400, `Turn on computer use for ${agent.name} first.`);
    let { url } = await readBody(req);
    url = String(url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    need(/^https?:\/\/[^\s]+$/i.test(url), 400, 'Enter a website address, e.g. mail.google.com');
    send(res, 202, { ok: true });
    const notice = (text) => {
      (state.chats[id] ||= []).push({ role: 'assistant', content: text, at: now() });
      save();
      bus.emit('event', { type: 'notice', agentId: id, text });
    };
    try {
      const reply = await complete({
        system: systemPrompt(agent),
        messages: [
          {
            role: 'user',
            content: `The founder wants to log in to ${url} in YOUR browser so you can use that site in later tasks.
1. Open ${url} with browser_navigate.
2. Do NOT type any credentials yourself. The founder will log in by hand in the visible browser window.
3. Wait for them: call browser_wait_for with time 20, then take a browser_snapshot to check whether they are
   logged in. Repeat up to 12 times (about 4 minutes) until the page clearly shows a logged-in state.
4. Reply in ONE short line: whether the login on ${url} succeeded and that it is saved for future tasks.`,
          },
        ],
        tools: ['mcp__browser'],
        agentId: id,
        kind: 'chat',
        maxTurns: 40,
        effort: 'low',
        demo: () => `Demo mode: in live mode a browser window opens on ${url} for you to log in.`,
      });
      notice(reply.trim() || `Finished the login session for ${url}.`);
    } catch (e) {
      notice(`⚠️ Login session for ${url} failed: ${e.message}`);
    }
  },
  'PUT /api/agents/:id': async (req, res, { id }) => {
    const a = updateAgent(id, await readBody(req));
    need(a, 404, 'agent not found');
    if (a.computer) warmBrowser();
    bus.emit('event', { type: 'agents', agents: allAgents().map(publicAgent) });
    send(res, 200, publicAgent(a));
  },
  'POST /api/agents/:id/reset': (req, res, { id }) => {
    need(resetAgent(id), 400, 'This bot has no edits to reset.');
    bus.emit('event', { type: 'agents', agents: allAgents().map(publicAgent) });
    send(res, 200, publicAgent(getAgent(id)));
  },
  'DELETE /api/agents/:id': (req, res, { id }) => {
    need(deleteAgent(id), 400, 'Only bots you created can be deleted.');
    bus.emit('event', { type: 'agents', agents: allAgents().map(publicAgent) });
    send(res, 200, { ok: true });
  },
  'POST /api/agents/:id/assign': async (req, res, { id }) => {
    const agent = getAgent(id);
    need(agent && id !== 'ceo', 404, 'Pick a bot to assign to (the CEO delegates missions instead).');
    const { title, instructions, deadlineHours = 4, skillId, size } = await readBody(req);
    need(title?.trim(), 400, 'title is required');
    const hours = Math.max(0.1, Number(deadlineHours) || 4);
    send(
      res,
      201,
      createMissionWithTasks({
        goal: title.trim(),
        deadline: new Date(Date.now() + hours * 36e5).toISOString(),
        specs: [{ agent: id, title: title.trim(), brief: instructions || title, deliverable: 'The finished work', due_in_hours: hours, skillId, size }],
        intro: `Assigned directly to **${agent.name}** — due in ${hours}h.`,
      }),
    );
  },
  'POST /api/agents/:id/memory': async (req, res, { id }) => {
    need(getAgent(id), 404, 'agent not found');
    const { text } = await readBody(req);
    need(text?.trim(), 400, 'text is required');
    const entry = remember(id, text, 'founder');
    bus.emit('event', { type: 'memory', agentId: id, memory: state.memory[id] });
    send(res, 201, entry);
  },
  'DELETE /api/agents/:id/memory/:memId': (req, res, { id, memId }) => {
    forget(id, memId);
    bus.emit('event', { type: 'memory', agentId: id, memory: state.memory[id] || [] });
    send(res, 200, { ok: true });
  },

  // ---- 1:1 chat with any bot, streamed back as SSE ----
  'GET /api/chats/:agentId': (req, res, { agentId }) => send(res, 200, state.chats[agentId] || []),
  'DELETE /api/chats/:agentId': (req, res, { agentId }) => {
    delete state.chats[agentId];
    save();
    send(res, 200, { ok: true });
  },
  'POST /api/chats/:agentId': async (req, res, { agentId }) => {
    const agent = getAgent(agentId);
    need(agent, 404, 'agent not found');
    const { text } = await readBody(req);
    need(text?.trim(), 400, 'text is required');

    // "Remember …" saves straight to the bot's memory.
    const rememberMatch = text.trim().match(/^(?:please\s+)?remember(?:\s+that)?[:,]?\s+(.+)/is);
    if (rememberMatch) {
      remember(agentId, rememberMatch[1], 'chat');
      bus.emit('event', { type: 'memory', agentId, memory: state.memory[agentId] });
    }

    const history = (state.chats[agentId] ||= []);
    history.push({ role: 'user', content: text.trim(), at: now() });
    // The reply keeps going even if the page is closed or refreshed; it is saved either way.
    const stream = sse(res);
    const write = (ev) => !res.destroyed && !res.writableEnded && stream(ev);
    const isCeo = agentId === 'ceo';
    const ref = { type: 'chat', agentId };
    const track = toolTracker(agentId, ref);

    const reply = { role: 'assistant', content: '', reasoning: '', at: now() };
    try {
      const work = Object.values(state.tasks)
        .filter((t) => t.agentId === agentId && t.status !== 'failed')
        .slice(-5)
        .map((t) => `- ${t.title} [${t.status}] due ${t.deadline}${t.file ? ` (file: ${t.file})` : ''}`)
        .join('\n');
      const ceoRules = isCeo
        ? `\n\nWhen the founder asks for WORK to be done (build, write, research, design, price, launch, fix…), you do
not do it yourself. Reply in 1–3 sentences saying which teammates will handle it, then end your message
with exactly one block in this format:
\`\`\`delegate
{"goal": "<the work, written as a clear mission goal with all the details the founder gave>", "deadline_hours": <number>}
\`\`\`
The OS turns it into a mission and you delegate it to the team. For questions, status checks and advice,
just answer (you may read the team's files) — no block.`
        : '';
      for await (const ev of streamChat({
        system: `${systemPrompt(agent)}\n\nYou are chatting 1:1 with the founder.${work ? `\nYour recent assignments:\n${work}` : ''}${rememberMatch ? '\nThe founder just asked you to remember something; it is saved to your memory — confirm briefly.' : ''}${ceoRules}`,
        messages: history.slice(-20).map(({ role, content }) => ({ role, content })),
        tools: isCeo ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] : toolsFor(agent),
        agentId,
        kind: 'chat',
        maxTurns: agent.computer ? 150 : 100,
        demo: () => (isCeo && !rememberMatch ? `On it — I'll get the team on this.\n\n\`\`\`delegate\n${JSON.stringify({ goal: text.trim(), deadline_hours: 24 })}\n\`\`\`` : demoChat(agentId, text)),
      })) {
        if (ev.type === 'turn') {
          // Text before a tool call was working-out-loud: keep it under Thoughts.
          if (reply.content) reply.reasoning += `${reply.content}\n`;
          reply.content = '';
        } else if (ev.type === 'text') reply.content += ev.text;
        else {
          reply.reasoning += ev.text;
          track(ev.text);
        }
        write(ev);
      }

      // CEO handed work to the team: start a real mission (it shows on the board).
      const block = isCeo && reply.content.match(/```delegate\s*([\s\S]*?)```/);
      if (block) {
        let spec = {};
        try {
          spec = JSON.parse(block[1]);
        } catch {
          spec = { goal: text.trim() };
        }
        const hours = Math.min(24 * 60, Math.max(1, Number(spec.deadline_hours) || 24));
        const m = createMission({ goal: String(spec.goal || text).trim(), deadline: new Date(Date.now() + hours * 36e5).toISOString(), source: 'chat' });
        reply.content = `${reply.content.replace(block[0], '').trim()}\n\n→ Started mission **[${m.title}](#/m/${m.id})** (due in ${hours}h) — I'm assigning it to the team now.`;
        reply.missionId = m.id;
        write({ type: 'replace', content: reply.content });
      }
      history.push(reply);
      logActivity(agentId, block ? 'turned your chat request into a mission' : 'replied to you in chat', ref);
      write({ type: 'done' });
    } catch (e) {
      if (reply.content) history.push(reply);
      history.push({ role: 'assistant', content: `⚠️ ${e.message}`, at: now() });
      write({ type: 'error', text: e.message });
    }
    save();
    bus.emit('event', { type: 'chat', agentId });
    if (!res.writableEnded) res.end();
  },

  // ---- team meetings & standups ----
  'POST /api/meetings': async (req, res) => {
    const body = await readBody(req);
    need(Array.isArray(body.participants) && body.participants.length, 400, 'Pick at least one bot to invite.');
    send(res, 201, startMeeting(body));
  },
  'POST /api/meetings/:id/messages': async (req, res, { id }) => {
    const mt = get('meetings', id, 'meeting');
    const { text } = await readBody(req);
    need(text?.trim(), 400, 'text is required');
    try {
      addFounderMessage(mt, text.trim());
    } catch (e) {
      throw new HttpError(409, e.message);
    }
    send(res, 202, { ok: true });
  },
  'POST /api/meetings/:id/launch': (req, res, { id }) => {
    try {
      send(res, 201, launchActionItems(get('meetings', id, 'meeting')));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
  },
  'DELETE /api/meetings/:id': (req, res, { id }) => {
    deleteMeeting(get('meetings', id, 'meeting'));
    send(res, 200, { ok: true });
  },

  // ---- skills & watch-and-learn ----
  'POST /api/skills': async (req, res) => {
    const body = await readBody(req);
    need(body.name?.trim(), 400, 'name is required');
    send(res, 201, createSkill({ ...body, status: body.status || 'active' }));
  },
  'PUT /api/skills/:id': async (req, res, { id }) => send(res, 200, updateSkill(get('skills', id, 'skill'), await readBody(req))),
  'DELETE /api/skills/:id': (req, res, { id }) => {
    deleteSkill(get('skills', id, 'skill'));
    send(res, 200, { ok: true });
  },
  'POST /api/skills/:id/run': async (req, res, { id }) => {
    const s = get('skills', id, 'skill');
    try {
      send(res, 201, runSkill(s, await readBody(req)));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  },
  'POST /api/teach': async (req, res) => {
    const body = await readBody(req, 60e6);
    try {
      send(res, 202, teachSkill(body));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  },

  // ---- connected accounts (GitHub, Vercel, Meta, Google Drive) ----
  'GET /api/connections': (req, res) => send(res, 200, listConnections()),
  'PUT /api/connections/:id': async (req, res, { id }) => {
    try {
      const c = saveConnection(id, await readBody(req));
      bus.emit('event', { type: 'connections', connections: listConnections() });
      send(res, 200, c);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  },
  'POST /api/connections/:id/test': async (req, res, { id }) => {
    const status = await testConnection(id);
    bus.emit('event', { type: 'connections', connections: listConnections() });
    if (status.ok) logActivity('ceo', `connected ${id} (${status.account})`);
    send(res, 200, status);
  },
  'DELETE /api/connections/:id': (req, res, { id }) => {
    removeConnection(id);
    bus.emit('event', { type: 'connections', connections: listConnections() });
    send(res, 200, { ok: true });
  },

  // ---- skill packs & role skills ----
  'GET /api/skill-packs': (req, res) => send(res, 200, listPacks()),
  'POST /api/skill-packs/install': async (req, res) => {
    const { id } = await readBody(req);
    if (id) installPack(id).catch(() => {});
    else installAll();
    send(res, 202, { ok: true });
  },
  'POST /api/agents/:id/generate-skills': async (req, res, { id }) => {
    need(getAgent(id), 404, 'agent not found');
    send(res, 202, { ok: true });
    generateRoleSkills(id).catch((e) => logActivity(id, `couldn't write its skills: ${e.message}`));
  },
  'POST /api/skills/generate-all': (req, res) => {
    send(res, 202, { ok: true });
    generateAllRoleSkills().catch(() => {});
  },

  // ---- routines ----
  'POST /api/routines': async (req, res) => {
    try {
      send(res, 201, createRoutine(await readBody(req)));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
  },
  'PUT /api/routines/:id': async (req, res, { id }) => {
    const r = get('routines', id, 'routine');
    try {
      send(res, 200, updateRoutine(r, await readBody(req)));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
  },
  'POST /api/routines/:id/run': (req, res, { id }) => send(res, 200, fireRoutine(get('routines', id, 'routine'), 'run now')),
  'DELETE /api/routines/:id': (req, res, { id }) => {
    deleteRoutine(get('routines', id, 'routine'));
    send(res, 200, { ok: true });
  },

  // ---- shared workspace files ----
  'GET /api/files': (req, res) => send(res, 200, { root: WORKSPACE, files: walk(WORKSPACE) }),
  'GET /api/file': async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = inWorkspace(url.searchParams.get('path'));
    const st = await fsp.stat(file).catch(() => null);
    need(st?.isFile(), 404, 'file not found');
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': TEXT.test(file) ? 'text/plain; charset=utf-8' : TYPES[ext] || 'application/octet-stream' };
    if (url.searchParams.get('download')) headers['content-disposition'] = `attachment; filename="${path.basename(file).replace(/"/g, '')}"`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  },
};

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, pattern] = key.split(' ');
  const names = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
  return { method, re, names, handler };
});

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await fsp.readFile(file);
    // no-cache: after a `git pull` the browser always picks up the new UI.
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    const body = await fsp.readFile(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    res.end(body);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    for (const r of compiled) {
      const match = req.method === r.method && pathname.match(r.re);
      if (match) {
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
        return await r.handler(req, res, params);
      }
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    await serveStatic(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

resumeAll();
resumeMeetings();
if (allAgents().some((a) => a.computer)) warmBrowser();
// Download any skill packs that aren't installed yet (needs git and internet; runs in the background).
if (process.env.SKILL_PACKS !== '0') installAll({ onlyMissing: true }).catch(() => {});
server.listen(PORT, () => {
  const p = providerInfo();
  console.log(`Yebunna OS running at http://localhost:${PORT}`);
  console.log(`Shared workspace: ${WORKSPACE}`);
  if (p.name !== 'demo') return console.log(`Engine: Claude via Claude Code ${p.cli} — model: ${p.model}`);
  console.log('Engine: offline demo (install Claude Code and run `claude` once to log in with your subscription)');
  const tried = detectionReport();
  if (tried.length) console.log(`Could not start Claude Code. Tried:\n  ${tried.join('\n  ')}\nSet CLAUDE_BIN in .env to the full path of claude.exe if it lives elsewhere.`);
  else if (process.env.DEMO_MODE !== '1') console.log('Claude Code was not found on this computer.');
});
