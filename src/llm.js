// LLM access through your Claude subscription. Every agent turn is a headless
// Claude Code run (`claude -p`), which signs in with the Pro/Max account you
// logged into Claude Code with. No API key involved.
// If the CLI is not installed (or DEMO_MODE=1) an offline demo engine is used.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoStream } from './demo.js';
import { WORKSPACE, state } from './store.js';
import { connectionMcpServers, connectionRuntime } from './connections.js';
import { recordUsage } from './usage.js';
import { UsageLimitError, limited, hitLimit, parseReset } from './limits.js';

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

/** Run a Claude Code CLI command (e.g. `mcp list`) and return its output. */
export function runCli(args, timeoutMs = 30_000) {
  if (!BIN) return Promise.reject(new Error('Claude Code was not found on this computer (the app is in demo mode).'));
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, [...BIN_ARGS, ...args], { cwd: WORKSPACE, env: childEnv, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', () => (clearTimeout(timer), resolve(out)));
  });
}

/** Why Claude Code could not be started (empty when it was found). */
export function detectionReport() {
  return tried;
}


// Strip API credentials so the CLI uses the subscription login, not API billing.
const childEnv = { ...process.env, MCP_TIMEOUT: process.env.MCP_TIMEOUT || '90000' };
delete childEnv.ANTHROPIC_API_KEY;
delete childEnv.ANTHROPIC_AUTH_TOKEN;

// ---- computer use: a real browser per bot (Playwright MCP) ------------------------
const BROWSER_PKG = '@playwright/mcp@0.0.83';
const BROWSER_DIR = path.join(WORKSPACE, '.browser');
const profilesInUse = new Set();
const npx = (args) => (process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args });

/**
 * Write the MCP config for this run: a browser (computer use) and/or connected services
 * such as GitHub. Each bot has its own persistent browser profile (so sites it was
 * logged into stay logged in); if that profile is already open in another run, this run
 * gets a throwaway in-memory profile instead. Secrets are referenced as ${ENV} and never
 * written to the file.
 */
function mcpConfig(agentId = 'shared', tools = []) {
  const servers = connectionMcpServers(tools);
  if (!tools.includes('mcp__browser')) {
    if (!Object.keys(servers).length) return null;
    fs.mkdirSync(BROWSER_DIR, { recursive: true });
    const file = path.join(BROWSER_DIR, `mcp-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    return { file, release: () => fs.rm(file, { force: true }, () => {}) };
  }
  const profile = path.join(BROWSER_DIR, 'profiles', agentId);
  const exclusive = !profilesInUse.has(profile);
  const args = ['-y', BROWSER_PKG, '--browser', state.settings.browser || 'chrome', '--output-dir', path.join(BROWSER_DIR, 'output')];
  if (exclusive) {
    fs.mkdirSync(profile, { recursive: true });
    profilesInUse.add(profile);
    args.push('--user-data-dir', profile);
  } else {
    args.push('--isolated');
  }
  if (state.settings.browserHeadless) args.push('--headless');
  if (process.env.BROWSER_EXECUTABLE) args.push('--executable-path', process.env.BROWSER_EXECUTABLE);
  if (process.env.BROWSER_EXTRA_ARGS) args.push(...process.env.BROWSER_EXTRA_ARGS.split(' ').filter(Boolean));
  fs.mkdirSync(BROWSER_DIR, { recursive: true });
  const file = path.join(BROWSER_DIR, `mcp-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { ...servers, browser: npx(args) } }));
  return {
    file,
    release() {
      if (exclusive) profilesInUse.delete(profile);
      fs.rm(file, { force: true }, () => {});
    },
  };
}

/** Download the browser tool ahead of time so the first computer-use task starts fast. */
export function warmBrowser() {
  if (demoMode) return;
  const { command, args } = npx(['-y', BROWSER_PKG, '--version']);
  const p = spawn(command, args, { stdio: 'ignore', windowsHide: true, cwd: WORKSPACE });
  p.on('error', () => {});
}

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

// ---- run limits --------------------------------------------------------------------
// Several missions, chats and meetings can be live at once; cap the number of Claude
// Code processes so a subscription is not rate-limited into failures.
const MAX_RUNS = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS || 4));
const RUN_TIMEOUT_MS = Math.max(1, Number(process.env.RUN_TIMEOUT_MINUTES || 45)) * 60_000;
// The founder never waits behind the team: chats get one extra, reserved slot and go to
// the front of the queue, so the CEO answers even while every bot is busy.
let running = 0;
const waiting = [];
export const runStats = () => ({ running, waiting: waiting.length, max: MAX_RUNS });
export const _slots = { acquire: (...a) => acquire(...a), release: () => releaseSlot() }; // for tests
async function acquire(signal, priority = false) {
  if (running < MAX_RUNS + (priority ? 1 : 0)) return void running++;
  await new Promise((resolve, reject) => {
    const entry = { resolve, priority };
    if (priority) waiting.splice(waiting.filter((w) => w.priority).length, 0, entry);
    else waiting.push(entry);
    signal?.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(new Error('aborted'));
    });
  });
}
function releaseSlot() {
  // Hand the slot straight over — but a normal run may only take it if that keeps
  // normal work within MAX_RUNS (the extra slot is for the founder's chats).
  const next = waiting[0];
  if (next && (next.priority || running - 1 < MAX_RUNS)) {
    waiting.shift();
    next.resolve();
  } else running--;
}

