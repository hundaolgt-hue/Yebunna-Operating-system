# Yebunna OS

An AI company that runs on your **Claude subscription**. You give the CEO a goal and a deadline. The CEO plans the work, assigns each task to a specialist agent with its own deadline, reviews every deliverable, and writes you a mission report. The interface is dark and minimal, styled after Grok.

![flow](https://img.shields.io/badge/goal-%E2%86%92%20CEO%20plan%20%E2%86%92%20delegate%20%E2%86%92%20work%20%E2%86%92%20review%20%E2%86%92%20report-111?style=flat-square)

## The team

| Agent | Role | Specialties | Live web |
|---|---|---|---|
| **Atlas** | CEO | Strategy, delegation, prioritization, quality review | |
| **Nova** | Market Research Analyst | Market sizing, competitor teardown, personas, trends | 🌐 |
| **Orion** | Product Manager | PRDs, MVP scoping, roadmaps, user stories | |
| **Forge** | Lead Engineer | Architecture, full-stack code, automation | |
| **Pixel** | Brand & UX Designer | Brand identity, UI/UX flows, design systems | |
| **Vega** | Creative Director | Creative concepts, ad creatives, AI images & video (Higgsfield) | 🌐 |
| **Echo** | Growth Marketer | Copywriting, launch plans, SEO, social & ads | 🌐 |
| **Ledger** | Revenue & Finance Lead | Pricing, unit economics, financial models | 🌐 |
| **Harbor** | Customer Success Lead | Onboarding, help docs, email sequences | |

Agents marked 🌐 can search and read the web while they work, like Grok's real-time search. To edit the roster, personas or tools, change `src/agents.js`.

## How a mission runs

1. **Plan.** Atlas breaks your goal into 4–8 tasks. Each task gets an owner, a brief, a deliverable, dependencies, and a deadline inside your overall deadline.
2. **Delegate.** Tasks start as soon as their dependencies are done. Up to `MAX_PARALLEL_TASKS` run at once, and the one with the earliest deadline goes first. Each bot gets its teammates' finished work and files as input.
3. **Review.** Atlas approves each deliverable or sends it back once with feedback (`MAX_REVISIONS`).
4. **Escalate.** A watchdog flags any task that passes its deadline and posts an escalation in the thread.
5. **Report.** Once every task is finished, Atlas writes a mission report. Every deliverable and the report are saved as files in the shared workspace.

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
| **Memory** | Each bot keeps its own memory. A one-line note is saved after every finished task, and you can add notes by hand or say "remember …" in chat. Memory goes into every prompt for that bot. |
| **Approvals** | **Settings:** require your OK on the CEO's plan before work starts, and/or on every deliverable (**Approve / Request changes** with feedback). |
| **Shared workspace (cloud computer)** | A real folder (`./workspace`) that every bot, CEO included, reads, writes and edits with Claude Code's file tools. Browse, preview and download in **Files**. |
| **Terminal** | On by default (**Settings → Terminal**). Every bot can run commands in the workspace, e.g. Python to build, recalculate and check spreadsheets. On Windows this needs Git for Windows, plus Python for Python scripts. |
| **Computer use (browser control)** | **Settings → Turn on for all bots**, or per bot under **Edit**. The bot drives a real browser (Edge, Chrome or Firefox) through the Playwright MCP server: it opens sites, clicks, types and fills forms. Each bot has its own browser profile. **🔑 Log in to a site** opens that browser so *you* log in, and the login stays saved. Bots never type passwords, solve CAPTCHAs, or buy, send, publish or delete anything unless the task says so. |
| **Live web search** | Nova, Echo, Ledger, and any bot you create with "web" turned on, use WebSearch and WebFetch. |
| **Create your own bots** | **Team → Create a bot:** pick a preset or write a name, main job, description and specialties. |
| **Direct assignments** | **Assign task** on any bot, with a deadline and an optional skill. No CEO planning step. |
| **Connections** | **Connections** page. Each service has setup steps, a **Save & test** button, and a choice of which bots may use it. **GitHub** uses GitHub's official MCP server with a personal access token. **Vercel** uses the Vercel CLI with `VERCEL_TOKEN` (preview deploys by default). **Meta (Facebook & Instagram)** uses the Graph and Marketing API with a system-user token; ads are created PAUSED, and nothing spends money or publishes unless the task says so. **Higgsfield** uses Higgsfield's MCP server (`https://mcp.higgsfield.ai/mcp`) for AI images and video, given to Vega, the Creative Director, by default. It signs in with OAuth, so there is no token to paste: run `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp` once, log in under `/mcp` in Claude Code, and bot runs reuse that login. Bots check your credits first and never buy credits or post anything unless the task says so. **Google Drive** works through the folder that *Google Drive for desktop* syncs to your PC. Tokens stay in `data/state.json` on your PC. They are never sent to the browser or written to files, and are passed only to the runs of bots you allowed. |
| **Usage & Economy mode** | **Settings → Usage** shows runs, tokens and an approximate API-equivalent cost per bot and per kind of work. **Economy mode** runs bot work on Sonnet and small jobs on Haiku, with lower effort. |
| **Voice** | 🎙 dictation in every message box and 🔊 read-aloud on replies, using the browser's speech features (Chrome or Edge). |

One Grok Bot feature isn't included:
- **Joining Zoom or Google Meet calls.** xAI hasn't released it either, and a local app can't join calls without platform integrations.

## Troubleshooting

- **Skill packs say "git is not installed".** Install Git for Windows, then click **Skills → Install / update all**.
- **Python tasks fail.** Install Python from python.org and tick "Add python.exe to PATH". Then run `pip install openpyxl pandas pypdf pdfplumber reportlab` once (the PDF skill uses the last three).
- **"Claude Code is not logged in".** Run `claude`, type `/login`, choose your Claude subscription, then type `/exit`.
- **A bot runs long.** Each run has a step budget and a 45-minute time limit (`RUN_TIMEOUT_MINUTES`). A bot that runs out of steps hands in what it has or takes one "finish now" pass. At most `MAX_CONCURRENT_RUNS` (default 4) Claude processes run at once.

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

Each agent turn is one headless Claude Code run (`claude -p`). It streams output, runs in an empty scratch folder, and gets only the tools that agent needs. Before launching the CLI, the server removes `ANTHROPIC_API_KEY` from its environment, so usage counts against your Claude plan and is never billed to an API key. A full mission is about 10–20 agent runs. On a busy day that can use a noticeable share of your plan's usage limits, so use **Stop** on a mission you no longer need.

This setup is for your own use on your own machine. Anthropic doesn't allow offering claude.ai login or plan limits to other people through a product you build. If you ever turn Yebunna OS into a service for others, switch it to an API key.

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MODEL` | your Claude Code default | Model alias passed to `claude --model` (`opus`, `sonnet`, `haiku`) |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `PORT` | `3000` | HTTP port |
| `MAX_PARALLEL_TASKS` | `3` | Agents working at the same time |
| `MAX_REVISIONS` | `1` | Times the CEO may send work back |
| `DEMO_MODE` | `0` | `1` forces the offline demo |
| `MAX_CONCURRENT_RUNS` | `4` | Claude Code processes allowed at once (tasks, chats, meetings) |
| `RUN_TIMEOUT_MINUTES` | `45` | Longest a single bot run may take before it is stopped |
| `DATA_DIR` | `./data` | Where missions, memory, skills and routines are saved (`state.json`) |
| `WORKSPACE_DIR` | `./workspace` | The shared folder bots work in |
| `META_API_VERSION` | `v26.0` | Graph / Marketing API version for the Meta connection (the test switches to a newer one if Meta asks) |
| `SKILL_PACKS` | `1` | `0` skips downloading skill packs at startup (offline use, tests) |

## Project layout

```
server.js            HTTP server, JSON API, Server-Sent Events
src/agents.js        the team: personas, custom bots, tools, memory, system prompts
src/orchestrator.js  CEO loop: plan → approve → delegate → run → review → report, watchdog, memory
src/meetings.js      team meetings & standups → minutes → action items
src/skills.js        skills, save-as-skill, watch-and-learn teaching
src/routines.js      schedules and event triggers
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
