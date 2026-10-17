// Claude plan usage limits. When a run hits the limit, the whole company pauses:
// nothing new is started (so no runs are wasted bumping into the limit), interrupted
// work goes back in the queue, and ONE timer wakes everything up when the limit resets.
// If Claude Code didn't say when that is, we try again every CHECK_HOURS.
import { state, save, now } from './store.js';
import { bus } from './bus.js';

const CHECK_HOURS = Math.max(0.25, Number(process.env.LIMIT_CHECK_HOURS || 2));
const GRACE_MS = 90_000; // start a little after the reset, not exactly on it
let timer = null;

export class UsageLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.code = 'usage_limit';
    this.resetAt = resetAt;
  }
}
export const isLimitError = (e) => e?.code === 'usage_limit';

/** Is the company paused because of the plan's usage limit? */
export const limited = () => Boolean(state.limit);

/**
 * When does the limit reset? Claude Code says it in a few ways:
 *   "Claude AI usage limit reached|1760014800"           (unix time)
 *   "You've hit your limit · resets 3pm (Africa/Addis_Ababa)"
 *   "5-hour limit reached ∙ resets 10:30am"
 * Returns an ISO time, or null if there's no time in the message.
 */
export function parseReset(text, from = Date.now()) {
  const s = String(text || '');
  const epoch = s.match(/limit reached\|(\d{10,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const m = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (!m[3]) hour = Number(m[1]); // 24-hour clock
  else if (m[3].toLowerCase() === 'pm') hour += 12;
  const minute = Number(m[2] || 0);
  if (hour > 23 || minute > 59) return null;
  return nextClockTime(hour, minute, m[4], from);
}

/** The next moment after `from` when the clock in `timeZone` shows hour:minute. */
function nextClockTime(hour, minute, timeZone, from) {
  let offsetMin = 0; // minutes the zone is ahead of UTC
  if (timeZone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
          .formatToParts(new Date(from))
          .map((p) => [p.type, p.value]),
      );
      const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
      offsetMin = Math.round((asUtc - from) / 60_000);
    } catch {
      timeZone = null; // unknown zone: use this PC's clock
    }
  }
  if (!timeZone) offsetMin = -new Date(from).getTimezoneOffset();
  const local = new Date(from + offsetMin * 60_000); // wall clock in that zone, read with UTC getters
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - offsetMin * 60_000;
  if (t <= from) t += 864e5;
  return new Date(t).toISOString();
}

/** A run hit the limit: pause everything until it resets. */
export function hitLimit(message, resetAt) {
  const wake = resetAt && Date.parse(resetAt) > Date.now() ? resetAt : new Date(Date.now() + CHECK_HOURS * 36e5).toISOString();
  const already = state.limit;
  state.limit = { since: already?.since || now(), resetAt: wake, known: Boolean(resetAt), message: String(message).slice(0, 300) };
  save();
  arm();
  bus.emit('event', { type: 'limit', limit: state.limit });
  if (!already) bus.emit('limit.hit', state.limit);
}

function arm() {
  clearTimeout(timer);
  if (!state.limit) return;
  const ms = Math.max(5_000, Date.parse(state.limit.resetAt) + (state.limit.known ? GRACE_MS : 0) - Date.now());
  timer = setTimeout(resume, Math.min(ms, 2 ** 31 - 1));
  timer.unref?.();
}

/** Try again: clear the pause and let everyone pick their work back up. If the limit is
 *  still on, the first run hits it again and sets a new wake-up time. */
export function resume(reason = 'limit reset') {
  if (!state.limit) return;
  const was = state.limit;
  state.limit = null;
  clearTimeout(timer);
  save();
  bus.emit('event', { type: 'limit', limit: null });
  bus.emit('limit.reset', { reason, was });
}

// After a restart, keep waiting (or resume straight away if the reset already passed).
setTimeout(() => state.limit && arm(), 0);