/** Thrown when a run used up its step budget; carries whatever it had written. */
export class OutOfStepsError extends Error {
  constructor(partial) {
    super('ran out of steps before finishing');
    this.code = 'max_turns';
    this.partial = partial;
  }
}

/**
 * Stream a Claude response. Yields events:
 *   { type: 'text', text }       answer text (streamed live)
 *   { type: 'reasoning', text }  thinking and tool use ("[using Write]")
 *   { type: 'turn' }             the bot finished one step and is continuing after tool use —
 *                                text streamed so far was "working out loud", not the answer
 *
 * effort:  'low' | 'medium' | 'high' | 'xhigh' | 'max' — how hard the agent thinks.
 * tools:   Claude Code tools the agent may use, e.g. ['Read', 'Write', 'Bash', 'mcp__browser'].
 * model:   optional model alias for this call (e.g. 'haiku' for cheap housekeeping).
 * agentId: which bot is running — picks its own browser profile for computer use.
 * demo:    function returning the scripted answer used in offline demo mode.
 */
// Usage modes: which model, effort and step budget each kind of work gets.
//   quality  — everything on your Claude Code default model (usually the biggest).
//   balanced — the big model only for planning and large tasks; Sonnet for normal work,
//              Haiku for yes/no reviews and notes. Small tasks get a small step budget.
//   economy  — no big model at all.
// [model, effort, steps]; null model = your default; steps scale up for computer use.
const PROFILES = {
  balanced: {
    task: { small: ['sonnet', 'low', 40], medium: ['sonnet', 'medium', 80], large: [null, 'high', 100] },
    plan: [null, 'high'],
    report: ['sonnet', 'medium'],
    chat: ['sonnet', 'medium'],
    meeting: ['sonnet', 'low'],
    skill: ['sonnet', 'medium'],
    review: ['haiku', 'low'],
    memory: ['haiku', 'low'],
  },
  economy: {
    task: { small: ['haiku', 'low', 30], medium: ['sonnet', 'low', 50], large: ['sonnet', 'medium', 60] },
    plan: ['sonnet', 'medium'],
    report: ['haiku', 'low'],
    chat: ['sonnet', 'low'],
    meeting: ['haiku', 'low'],
    skill: ['sonnet', 'low'],
    review: ['haiku', 'low'],
    memory: ['haiku', 'low'],
  },
};
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
export const usageMode = () => state.settings.usageMode || (state.settings.economy ? 'economy' : 'balanced');

export function pick(kind, model, effort, maxTurns, size = 'medium') {
  const profile = PROFILES[usageMode()];
  if (!profile) return { model: model || (kind === 'task' && size === 'large' && state.settings.opusForLarge ? 'opus' : MODEL), effort, maxTurns };
  // "Opus for large tasks": heavy work gets Opus at full effort whatever the mode.
  if (kind === 'task' && size === 'large' && state.settings.opusForLarge) return { model: model || 'opus', effort, maxTurns };
  const p = kind === 'task' ? profile.task[size] || profile.task.medium : profile[kind];
  if (!p) return { model: model || MODEL, effort, maxTurns };
  const [m, e, steps] = p;
  return {
    model: model || m || MODEL,
    // Never raise effort above what the caller asked for.
    effort: EFFORT[Math.min(EFFORT.indexOf(effort), EFFORT.indexOf(e))] || e,
    maxTurns: steps ? Math.round((steps * maxTurns) / 100) : maxTurns,
  };
}

