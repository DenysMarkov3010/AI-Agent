# Guide — QA agent operations (Jira → approval → CSV → Azure DevOps)

This document is the **single operational guide**: setup, single and batch runs, approval, CSV, optional Azure DevOps. Deep-dive reference: [TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md) (CSV format, architecture, MCP prompts). Azure DevOps APIs: [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md).

In all examples, replace `**PATH_TO_DEMO_AGENT`** with your project folder (e.g. `C:\Users\<you>\OneDrive\Desktop\DemoAgent`).

**Terminal commands:** **Bash** = macOS, Linux, or Git Bash. **PowerShell** = Windows (use separate lines for `$env:…` assignments).

**Web helper:** From the project folder run `npm run web` to open a local page (`http://127.0.0.1:3847/` by default) with a form that mirrors the flow below (labels **Day 1** / **Day 2**, **2A/2B** and **4A/4B** as dropdowns), **copy-paste** Bash and PowerShell, optional **folder picker**, and **Run** for **Day 1** (starts the agent in the chosen project folder). Port: set `WEB_UI_PORT`. **Windows:** when the web UI starts, the server runs `scripts/ensure-desktop-shortcut.ps1` in the background: if **AI Test Agent.lnk** is already on the Desktop, it does nothing; otherwise it creates the shortcut (same steps as `npm run shortcut` — no duplicate).

---

## What happens at each stage


| Stage                      | Who          | Result                                                                                                      |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| 0. Setup                   | You          | Node.js, `npm install`, filled-in `.env`                                                                    |
| 1. (Optional) Azure DevOps | You          | Verify PAT: list Test Plans                                                                                 |
| 2. Day 1 — generate        | Agent        | **Checklist** or **test cases** in Jira (comment on **Test design** QA Sub-task; context from parent story) |
| 3. Review                  | You          | Jira comment: `APPROVED: 1,2,3` or `APPROVED: all` (must be the first non-empty line)                       |
| 4. Day 2 — CSV             | Agent        | Azure DevOps-style CSV under `**CHECKLIST_OUTPUT_DIR`**, plus attachment + link in Jira             |
| 5. (Optional) ADO          | Agent or you | **Test Case** work items in Azure DevOps built from that CSV                                                |


**Batch mode** (`npm run batch`): many issues from JQL; summary in `**Batch Summary Archive/batch-summary-YYYY-MM-DD.json`**.

---

## What to do **after the CSV file is created**

You are **done with the agent** for that ticket unless you want Azure DevOps work items.

1. **Find the file**
  Open the folder set in `**.env`** as `CHECKLIST_OUTPUT_DIR` (default on Windows: `%USERPROFILE%\OneDrive\Desktop\Checklists and Test cases`).  
   Typical names are title-based with Jira key in brackets: `... (<PROJ-KEY>).csv`.
2. **Use the CSV as you need**
  - Open it in Excel / import into your test tool.  
  - Or download the same file from **Jira** (it is attached to the **Test design** subtask when the run succeeds).
3. **If you want Test Cases inside Azure DevOps (work items)** — pick **one** approach:
  - **Automatic:** In `.env` set `ADO_SYNC_APPROVED_CSV=true`, configure `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT` (Work items **Read & write**), and a valid `**ADO_AREA_PATH_PREFIX`** or `**ADO_DEFAULT_AREA_PATH**`. Set `**ADO_ACTIVE_TEST_PLAN_ID**` to the Test Plan where new cases should land (automatic sync uses **only** this plan id — not `**ADO_SYNC_PLAN_ID`** or `**planId**` from `**ADO_SYNC_TEST_PLAN_URL**`). The sync **loads all suites** in that plan, logs their paths, reads the Jira key from the **CSV file name** (e.g. `PROJ-123`), and links new cases to the suite whose **title/path** contains that key; `**ADO_SYNC_SUITE_ID`** / URL is **fallback** if nothing matches. Run **Day 2 again** (`CHECK_APPROVAL=true` for the same issue, or batch Day 2). The agent creates ADO Test Cases after writing the CSV.  
  - **Manual (no second approval run):** From the project folder run:
  **Bash**
    ```bash
    npm run ado:sync-csv -- "/full/path/to/your-approved-file.csv"
    ```
    **PowerShell**
    ```powershell
    npm run ado:sync-csv -- "C:\full\path\to\your-approved-file.csv"
    ```
    **Plan/suite ids** (manual sync only): same as in the browser query string `…/_testPlans/define?planId=…&suiteId=…`. The path segments before `_testPlans` (e.g. `YourOrg/YourProject`) are **organization / project** (`ADO_ORG` / `ADO_PROJECT`), not the plan id. Set **`ADO_SYNC_PLAN_ID`** / **`ADO_SYNC_SUITE_ID`**, or paste the full page URL in **`ADO_SYNC_TEST_PLAN_URL`**, or run sync with **`-p`/`-s`** or **`-u "https://…"`**. Use **`npm run ado:list-suites -- <planId>`** to list suite ids. Optionally **`ADO_SYNC_JIRA_KEY`** / **`--jira-key`** for a `Jira:KEY` tag. (For **automatic** approval sync, plan comes from **`ADO_ACTIVE_TEST_PLAN_ID`** — see **`ADO_TEST_PLANS.md`** §9.)
