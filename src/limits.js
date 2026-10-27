// Claude plan usage limits. When a run hits the limit, the whole company pauses:
// nothing new is started (so no runs are wasted bumping into the limit), interrupted
// work goes back in the queue, and ONE timer wakes everything up when the limit resets.
// If Claude Code didn't say when that is, we try again every CHECK_HOURS.
//
// API fallback (optional, Settings → Usage): instead of pausing, the team switches to the
// founder's Anthropic API key until the plan resets, then back to the subscription. A daily
// spending cap stops it; past the cap the team pauses as usual.
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

/** Why the team is paused, in plain words, with the exact text that caused it. */
export function pauseReason() {
  const l = state.limit;
  if (!l) return null;
  const until = new Date(l.resetAt).toLocaleString();
  if (l.kind === 'disk') return `Paused because the disk is almost full (${l.message}). It resumes by itself when there is room: Settings → Storage shows what uses space.`;
  if (/^API key:|Daily API cap/.test(l.message || '')) return `Paused: ${l.message}. It resumes at ${until}, or click Try now.`;
  return `Paused on Claude's usage limit until ${until}. Claude Code said: “${String(l.message || '').slice(0, 160)}”. If your plan isn't limited, click Try now — the app also checks by itself a few minutes after a pause.`;
}

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

// ---- API fallback -------------------------------------------------------------------

const fallback = () => state.apiFallback || {};
const today = () => new Date().toISOString().slice(0, 10);
/** API money spent today (USD, as Claude Code reports it). */
export const apiSpentToday = () => (state.apiSpend?.day === today() ? state.apiSpend.usd : 0);
const underCap = () => apiSpentToday() < Number(fallback().dailyCapUsd || 10);
/**
 * How runs are billed (Settings → Billing):
 *   plan — the Claude subscription; at its limit the team pauses until it resets.
 *   auto — the subscription, with the API key as a fallback while the plan's limit is hit.
 *   api  — every run on the API key; the subscription is never used.
 */
export const billingMode = () => (fallback().mode === 'api' || fallback().mode === 'plan' ? fallback().mode : fallback().enabled ? 'auto' : 'plan');
const canUseApi = () => Boolean(billingMode() === 'auto' && fallback().key && underCap());
/** Are runs billed to the API key right now? */
export const onApi = () => billingMode() === 'api' ? Boolean(fallback().key) : Boolean(state.apiMode);
let apiTimer = null;

/** The plan's limit was hit: carry on with the API key until the plan resets. */
function enterApi(resetAt, message) {
  const back = resetAt && Date.parse(resetAt) > Date.now() ? resetAt : new Date(Date.now() + CHECK_HOURS * 36e5).toISOString();
  state.apiMode = { since: now(), backAt: back, known: Boolean(resetAt), message: String(message).slice(0, 300) };
  save();
  armApi();
  bus.emit('event', { type: 'limit', limit: null, apiMode: state.apiMode });
  bus.emit('api.on', state.apiMode);
  // The run that hit the limit went back in the queue: start the team again, now on the API.
  setTimeout(() => bus.emit('limit.reset', { reason: 'switched to the API key' }), 1500);
}

/** Back to the subscription (the plan has reset, or the API can't be used any more). */
export function leaveApi(reason = 'plan reset') {
  if (!state.apiMode) return;
  state.apiMode = null;
  clearTimeout(apiTimer);
  save();
  bus.emit('event', { type: 'limit', limit: state.limit, apiMode: null });
  bus.emit('api.off', { reason });
}

function armApi() {
  clearTimeout(apiTimer);
  if (!state.apiMode) return;
  const ms = Math.max(5_000, Date.parse(state.apiMode.backAt) + (state.apiMode.known ? GRACE_MS : 0) - Date.now());
  // At the reset the next run tries the subscription again; if it is still limited, it switches back.
  apiTimer = setTimeout(() => leaveApi('plan reset'), Math.min(ms, 2 ** 31 - 1));
  apiTimer.unref?.();
}

/** Count what an API-billed run cost; past the daily cap, stop using the API. */
export function recordApiCost(usd) {
  const day = today();
  state.apiSpend = state.apiSpend?.day === day ? state.apiSpend : { day, usd: 0 };
  state.apiSpend.usd += Number(usd) || 0;
  save();
  if (billingMode() === 'api' && !underCap() && !state.limit) {
    // API only: past the cap, wait for tomorrow (UTC) — the plan is never used.
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 30, 0);
    hitLimit(`Daily API cap of $${fallback().dailyCapUsd || 10} reached`, tomorrow.toISOString(), 'usage', { noApi: true });
  } else if (state.apiMode && !canUseApi()) {
    const backAt = state.apiMode.backAt;
    leaveApi('daily API cap reached');
    hitLimit(`Daily API cap of $${fallback().dailyCapUsd || 10} reached`, backAt, 'usage', { noApi: true });
  }
}

/** The API key can't be used (no credit, revoked): pause like a normal limit. */
export function apiFailed(message) {
  const backAt = state.apiMode?.backAt;
  leaveApi('API key failed');
  // API only: nothing else to fall back to; try again in an hour (or when the founder fixes the key).
  hitLimit(`API key: ${message}`, backAt || (billingMode() === 'api' ? new Date(Date.now() + 3600e3).toISOString() : null), 'usage', { noApi: true });
}

/**
 * The fallback was just turned on (or the app started) while paused on the plan's limit:
 * switch to the API key now instead of waiting for the reset.
 */
export function useApiIfPaused() {
  if (!state.limit || state.limit.kind !== 'usage' || state.apiMode || !canUseApi()) return false;
  const { resetAt, known, message } = state.limit;
  state.limit = null;
  clearTimeout(timer);
  enterApi(known ? resetAt : null, message);
  return true;
}

/** A run hit the limit: switch to the API key if allowed, otherwise pause everything until it resets. */
export function hitLimit(message, resetAt, kind = 'usage', { noApi = false } = {}) {
  if (kind === 'usage' && !noApi && !state.apiMode && canUseApi()) return enterApi(resetAt, message);
  if (state.apiMode && kind === 'usage' && !noApi) return; // already on the API: this was a stray subscription run
  const wake = resetAt && Date.parse(resetAt) > Date.now() ? resetAt : new Date(Date.now() + CHECK_HOURS * 36e5).toISOString();
  const already = state.limit;
  state.limit = { since: already?.since || now(), resetAt: wake, known: Boolean(resetAt), message: String(message).slice(0, 300), kind };
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
setTimeout(() => {
  if (useApiIfPaused()) return;
  if (state.limit) arm();
  if (state.apiMode) armApi();
}, 0);
