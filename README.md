# Yebunna OS

An AI company that runs on your **Claude subscription**. You give the CEO a goal and a deadline. The CEO plans the work, assigns each task to a specialist agent with its own deadline, reviews every deliverable, and writes you a mission report. The interface is dark and minimal, styled after Grok.

![flow](https://img.shields.io/badge/goal-%E2%86%92%20CEO%20plan%20%E2%86%92%20delegate%20%E2%86%92%20work%20%E2%86%92%20review%20%E2%86%92%20report-111?style=flat-square)

## The team

Every kind of deliverable has exactly one owner, so roles never overlap. Each bot has its own Claude model and effort.

| Agent | Role | Owns (and nobody else does) | Model · effort | Live web |
|---|---|---|---|---|
| **Atlas** | CEO | Planning, briefs, order of work, reviews, unblocking, reports | Opus high to plan and brief · Sonnet low for the rest | |
| **Nova** | Market Research Analyst | Demand and supply evidence, competitor teardown and prices seen, niche scoring (no pricing decisions) | Sonnet medium | 🌐 |
| **Orion** | Product Manager | The product spec: scope, structure, logic, acceptance tests | Sonnet low | 🌐 |
| **Forge** | Lead Engineer | The product itself: Excel/Sheets models, code, automations | Opus high | 🌐 |
| **Pixel** | Brand & Visual Designer | Brand system, mockups and every still image (ad stills, thumbnails, posters) | Sonnet medium | 🌐 |
| **Vega** | Creative Director (Video) | Every video: concepts, scripts, motion graphics, AI video, tutorial videos | Opus medium | 🌐 |
| **Lumen** | Landing Page & Conversion Lead | The landing page: its copy, build, Ye-Buna checkout, Meta Pixel, Vercel | Sonnet medium | 🌐 |
| **Echo** | Growth Marketer | Ad copy, Meta campaign setup, reading campaign results | Sonnet low | 🌐 |
| **Ledger** | Revenue & Finance Lead | Price, offer, unit economics, projections | Sonnet low | 🌐 |
| **Harbor** | Customer Success Lead | Written tutorial, FAQ, buyer replies, after-sale emails | Haiku low | 🌐 |

Change a bot's model and effort under **Settings → Usage** or **Team → Edit**. Job descriptions and defaults are in `src/personas.js`; the roster and tools are in `src/agents.js`.

## How a mission runs

One mission is one product.

1. **Plan.** Atlas breaks the product goal into 3–6 tasks, in order. Each task has one owner, a brief, a deliverable and a deadline inside your overall deadline.
2. **One at a time.** Only one bot works at a time across the whole company (the CEO is the only other one running). Tasks go in plan order, oldest mission first. The next task starts only after the previous one is reviewed and handed over. If a mission's next task waits on you, the next mission goes on.
3. **Handover.** Bots work in files. Each ends with a short handover (result, files, key points, open issues, at most 150 words). The next bot gets the handovers, not full outputs, and opens the files it needs.
4. **Review.** Atlas checks the handover against the acceptance criteria, looks at the main file, and approves it or sends it back once (`MAX_REVISIONS`).
5. **Escalate.** A watchdog flags any task that passes its deadline.
6. **Report.** Once every task is finished, Atlas writes a report of at most 150 words. Every handover and the report are saved in the mission folder.

### Changing work that is already assigned

The CEO sorts every message (in the app, on Telegram, or in a mission's box) before acting on it:
- **A change, correction or comment on assigned work** edits that task. It never creates a new task or mission. A queued task gets the change in its brief. A running task stops and restarts with the change. A finished task is redone with the change.
- **New work for the same product** is added to that product's mission.
- **A different product** becomes a new mission.
- **Questions and status checks** just get an answer.

### Lean on tokens

- All bots write tersely: results, numbers, decisions, file paths. They don't recap, repeat or summarise.
- Prompts are small. Specialists don't get the team roster or a skill-library list. The CEO picks the skills each task needs, and the skill catalog gives one short line per skill.
- No memory note is written after each task (that was an extra run per task).
- Each new mission starts clean. Bots keep only the standing facts you gave them ("remember …") and the playbook rules from the retrospectives. The CEO chat sees only the messages since the current product's mission began, at most 8.

## Grok Bot capabilities

| Capability | How it works here |
|---|---|
| **Team meetings / group chat** | Put 2–6 bots in a room (**Meetings**). The CEO moderates, the bots take turns and react to each other by name, and you can jump in. The meeting ends with minutes, decisions and action items that start as a mission with one click, or automatically. |
| **Standups** | One click (**☀️ Standup now**) or a routine. Each bot reports what it finished, what's next and its blockers, from its real task list. |
| **Teach a task (watch and learn)** | **Skills → Teach a task.** Share your screen and do the workflow once, narrating by typing or speaking. Changed frames are captured. The bot then opens the screenshots with Claude Code's Read tool and drafts a skill for you to review, edit, activate and test-run. |
| **Skills** | Reusable procedures (steps, decision rules, output requirements, approval boundaries). Write them by hand, teach them by demo, click **💾 Save as skill** on a finished task, or click **✨ Write skills from my role** so a bot turns its role, responsibilities and specialties into skills. Active skills go into the bot's instructions, and the CEO routes work to bots whose skills match. |
| **Skill packs** | Community libraries, the same ones `npx skills add` installs, downloaded with git into `workspace/.skills/` on first start and given to the right bots. The packs are: Taste Skill (design-taste-frontend), Build Awwwards-quality sites, find-skills, Corey Haines' marketing skills, Charlie Hills' social-media skills, Superpowers subagent-driven-development, Anthropic's PDF skill, and Addy Osmani's agent-skills. Bots see each skill's name and description, and open its SKILL.md when a task matches. Change which bots use a skill under **Skills → Skill library → Bots**. |
| **Live activity** | Everything bots do (assignments, tools used, deliveries, reviews, chats, meetings, routines) streams into the **Task board**, and each bot's page shows its own feed. |
| **Routines (schedules and triggers)** | Every N hours, daily, weekly, or when a mission or task completes. A routine can assign a task, run a skill, have the CEO plan a whole mission, or hold a standup. Includes run history and **Run now**. |
| **Memory** | Each bot keeps standing facts and preferences you give it: add them by hand, or say "remember …" in chat. They go into every prompt for that bot. Notes about past missions are not carried into new missions; lessons become playbook rules in the morning retrospective. |
| **Approvals** | **Settings:** require your OK on the CEO's plan before work starts, and/or on every deliverable (**Approve / Request changes** with feedback). |
| **Shared workspace (cloud computer)** | A real folder (`./workspace`) that every bot, CEO included, reads, writes and edits with Claude Code's file tools. Browse, preview and download in **Files**. |
| **Terminal** | On by default (**Settings → Terminal**). Every bot can run commands in the workspace, e.g. Python to build, recalculate and check spreadsheets. On Windows this needs Git for Windows, plus Python for Python scripts. |
| **Computer use (browser control)** | **Settings → Turn on for all bots**, or per bot under **Edit**. The bot drives a real browser (Edge, Chrome or Firefox) through the Playwright MCP server: it opens sites, clicks, types and fills forms. Each bot has its own browser profile. **🔑 Log in to a site** opens that browser so *you* log in, and the login stays saved. Bots never type passwords, solve CAPTCHAs, or buy, send, publish or delete anything unless the task says so. |
| **Live web search** | Nova, Echo, Ledger, and any bot you create with "web" turned on, use WebSearch and WebFetch. |
| **Create your own bots** | **Team → Create a bot:** pick a preset or write a name, main job, description and specialties. |
| **Direct assignments** | **Assign task** on any bot, with a deadline and an optional skill. No CEO planning step. |
| **Connections** | **Connections** page. Each service has setup steps, a **Save & test** button, and a choice of which bots may use it. **GitHub** uses GitHub's official MCP server with a personal access token. **Vercel** uses the Vercel CLI with `VERCEL_TOKEN` (preview deploys by default). **Meta (Facebook & Instagram)** uses the Graph and Marketing API with a system-user token; ads are created PAUSED, and nothing spends money or publishes unless the task says so. **Higgsfield** uses Higgsfield's MCP server (`https://mcp.higgsfield.ai/mcp`) for AI images and video, given to Vega, the Creative Director, by default. It signs in with OAuth, so there is no token to paste: run `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp` once, log in under `/mcp` in Claude Code, and bot runs reuse that login. Bots check your credits first and never buy credits or post anything unless the task says so. **Google Drive** works through the folder that *Google Drive for desktop* syncs to your PC. Tokens stay in `data/state.json` on your PC. They are never sent to the browser or written to files, and are passed only to the runs of bots you allowed. |
| **Blockers → CEO → you** | A bot that can't get past something (missing access, a login, a decision, a tool that keeps failing) ends its work with `BLOCKED: … \| NEED: …`. Failed runs count as blockers too. The CEO then tells the bot how to get past it, hands the task to a teammate who has the access, or, only when nobody on the team can, asks you. Your question shows on the task card (**🙋 Needs you**) and on Telegram. Your answer sends the task back to work. |
| **Telegram: chat with the CEO** | **Connections → Telegram:** make a bot with @BotFather, paste its token, press Start in the bot, then click **Save & test** (your chat is found automatically). Then talk to the CEO there by text or voice note, in the same conversation as the CEO chat in the app. The CEO answers questions (it can read the team's files) and acts: a change to assigned work edits that task, new work for the same product is added to its mission, only a new product becomes a new mission, "from now on…" becomes a playbook rule, and it can answer or approve what is waiting on you. Voice notes are transcribed first: paste a free Groq API key (console.groq.com) or an OpenAI key in the connection, or install `faster-whisper` to transcribe on your PC. The app sends back what it heard so you can check. You also get alerts when something only you can do blocks a mission, when a plan or deliverable needs your OK, when the usage limit pauses or resumes work, and when a mission finishes. Reply to an alert to answer it; reply to "mission complete" to comment on that mission. `/status`, `/answer <n> <text>` and `/resume` also work. Only your own chat is accepted. |
| **Usage-limit auto-resume** | When a run hits your Claude usage limit, everything pauses: running tasks, CEO reviews, plans, reports and meetings go back in the queue, nothing new starts, and no runs are wasted. One timer wakes the team at the reset time Claude Code reports (plus 90 seconds). If no time is reported, it tries again every 2 hours (`LIMIT_CHECK_HOURS`). A banner shows the pause, with **Try now**. It survives restarts. |
| **Morning retrospective & playbook** | Every morning at 08:00 (a routine you can change), the bots that worked since the last retrospective meet. Each reports what went well, what went wrong and why, and proposes a rule. The CEO turns lessons into **DO** / **DON'T** rules in the **team playbook** and retires rules that stopped helping. Every bot follows the playbook in every task. If nothing happened since the last retrospective, the meeting is skipped and uses nothing. Edit the playbook on the **Meetings** page. |
| **House standards** | Standing rules the founder set, written as skills that are always included in full for the bots they apply to. Edit them in **Skills**; your edits are never overwritten. **House creative standards** (Pixel, Vega, Lumen): Fortune-500 launch-ad quality; motion references motionin.design and Motion Array (pacing and transitions only, no unlicensed assets); aesthetic reference savee.com; Facebook/Instagram ad sizes (images 1:1, 4:5 and 9:16; videos vertical only, 9:16 1080×1920 plus a 4:5 Feed cut, with safe zones); Amharic on-screen text added as an overlay (AI models garble Ge'ez); no voiceover, only sound effects and royalty-safe classical music; ffprobe/frame checks before hand-in. **Ye-Buna landing page standard** (Lumen): page structure, every buy button to the product's Ye-Buna checkout (Lumen asks you if it doesn't have the link), Pixel events, Vercel preview deploy, and checks at mobile and desktop widths. |
| **Disk space guard** | A full disk can no longer crash the app: a failed save is retried, and your data file stays intact. The free space on the workspace drive is checked every 3 minutes. Below 5 GB (`DISK_WARN_GB`) you get a warning in the app and on Telegram. Below 1 GB (`DISK_PAUSE_GB`) the team pauses like on the usage limit and resumes by itself once there is room. **Settings → Storage** shows free space, the size of each mission folder, browser profiles and skill packs, and the largest files. Bots delete render frames and temporary files when they finish. |
| **Reference samples** | Give the team sample images, videos or documents in two ways. In **Files → ⬆ Upload references** (or drag and drop), up to 500 MB per file. Or send a photo, video or file to the Telegram bot (Telegram limits bots to 20 MB); a caption such as "make 3 ads in this style" goes straight to the CEO with the file attached. Files are saved in `references/<date>/`. Bots study them when a task mentions references or samples: images with Read, videos frame by frame with ffmpeg. The creative standards tell Vega and Pixel to match your samples' style first. |
| **CEO briefs before anyone starts** | Every task, whether planned, assigned directly, from a routine or from a meeting, gets a complete, short brief from the CEO before a bot starts: objective and why, inputs (file paths), steps, the skills to use (picked from the installed skill catalog; if none fits, the bot is told to find one with find-skills), at least 3 acceptance criteria and the exact deliverable. A plan with vague briefs is sent back to the CEO (up to twice). The CEO reviews each handover against the acceptance criteria. The brief is shown on each task card. |
| **CEO check-ins** | A stall watchdog checks every minute. A bot that shows no output, thinking or tool use for 20 minutes (`STALL_MINUTES`) is stopped, and the CEO works out why: it re-briefs, reassigns, or asks you. The deadline watchdog still escalates late tasks. |
| **Job descriptions & core skills** | Each built-in bot has a job description with what it owns and what it never touches (`src/personas.js`, editable under **Team → Edit**) and **core skills** it must open and follow on every task where they apply (also editable there; missing skills are flagged). Nova (research) uses the web, the Facebook Ad Library and ye-buna.com in a real browser. Vega (creative director) works from higgsfield-motion, higgsfield-motion-saas and rapha-motion-video with a fast workflow (concept → calibrate → parallel generation → one QA pass). |
| **Your own skill files** | **Skills → Upload .skill / .zip** installs skills exported from Claude (e.g. higgsfield-motion). **Import from Claude Code** copies the skills Claude Code keeps on this PC (`%USERPROFILE%\.claude\skills`, including skills synced from claude.ai); this also runs at every start (`IMPORT_CLAUDE_SKILLS=0` turns it off). They're saved in `workspace/.skills/custom/` and stay on your PC. Known skills go to the right bots automatically, and the CEO can assign any skill per task. |
| **Models per bot** | **Settings → Usage** sets each bot's model and effort (see the team table) and shows runs, tokens and an approximate API-equivalent cost per bot, per kind of work and per model. The CEO plans and briefs on Opus at high effort and reviews, chats and reports on Sonnet at low effort. Meetings use each bot's model at low effort. The CEO sizes every task *small*, *medium* or *large*, which only sets the step budget. Deadlines only set the order of work. |
| **Voice** | 🎙 dictation in every message box and 🔊 read-aloud on replies, using the browser's speech features (Chrome or Edge). |

One Grok Bot feature isn't included:
- **Joining Zoom or Google Meet calls.** xAI hasn't released it either, and a local app can't join calls without platform integrations.

## Troubleshooting

- **Skill packs say "git is not installed".** Install Git for Windows, then click **Skills → Install / update all**.
- **Python tasks fail.** Install Python from python.org and tick "Add python.exe to PATH". Then run `pip install openpyxl pandas pypdf pdfplumber reportlab` once (the PDF skill uses the last three).
- **"Claude Code is not logged in".** Run `claude`, type `/login`, choose your Claude subscription, then type `/exit`.
- **A bot runs long.** Each run has a step budget and a 45-minute time limit (`RUN_TIMEOUT_MINUTES`). A bot that runs out of steps hands in what it has or takes one "finish now" pass. At most `MAX_CONCURRENT_RUNS` (default 2: one bot and the CEO) Claude processes run at once.

## Run it

Requirements: Node 22.9+ and [Claude Code](https://claude.com/claude-code), logged in with your Claude Pro or Max account.

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have it yet
claude                                     # log in once with your Claude subscription, then exit

git clone https://github.com/hundaolgt-hue/Yebunna-Operating-system
cd Yebunna-Operating-system
cp .env.example .env                       # optional settings
npm start                                  # → http://localhost:3000
```

Run `npm test` for an end-to-end smoke test: it starts the server in demo mode with throwaway folders and drives missions, plan approval, chat, bots, meetings, skills and routines through the API (about 2 minutes).

There are no npm dependencies. If the `claude` CLI isn't found, or `DEMO_MODE=1` is set, the app runs an offline scripted demo so you can explore the UI.

### How it uses your subscription

Each agent turn is one headless Claude Code run (`claude -p`). It streams output, runs in an empty scratch folder, and gets only the tools that agent needs. Before launching the CLI, the server removes `ANTHROPIC_API_KEY` from its environment, so usage counts against your Claude plan and is never billed to an API key. A full mission is about 8–15 agent runs. On a busy day that can use a noticeable share of your plan's usage limits, so use **Stop** on a mission you no longer need.

This setup is for your own use on your own machine. Anthropic doesn't allow offering claude.ai login or plan limits to other people through a product you build. If you ever turn Yebunna OS into a service for others, switch it to an API key.

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MODEL` | your Claude Code default | Fallback model when a bot has none set (each bot's model is set in **Settings → Usage**) |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `PORT` | `3000` | HTTP port |
| `MAX_REVISIONS` | `1` | Times the CEO may send work back |
| `DEMO_MODE` | `0` | `1` forces the offline demo |
| `MAX_CONCURRENT_RUNS` | `2` | Claude Code processes allowed at once, 1 or 2 (one bot and the CEO; your chats go first in line) |
| `RUN_TIMEOUT_MINUTES` | `45` | Longest a single bot run may take before it is stopped |
| `DATA_DIR` | `./data` | Where missions, memory, skills and routines are saved (`state.json`) |
| `WORKSPACE_DIR` | `./workspace` | The shared folder bots work in |
| `META_API_VERSION` | `v26.0` | Graph / Marketing API version for the Meta connection (the test switches to a newer one if Meta asks) |
| `LIMIT_CHECK_HOURS` | `2` | After a usage-limit pause with no reset time, how often to try again |
| `RETRO_TIME` | `08:00` | Time of the morning retrospective created on first start |
| `STALL_MINUTES` | `20` | A bot with no activity for this long is stopped and the CEO steps in |
| `IMPORT_CLAUDE_SKILLS` | `1` | `0` skips importing Claude Code's skills from this PC at start |
| `SKILL_PACKS` | `1` | `0` skips downloading skill packs at startup (offline use, tests) |

## Project layout

```
server.js            HTTP server, JSON API, Server-Sent Events
src/agents.js        the team: custom bots, tools, memory, system prompts
src/personas.js      built-in job descriptions and core skills
src/skillimport.js   .skill uploads and Claude Code skill import
src/orchestrator.js  CEO loop: plan → approve → delegate → run → review → report, watchdog, memory
src/meetings.js      team meetings & standups → minutes → action items
src/skills.js        skills, save-as-skill, watch-and-learn teaching
src/routines.js      schedules and event triggers (incl. the morning retrospective)
src/limits.js        usage-limit pause and automatic resume
src/telegram.js      Telegram: alerts, replies, voice-note transcription
src/ceochat.js       the founder's conversation with the CEO (Telegram), with actions
src/playbook.js      team rules learned in retrospectives
src/skillpacks.js    downloads skill packs (git) and assigns them to bots
src/activity.js      live activity feed
src/llm.js           Claude Code bridge (headless `claude -p`, streamed)
src/demo.js          offline demo engine
src/store.js         JSON persistence (missions survive restarts and resume)
test/smoke.test.js   end-to-end API test in demo mode (`npm test`)
public/              the UI (vanilla JS modules, no build step)
```

### API

See the `routes` table in `server.js`: missions, tasks (approval, save-as-skill), agents (create, assign, memory), chats (SSE), meetings, skills, teach, routines, files and settings. Live updates stream from `GET /api/events`.
