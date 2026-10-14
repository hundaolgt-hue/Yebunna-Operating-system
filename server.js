// Yebunna OS — HTTP server. Zero dependencies: Node's http module, a JSON API,
// Server-Sent Events for live updates, and the static UI in /public.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, getAgent, publicAgent, systemPrompt } from './src/agents.js';
import { state, save } from './src/store.js';
import { providerInfo, streamChat, detectionReport } from './src/llm.js';
import { demoChat } from './src/demo.js';
import { bus, createMission, sendToMission, cancelMission, deleteMission, resumeAll } from './src/orchestrator.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const routes = {
  'GET /api/meta': (req, res) =>
    send(res, 200, { provider: providerInfo(), agents: AGENTS.map(publicAgent) }),

  'GET /api/state': (req, res) =>
    send(res, 200, { missions: Object.values(state.missions), tasks: Object.values(state.tasks) }),

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

  'POST /api/missions': async (req, res) => {
    const { goal, deadline } = await readBody(req);
    if (!goal?.trim()) return send(res, 400, { error: 'goal is required' });
    const due = Date.parse(deadline);
    if (!Number.isFinite(due) || due < Date.now() + 60_000) return send(res, 400, { error: 'deadline must be in the future' });
    send(res, 201, createMission({ goal: goal.trim(), deadline: new Date(due).toISOString() }));
  },

  'POST /api/missions/:id/messages': async (req, res, { id }) => {
    const m = state.missions[id];
    if (!m) return send(res, 404, { error: 'mission not found' });
    const { text, mode } = await readBody(req);
    if (!text?.trim()) return send(res, 400, { error: 'text is required' });
    if (m.status === 'planning') return send(res, 409, { error: 'The CEO is still planning — try again in a moment.' });
    if (m.status === 'cancelled') m.status = 'done';
    sendToMission(m, { text: text.trim(), mode: mode === 'ask' ? 'ask' : 'delegate' });
    send(res, 202, { ok: true });
  },

  'POST /api/missions/:id/cancel': (req, res, { id }) => {
    const m = state.missions[id];
    if (!m) return send(res, 404, { error: 'mission not found' });
    cancelMission(m);
    send(res, 200, { ok: true });
  },

  'DELETE /api/missions/:id': (req, res, { id }) => {
    const m = state.missions[id];
    if (!m) return send(res, 404, { error: 'mission not found' });
    deleteMission(m);
    send(res, 200, { ok: true });
  },

  'GET /api/chats/:agentId': (req, res, { agentId }) => send(res, 200, state.chats[agentId] || []),

  'DELETE /api/chats/:agentId': (req, res, { agentId }) => {
    delete state.chats[agentId];
    save();
    send(res, 200, { ok: true });
  },

  // Direct 1:1 chat with any agent, streamed back as SSE.
  'POST /api/chats/:agentId': async (req, res, { agentId }) => {
    const agent = getAgent(agentId);
    if (!agent) return send(res, 404, { error: 'agent not found' });
    const { text } = await readBody(req);
    if (!text?.trim()) return send(res, 400, { error: 'text is required' });

    const history = (state.chats[agentId] ||= []);
    history.push({ role: 'user', content: text.trim(), at: new Date().toISOString() });
    const write = sse(res);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const reply = { role: 'assistant', content: '', reasoning: '', at: new Date().toISOString() };
    try {
      const work = Object.values(state.tasks)
        .filter((t) => t.agentId === agentId && t.status !== 'failed')
        .slice(-5)
        .map((t) => `- ${t.title} [${t.status}] due ${t.deadline}`)
        .join('\n');
      for await (const ev of streamChat({
        system: `${systemPrompt(agent)}\n\nYou are chatting 1:1 with the founder.${work ? `\nYour recent assignments:\n${work}` : ''}`,
        messages: history.slice(-20).map(({ role, content }) => ({ role, content })),
        tools: agent.tools || [],
        signal: abort.signal,
        demo: () => demoChat(agentId, text),
      })) {
        if (ev.type === 'text') reply.content += ev.text;
        else reply.reasoning += ev.text;
        write(ev);
      }
      history.push(reply);
      write({ type: 'done' });
    } catch (e) {
      if (reply.content) history.push(reply);
      write({ type: 'error', text: e.message });
    }
    save();
    res.end();
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
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA fallback
    const body = await fs.readFile(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' });
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
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

resumeAll();
server.listen(PORT, () => {
  const p = providerInfo();
  console.log(`Yebunna OS running at http://localhost:${PORT}`);
  if (p.name !== 'demo') return console.log(`Engine: Claude via Claude Code ${p.cli} — model: ${p.model}`);
  console.log('Engine: offline demo (install Claude Code and run `claude` once to log in with your subscription)');
  const tried = detectionReport();
  if (tried.length) console.log(`Could not start Claude Code. Tried:\n  ${tried.join('\n  ')}\nSet CLAUDE_BIN in .env to the full path of claude.exe if it lives elsewhere.`);
  else if (process.env.DEMO_MODE !== '1') console.log('Claude Code was not found on this computer.');
});
