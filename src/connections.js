// Connections: give bots access to the founder's accounts — GitHub, Vercel, Meta
// (Facebook & Instagram), Higgsfield and Google Drive. Each connection has its own credentials
// (kept only on this PC, never sent to the browser UI) and a list of bots allowed to
// use it. At run time a bot gets the matching tools, environment variables, folders
// and instructions — and nothing for connections it isn't allowed to use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, save, now, WORKSPACE } from './store.js';

/** Copy the bots' helper scripts (tools/) into the workspace as .tools/, so every run can use them. */
export function seedTools() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
  const dst = path.join(WORKSPACE, '.tools');
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  } catch (e) {
    console.error('Could not copy the bot tools:', e.message);
  }
}

export const SERVICES = {
  github: {
    label: 'GitHub',
    icon: '🐙',
    bots: ['engineer', 'landing', 'ceo'],
    fields: [{ key: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_… or ghp_…' }],
    steps: [
      'Open github.com/settings/personal-access-tokens/new (fine-grained token).',
      'Name it "Yebunna OS", pick an expiry, and choose the repositories the bots may use.',
      'Repository permissions: Contents, Issues, Pull requests → Read and write. Metadata → Read.',
      'Click Generate token, copy it, paste it below.',
    ],
    link: 'https://github.com/settings/personal-access-tokens/new',
    uses: 'Read and change repositories, issues and pull requests (GitHub MCP tools), and git push over HTTPS.',
  },
  vercel: {
    label: 'Vercel',
    icon: '▲',
    bots: ['engineer', 'design', 'landing'],
    needsTerminal: true,
    fields: [
      { key: 'token', label: 'Access token', secret: true, placeholder: 'Vercel token' },
      { key: 'team', label: 'Team slug (optional)', placeholder: 'e.g. rapha' },
    ],
    steps: ['Open vercel.com/account/tokens.', 'Create a token named "Yebunna OS" with the scope of your team, copy it, paste it below.'],
    link: 'https://vercel.com/account/tokens',
    uses: 'Deploy sites and check deployments with the Vercel CLI (previews by default; production only when the task says so).',
  },
  meta: {
    label: 'Facebook & Instagram (Meta)',
    icon: 'ⓕ',
    bots: ['marketing', 'sales'],
    needsTerminal: true,
    fields: [
      { key: 'token', label: 'Access token', secret: true, placeholder: 'System-user or long-lived token' },
      { key: 'adAccountId', label: 'Ad account ID', placeholder: 'act_1234567890' },
      { key: 'pageId', label: 'Facebook Page ID (optional)', placeholder: '1234567890' },
      { key: 'igUserId', label: 'Instagram business account ID (optional)', placeholder: '1784…' },
    ],
    steps: [
      'Open business.facebook.com/settings → Users → System users → Add (role: Admin).',
      'Click "Assign assets" and give the SYSTEM USER (not yourself) your ad account (Manage campaigns) and Page. Do this BEFORE generating the token: a token never gains access given after it was made.',
      'Click "Generate new token", choose your app (create one at developers.facebook.com if needed; its type must allow the Marketing API) and tick: ads_read, ads_management, business_management, pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish.',
      'Copy the token and paste it below with your ad account ID (Ads Manager → account dropdown, starts with act_).',
    ],
    link: 'https://business.facebook.com/settings/system-users',
    uses: 'Read ad performance and insights, prepare campaigns and ads (created PAUSED), and draft or publish Page/Instagram posts only when a task says so.',
  },
  higgsfield: {
    label: 'Higgsfield (AI images & video)',
    icon: '🎬',
    bots: ['creative', 'design'],
    // No token: Higgsfield's MCP server signs in with OAuth. Claude Code keeps that login
    // and reuses it for bot runs, because they use the same server name and URL.
    fields: [],
    steps: [
      'Open a terminal and run:  claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp',
      'Run  claude , type  /mcp , pick "higgsfield" and choose Authenticate. A browser opens: sign in to Higgsfield and allow access. Then type  /exit .',
      'Pick which bots may use it below and click Save & test.',
    ],
    link: 'https://higgsfield.ai',
    uses: 'Generate images and videos (ads, product shots, reels, thumbnails) with Higgsfield. Uses your Higgsfield credits; nothing is bought or posted unless the task says so.',
  },
  telegram: {
    label: 'Telegram (alerts to you)',
    icon: '✈️',
    system: true, // used by the app itself to reach the founder, not by bots
    bots: [],
    fields: [
      { key: 'token', label: 'Bot token', secret: true, placeholder: '123456789:AA…' },
      { key: 'chatId', label: 'Your chat ID (optional — found automatically)', placeholder: 'filled in after the test' },
      { key: 'sttKey', label: 'Voice notes: Groq or OpenAI API key (optional)', secret: true, placeholder: 'gsk_… (free at console.groq.com) or sk-…' },
      { key: 'voiceLang', label: 'Voice note language: am, en or auto (optional)', placeholder: 'auto' },
    ],
    steps: [
      'In Telegram, open @BotFather, send /newbot, and pick a name and a username for your bot.',
      'BotFather replies with a token like 123456789:AA… — copy it and paste it below.',
      'Open your new bot in Telegram and press Start (or send it "hi"), so it is allowed to message you.',
      'Click Save & test. You get a test message, and your chat ID is filled in automatically.',
      'Voice notes (optional): create a free API key at console.groq.com → API Keys and paste it below. Or, without a key, install Python and run "pip install faster-whisper" (free, runs on this PC, slower).',
    ],
    link: 'https://t.me/BotFather',
    uses: 'Chat with the CEO by text or voice note: ask how things are going, give new work, comment on a mission, set rules. You also get a message when something only you can do is blocking a mission, when plans or deliverables need your OK, and when the usage limit pauses or resumes work.',
  },
  gdrive: {
    label: 'Google Drive',
    icon: '🗂',
    bots: ['*'],
    fields: [
      { key: 'path', label: 'Google Drive folder on this PC', placeholder: 'G:\\My Drive' },
      { key: 'outputs', label: 'Folder for the team\'s outputs inside it (optional)', placeholder: 'Yebunna OS' },
    ],
    steps: [
      'Install "Google Drive for desktop" (google.com/drive/download) and sign in with the Google account whose Drive should get the outputs.',
      'It adds a drive such as G:\\ — open it in File Explorer and copy the path of "My Drive" (e.g. G:\\My Drive).',
      'Paste the path below. Optionally name the outputs folder (default "Yebunna OS"); to use a folder someone shared with you, first add a shortcut to it in My Drive and give its name here.',
      'Click Save & test. From now on every approved deliverable is copied there: one folder per mission ("2026-10-19 Product name"), one numbered folder per task, files stamped with version and time. A new version replaces the old one.',
    ],
    link: 'https://www.google.com/drive/download/',
    uses: 'Every approved deliverable and mission report is copied to your Drive, organised by mission and task, version- and time-stamped, with old versions removed. Bots can also read your Drive files.',
  },
};

// Graph / Marketing API version. Unversioned calls fall back to the Meta app's own default,
// which the Ads API rejects once it is retired (error #2635), so always name one.
let metaVersion = process.env.META_API_VERSION || 'v26.0';
const graph = (p) => `https://graph.facebook.com/${metaVersion}/${p}`;

const conns = () => (state.connections ||= {});
const get = (id) => conns()[id] || { enabled: false, config: {}, bots: SERVICES[id].bots };

/** What the UI sees: everything except secret values. */
export function listConnections() {
  return Object.entries(SERVICES).map(([id, svc]) => {
    const c = get(id);
    const config = Object.fromEntries(svc.fields.map((f) => [f.key, f.secret ? (c.config?.[f.key] ? '••••••' + String(c.config[f.key]).slice(-4) : '') : c.config?.[f.key] || '']));
    return { id, label: svc.label, icon: svc.icon, fields: svc.fields, steps: svc.steps, link: svc.link, uses: svc.uses, needsTerminal: !!svc.needsTerminal, system: !!svc.system, enabled: !!c.enabled, bots: c.bots || svc.bots, config, status: c.status || null };
  });
}

export function saveConnection(id, { config = {}, bots, enabled }) {
  const svc = SERVICES[id];
  if (!svc) throw new Error('Unknown connection');
  const c = { ...get(id), config: { ...(get(id).config || {}) } }; // stored only once it checks out
  for (const f of svc.fields) {
    const v = config[f.key];
    if (v === undefined) continue;
    // Secret boxes are left empty to keep the saved value (Disconnect clears it).
    if (f.secret && (!String(v).trim() || String(v).startsWith('••••••'))) continue;
    c.config[f.key] = f.secret ? cleanToken(v) : String(v).trim().replace(/^["']+|["']+$/g, '').trim(); // Explorer's "Copy as path" adds quotes
  }
  if (id === 'telegram' && c.config.token && !/^\d+:[\w-]{30,}$/.test(c.config.token)) {
    throw new Error("That doesn't look like a Telegram bot token. It looks like 123456789:AA… — copy the whole line BotFather sent you.");
  }
  if (id === 'meta' && c.config.token && !/^EA[A-Za-z0-9]{20,}$/.test(c.config.token)) {
    throw new Error("That doesn't look like a Meta access token. They start with \"EAA\" and are one long line of letters and numbers. Copy it again from Business Settings → System users → Generate new token.");
  }
  conns()[id] = c;
  if (Array.isArray(bots)) c.bots = bots;
  if (enabled !== undefined) c.enabled = Boolean(enabled);
  else c.enabled = svc.fields.filter((f) => !f.label.includes('optional')).every((f) => c.config[f.key]);
  c.status = null;
  save();
  return listConnections().find((x) => x.id === id);
}

/** Tokens are often pasted with spaces, line breaks, quotes, "Bearer " or "access_token=". */
function cleanToken(v) {
  return String(v)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(bearer\s+|access_token=)/i, '')
    .replace(/\s+/g, '');
}

export function removeConnection(id) {
  delete conns()[id];
  save();
}

/** Check the credentials really work, and remember who they belong to. */
export async function testConnection(id) {
  const c = get(id);
  const cfg = c.config || {};
  let account;
  try {
    if (id === 'telegram') {
      const { testTelegram } = await import('./telegram.js');
      account = await testTelegram(c);
    } else if (id === 'higgsfield') {
      account = await checkHiggsfield();
    } else if (id === 'gdrive') {
      if (!cfg.path) throw new Error('No folder set');
      const st = fs.statSync(cfg.path);
      if (!st.isDirectory()) throw new Error('That path is not a folder');
      const out = outputsDir(cfg);
      fs.mkdirSync(out, { recursive: true });
      fs.accessSync(out, fs.constants.W_OK);
      account = `outputs go to ${out}`;
    } else {
      if (!cfg.token) throw new Error('No token saved');
      const call = async (url, headers = {}) => {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
          if (/cannot parse access token/i.test(msg)) throw new Error(`${msg}. The saved token is not a valid token — paste it again (one line, starting with EAA) and click Save & test.`);
          if (body?.error?.code === 190) throw new Error(`${msg}. The token has expired or was revoked — generate a new one.`);
          throw new Error(msg);
        }
        return body;
      };
      if (id === 'github') {
        const u = await call('https://api.github.com/user', { authorization: `Bearer ${cfg.token}`, 'user-agent': 'yebunna-os' });
        account = `@${u.login}`;
      } else if (id === 'vercel') {
        const u = await call(`https://api.vercel.com/v2/user`, { authorization: `Bearer ${cfg.token}` });
        account = u.user?.username || u.user?.email || 'connected';
      } else if (id === 'meta') {
        // If Meta says our version is deprecated, it names the latest one: switch and retry once.
        const metaCall = (p) =>
          call(graph(p)).catch((e) => {
            const latest = e.message.match(/latest version:?\s*(v\d+\.\d+)/i)?.[1];
            if (!latest || latest === metaVersion) throw e;
            metaVersion = latest;
            return call(graph(p));
          });
        const token = `access_token=${encodeURIComponent(cfg.token)}`;
        const me = await metaCall(`me?fields=id,name&${token}`);
        account = me.name || me.id;
        // What this token can do, and which ad accounts it can see: the usual cause of Meta's
        // error #200 is a token generated before the ad account was assigned, or without the
        // ads_management / ads_read boxes ticked.
        const scopes = await metaCall(`me/permissions?${token}`).then((r) => (r.data || []).filter((x) => x.status === 'granted').map((x) => x.permission)).catch(() => null);
        const visible = await metaCall(`me/adaccounts?fields=id,name&limit=100&${token}`).then((r) => r.data || []).catch(() => null);
        if (cfg.adAccountId) {
          const acct = cfg.adAccountId.startsWith('act_') ? cfg.adAccountId : `act_${cfg.adAccountId}`;
          try {
            const a = await metaCall(`${acct}?fields=name,account_status,currency&${token}`);
            account += ` · ad account “${a.name}” (${a.currency})`;
          } catch (e) {
            if (!/#200|ads_management|ads_read|permission/i.test(e.message)) throw e;
            const missing = scopes && !scopes.includes('ads_management') && !scopes.includes('ads_read');
            const seen = visible?.map((x) => x.id) || [];
            const hint = missing
              ? `This token has no ads permission at all (it has: ${scopes.join(', ') || 'none'}). Generate a NEW token for the system user and tick ads_management and ads_read before clicking Generate.`
              : visible && !seen.includes(acct)
                ? `The token has ads permission, but can't see ${acct}. It can see: ${visible.map((x) => `${x.id} (${x.name})`).join(', ') || 'no ad accounts'}. In Business Settings → Users → System users, pick this system user → Assign assets → Ad accounts → add ${acct} with Manage campaigns — then generate a NEW token (an old token never gains access given later).`
                : `Generate a NEW token for the system user (after assigning the ad account to it) with ads_management and ads_read ticked, and paste it here. Access given after a token was made does not reach that token.`;
            throw new Error(`${e.message} ${hint}`);
          }
        }
        if (scopes && !scopes.includes('ads_management') && !scopes.includes('ads_read')) throw new Error(`The token works but has no ads permission (it has: ${scopes.join(', ') || 'none'}). Generate a new one with ads_management and ads_read ticked.`);
        account += ` · API ${metaVersion}`;
      }
    }
    c.status = { ok: true, account, at: now() };
  } catch (e) {
    c.status = { ok: false, error: e.message, at: now() };
  }
  conns()[id] = c;
  save();
  return c.status;
}

export const HIGGSFIELD_URL = 'https://mcp.higgsfield.ai/mcp';

/** Ask Claude Code whether its higgsfield MCP server is added and logged in. */
async function checkHiggsfield() {
  const { runCli } = await import('./llm.js');
  const out = await runCli(['mcp', 'list'], 60_000);
  const line = out.split(/\r?\n/).find((l) => /^higgsfield:/i.test(l.trim()));
  if (!line) throw new Error('Claude Code has no "higgsfield" server yet — do step 1 first.');
  if (!line.includes(HIGGSFIELD_URL)) throw new Error(`The "higgsfield" server in Claude Code points elsewhere. Remove it (claude mcp remove higgsfield -s user) and do step 1 again.`);
  if (/✓|connected/i.test(line) && !/fail|auth/i.test(line)) return 'logged in via Claude Code';
  if (/auth/i.test(line)) throw new Error('Not logged in yet — do step 2 (/mcp → higgsfield → Authenticate).');
  throw new Error(`Claude Code can't reach Higgsfield: ${line.split(' - ').pop().trim()}`);
}

const allowed = (id, agentId) => {
  const c = conns()[id];
  if (!c?.enabled) return false;
  const bots = c.bots || SERVICES[id].bots;
  return bots.includes('*') || bots.includes(agentId);
};

/** Short names of the services a bot may use (for the CEO when it assigns work). */
export function connectedServices(agentId) {
  return Object.keys(SERVICES)
    .filter((id) => allowed(id, agentId))
    .map((id) => SERVICES[id].label.replace(/\s*\(.*\)$/, ''));
}

/** Extra tools a bot gets from its connections. */
export function connectionTools(agentId) {
  return [...(allowed('github', agentId) ? ['mcp__github'] : []), ...(allowed('higgsfield', agentId) ? ['mcp__higgsfield'] : [])];
}

/** MCP server definitions for connection tools (secrets come from env, never written to disk). */
export function connectionMcpServers(tools) {
  const servers = {};
  if (tools.includes('mcp__github')) {
    servers.github = { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${YEBUNNA_GITHUB_TOKEN}' } };
  }
  // Same name and URL as the founder's `claude mcp add`, so the stored Higgsfield login is reused.
  if (tools.includes('mcp__higgsfield')) servers.higgsfield = { type: 'http', url: HIGGSFIELD_URL };
  return servers;
}

/** Environment variables and folders a bot's run gets from its connections. */
export function connectionRuntime(agentId) {
  const env = {};
  const addDirs = [];
  const cfg = (id) => conns()[id]?.config || {};
  if (allowed('github', agentId)) {
    env.YEBUNNA_GITHUB_TOKEN = cfg('github').token;
    env.GH_TOKEN = cfg('github').token; // gh CLI, if installed
    env.GITHUB_TOKEN = cfg('github').token;
  }
  if (allowed('vercel', agentId)) {
    env.VERCEL_TOKEN = cfg('vercel').token;
    if (cfg('vercel').team) env.VERCEL_SCOPE = cfg('vercel').team;
  }
  if (allowed('meta', agentId)) {
    env.META_ACCESS_TOKEN = cfg('meta').token;
    env.META_API_VERSION = metaVersion;
    if (cfg('meta').adAccountId) env.META_AD_ACCOUNT_ID = cfg('meta').adAccountId.startsWith('act_') ? cfg('meta').adAccountId : `act_${cfg('meta').adAccountId}`;
    if (cfg('meta').pageId) env.META_PAGE_ID = cfg('meta').pageId;
    if (cfg('meta').igUserId) env.META_IG_USER_ID = cfg('meta').igUserId;
  }
  if (allowed('gdrive', agentId) && cfg('gdrive').path && fs.existsSync(cfg('gdrive').path)) addDirs.push(cfg('gdrive').path);
  return { env, addDirs };
}

let sampleCache = { at: 0, dir: null };
/**
 * The founder's "sample videos" folder in Google Drive (found by name, up to 3 folders deep;
 * re-checked every 10 minutes). Null when Drive isn't connected or the folder doesn't exist.
 */
export function sampleVideosDir() {
  const c = conns().gdrive;
  if (!c?.enabled || !c.config?.path || !fs.existsSync(c.config.path)) return null;
  if (Date.now() - sampleCache.at < 10 * 60_000) return sampleCache.dir;
  const want = /^sample[\s_-]*videos?$/i;
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && want.test(e.name.trim())) return void (found = path.join(dir, e.name));
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(c.config.path, 0);
  sampleCache = { at: Date.now(), dir: found };
  return found;
}

/** Where finished work is published in Drive (created when needed), or null when Drive isn't connected. */
const outputsDir = (cfg) => path.join(cfg.path, String(cfg.outputs || 'Yebunna OS').replace(/[<>:"/\\|?*]/g, ' ').trim() || 'Yebunna OS');
export function driveOutputRoot() {
  const c = conns().gdrive;
  if (!c?.enabled || !c.config?.path || !fs.existsSync(c.config.path)) return null;
  return outputsDir(c.config);
}

/** Instructions describing the bot's connections and the rules for using them. */
export function connectionPrompt(agentId) {
  const parts = [];
  if (allowed('github', agentId)) {
    parts.push(`- GitHub (${conns().github.status?.account || 'connected'}): use the GitHub MCP tools (mcp__github__*) for repositories, files, issues and pull requests. git over HTTPS can use the GITHUB_TOKEN environment variable. Work on a new branch and open a pull request; never force-push, delete repositories or branches, change settings, or merge into the main branch unless the task explicitly says so.`);
  }
  if (allowed('vercel', agentId)) {
    parts.push(`- Vercel: use the Vercel CLI through the terminal (\`npx vercel@latest …\`). The token is already in the VERCEL_TOKEN environment variable — never pass it with --token or print it.${conns().vercel.config?.team ? ` Use --scope ${conns().vercel.config.team}.` : ''} Deploy preview deployments by default; deploy to production (--prod), change domains or environment variables only when the task explicitly says so. Report the deployment URL.`);
  }
  if (allowed('meta', agentId)) {
    const acct = cfg('meta').adAccountId ? (cfg('meta').adAccountId.startsWith('act_') ? cfg('meta').adAccountId : `act_${cfg('meta').adAccountId}`) : 'act_<id>';
    parts.push(`- Meta (Facebook & Instagram): the Marketing API, through the helper in the terminal: \`python .tools/meta_api.py get|post|delete <path> key=value …\` (run it with no arguments for examples). It reads the token from META_ACCESS_TOKEN (never print it or save it to a file), the version from META_API_VERSION and follows pagination. The ad account is ${acct}${conns().meta.config?.pageId ? `, the Page ${conns().meta.config.pageId}` : ''}${conns().meta.config?.igUserId ? `, the Instagram account ${conns().meta.config.igUserId}` : ''}.
  The "Meta Ads MCP tools" that skills written for claude.ai name (ads_get_ad_entities, ads_create_campaign, ads_create_ad_set, ads_create_creative, ads_create_ad, ads_update_entity, ads_get_ad_preview, ads_creative_upload_media, ads_insights_*) DO NOT EXIST here and are never a reason to be blocked: do the same thing with the helper —
  ads_get_ad_entities → get ${acct}/campaigns (or /adsets, /ads) fields=id,name,status,effective_status,daily_budget,objective · insights → get ${acct}/insights fields=spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type level=ad date_preset=last_7d
  ads_create_campaign → post ${acct}/campaigns name=… objective=OUTCOME_SALES status=PAUSED special_ad_categories=[] · ads_create_ad_set → post ${acct}/adsets name=… campaign_id=… daily_budget=<cents> billing_event=IMPRESSIONS optimization_goal=OFFSITE_CONVERSIONS promoted_object={"pixel_id":"…","custom_event_type":"PURCHASE"} targeting={…} status=PAUSED
  ads_creative_upload_media → post ${acct}/adimages --file x.png (or /advideos --file x.mp4) · ads_create_creative → post ${acct}/adcreatives name=… object_story_spec={…} · ads_create_ad → post ${acct}/ads name=… adset_id=… creative={"creative_id":"…"} status=PAUSED
  ads_update_entity → post <object id> field=value · ads_get_ad_preview → get <ad id>/previews ad_format=MOBILE_FEED_STANDARD · ads_get_ad_images/videos → get ${acct}/adimages (or /advideos).
  The skill's "Projects tool" files (claude/…md) are this mission's workspace files instead. Reading insights is always fine. Create campaigns, ad sets and ads with status PAUSED. Never activate anything that spends money, change budgets or bids, publish posts, or reply to people unless the task explicitly says so.`);
  }
  if (allowed('higgsfield', agentId)) {
    parts.push(`- Higgsfield: use the Higgsfield MCP tools (mcp__higgsfield__*) to generate images and videos. Every generation spends the founder's Higgsfield credits: check the balance first, prefer a cheaper model or a still image when it does the job, generate only the variants the task needs, and stop and report if the credits would not cover the work. Never buy credits, change plans or subscriptions, publish to TikTok or other platforms, or enter contests unless the task explicitly says so. Download every finished asset into the mission's workspace folder and list its file path and Higgsfield URL in your deliverable.`);
  }
  const drive = conns().gdrive?.config?.path;
  if (allowed('gdrive', agentId) && drive) {
    parts.push(`- Google Drive: the founder's Drive is synced at "${drive}". Read files there when useful. Don't save your work there yourself: the OS copies every approved deliverable to Drive, organised and version-stamped. Never delete or overwrite files there.`);
  }
  return parts.length ? `\nCONNECTED ACCOUNTS (use them for real work; follow these rules exactly):\n${parts.join('\n')}\n` : '';
}
