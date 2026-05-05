# Updated CSV Flow

This is a **separate flow** from the default `agent-docs.js` flow.

Goal: take CSV files from `Updated test cases`, re-check them against Jira requirements, post updated content to **Test design QA sub-task**, then use the same approval mechanism and automatic CSV/ADO sync.

## 1) Prepare

- Put your source CSV into `Updated test cases`.
- Optional fast import from `Downloads` by file name:

### Bash

```bash
cd /path/to/DemoAgent
npm run csv:from-downloads -- "Patient app - Redesign_Add post, comment, reply.csv" --to "Updated test cases"
```

### PowerShell

```powershell
cd PATH_TO_DEMO_AGENT
npm run csv:from-downloads -- "Patient app - Redesign_Add post, comment, reply.csv" --to "Updated test cases"
```

- Set environment:
  - `JIRA_ISSUE_KEY=PROJ-12345` (story or Test design sub-task key)
  - `CHECK_APPROVAL=false`
  - optional:
    - `UPDATED_FLOW_INPUT_FILE=<file.csv>` (if omitted, latest CSV in folder is used)
    - `UPDATED_FLOW_MODE=auto|testcases|checklist` (default `auto`)

## 2) Generate updated content (Day 1 style)

### Bash

```bash
cd /path/to/DemoAgent
JIRA_ISSUE_KEY=PROJ-12345 CHECK_APPROVAL=false UPDATED_FLOW_MODE=checklist node agent-update-csv.js
```

### PowerShell

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-12345"
$env:CHECK_APPROVAL="false"
$env:UPDATED_FLOW_MODE="checklist"   # or "testcases" / "auto"
node agent-update-csv.js
```

`UPDATED_FLOW_MODE` can be changed **before each run**:

- `checklist` - force checklist output (legacy segment rules; same as before)
- `testcases` - force test cases output (all `Test Case` parents parsed as test cases, same as before)
- `auto` - walk the CSV **in order** and treat each parent block separately (default)

**`auto` classification (per block, top to bottom):**

1. **Legacy file** (no parent rows with Work Item Type + Title): one checklist segment from all rows (unchanged).
2. **Explicit checklist work item**: Work Item Type contains `checklist` (case-insensitive) → that block is a **checklist** (child rows → checklist items).
3. **`Test Case` work item**:
   - If **every** step row has an empty **Step Expected** → **checklist** block (matches ADO exports where checklists reuse the Test Case shape; items come from Step Action / Title columns).
   - If **at least one** step has a non-empty Step Expected → **test case** block (steps merged like `rowsToTestCases`).

Mixed files are supported: the script runs the test-case LLM and the checklist LLM **as many times as needed**, in **CSV order** (comments on the Jira sub-task may alternate between ADF test-case posts and checklist text posts).

What happens:

1. Reads CSV from `Updated test cases`.
2. Loads Jira requirements from the parent context issue.
3. Finds Test design QA sub-task for that parent.
4. Generates updated checklist and/or test cases (depending on mode).
5. Posts result to Test design sub-task:
   - test cases: ADF table comment + `generated-testcases-<KEY>.json` attachment;
   - checklist: checklist comment.
6. Leaves approval instructions on the Test design sub-task (Update test design only — see below).

## 3) Approval and final CSV + ADO sync (Day 2 style)

**Approval rules (only when the sub-task has posts titled “…(Updated CSV flow)”):** blocks are numbered **1, 2, …** in **chronological order** of posts on that sub-task (checklist comments and test-case JSON segments mixed in time order). Each generated comment repeats **which block number this post is** (e.g. “use APPROVED (2) for this post only”). For checklists exported as multiple parts, the header still shows **Part i/n** among checklists in the file, while **APPROVED (k)** uses the **global** post index on the sub-task when test cases and checklists are mixed.

- **Approve everything:** a new comment whose **first line** is `APPROVED` or `APPROVED: all` (optional trailing `.` / `!`).
- **Approve whole blocks:** `APPROVED (1)`, `APPROVED (2)`, … (parentheses = global block index on the sub-task). The same directives can appear **in one comment** (several lines) or in **several comments** after the latest `Updated CSV flow: source file …` summary — those lines are merged in chronological order before parsing.
- **Approve only some checks inside one block:** `APPROVED (1): 1,2,3,4,…` — block `1`, then item numbers as shown in that post (checklist lines `1. […]` or numbered test cases `1. Title`). Same for `APPROVED (2): …` for Part 2, etc. You can use `APPROVED (n): all` for the whole block *n*.
- **More than one posted block** (test-case segments and/or checklists): a CSV is generated only when **every** block index `1 … N` is explicitly addressed (e.g. `APPROVED (1)` and `APPROVED (2)`, or `APPROVED (1): 1,2` for a partial block), **or** the first line is `APPROVED` / `APPROVED: all` for everything. Checklist `Part i/n` is a file-local label; approval block numbers follow **global** post order on the sub-task.
- **Exactly one block in the thread:** you may still use `APPROVED: 1,2,3` to pick **items inside that single block**, or `APPROVED: all` (without block index).

The default `agent-docs.js` checklist/test-case flow (no “Updated CSV flow” in the post) is unchanged: it still looks for a line starting with `APPROVED:` as before.

After the reviewer adds a comment, run:

### Bash

```bash
cd /path/to/DemoAgent
JIRA_ISSUE_KEY=PROJ-12345 CHECK_APPROVAL=true node agent-update-csv.js
```

### PowerShell

```powershell
cd PATH_TO_DEMO_AGENT
$env:JIRA_ISSUE_KEY="PROJ-12345"
$env:CHECK_APPROVAL="true"
node agent-update-csv.js
```

`agent-update-csv.js` delegates approval step to existing `agent-docs.js` approval flow, so behavior is the same as current process:

- approved-only CSV generation,
- Jira attachment + comment link,
- optional Azure DevOps auto-sync when `ADO_SYNC_APPROVED_CSV=true`.
- additionally for this updated flow, an extra CSV copy is created with parent-task naming:
  - `<Parent Summary> (PROJ-12345) (updated by AI).csv`
  - PROJ key is required in the file name when detected from the parent context.

## Notes

- This flow is isolated from the default generation flow; no change to existing commands.
- If no `UPDATED_FLOW_INPUT_FILE` is set, the newest `.csv` in `Updated test cases` is used.
- Requires usual credentials in `.env` (`JIRA_*`, `OPENROUTER_API_KEY`; and `ADO_*` only for auto-sync).