export async function* streamChat({ system, messages, effort = 'medium', tools = [], model, maxTurns = 100, agentId, kind = 'other', size, signal, demo }) {
  ({ model, effort, maxTurns } = pick(kind, model, effort, maxTurns, size));
  if (demoMode) {
    yield* demoStream(demo ? demo() : 'Demo mode: install Claude Code and log in to run the team on Claude.', signal);
    return;
  }

  // Paused on the plan's usage limit: don't spend a run finding that out again.
  if (limited()) throw new UsageLimitError(state.limit.kind === 'disk' ? 'Paused: the disk is almost full. Free some space and work resumes by itself.' : `Paused until your Claude usage limit resets (${new Date(state.limit.resetAt).toLocaleString()}).`, state.limit.resetAt);
  await acquire(signal, kind === 'chat');
  if (limited()) {
    releaseSlot();
    throw new UsageLimitError('Paused until your Claude usage limit resets.', state.limit.resetAt);
  }
  // Instructions go in a file: Windows caps a command line at ~32k characters.
  const promptFile = path.join(os.tmpdir(), `yebunna-sys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(promptFile, system);
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--setting-sources', '',
    '--system-prompt-file', promptFile,
    '--effort', effort,
    '--tools', tools.filter((t) => !t.startsWith('mcp__')).join(','),
    '--max-turns', String(maxTurns),
  ];
  if (tools.length) args.push('--allowedTools', ...tools);
  if (model) args.push('--model', model);
  let browser = null;
  let child;
  try {
    browser = mcpConfig(agentId, tools);
    if (browser) args.push('--mcp-config', browser.file, '--strict-mcp-config');
    // Connected accounts: tokens go in this run's environment only; synced folders are added.
    const conn = agentId ? connectionRuntime(agentId) : { env: {}, addDirs: [] };
    for (const dir of conn.addDirs) args.push('--add-dir', dir);
    child = spawn(BIN, [...BIN_ARGS, ...args], { cwd: WORKSPACE, env: { ...childEnv, ...conn.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    browser?.release();
    fs.rm(promptFile, { force: true }, () => {});
    releaseSlot();
    throw e;
  }
  let timedOut = false;
  const kill = () => child.kill('SIGTERM');
  const timer = setTimeout(() => ((timedOut = true), kill()), RUN_TIMEOUT_MS);
  signal?.addEventListener('abort', kill, { once: true });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(toPrompt(messages));

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('close', resolve));

  let result = null;
  let buf = '';
  let turns = 0;
  let lastText = '';
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
        if (msg.type !== 'stream_event' || msg.parent_tool_use_id) continue;
        const ev = msg.event;
        if (ev.type === 'message_start') {
          if (turns++ > 0) {
            lastText = '';
            yield { type: 'turn' };
          }
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          yield { type: 'reasoning', text: `\n[using ${ev.content_block.name}]\n` };
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'thinking_delta') yield { type: 'reasoning', text: ev.delta.thinking };
          else if (ev.delta.type === 'text_delta') {
            lastText += ev.delta.text;
            yield { type: 'text', text: ev.delta.text };
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
    browser?.release();
    fs.rm(promptFile, { force: true }, () => {});
    releaseSlot();
  }

  const code = await exited;
  if (result) recordUsage({ agentId, kind, model: mainModel(result.modelUsage) || model || MODEL || 'default', usage: result.usage, cost: result.total_cost_usd, turns: result.num_turns });
  if (signal?.aborted) throw new Error('aborted');
  if (timedOut) throw new Error(`timed out after ${RUN_TIMEOUT_MS / 60_000} minutes`);
  if (result?.subtype === 'error_max_turns') throw new OutOfStepsError(lastText);
  // Sometimes the limit notice comes back as the "answer" instead of an error.
  if (!result?.is_error && /^(claude ai usage limit reached|you've hit your limit|\d+-hour limit reached)/i.test(String(result?.result || lastText).trim())) {
    result = { ...result, is_error: true, result: result?.result || lastText };
  }
  if (result?.is_error || (code !== 0 && !result)) {
    const why = String(result?.result || stderr.trim() || `claude exited with code ${code}`);
    if (/not logged in|please run \/login|invalid api key|authentication_error|oauth token|\/login/i.test(why)) {
      throw new Error('Claude Code is not logged in. In cmd run `claude`, type /login, choose your Claude account (Pro/Max subscription), finish in the browser, type /exit, then try again.');
    }
    const all = `${why}\n${lastText}\n${stderr}`;
    if (/usage limit|limit reached|hit your limit|limit will reset|resets? \d/i.test(all)) {
      const resetAt = parseReset(all);
      hitLimit(why, resetAt);
      throw new UsageLimitError(`Your Claude usage limit was reached — work pauses and resumes automatically${resetAt ? ` at ${new Date(resetAt).toLocaleString()}` : ''}.`, resetAt);
    }
    if (/rate limit|overloaded|429|529/i.test(why)) {
      throw new Error(`Claude is busy right now (rate limited) — try again in a few minutes. (${why.slice(0, 200)})`);
    }
    throw new Error(`Claude Code: ${why.slice(0, 400)}`);
  }
}

/**
 * Run a completion to the end, forwarding stream events. Returns the bot's final
 * answer — the text of its last step, not the "working out loud" before tool calls.
 */
/** The model that did most of a run's writing (Claude Code may also use a small one for housekeeping). */
function mainModel(usage = {}) {
  return Object.entries(usage).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0]?.[0];
}

export async function complete(opts, onEvent) {
  let text = '';
  for await (const ev of streamChat(opts)) {
    onEvent?.(ev);
    if (ev.type === 'turn') text = '';
    else if (ev.type === 'text') text += ev.text;
  }
  return text;
}

/** Pull a JSON object out of a model reply (tolerates code fences, chatter and stray braces). */
export function extractJson(text) {
  const candidates = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).concat(String(text));
  for (const src of candidates) {
    const end = src.lastIndexOf('}');
    for (let start = src.indexOf('{'); start >= 0 && start < end; start = src.indexOf('{', start + 1)) {
      try {
        const value = JSON.parse(src.slice(start, end + 1));
        if (value && typeof value === 'object') return value;
      } catch {
        // try the next opening brace
      }
    }
  }
  throw new Error('No JSON object in model reply');
}
