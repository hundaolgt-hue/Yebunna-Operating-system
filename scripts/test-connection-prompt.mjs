// Regression test for connectionPrompt: 'ReferenceError: cfg is not defined' when Meta is allowed.
// Uses a throwaway DATA_DIR / WORKSPACE_DIR and stub connections; never the real state or tokens.
// Run: node scripts/test-connection-prompt.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-connprompt-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.WORKSPACE_DIR = path.join(tmp, 'workspace');

const { state } = await import('../src/store.js');
const { connectionPrompt } = await import('../src/connections.js');

const STUB_ACCT = 'act_1234567890';
const base = () => ({
  github: { enabled: true, bots: ['engineer', 'landing', 'ceo'], config: { token: 'stub-github' }, status: { account: 'stub-user' } },
  vercel: { enabled: true, bots: ['engineer', 'design', 'landing'], config: { token: 'stub-vercel' } },
});
const states = {
  'meta-enabled': () => ({ ...base(), meta: { enabled: true, bots: ['marketing', 'sales'], config: { token: 'stub-meta', adAccountId: STUB_ACCT } } }),
  'meta-disabled': () => ({ ...base(), meta: { enabled: false, bots: ['marketing', 'sales'], config: { token: 'stub-meta', adAccountId: STUB_ACCT } } }),
};

let failed = 0;
for (const [name, make] of Object.entries(states)) {
  for (const bot of ['marketing', 'landing', 'engineer']) {
    state.connections = make();
    let out;
    let err = null;
    try {
      out = connectionPrompt(bot);
    } catch (e) {
      err = e;
    }
    const problems = [];
    if (err) problems.push(`threw ${err.name}: ${err.message}`);
    else if (typeof out !== 'string') problems.push(`returned ${typeof out}, not a string`);
    else if (bot === 'marketing' && name === 'meta-enabled' && !out.includes(`The ad account is ${STUB_ACCT}`)) problems.push('missing ad-account line (act_...)');
    else if (name === 'meta-disabled' && out.includes('Meta (Facebook')) problems.push('Meta text present while Meta is disabled');
    if (problems.length) failed++;
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${bot.padEnd(9)} ${name.padEnd(13)} ${problems.join('; ') || `string, ${out.length} chars`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} of 6 cases FAILED` : '\nAll 6 cases PASS');
process.exit(failed ? 1 : 0);