4. **If you do not use Azure DevOps**
  Nothing else is required. Keep, share, or import the CSV elsewhere.

More options (plan/suite IDs, tags): `[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)` §9.

---

## 0. One-time setup

Copy `.env.example` → `.env` and set at minimum:

- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- `OPENROUTER_API_KEY`
- `JIRA_PROJECT_KEY`

**Bash**

```bash
cd /path/to/DemoAgent
npm install
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
npm install
```

---

## 1. (Optional) Verify Azure DevOps

Requires `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT` in `.env`. Details: `[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)`.

**Bash**

```bash
cd /path/to/DemoAgent
npm run ado:list-plans
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
npm run ado:list-plans
```

Expected: console lists Test Plans (id and name). If empty or errors, check PAT and **Test (Read)** scope.

---

## 2. Day 1 — generate checklist or test cases

### 2A. Single issue (story or Test design sub-task)

**Checklist (default):**

**Bash**

```bash
cd /path/to/DemoAgent
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false RELATED_ISSUES_KEYWORDS="payment status,verification dashboard" node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
$env:RELATED_ISSUES_KEYWORDS="payment status,verification dashboard"
node agent-docs.js
```

Use `RELATED_ISSUES_KEYWORDS` when you want to control related-issue search per single run (instead of automatic words from the issue title). The agent still returns up to 30 related Jira issues.

**Test cases in one run:**

**Bash**

```bash
cd /path/to/DemoAgent
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false GENERATE_MODE=testcases RELATED_ISSUES_KEYWORDS="payment status,verification dashboard" node agent-docs.js
```

**PowerShell**

```powershell
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
$env:GENERATE_MODE="testcases"
$env:RELATED_ISSUES_KEYWORDS="payment status,verification dashboard"
node agent-docs.js
```

### 2B. Batch (recommended daily)

Set `BATCH_JQL_CHECKLIST` in `.env` (typically QA Sub-task “Test design” + status). See `.env.example`.

**Bash**

```bash
cd /path/to/DemoAgent
CHECK_APPROVAL=false npm run batch
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:CHECK_APPROVAL="false"
npm run batch
```

For test cases in batch: set `GENERATE_MODE=testcases` in `.env`, same commands.

---

## 3. Approve in Jira (manual)

On the **Test design** issue where the AI output appeared, add a **new** comment whose **first non-empty line** is:

```text
APPROVED: 1,2,5
```

or

```text
APPROVED: all
```

---

## 4. Day 2 — generate CSV from approved items

### 4A. Single issue

Use the same issue key you use to read comments (often the Test design sub-task or the story, depending on how you run).

**Bash**

```bash
cd /path/to/DemoAgent
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="true"
node agent-docs.js
```

**File location:** directory from `CHECKLIST_OUTPUT_DIR` in `.env` (default on Windows: `OneDrive\Desktop\Checklists and Test cases`). Output files use parent-task title + Jira key format: `… (<PROJ-KEY>).csv`.

### 4B. Batch

**Bash**

```bash
cd /path/to/DemoAgent
CHECK_APPROVAL=true npm run batch
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:CHECK_APPROVAL="true"
npm run batch
```

**Batch summary:** `Batch Summary Archive/batch-summary-YYYY-MM-DD.json`.

---

## 5. (Optional) Create Test Cases in Azure DevOps from the CSV

### 5A. Automatically right after Day 2

In `.env`:

- `ADO_SYNC_APPROVED_CSV=true`
- PAT with **Work items: Read & write**
- `ADO_AREA_PATH_PREFIX` or `ADO_DEFAULT_AREA_PATH` (valid Area Path in your project)
- `**ADO_ACTIVE_TEST_PLAN_ID`** — Test Plan id for new work items (required for this flow; `**ADO_SYNC_PLAN_ID**` / URL `**planId**` are not used for the plan)
- Suite target: **by default**, Jira key from the **CSV filename** is matched against suite **names/paths** in that plan (see `**ADO_TEST_PLANS.md`** §9). Optional `**ADO_SYNC_SUITE_ID**` / `**ADO_SYNC_TEST_PLAN_URL**` (suite only) as **fallback**; `**ADO_SYNC_SUITE_MATCH_CSV_KEY=false`** to use only env/URL

Run the same commands as **section 4** (`CHECK_APPROVAL=true`). After the CSV is written, the agent creates work items (logs show `Azure DevOps Test Case #…`).

### 5B. Manually from an existing file

**Bash**

```bash
cd /path/to/DemoAgent
export ADO_SYNC_JIRA_KEY=PROJ-100
npm run ado:sync-csv -- -p 6329 -s 6330 /path/to/approved-testcases-PROJ-100.csv
```

**PowerShell**

```powershell
cd PATH_TO_DEMO_AGENT
$env:ADO_SYNC_JIRA_KEY="PROJ-100"
npm run ado:sync-csv -- --plan-id 6329 --suite-id 6330 "C:\Users\<you>\OneDrive\Desktop\Checklists and Test cases\approved-testcases-PROJ-100.csv"
```

Omit `-p`/`-s` if `ADO_SYNC_PLAN_ID` / `ADO_SYNC_SUITE_ID` are already in `.env`. Use `npm run ado:list-suites -- <planId>` to pick suite ids.

Variables: `[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)` §9.

---

## Command cheat sheet


| Action                                   | Command                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install dependencies                     | `npm install`                                                                                                                                                                                    |
| Single: checklist                        | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=false node agent-docs.js`                                                                                                                                       |
| Single: test cases                       | `… GENERATE_MODE=testcases node agent-docs.js`                                                                                                                                                   |
| Single: CSV after approve                | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=true node agent-docs.js`                                                                                                                                        |
| Batch Day 1                              | `CHECK_APPROVAL=false npm run batch`                                                                                                                                                             |
| Batch Day 2                              | `CHECK_APPROVAL=true npm run batch`                                                                                                                                                              |
| List ADO Test Plans                      | `npm run ado:list-plans`                                                                                                                                                                         |
| List suites in a plan                    | `npm run ado:list-suites -- <planId>`                                                                                                                                                            |
| Optional: export plan JSON               | `npm run ado:export-plan -- <planId>`                                                                                                                                                            |
| CSV → Azure DevOps (manual)              | `npm run ado:sync-csv -- "<path\to\file.csv>"` (optional `--plan-id` / `--suite-id`, or `ADO_SYNC_*` in `.env`)                                                                                  |
| CSV → Azure DevOps (auto after approval) | `.env`: `ADO_SYNC_APPROVED_CSV=true`, `**ADO_ACTIVE_TEST_PLAN_ID**`; suite from **filename key** ↔ ADO suite path; fallback `ADO_SYNC_SUITE_ID`; see `[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)` §9 |
| MCP server                               | `npm run mcp-server`                                                                                                                                                                             |


---

## Scheduling (daily batch runs)

Use **two** scheduled tasks (or cron jobs): Day 1 `CHECK_APPROVAL=false`, Day 2 `CHECK_APPROVAL=true`, same `agent-batch.js`; **Start in** = project folder.

**Windows Task Scheduler:** Program `node.exe` (or full path), arguments `C:\path\to\DemoAgent\agent-batch.js`, set env `CHECK_APPROVAL` per task.

**Linux/macOS crontab example:** `0 9 * * * cd /path/to/DemoAgent && CHECK_APPROVAL=false /usr/bin/node agent-batch.js >> logs/batch.log 2>&1`

**Logs:** redirect stdout to a daily log file (see PowerShell/Bash examples in older notes). **Summary:** `Batch Summary Archive/batch-summary-YYYY-MM-DD.json`. Rate limiting: ~2s between issues.

**JQL:** configure `BATCH_JQL_CHECKLIST` and `BATCH_JQL_APPROVAL` in `.env` (see `.env.example`).

---

## Related docs (consolidated)


| Topic                                         | File                                     |
| --------------------------------------------- | ---------------------------------------- |
| CSV format, architecture, MCP prompts         | [TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md) |
| Azure DevOps Test Plans, sync, export tag CSV | [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)     |
| Project overview                              | [README.md](README.md)                     |


