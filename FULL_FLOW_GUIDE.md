# Full Flow Guide — from Jira to CSV (and optionally Azure DevOps)

This is the **single operational guide**. Read it once and you'll know every command the agent supports.

- New to the project? Start with **[README.md](README.md)** first.
- Need CSV column descriptions? **[TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)**.
- Azure DevOps details? **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)**.
- Re-doing an existing CSV after requirements changed? **[UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)**.

## What the agent does, in 5 stages

| # | Stage | Who runs it | Result |
|---|---|---|---|
| 0 | Setup | You (once) | Node.js, `npm install`, filled-in `.env`. |
| 1 | (Optional) Check ADO | You (once) | Confirm your Azure DevOps PAT works. |
| 2 | **Day 1** — generate | Agent | A checklist or test cases posted as a Jira comment. |
| 3 | Review | You | Add `APPROVED: …` comment in Jira. |
| 4 | **Day 2** — CSV | Agent | A CSV file saved locally and attached to Jira. |
| 5 | (Optional) ADO | Agent or you | The CSV becomes Test Case work items in Azure DevOps. |

Stages 2–4 can run for one issue at a time (**single mode**) or for many issues at once (**batch mode**). Batch summary is saved to `Batch Summary Archive/batch-summary-YYYY-MM-DD.json`.

> **Tip:** you don't have to type any of the commands below. Run `npm run web`, open <http://127.0.0.1:3847/>, click. The Web UI runs the same commands for you.

## Conventions in this document

- **Bash** = macOS, Linux, Git Bash for Windows.
- **PowerShell** = Windows.
- Replace `PATH_TO_DEMO_AGENT` with your project folder (the one that contains `agent-docs.js` and `package.json`).
- Examples use `PROJ-123` as a placeholder Jira key. Use your actual key.

---

## 0. One-time setup

Fill `.env` with at least these variables:

| Variable | Where to get it |
|---|---|
| `JIRA_BASE_URL` | `https://<your-company>.atlassian.net` (no trailing slash) |
| `JIRA_EMAIL` | The email you sign into Jira with |
| `JIRA_API_TOKEN` | <https://id.atlassian.com/manage-profile/security/api-tokens> |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> |
| `JIRA_PROJECT_KEY` | Your project prefix, e.g. `PROJ` |

Then install dependencies:

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
npm install
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
npm install
```

This is a one-time step per checkout.

---

## 1. (Optional) Check Azure DevOps

Skip this section if you do not use Azure DevOps.

You need `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT` in `.env`. Full details: **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)**.

**Bash**

```bash
npm run ado:list-plans
```

**PowerShell**

```powershell
npm run ado:list-plans
```

**Expected:** the console lists your Test Plans (id and name). If the list is empty or you see errors, the PAT is missing the **Test (Read)** scope, or `ADO_ORG` / `ADO_PROJECT` is wrong.

---

## 2. Day 1 — generate checklist or test cases

The agent reads a **Test design** QA sub-task on a Jira story (plus the parent story for context) and posts a draft as a Jira comment. The draft is either a **checklist** (numbered scenarios) or **test cases** (structured BDD-style steps).

### 2A. Single issue

**Checklist (default)**

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
node agent-docs.js
```

**Test cases**

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false GENERATE_MODE=testcases node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
$env:GENERATE_MODE="testcases"
node agent-docs.js
```

**Want to influence the related-issue search for this run?** Add `RELATED_ISSUES_KEYWORDS="comma, separated, phrases"`. The agent still returns at most 30 related issues — keywords just steer the search.

### 2B. Many tickets at once (recommended for daily use)

Set `BATCH_JQL_CHECKLIST` in `.env` (typically: QA Sub-task **Test design** with the status you care about). See `.env.example` for ready-made examples.

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
CHECK_APPROVAL=false npm run batch
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:CHECK_APPROVAL="false"
npm run batch
```

For test cases in batch mode: set `GENERATE_MODE=testcases` in `.env` and run the same command.

---

## 3. Approve in Jira

On the **Test design** QA sub-task where the agent posted its draft, add a **new** comment whose **first non-empty line** is one of:

```text
APPROVED: all
```

or

```text
APPROVED: 1,2,5
```

> The numbers must match item numbers in the agent's draft. Anything after the first line is ignored, so feel free to add notes for your team.

The agent only re-reads **new** comments. Editing an old comment will not trigger a Day 2 run.

---

## 4. Day 2 — generate the CSV

### 4A. Single issue

Same Jira key as in 2A.

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="true"
node agent-docs.js
```

### 4B. Many tickets at once

Set `BATCH_JQL_APPROVAL` in `.env` (typically: QA Sub-task **Test design** with status that means "ready to export"). See `.env.example`.

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
CHECK_APPROVAL=true npm run batch
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:CHECK_APPROVAL="true"
npm run batch
```

### Where the CSV ends up

- **Local file:** folder defined by `CHECKLIST_OUTPUT_DIR` in `.env`. Windows default: `%USERPROFILE%\OneDrive\Desktop\Checklists and Test cases`.
- **File name:** `<Parent task title> (<PROJ-KEY>).csv`.
- **Jira:** the same file is attached to the **Test design** sub-task; a link is also posted as a comment.

### What to do next

You are done unless you want Azure DevOps work items.

- Open the CSV in Excel or import it into your test tool.
- Or grab it directly from the Jira attachment.
- Or continue with section 5 to push it into Azure DevOps.

---

## 5. (Optional) Push the CSV to Azure DevOps

Two ways to do it: **automatic** right after Day 2, or **manual** against any CSV file.

### 5A. Automatic during Day 2

Add to `.env`:

| Variable | Value |
|---|---|
| `ADO_SYNC_APPROVED_CSV` | `true` |
| `ADO_PAT` | A PAT with **Work Items: Read & write** scope |
| `ADO_AREA_PATH_PREFIX` *or* `ADO_DEFAULT_AREA_PATH` | A valid Area Path in your ADO project |
| `ADO_ACTIVE_TEST_PLAN_ID` | The Test Plan id where new work items should land |

**How the agent picks the suite:** it reads the Jira key from the **CSV file name** (e.g. `PROJ-123` in `… (PROJ-123).csv`) and looks for a suite whose name or path inside the plan contains that same key. If nothing matches, it falls back to `ADO_SYNC_SUITE_ID` / `ADO_SYNC_TEST_PLAN_URL`. To disable matching entirely: `ADO_SYNC_SUITE_MATCH_CSV_KEY=false`.

Then run **Day 2** as in section 4. After the CSV is written you'll see `Azure DevOps Test Case #…` lines in the log.

> `ADO_ACTIVE_TEST_PLAN_ID` is **only** for the automatic flow. The manual `ado:sync-csv` script uses `ADO_SYNC_PLAN_ID` (or `--plan-id`) — see 5B.

### 5B. Manual from an existing CSV

**Bash**

```bash
cd PATH_TO_DEMO_AGENT
export ADO_SYNC_JIRA_KEY=PROJ-100
npm run ado:sync-csv -- -p 6329 -s 6330 /path/to/approved-PROJ-100.csv
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:ADO_SYNC_JIRA_KEY="PROJ-100"
npm run ado:sync-csv -- --plan-id 6329 --suite-id 6330 "C:\path\to\approved-PROJ-100.csv"
```

You can omit `-p`/`-s` if `ADO_SYNC_PLAN_ID` / `ADO_SYNC_SUITE_ID` are already in `.env`. Use `npm run ado:list-suites -- <planId>` to find the right suite id.

**Reading plan / suite ids from the ADO URL:** the address bar looks like `…/_testPlans/define?planId=<plan>&suiteId=<suite>`. Everything before `_testPlans` is org/project (`ADO_ORG` / `ADO_PROJECT`) — **not** the plan id.

For all ADO options, see **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** §9.

---

## Command cheat sheet

