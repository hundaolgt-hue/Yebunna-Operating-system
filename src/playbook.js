// The team playbook: rules learned from past missions. The morning retrospective adds
// "do" rules for what worked and "don't" rules for what went wrong, and retires rules
// that no longer help. Every bot gets the playbook in its instructions, so lessons
// carry into every future mission. The founder can add or delete rules by hand.
import { state, save, newId, now } from './store.js';
import { bus } from './bus.js';

const MAX_RULES = 30;
const rules = () => (state.rules ||= []);
const emit = () => {
  save();
  bus.emit('event', { type: 'rules', rules: rules() });
};

export function addRule({ type = 'do', text, why = '', source = 'founder' }) {
  const clean = String(text || '').trim().replace(/^(do|don'?t)\s*:\s*/i, '').slice(0, 300);
  if (!clean) throw new Error('Write the rule.');
  // Skip near-duplicates.
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (rules().some((r) => r.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key)) return null;
  const rule = { id: newId('rule'), type: type === 'dont' ? 'dont' : 'do', text: clean, why: String(why).slice(0, 300), source, at: now() };
  rules().push(rule);
  // Over the cap: drop the oldest retrospective rules first; the founder's rules and corrections stay.
  while (rules().length > MAX_RULES) {
    const i = rules().findIndex((r) => r.source !== 'founder' && r.source !== 'correction');
    rules().splice(i >= 0 ? i : 0, 1);
  }
  emit();
  return rule;
}

export function removeRule(id) {
  const before = rules().length;
  state.rules = rules().filter((r) => r.id !== id);
  if (state.rules.length !== before) emit();
}

export const listRules = () => rules();

/** The playbook as it goes into every bot's instructions. */
export function playbookPrompt(agentId = null) {
  // Lessons from the founder's corrections of the CEO are for the CEO alone.
  const mine = rules().filter((r) => r.source !== 'correction' || agentId === 'ceo');
  if (!mine.length) return '';
  const dos = mine.filter((r) => r.type === 'do');
  const donts = mine.filter((r) => r.type === 'dont');
  const lessons = mine.filter((r) => r.source === 'correction');
  return `\nTEAM PLAYBOOK — rules learned from past missions. Follow them in every task:
${dos.map((r) => `- DO: ${r.text}`).join('\n')}${dos.length && donts.length ? '\n' : ''}${donts.filter((r) => r.source !== 'correction').map((r) => `- DON'T: ${r.text}`).join('\n')}${
    lessons.length ? `\nLESSONS FROM THE FOUNDER'S CORRECTIONS (you got these wrong before; never again):\n${lessons.map((r) => `- DON'T: ${r.text}`).join('\n')}` : ''
  }\n`;
}
