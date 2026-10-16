// Usage meter: every Claude Code run reports its tokens and its API-equivalent cost.
// On a subscription nothing is billed per token, but these numbers show which bots and
// which kinds of work use up the plan's limits fastest.
import { state, save } from './store.js';
import { bus } from './bus.js';

const KEEP_DAYS = 14;
let pending = null;

export function recordUsage({ agentId = 'system', kind = 'other', model = 'default', usage = {}, cost = 0, turns = 0 }) {
  const day = new Date().toISOString().slice(0, 10);
  const days = ((state.usage ||= {}).days ||= {});
  const d = (days[day] ||= { runs: 0, input: 0, output: 0, cached: 0, cost: 0, turns: 0, byBot: {}, byKind: {}, byModel: {} });
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const cached = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const add = (o) => {
    o.runs = (o.runs || 0) + 1;
    o.input = (o.input || 0) + input;
    o.cached = (o.cached || 0) + cached;
    o.output = (o.output || 0) + output;
    o.cost = (o.cost || 0) + (cost || 0);
    o.turns = (o.turns || 0) + (turns || 0);
  };
  add(d);
  add((d.byBot[agentId] ||= {}));
  add((d.byKind[kind] ||= {}));
  add(((d.byModel ||= {})[model] ||= {}));
  for (const k of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[k];
  save();
  // Batch UI updates: at most one every 2 seconds.
  if (!pending) pending = setTimeout(() => ((pending = null), bus.emit('event', { type: 'usage', usage: state.usage })), 2000);
}
