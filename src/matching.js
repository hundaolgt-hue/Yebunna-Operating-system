// Matching what the founder or the CEO wrote to work that already exists, so a change edits
// the task it is about and repeat work never becomes a second task or mission.
import { state } from './store.js';

const STOP = new Set('the and for with this that from into your our you are was were will make made write build create new more less some all any can could should would please also just then than them they their there here about after before over under very really a an of to in on at by is it be as or do'.split(' '));

/** The meaningful words of a text (lower case, no stop words). */
export function words(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** How much two texts are about the same thing: shared words over the shorter text (0–1). */
export function overlap(a, b, minShared = 1) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared < minShared ? 0 : shared / Math.min(A.size, B.size);
}

const tasksOf = (m) => m.taskIds.map((id) => state.tasks[id]).filter(Boolean);

/**
 * Find the task a reference means: its id, its key, "T2" / "2" (position in the mission),
 * or its title (exact or close). Searches one mission, or all live missions.
 */
export function resolveTask(ref, mission = null) {
  if (!ref) return null;
  const r = String(ref).trim();
  if (state.tasks[r] && (!mission || state.tasks[r].missionId === mission.id)) return state.tasks[r];
  const missions = mission ? [mission] : Object.values(state.missions).filter((m) => m.status !== 'cancelled');
  const n = r.match(/^(?:t(?:ask)?\s*#?\s*)?(\d{1,2})$/i);
  for (const m of missions) {
    const ts = tasksOf(m);
    if (n && mission) return ts[Number(n[1]) - 1] || null;
    const hit = ts.find((t) => t.key === r || t.title.toLowerCase() === r.toLowerCase());
    if (hit) return hit;
  }
  let best = null;
  let score = 0.6;
  for (const m of missions) {
    for (const t of tasksOf(m)) {
      const s = overlap(r, t.title);
      if (s > score) [best, score] = [t, s];
    }
  }
  return best;
}

/** An existing task in this mission that already covers a proposed one (same owner, same work). */
export function duplicateTask(mission, spec, agentId) {
  return (
    tasksOf(mission).find(
      (t) => t.status !== 'failed' && t.agentId === agentId && overlap(`${spec.title} ${spec.deliverable || ''}`, `${t.title} ${t.deliverable || ''}`) >= 0.5,
    ) || null
  );
}

// Words in product names that say what kind of thing it is, not which product it is.
const GENERIC = new Set('template templates excel sheet sheets spreadsheet google workbook model calculator tracker planner budget cost costs construction project projects business pro plus lite kit pack bundle tool tools app system dashboard ethiopia ethiopian amharic product products'.split(' '));

/**
 * The live (or recently finished) mission a new goal is about: its product's distinctive name
 * (e.g. "ProfitCheck" in "ProfitCheck Pro") appears in the goal. Saying "new product" opts out.
 */
export function missionFor(goal) {
  if (/\b(new|another|next|different|second)\s+(product|template|idea)\b/i.test(goal)) return null;
  const goalWords = words(goal);
  const live = Object.values(state.missions).filter(
    (m) => ['planning', 'running', 'reporting', 'awaiting_approval', 'failed'].includes(m.status) || (m.status === 'done' && Date.now() - Date.parse(m.completedAt || 0) < 14 * 864e5),
  );
  return (
    live
      .filter((m) => m.product)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .find((m) => [...words(m.product)].some((w) => !GENERIC.has(w) && w.length >= 4 && goalWords.has(w))) || null
  );
}
