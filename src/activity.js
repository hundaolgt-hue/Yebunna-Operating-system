// Live activity feed: what every bot is doing right now (tasks, tool use, chats,
// meetings, skills, routines), shown on the task board and each bot's page.
import { bus } from './bus.js';
import { state, save, newId, now } from './store.js';

const MAX = 400;

export function logActivity(agentId, text, ref = null) {
  const item = { id: newId('act'), at: now(), agentId, text: String(text).slice(0, 240), ref };
  (state.activity ||= []).push(item);
  if (state.activity.length > MAX) state.activity.splice(0, state.activity.length - MAX);
  save();
  bus.emit('event', { type: 'activity', item });
  return item;
}

const TOOL_LABEL = {
  Read: 'reading files',
  Write: 'writing a file',
  Edit: 'editing a file',
  Glob: 'looking through files',
  Grep: 'searching files',
  Bash: 'running a command',
  WebSearch: 'searching the web',
  WebFetch: 'reading a web page',
};

/** Turn "[using X]" tool markers into readable activity, without repeating the same tool. */
export function toolTracker(agentId, ref) {
  let last = '';
  return (text) => {
    const m = String(text).match(/\[using ([^\]]+)\]/);
    if (!m || m[1] === last) return;
    last = m[1];
    const label = TOOL_LABEL[m[1]] || (m[1].startsWith('mcp__browser__') ? `using the browser (${m[1].replace('mcp__browser__browser_', '').replace(/_/g, ' ')})` : `using ${m[1]}`);
    logActivity(agentId, label, ref);
  };
}
