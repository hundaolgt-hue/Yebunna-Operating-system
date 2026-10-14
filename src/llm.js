// LLM access through your Claude subscription. Every agent turn is a headless
// Claude Code run (`claude -p`), which signs in with the Pro/Max account you
// logged into Claude Code with. No API key involved.
// If the CLI is not installed (or DEMO_MODE=1) an offline demo engine is used.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoStream } from './demo.js';

const MODEL = process.env.CLAUDE_MODEL || '';

/**
 * Find how to launch Claude Code: [command, leadingArgs].
 * On Windows an npm install is a `claude.cmd` shim, which Node cannot spawn
 * without a shell, so we run its cli.js with Node directly instead.
 */
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return [process.env.CLAUDE_BIN, []];
  if (process.platform !== 'win32') return ['claude', []];
  const found = spawnSync('where', ['claude'], { encoding: 'utf8' }).stdout?.split(/\r?\n/).filter(Boolean) || [];
  const exe = found.find((p) => p.toLowerCase().endsWith('.exe'));
  if (exe) return [exe, []];
  for (const shim of found) {
    const pkg = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
    for (const entry of ['cli.js', 'cli.mjs']) {
      if (fs.existsSync(path.join(pkg, entry))) return [process.execPath, [path.join(pkg, entry)]];
    }
  }
  return ['claude.exe', []];
}

const [BIN, BIN_ARGS] = resolveClaude();
const cliVersion = (() => {
  const r = spawnSync(BIN, [...BIN_ARGS, '--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();
const demoMode = process.env.DEMO_MODE === '1' || !cliVersion;

// Agents run in an empty folder so they don't pick up any project's CLAUDE.md.
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yebunna-agent-'));

// Strip API credentials so the CLI uses the subscription login, not API billing.
const childEnv = { ...process.env };
delete childEnv.ANTHROPIC_API_KEY;
delete childEnv.ANTHROPIC_AUTH_TOKEN;

export function providerInfo() {
  return demoMode
    ? { name: 'demo', label: 'Demo', model: 'offline-demo' }
    : { name: 'claude', label: 'Claude', model: MODEL || 'default', cli: cliVersion };
}

/** Flatten a chat history into one prompt for a single headless run. */
function toPrompt(messages) {
  if (messages.length === 1) return messages[0].content;
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'Founder' : 'You'}: ${m.content}`)
    .join('\n\n');
  return `Conversation so far:\n\n${history}\n\nFounder: ${messages.at(-1).content}`;
}

/**
 * Stream a Claude response. Yields `{ type: 'reasoning' | 'text', text }` events.
 *
 * effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' — how hard the agent thinks.
 * tools:  Claude Code tools the agent may use, e.g. ['WebSearch', 'WebFetch'].
 * demo:   function returning the scripted answer used in offline demo mode.
 */
export async function* streamChat({ system, messages, effort = 'medium', tools = [], signal, demo }) {
  if (demoMode) {
    yield* demoStream(demo ? demo() : 'Demo mode: install Claude Code and log in to run the team on Claude.', signal);
    return;
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--setting-sources', '',
    '--system-prompt', system,
    '--effort', effort,
    '--tools', tools.join(','),
  ];
  if (tools.length) args.push('--allowedTools', ...tools, '--max-turns', '12');
  if (MODEL) args.push('--model', MODEL);

  const child = spawn(BIN, [...BIN_ARGS, ...args], { cwd: WORKDIR, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const kill = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', kill, { once: true });
  child.stdin.end(toPrompt(messages));

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('close', resolve));

  let result = null;
  let buf = '';
  try {
    for await (const chunk of child.stdout) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'result') {
          result = msg;
          continue;
        }
        if (msg.type !== 'stream_event') continue;
        const ev = msg.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          yield { type: 'reasoning', text: `\n[using ${ev.content_block.name}]\n` };
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'thinking_delta') yield { type: 'reasoning', text: ev.delta.thinking };
          else if (ev.delta.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', kill);
  }

  const code = await exited;
  if (signal?.aborted) throw new Error('aborted');
  if (result?.is_error || (code !== 0 && !result)) {
    const why = result?.result || stderr.trim() || `claude exited with code ${code}`;
    throw new Error(`Claude Code: ${why.slice(0, 400)}`);
  }
}

/** Run a completion to the end, forwarding stream events, and return the text. */
export async function complete(opts, onEvent) {
  let text = '';
  for await (const ev of streamChat(opts)) {
    onEvent?.(ev);
    if (ev.type === 'text') text += ev.text;
  }
  return text;
}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model reply');
  return JSON.parse(src.slice(start, end + 1));
}
