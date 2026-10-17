// Connections: give bots access to the founder's accounts — GitHub, Vercel, Meta
// (Facebook & Instagram), Higgsfield and Google Drive. Each connection has its own credentials
// (kept only on this PC, never sent to the browser UI) and a list of bots allowed to
// use it. At run time a bot gets the matching tools, environment variables, folders
// and instructions — and nothing for connections it isn't allowed to use.
import fs from 'node:fs';
import path from 'node:path';
import { state, save, now } from './store.js';

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
      'Click "Assign assets" and give the system user your ad account and Page.',
      'Click "Generate new token", choose your app (create one at developers.facebook.com if needed) and tick: ads_read, ads_management, business_management, pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish.',
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
    fields: [{ key: 'path', label: 'Google Drive folder on this PC', placeholder: 'G:\\My Drive' }],
    steps: [
      'Install "Google Drive for desktop" (google.com/drive/download) and sign in.',
      'It adds a drive such as G:\\ — open it in File Explorer and copy the path of "My Drive" (e.g. G:\\My Drive).',
      'Paste the path below. Bots read files there and save to it only when a task asks.',
    ],
    link: 'https://www.google.com/drive/download/',
    uses: 'Read your Drive files and save deliverables into Drive when a task asks.',
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
    c.config[f.key] = f.secret ? cleanToken(v) : String(v).trim();
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
      account = `${fs.readdirSync(cfg.path).length} items in ${path.basename(cfg.path) || cfg.path}`;
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
        if (cfg.adAccountId) {
          const acct = cfg.adAccountId.startsWith('act_') ? cfg.adAccountId : `act_${cfg.adAccountId}`;
          const a = await metaCall(`${acct}?fields=name,account_status,currency&${token}`);
          account += ` · ad account “${a.name}” (${a.currency})`;
        }
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
    parts.push(`- Meta (Facebook & Instagram): call the Graph / Marketing API from Python or curl in the terminal, always with the version in the URL: https://graph.facebook.com/${metaVersion}/… (also in the META_API_VERSION environment variable). Never call it without a version: Meta then uses an old default that the Ads API rejects (error #2635). If Meta says a newer version is required, use the one it names. The token is in META_ACCESS_TOKEN (never print it or save it to a file); the ad account is META_AD_ACCOUNT_ID${conns().meta.config?.pageId ? ', the Page is META_PAGE_ID' : ''}${conns().meta.config?.igUserId ? ', the Instagram account is META_IG_USER_ID' : ''}. Reading insights is always fine. Create campaigns, ad sets and ads with status PAUSED. Never activate anything that spends money, change budgets or bids, publish posts, or reply to people unless the task explicitly says so.`);
  }
  if (allowed('higgsfield', agentId)) {
    parts.push(`- Higgsfield: use the Higgsfield MCP tools (mcp__higgsfield__*) to generate images and videos. Every generation spends the founder's Higgsfield credits: check the balance first, prefer a cheaper model or a still image when it does the job, generate only the variants the task needs, and stop and report if the credits would not cover the work. Never buy credits, change plans or subscriptions, publish to TikTok or other platforms, or enter contests unless the task explicitly says so. Download every finished asset into the mission's workspace folder and list its file path and Higgsfield URL in your deliverable.`);
  }
  const drive = conns().gdrive?.config?.path;
  if (allowed('gdrive', agentId) && drive) {
    parts.push(`- Google Drive: the founder's Drive is synced at "${drive}". Read files there when useful. Save into Drive only when the task asks to put something in Drive (use a clear subfolder); never delete or overwrite files there unless the task says so.`);
  }
  return parts.length ? `\nCONNECTED ACCOUNTS (use them for real work; follow these rules exactly):\n${parts.join('\n')}\n` : '';
}
