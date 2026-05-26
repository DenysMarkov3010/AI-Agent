# AI Test Agent — QA test generation from Jira

A small Node.js tool for QA engineers. It reads a Jira issue, asks an LLM to draft a **checklist** or **test cases**, waits for your approval in a Jira comment, and then exports an **Azure DevOps–compatible CSV**. Pushing that CSV into Azure DevOps as Test Case work items is optional.

> **New here? Read this file first, then [FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) when you need the full step-by-step.**

## Who is this for

- QA engineers who want a first-draft test coverage they can edit, instead of writing from scratch.
- Anyone who needs a ready-to-import CSV with test cases in Azure DevOps format.

You do **not** need to understand the internals to use it — the **Web UI** hides all the commands.

## What you need before you start

| Requirement | Where to get it / how to check |
|---|---|
| **Node.js 18+** | `node -v`. Download from <https://nodejs.org> if missing. |
| **Jira account** + **API token** | <https://id.atlassian.com/manage-profile/security/api-tokens> |
| **OpenRouter API key** (LLM provider) | <https://openrouter.ai/keys>. Pay-as-you-go. |
| **Your Jira project key** | The 3–4-letter prefix on your tickets (e.g. `PROJ` if your keys look like `PROJ-1234`). |
| Azure DevOps **org / project / PAT** | Optional — only if you want CSV → ADO work items. |
| **Google Chrome** (macOS) | The Desktop shortcut opens the Web UI in Chrome. |

## First-time setup (5 minutes)

1. **Open the project folder** in a terminal. This is the folder that contains `package.json` and `agent-docs.js`.

   - macOS: `cd "/Users/<you>/Desktop AI agent/Pixel_AI_Agent"`
   - Windows: `cd C:\path\to\Pixel_AI_Agent`

   > **Important:** if you see `npm error code ENOENT — Could not read package.json`, you are one folder above the correct one. `cd` one level deeper.

2. **Create your `.env`** from the example:

   - macOS / Linux: `cp .env.example .env`
   - Windows: `copy .env.example .env`

3. **Open `.env`** in any editor and fill in at minimum:

   ```dotenv
   JIRA_BASE_URL=https://yourcompany.atlassian.net
   JIRA_EMAIL=your.email@company.com
   JIRA_API_TOKEN=...                # from step "What you need" above
   OPENROUTER_API_KEY=sk-or-v1-...   # from openrouter.ai/keys
   JIRA_PROJECT_KEY=PROJ              # your project prefix
   ```

   Azure DevOps variables (`ADO_*`) are optional — skip them unless you plan to push CSVs into ADO.

4. **Install dependencies:**

   ```bash
   npm install
   ```

5. **Start the Web UI:**

   ```bash
   npm run web
   ```

   Open <http://127.0.0.1:3847/> in Chrome. You should see the AI Test Agent home page.

That's it. After the first `npm run web` you'll also see a Desktop shortcut named **AI Test Coverage** — double-click it next time instead of running the command.

## Using it: the easy path (Web UI)

The home page has two cards:

| Card | What it does |
|---|---|
| **Create new test design** | Generates a fresh checklist or test cases for a Jira issue, then (after you approve in Jira) builds the CSV. |
| **Update test design** | Re-generates an already-existing CSV when requirements change. See [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md). |

A typical "Create" run, step by step:

1. Click **Create new test design**.
2. In **Project folder** click **Browse** and pick the folder that contains `agent-docs.js`. This is the same folder you started `npm run web` from.
3. Type the Jira issue key (for example, `PROJ-1234`).
4. Choose **Checklist** or **Test cases**.
5. Click **Run Day 1**. The agent posts the draft as a Jira comment on the **Test design** QA sub-task.
6. Open the Jira issue, review the items.
7. Add a **new** comment whose **first non-empty line** is one of:
   - `APPROVED: all` — approve everything.
   - `APPROVED: 1,3,5` — approve only these item numbers.
8. Back in the Web UI, click **Run Day 2** with the same Jira key. The agent reads your approval, writes the CSV, and (if Azure DevOps is configured) creates Test Case work items.

The output CSV is saved to the folder set by `CHECKLIST_OUTPUT_DIR` in `.env`. On Windows the default is `OneDrive\Desktop\Checklists and Test cases`. The same file is also attached to the Jira **Test design** sub-task.

