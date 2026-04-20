# QA MCP Agent (Jira) — Checklists, test cases, CSV

The agent reads **Jira** issue descriptions, generates **test checklists** or **test cases** (LLM), and after you comment `APPROVED:` produces a **CSV**. **Confluence** and **Azure DevOps** are optional.

## Documentation (four files)

| Document | What to use it for |
|----------|-------------------|
| **[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)** | End-to-end operations: `.env`, single issue, batch, approval, CSV, optional ADO steps, **scheduling**, command cheat sheet |
| **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** | Azure DevOps: Test Plans, WIQL, `npm run ado:*`, export test cases by tag → `Test cases/`, sync CSV to ADO. **Automatic sync after approval** uses **`ADO_ACTIVE_TEST_PLAN_ID`** and matches **Jira key from the CSV filename** to a suite in that plan; **`ADO_SYNC_PLAN_ID`** is for manual `ado:sync-csv` only (see §9). |
| **[TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)** | Pixel/Azure **CSV format** (examples), **MCP / architecture**, **Cursor prompts**, **`Test cases/`** folder (`ENABLE_TEST_CASES_ANALYSIS`) |
| **README.md** (this file) | Entry point and index |

**Shell note:** **Bash** = macOS, Linux, Git Bash · **PowerShell** = Windows.

## Web UI (command helper)

`npm run web` starts a local server (default [http://127.0.0.1:3847/](http://127.0.0.1:3847/), listens on **all interfaces** `0.0.0.0` for the same port) that serves **`web/`**: a **home** page (`/`) with **Create new test design** (`/create.html`) and **Update test design** (`/update.html`). Create aligns with **FULL_FLOW_GUIDE.md**; Update with **UPDATED_CSV_FLOW.md**. Both build **Bash and PowerShell** snippets and support **Run** (spawn on the machine running the server) plus **Browse folder** (OS dialog — Windows / macOS / `zenity` on Linux). Override port: `WEB_UI_PORT=4000 npm run web`.

Guide links **`/FULL_FLOW_GUIDE.md`**, **`/UPDATED_CSV_FLOW.md`**, **`/ADO_TEST_PLANS.md`** open as **HTML preview** (readable typography and tables, dark/light follows the system). Append **`?raw=1`** for the plain Markdown source, or send **`Accept: text/markdown`** without `text/html`.

Web UI: folder pick uses **two-phase** routes (`GET /__da/folder-pick/start` then poll `.../status?jobId=`) plus aliases **`/web/folder-pick-start.json`** / **`/web/folder-pick-status.json`** so the OS dialog does not block the HTTP response (and some embedded browsers tolerate `.json` URLs). **Cursor Simple Browser** often still cannot reach localhost APIs at all — use Chrome/Edge for full functionality. Health: `GET /__da/health`. Legacy **`/api/*`** paths remain where listed in `web-ui-server.js`.

**Windows — shortcut on first web start:** when you run `npm run web`, the server calls `scripts/ensure-desktop-shortcut.ps1` in the background. If **AI Test Agent.lnk** is **not** already on your Desktop, it runs the same logic as `npm run shortcut` (builds the icon if needed, creates the `.lnk`). If the shortcut **already exists**, nothing is created (no duplicate).

**Desktop shortcut «AI Test Agent»:** run `npm install` then `npm run shortcut` (or `powershell -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1`). It builds `assets/ai-agent.ico` via `npm run build:icon`, creates a **Desktop** `.lnk` with that icon, starts the web UI if needed, and opens **http://127.0.0.1:3847/** in the browser. Replace `assets/ai-agent.png` if you change the artwork, then run `npm run shortcut` again. If the icon stays blank, refresh the desktop (F5) or sign out/in. To open the URL inside Cursor: Command Palette → **Simple Browser: Show**.

## Quickest path

### 1. Create `.env`

The `.env` file is **not included in the repo** (it contains secrets). Create it from the template:

```bash
# Mac / Linux / Git Bash
cp .env.example .env

# PowerShell (Windows)
Copy-Item .env.example .env
```

Then open `.env` and fill in the required values:

| Variable | Where to get it |
|----------|----------------|
| `JIRA_BASE_URL` | Your Jira URL, e.g. `https://yourcompany.atlassian.net` |
| `JIRA_EMAIL` | Your Jira account email |
| `JIRA_API_TOKEN` | [Jira → Account Settings → Security → API tokens](https://id.atlassian.com/manage-account/security) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) — free tier available |
| `JIRA_PROJECT_KEY` | Your Jira project key, e.g. `FER`, `QA`, `PROJ` |

Everything else in `.env` is optional — the defaults in `.env.example` work out of the box.

### 2. Install and run

```bash
npm install
```

- **One ticket:** `JIRA_ISSUE_KEY=PROJ-123 node agent-docs.js` (or set `JIRA_ISSUE_KEY` in `.env`).
- **Daily batch:** `CHECK_APPROVAL=false npm run batch` / `CHECK_APPROVAL=true npm run batch` — details in **FULL_FLOW_GUIDE.md**.

Results: Jira comments, CSV under **`CHECKLIST_OUTPUT_DIR`**, batch summary in **`Batch Summary Archive/`**.

Results: Jira comments, CSV under **`CHECKLIST_OUTPUT_DIR`**, batch summary in **`Batch Summary Archive/`**.

## Project layout (short)

- `agent-docs.js` — single issue  
- `agent-batch.js` — batch JQL  
- `ado-*.js` — Azure DevOps client, plan tools, tag CSV export, approved CSV sync  
- `mcp-server.js` — Cursor MCP  
- `prompts-docs.js` — LLM prompts  
- `web/` + `web-ui-server.js` — browser helper for guide commands (`npm run web`)  
- `scripts/launch-ai-agent.ps1` + `scripts/create-desktop-shortcut.ps1` + `scripts/ensure-desktop-shortcut.ps1` — desktop shortcut (`npm run shortcut`; optional auto-create on Windows when `npm run web` starts if `.lnk` is missing)  
