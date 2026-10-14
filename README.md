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
| **Echo** | Growth Marketer | Copywriting, launch plans, SEO, social & ads | 🌐 |
| **Ledger** | Revenue & Finance Lead | Pricing, unit economics, financial models | 🌐 |
| **Harbor** | Customer Success Lead | Onboarding, help docs, email sequences | |

Agents marked 🌐 can search and read the web while they work, like Grok's real-time search. To edit the roster, personas or tools, change `src/agents.js`.

## How a mission runs

1. **Plan.** Atlas breaks your goal into 4–8 tasks. Each task gets an owner, a brief, a deliverable, dependencies, and a deadline inside your overall deadline.
2. **Delegate.** Tasks start as soon as their dependencies are done. Up to `MAX_PARALLEL_TASKS` run at once, and the one with the earliest deadline goes first. Each agent gets its teammates' finished work as input.
3. **Review.** Atlas approves each deliverable or sends it back once with feedback (`MAX_REVISIONS`).
4. **Escalate.** A watchdog flags any task that passes its deadline and posts an escalation in the thread.
5. **Report.** Once every task is finished, Atlas writes a mission report covering decisions, owners, deadline performance, risks and next moves.

You can keep going after that. In the mission thread, **Delegate to team** has the CEO plan more work, and **Ask the CEO** gets you a status answer. You can also chat 1:1 with any agent from the **Team** page.

## UI

- **Command center:** a Grok-style home page with a large prompt box, deadline picker, suggestion chips and the team strip.
- **Mission thread:** the CEO's plan with live delegation cards showing status, a countdown and streaming output. A collapsible "Thinking" panel shows tool activity.
- **Task board:** a kanban view (Queued → Working → CEO review → Done / Failed) across all missions.
- **Team:** agent cards with delivered count, on-time %, open work, and a 1:1 chat.
- Works on phones too, with a collapsible sidebar.

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
| `DATA_DIR` | `./data` | Where missions are saved (`state.json`) |

## Project layout

```
server.js            HTTP server, JSON API, Server-Sent Events
src/agents.js        the team: personas, specialties, tools, system prompts
src/orchestrator.js  CEO loop: plan → delegate → run → review → report, deadline watchdog
src/llm.js           Claude Code bridge (headless `claude -p`, streamed)
src/demo.js          offline demo engine
src/store.js         JSON persistence (missions survive restarts and resume)
public/              the UI (vanilla JS, no build step)
```

### API

| Method | Path | |
|---|---|---|
| `GET` | `/api/meta` | engine info + agents |
| `GET` | `/api/state` | all missions and tasks |
| `GET` | `/api/events` | live SSE stream (mission/task updates, token deltas) |
| `POST` | `/api/missions` | `{ goal, deadline }` → start a mission |
| `POST` | `/api/missions/:id/messages` | `{ text, mode: "delegate" \| "ask" }` |
| `POST` | `/api/missions/:id/cancel` | stop a mission |
| `DELETE` | `/api/missions/:id` | delete a mission |
| `GET/POST/DELETE` | `/api/chats/:agentId` | 1:1 chat with an agent (POST streams SSE) |