For every option, every CLI command, and the batch mode that handles many tickets at once, see **[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)**.

## Using it: the advanced path (CLI)

A few shortcuts you'll use most often:

```bash
# Generate a checklist for one ticket
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false node agent-docs.js

# After you wrote APPROVED: in Jira, build the CSV
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true  node agent-docs.js

# Batch: process every ticket that matches your BATCH_JQL_CHECKLIST
CHECK_APPROVAL=false npm run batch        # Day 1
CHECK_APPROVAL=true  npm run batch        # Day 2 (CSVs for approved items)
```

PowerShell users need to set environment variables on separate lines — see FULL_FLOW_GUIDE.md.

## Documentation map

| File | When to open it |
|---|---|
| **README.md** (this file) | Start here. Installation, quick walk-through, troubleshooting. |
| **[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)** | The step-by-step operational guide — every command, every option, scheduling. |
| **[UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)** | What to do when requirements change and you need to update an existing CSV. |
| **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** | Azure DevOps integration — Test Plans, suite linking, CSV sync, tag export. |
| **[TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)** | The exact CSV format the agent produces (with examples). Also has the Cursor / MCP prompts. |
| **[OPENROUTER.md](OPENROUTER.md)** | Choosing and configuring the LLM model. |

## Desktop shortcut

`npm run shortcut` creates a Desktop shortcut named **AI Test Coverage**. Double-clicking it starts the Web UI (if it is not running yet) and opens the page in your browser. It is created automatically the first time you run `npm run web` and is a one-time, idempotent action.

- **Windows:** `.lnk` file with the project's icon.
- **macOS:** `.app` bundle that opens the page in **Google Chrome** (falls back to your default browser if Chrome is not installed).

If the shortcut stops working after you move the project folder, just run `npm run shortcut` again from the new location.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `npm error code ENOENT — Could not read package.json` | You're not in the project folder. `cd` into the folder that contains `package.json` and `agent-docs.js`. |
| Web UI shows **Folder must contain agent-docs.js (DemoAgent root)** | In **Browse**, pick the folder that contains `agent-docs.js` — usually `…/Pixel_AI_Agent/`, **not** its parent. |
| Web UI does not load / port is already in use | Use a different port: `WEB_UI_PORT=4000 npm run web`. |
| Cursor's Simple Browser cannot reach 127.0.0.1:3847 | Cursor's built-in browser sometimes blocks localhost. Open the URL in regular Chrome or Edge. |
| macOS Desktop shortcut does nothing on click | Check `/tmp/ai-agent.log` for errors. Most often: the project folder was moved — rebuild the shortcut with `npm run shortcut` from the new location. |
| OpenRouter returns 401 / 403 | Wrong `OPENROUTER_API_KEY`, or the model you configured needs paid credits. See [OPENROUTER.md](OPENROUTER.md). |
| Jira returns 401 | Wrong `JIRA_API_TOKEN` or `JIRA_EMAIL`. Re-create the token. |
| `APPROVED:` line is ignored | The line must be the **first non-empty line** of a **new** Jira comment. Edits to old comments are not re-read. |
| No comment posted in Jira | The Jira key must point to a story that has a **Test design** QA sub-task, or directly to that sub-task. |

For deeper diagnostics, the batch summary file `Batch Summary Archive/batch-summary-YYYY-MM-DD.json` is the best starting point.

## Project layout (for the curious)

- `agent-docs.js` — runs one Jira issue end-to-end.
- `agent-batch.js` — same, but for many issues from a JQL query.
- `agent-update-csv.js` — updates an existing CSV when requirements change.
- `ado-*.js` — Azure DevOps client, test plan tools, CSV sync.
- `prompts-docs.js` — the LLM prompts the agent sends.
- `web/` + `web-ui-server.js` — the local Web UI (`npm run web`).
- `mcp-server.js` — MCP integration for Cursor.
- `scripts/desktop-shortcut.js` + `scripts/{create,ensure,launch}-desktop-shortcut.{ps1,sh}` — Desktop shortcut builders (Windows `.ps1`, macOS `.sh`).
- `assets/` — icons used by the Desktop shortcut.

## Shell conventions used in our docs

- **Bash** snippets work on macOS, Linux, and Git Bash for Windows.
- **PowerShell** snippets are for Windows native shell.
- Variable assignments differ between the two; the docs show both side by side whenever it matters.
