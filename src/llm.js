// LLM access through your Claude subscription. Every agent turn is a headless
// Claude Code run (`claude -p`), which signs in with the Pro/Max account you
// logged into Claude Code with. No API key involved.
// If the CLI is not installed (or DEMO_MODE=1) an offline demo engine is used.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoStream } from './demo.js';
import { WORKSPACE } from './store.js';

const MODEL = process.env.CLAUDE_MODEL || '';

/**
 * Ways Claude Code might be launchable on this machine, as [command, leadingArgs].
 * On Windows an npm install is a `claude.cmd` shim, which Node cannot spawn
 * without a shell, so we target what the shim points at: the package's
 * bin/claude.exe (current releases) or cli.js run with Node (older releases).
 */
function candidates() {
  if (process.env.CLAUDE_BIN) return [[process.env.CLAUDE_BIN, []]];
  const home = os.homedir();
  if (process.platform !== 'win32') return [['claude', []], [path.join(home, '.local', 'bin', 'claude'), []]];

  const list = [];
  const found = spawnSync('where', ['claude'], { encoding: 'utf8' }).stdout?.split(/\r?\n/).filter(Boolean) || [];
  for (const p of found) if (p.toLowerCase().endsWith('.exe')) list.push([p, []]);
  const dirs = [...found.map((p) => path.dirname(p)), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')];
  for (const dir of new Set(dirs)) {
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    list.push([path.join(pkg, 'bin', 'claude.exe'), []]);
    for (const entry of ['cli.js', 'cli.mjs']) list.push([process.execPath, [path.join(pkg, entry)]]);
  }
  // The native installer puts claude.exe in ~/.local/bin, which may not be on PATH.
  list.push([path.join(home, '.local', 'bin', 'claude.exe'), []], ['claude.exe', []]);
  return list.filter(([cmd, args]) => !path.isAbsolute(args[0] || cmd) || fs.existsSync(args[0] || cmd));
}

const tried = [];
const [BIN, BIN_ARGS, cliVersion] = (() => {
  if (process.env.DEMO_MODE === '1') return [null, [], null];
  for (const [cmd, args] of candidates()) {
    const r = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return [cmd, args, r.stdout.trim()];
    tried.push(`${[cmd, ...args].join(' ')} → ${r.error?.code || r.error?.message || (r.stderr || '').trim().slice(0, 120) || `exit ${r.status}`}`);
  }
  return [null, [], null];
})();
const demoMode = !cliVersion;

/** Why Claude Code could not be started (empty when it was found). */
export function detectionReport() {
  return tried;
}


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
 * tools:  Claude Code tools the agent may use, e.g. ['Read', 'Write', 'WebSearch'].
 * model:  optional model alias for this call (e.g. 'haiku' for cheap housekeeping).
 * demo:   function returning the scripted answer used in offline demo mode.
 */
export async function* streamChat({ system, messages, effort = 'medium', tools = [], model, maxTurns = 25, signal, demo }) {
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
  if (tools.length) args.push('--allowedTools', ...tools, '--max-turns', String(maxTurns));
  if (model || MODEL) args.push('--model', model || MODEL);

  const child = spawn(BIN, [...BIN_ARGS, ...args], { cwd: WORKSPACE, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