| Action | Command |
|---|---|
| Install dependencies | `npm install` |
| Start the Web UI | `npm run web` (default port 3847; override with `WEB_UI_PORT=…`) |
| Create / refresh the Desktop shortcut | `npm run shortcut` |
| Single ticket: checklist | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=false node agent-docs.js` |
| Single ticket: test cases | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=false GENERATE_MODE=testcases node agent-docs.js` |
| Single ticket: build CSV after approval | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=true node agent-docs.js` |
| Batch Day 1 | `CHECK_APPROVAL=false npm run batch` |
| Batch Day 2 | `CHECK_APPROVAL=true npm run batch` |
| List ADO Test Plans | `npm run ado:list-plans` |
| List suites in a plan | `npm run ado:list-suites -- <planId>` |
| Export plan as JSON | `npm run ado:export-plan -- <planId>` |
| Sync CSV → ADO (manual) | `npm run ado:sync-csv -- "<path/to/file.csv>"` (optional `--plan-id`/`--suite-id`) |
| Update an existing CSV | `npm run update-csv-flow` (see [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)) |
| Export ADO test cases by tag | `npm run ado:export-tag-csv -- --tag "<tag>"` |
| MCP server for Cursor | `npm run mcp-server` |

---

## Run it on a schedule (daily batch)

Use **two** scheduled jobs (same `agent-batch.js`, different `CHECK_APPROVAL` value):

- Day 1 — `CHECK_APPROVAL=false`
- Day 2 — `CHECK_APPROVAL=true`

Both jobs must run with the project folder as the working directory.

**Linux / macOS crontab — example (Day 1 at 09:00, Day 2 at 18:00):**

```cron
0  9 * * * cd /path/to/Pixel_AI_Agent && CHECK_APPROVAL=false /usr/bin/node agent-batch.js >> logs/day1.log 2>&1
0 18 * * * cd /path/to/Pixel_AI_Agent && CHECK_APPROVAL=true  /usr/bin/node agent-batch.js >> logs/day2.log 2>&1
```

**Windows Task Scheduler:**

- **Program:** full path to `node.exe`
- **Arguments:** full path to `agent-batch.js`
- **Start in:** the project folder
- Set the environment variable `CHECK_APPROVAL` per task (`false` or `true`).

The batch script waits ~2 seconds between issues to stay friendly to Jira's API.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm error code ENOENT — Could not read package.json` | You're not in the project folder. `cd` into the folder that contains `package.json` and `agent-docs.js`. |
| Web UI shows **Folder must contain agent-docs.js (DemoAgent root)** | In **Browse**, pick the folder that contains `agent-docs.js` (usually `…/Pixel_AI_Agent/`, not its parent). |
| Agent posts nothing in Jira | The Jira key must point to a story that has a **Test design** QA sub-task (or directly to that sub-task). Also re-check `JIRA_API_TOKEN`. |
| `APPROVED:` line is ignored | The line must be the **first non-empty line** of a **new** comment. Edits to old comments are not re-read. |
| ADO sync skipped | `ADO_SYNC_APPROVED_CSV` must be `true`, and the PAT must have **Work Items: Read & write**. |
| Suite not matched by file name | The CSV file name must contain the Jira key (e.g. `… (PROJ-123).csv`). As a fallback, set `ADO_SYNC_SUITE_ID`. |
| Port 3847 already in use | Use a different port: `WEB_UI_PORT=4000 npm run web`. |
| macOS Desktop shortcut does nothing on click | Open `/tmp/ai-agent.log` for diagnostics. Most often: the project folder was moved — rebuild the shortcut with `npm run shortcut` from the new location. |
| OpenRouter returns 401 / 403 | Wrong `OPENROUTER_API_KEY` in `.env`, or the configured model needs paid credits. See [OPENROUTER.md](OPENROUTER.md). |

When something fails in batch mode, the file `Batch Summary Archive/batch-summary-YYYY-MM-DD.json` lists every issue, what was attempted, and what went wrong.

---

## Related documentation

| Topic | File |
|---|---|
| Project overview, installation, troubleshooting | [README.md](README.md) |
| CSV column format, architecture, MCP prompts | [TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md) |
| Azure DevOps Test Plans, sync, tag CSV export | [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md) |
| Update an existing CSV when requirements change | [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md) |
| Choosing the LLM model (OpenRouter) | [OPENROUTER.md](OPENROUTER.md) |
