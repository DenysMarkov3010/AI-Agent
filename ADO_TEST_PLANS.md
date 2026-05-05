# Azure DevOps: Test Plans and direct test case analysis

**Where this fits in the overall pipeline:** `[GUIDE.md](GUIDE.md)` (stages 1, 4–5).

**Terminal commands:** where both appear, **Bash** = macOS / Linux / Git Bash; **PowerShell** = Windows.

This integration talks to **Azure DevOps over the REST API only**. Test cases remain the **source of truth in Azure DevOps**; the agent **reads** them in real time (in memory), optionally filters them, analyzes them, and can then drive checklist / test case generation — **without** having to import or mirror the whole plan into a local file first.

Official API documentation: [Test Plan REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/testplan/), [Work Items](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items), [WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql).

---

## How analysis works (directly in / from Azure DevOps)


| Step                  | What happens                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Connect            | `ado-client.js` uses your org, project, and PAT — all calls go to Azure DevOps.                                                                                                     |
| 2. Choose scope       | Either a **Test Plan** (plan id → suites → case ids) or a **WIQL** query (e.g. filter **Test Cases** by **tags**, area path, state).                                                |
| 3. Load details       | `getWorkItemsByIds` loads titles, steps, and other fields from work items — still **live data** from ADO, not a stale file.                                                         |
| 4. Analyze & generate | Your script or LLM pipeline uses that payload to **review coverage, gaps, or duplicates**, then **generates** new checklists or test cases (same idea as `agent-docs.js` for Jira). |


**Export to JSON** (`npm run ado:export-plan`) is **optional**: useful for debugging, snapshots, or sharing. The primary model for automation is **API → memory → analysis/generation**, not “download file first.”

**Filtering by tags:** use **WIQL** (e.g. `[System.Tags] CONTAINS 'your-tag'`). The client exposes `runWiql(wiql)` for this. To narrow to cases that also belong to a specific Test Plan, combine WIQL with your process (e.g. query by tags and intersect with ids from the plan, or use fields/links your project uses).

---

## 1. What the code reads


| Resource                                                    | Purpose                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET .../testplan/plans`                                    | List Test Plans (to find **Plan ID**)                                       |
| `GET .../testplan/plans/{planId}`                           | One plan (including **rootSuite**)                                          |
| `GET .../testplan/plans/{planId}/suites`                    | Child suites (`parentSuiteId`)                                              |
| `GET .../testplan/plans/{planId}/suites/{suiteId}/testcase` | Test Case work item references in a suite                                   |
| `POST .../wit/wiql`                                         | **WIQL** — filter Test Cases (tags, etc.) **without** exporting a plan file |
| `GET .../wit/workitems?ids=...`                             | Work item fields (title, steps) for analysis                                |


Test Case step text lives in **work items**, so you need **Work Items (Read)** on the PAT for full text analysis, in addition to **Test (Read)** for plan/suite APIs.

---

## 2. Environment variables (`.env`)

Copy the **Azure DevOps** block from `.env.example` and fill in the values:


| Variable                      | Required | Description                                                                                                                                                            |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADO_ORG`                     | Yes      | Organization segment after `https://dev.azure.com/`                                                                                                                    |
| `ADO_PROJECT`                 | Yes      | Project name (as in the URL)                                                                                                                                           |
| `ADO_PAT`                     | Yes      | Personal Access Token (see section 3)                                                                                                                                  |
| `ADO_ACTIVE_TEST_PLAN_ID`     | No       | Default **active** (feature) Test Plan id for `npm run ado:export-plan` / `npm run ado:list-suites` when no CLI argument                                               |
| `ADO_REGRESSION_TEST_PLAN_ID` | No       | **Regression** Test Plan id for regression coverage / gap analysis (vs active plan); use with `list-suites` / `export-plan` or custom tooling that reads `process.env` |
| `ADO_SERVER_URL`              | No       | Default `https://dev.azure.com`; for **Azure DevOps Server**, set the collection URL                                                                                   |
| `ADO_API_VERSION`             | No       | Test Plan API version (default `7.1-preview.1`)                                                                                                                        |
| `ADO_WIT_API_VERSION`         | No       | WIT / WIQL API version (default `7.1`)                                                                                                                                 |
| `ADO_EXPORT_DIR`              | No       | Optional folder for JSON exports only                                                                                                                                  |


Alternative names: `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT`.

**Active vs regression:** `ADO_ACTIVE_TEST_PLAN_ID` is the default plan when you run `npm run ado:list-suites` or `npm run ado:export-plan` **without** a numeric argument. Set `**ADO_REGRESSION_TEST_PLAN_ID`** to the **regression** Test Plan id used for regression coverage / gap analysis (e.g. compare against the active plan in tooling or prompts). To inspect the regression plan once, pass its id explicitly: `npm run ado:list-suites -- <id>` or `npm run ado:export-plan -- <id>`.

**Legacy:** `ADO_TEST_PLAN_ID` is still read as a fallback for the active plan id only (same role as `ADO_ACTIVE_TEST_PLAN_ID`); rename to `ADO_ACTIVE_TEST_PLAN_ID` when you can.

---

## 3. Personal Access Token (PAT)

1. **User settings** → **Personal access tokens** → **New Token**.
2. **Custom defined** scopes.
3. **Test** → **Read** (plans, suites, cases in plan).
4. **Work items** → **Read** (WIQL, work item fields, Test Case steps).

Keep scopes minimal; do not add Build/Code/Release unless needed.

Store as `ADO_PAT` in `.env`. **Do not commit** `.env`.

---

## 4. How to find Plan ID

**From the URL:** look for `planId=...` in the Test Plan URL.

**From CLI:**

**Bash**

```bash
npm run ado:list-plans
```

**PowerShell**

```powershell
npm run ado:list-plans
```

First column = **Plan ID**.

---

## 5. npm commands (optional export)


| Command                               | Action                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run ado:list-plans`              | List Test Plans (id, name, rootSuite)                                                                             |
| `npm run ado:list-suites -- <planId>` | List suites in that plan (`suiteId`, path, test case count) — use ids for `ado:sync-csv` / `ADO_SYNC_`*           |
| `npm run ado:export-plan`             | Write a **snapshot** JSON under `ado-exports/` (suite tree + case ids) — **not** required for direct API analysis |
| `npm run ado:export-tag-csv`          | Export all **Test Cases** whose **Tags** contain a substring to **one CSV** in `Test cases/` — see §5a            |


**Bash**

```bash
npm run ado:export-plan -- 12345
```

**PowerShell**

```powershell
npm run ado:export-plan -- 12345
```

### 5a. Export Test Cases by tag → CSV (`Test cases/`)

Use this when you want a **local  CSV** of every Test Case in the project whose **Tags** field contains a given text (same idea as `[System.Tags] CONTAINS` in WIQL).

**Flow**

1. **WIQL** loads all matching work item ids: `Test Case` type and tag substring.
2. **Work Items API** loads fields in batches (title, steps, priority, area path, assignee, state).
3. Steps are read from **Microsoft.VSTS.TCM.Steps** and written in the usual columns (**Test Step**, **Step Action**, **Step Expected**). ADO often stores step text as HTML; the exporter **always strips tags** so the CSV contains only plain text.
4. Output defaults to `**Test cases/<tag>.csv`** — the file name matches the import tag (characters that are invalid in file names are replaced with `_`). Path is relative to the current working directory when you run npm (usually the project root).
5. **Each run keeps a single CSV in that folder:** before writing, **all other `.csv` files** in the same directory as the output file are **removed** (then the new file is written). Override path with `**-o`** / `**--output**` or `**ADO_TAG_CSV_PATH**` in `.env` (the same cleanup applies to that folder). Put unrelated CSVs elsewhere if you need to keep them.

**Bash**

```bash
npm run ado:export-tag-csv -- --tag Regression
```

**PowerShell**

```powershell
npm run ado:export-tag-csv -- --tag="Regression"
```

Optional: `npm run ado:export-tag-csv -- --tag smoke -o "Test cases/custom-name.csv"`

**Tags with parentheses or spaces:** In PowerShell, `( )` are special unless the value is quoted. Prefer one of:

- **Equals form (one argv token):** `npm run ado:export-tag-csv -- --tag=Regression(smoke)` or `--tag="Regression (smoke)"`
- **Tag file:** put the exact tag on the first line of e.g. `tag.txt`, then `npm run ado:export-tag-csv -- --tag-file tag.txt`
- `**.env`:** `ADO_EXPORT_TAG=Regression (smoke)` then run without `--tag`

If the query returns **no** work items, any **existing** file at the output path is **removed** so you do not keep a stale export.

**Fewer rows than expected:** The exporter only includes work items of type **Test Case** whose `**System.Tags`** field matches the substring (WIQL `CONTAINS`). Items that appear only under a Test Plan filter but **do not** have that tag on the work item itself, or items of another type (e.g. shared steps), are **not** returned. Run with `**--verbose`** to print the list of ids returned by WIQL. If the console shows a **Warning** about ids “not returned by the API”, those work items were in the WIQL result but were omitted when loading details (permissions, deleted, or wrong project).

---

## 6. Suggested automation flow (no file)

1. Instantiate `AdoClient` with env credentials.
2. **Option A — by plan:** walk plan/suites (`getTestPlan`, `listChildSuites`, `listTestCasesInSuite`), collect work item ids.
3. **Option B — by tags:** `runWiql(\`SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'tag')`, collect ids from` workItems`.
4. **Option C — combine:** intersect ids from A with results from B in your script.
5. `getWorkItemsByIds(ids)` — load fields needed for analysis.
6. Pass structured text to your LLM (chunk if large), then generate checklists / new test cases per your prompts.

---

## 7. Common issues


| Symptom                                                             | What to check                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Access Denied`                                             | PAT, expiry, scopes                                                                                                                                                                                                                                                                                                                |
| WIQL errors                                                         | [WIQL syntax](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax), project process (field names)                                                                                                                                                                                                            |
| Empty plan                                                          | Wrong `ADO_PROJECT` or no plans                                                                                                                                                                                                                                                                                                    |
| No step text                                                        | **Work items (Read)**                                                                                                                                                                                                                                                                                                              |
| Create Test Case fails (403 / field error)                          | PAT needs **Work items (Write)**; **Area Path** must match the project (see `ADO_AREA_PATH_PREFIX` / `ADO_DEFAULT_AREA_PATH`)                                                                                                                                                                                                      |
| `404` on `.../testplan/.../testcase` — “controller … was not found” | Often **Azure DevOps Server** routing: the supported URL is `.../testplan/Plans/{planId}/Suites/{suiteId}/TestCase` with `**api-version=7.1`** (the client uses this; set `**ADO_TESTPLAN_API_VERSION**` if your server needs another version). Also confirm **suite id** comes from `ado:list-suites`, not a random work item id. |


---

## 9. Push approved CSV to Azure DevOps (after Jira approval)

After you approve a checklist or AI test cases and run with `**CHECK_APPROVAL=true`**, the agent writes the same **Azure-style CSV** as today (locally + Jira attachment). You can **also** create **Test Case** work items in Azure DevOps from that file.

### Automatic sync (with approval run)

1. Set `**ADO_SYNC_APPROVED_CSV=true`** in `.env`.
2. Ensure the PAT has **Work items → Read & write** (not read-only).
3. Set `**ADO_ACTIVE_TEST_PLAN_ID`** to the Test Plan id where new cases should be linked (same as your **active** plan for `ado:export-plan` / `ado:list-suites`). **Automatic sync uses this plan id only** — it does **not** use `**ADO_SYNC_PLAN_ID`** or the `**planId**` from `**ADO_SYNC_TEST_PLAN_URL**` (those apply to **manual** `npm run ado:sync-csv` only).
4. Set area path helpers if needed (see table below).
5. **Suite selection (default):** the sync calls Azure DevOps `**GET .../_apis/test/Plans/{planId}/suites`** (Test REST API) to load **all suites in one paginated response**, builds each suite’s **path** from `parent` links, reads the Jira key from the **CSV file name** (e.g. `approved-testcases-PROJ-123.csv` or `… (PROJ-123).csv`), and picks the suite whose **name or path** contains that key as a **token** (so `PROJ-123` does not match `PROJ-1234`). The log prints **one line**: either `**"KEY" → suite {id} — {path}`** or `**"KEY" → Not found**`. New Test Cases are **linked to that suite**. If no suite matches, `**ADO_SYNC_SUITE_ID`** / `**ADO_SYNC_TEST_PLAN_URL**` (suite only) is used as **fallback** when set. If the bulk call fails, the client **falls back** to walking the tree (`testplan` API per suite). Set `**ADO_SYNC_SUITE_USE_TREE_WALK=true`** to force the slow tree walk only.
6. Set `**ADO_SYNC_SUITE_MATCH_CSV_KEY=false**` only if you want to **skip** listing/matching and use `**ADO_SYNC_SUITE_ID`** / URL alone. Optional `**ADO_SYNC_SUITE_LIST_VERBOSE=true**` prints many suite lines (capped by `**ADO_SYNC_SUITE_LIST_MAX**`, default `**50**`).
7. Run the agent / batch with `**CHECK_APPROVAL=true**` as usual. After the CSV is generated, work items are created; the run logs `Azure DevOps Test Case #…` lines.

**Naming in Azure DevOps:** create or rename a suite so its **title** (or a segment of the path) includes the Jira key, e.g. a suite named `**PROJ-123`** or `**… / PROJ-123 / …**`, so the matcher can find it.

### Pick a Test Suite (plan id + suite id)

In the browser the URL looks like:  
`…/{org}/{project}/_testPlans/define?planId=12686&suiteId=14213`  

- `**suiteId**` matches `**ADO_SYNC_SUITE_ID**`, `**-s**`, and the REST API. For **automatic approval sync**, `**planId` in the URL is not used** — use `**ADO_ACTIVE_TEST_PLAN_ID`** for the plan (see §9 *Automatic sync*). For **manual** `ado:sync-csv`, `**planId*`* matches `**ADO_SYNC_PLAN_ID**`, `**-p**`, etc.  
- The `**org**` / `**project**` path segments (e.g. `YourOrg` / `YourProject`) map to `**ADO_ORG**` / `**ADO_PROJECT**` — do not confuse them with the plan id.

Ways to choose ids:

1. **Manual sync:** copy `**planId`** / `**suiteId**` into `**ADO_SYNC_PLAN_ID**` / `**ADO_SYNC_SUITE_ID**`, or paste the full URL into `**ADO_SYNC_TEST_PLAN_URL**`.
2. **Automatic approval sync:** set `**ADO_ACTIVE_TEST_PLAN_ID`** (plan); suite is resolved by **Jira key in the CSV file name** vs suite **titles/paths** in that plan, with `**ADO_SYNC_SUITE_ID`** / URL as fallback.
3. `**npm run ado:list-plans**` — plan id is the first column.
4. `**npm run ado:list-suites -- <planId>**` — the `**suiteId**` column for each suite.
5. CLI (`ado:sync-csv` only): `**-p**` / `**-s**` or `**-u "https://dev.azure.com/…/define?planId=…&suiteId=…"**`.

### Manual sync (any CSV on disk)

**Bash**

```bash
npm run ado:sync-csv -- "/path/to/approved-testcases-PROJ-123.csv"
```

**PowerShell**

```powershell
npm run ado:sync-csv -- "C:\path\to\approved-testcases-PROJ-123.csv"
```

With a specific suite (overrides `.env` for this run):

**Bash**

```bash
npm run ado:sync-csv -- --plan-id 12686 --suite-id 14213 "/path/to/approved-testcases-PROJ-123.csv"
npm run ado:sync-csv -- -p 12686 -s 14213 ./approved.csv
npm run ado:sync-csv -- -u "https://dev.azure.com/YourOrg/YourProject/_testPlans/define?planId=12686&suiteId=14213" ./approved.csv
```

**PowerShell**

```powershell
npm run ado:sync-csv -- --plan-id 12686 --suite-id 14213 "C:\path\to\approved-testcases-PROJ-123.csv"
npm run ado:sync-csv -- -p 12686 -s 14213 .\approved.csv
npm run ado:sync-csv -- -u "https://dev.azure.com/YourOrg/YourProject/_testPlans/define?planId=12686&suiteId=14213" .\approved.csv
```

You can mix CLI and `.env` (e.g. plan in `.env`, `**--suite-id**` only). Plan id and suite id must both be set somewhere, or both omitted (work items are created but not added to a plan suite).

Optional: `**ADO_SYNC_JIRA_KEY=PROJ-123**` or `**--jira-key PROJ-123**` / `**-j**` so the tag `**Jira:PROJ-123**` is set on each new Test Case.

### Extra environment variables (sync)


| Variable                                 | Purpose                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADO_SYNC_APPROVED_CSV`                  | `true` to run sync after approval CSV is written                                                                                                                                                                                                                                            |
| `ADO_SYNC_BDD_FROM_PROMPT`               | Default **on** (`false` / `0` / `no` to disable). When on, **after** each Test Case is created in Azure DevOps, the importer makes one LLM call per work item using the prompt from **TEST_CASE_FORMAT.md → "Prompt: BDD / Gherkin for Azure DevOps Summary"** and writes the resulting Gherkin into **System.Description** (Summary tab → Description). Requires `OPENROUTER_API_KEY`. Mode (`test_case` / `checklist`) is auto-detected per Test Case based on Step Expected fill rate. Failures of BDD generation are non-fatal: a warning is logged and the imported work item is preserved with empty Description. |
| `ADO_SYNC_BDD_MAX_TOKENS`                | Max tokens for the BDD LLM call per Test Case (default `2000`).                                                                                                                                                                                                                              |
| `ADO_AREA_PATH_PREFIX`                   | If the CSV **Area Path** column is short (e.g. `YourProject`), full ADO path can be `PREFIX\YourProject`                                                                                                                                                                                        |
| `ADO_DEFAULT_AREA_PATH`                  | Used when the CSV row has empty Area Path                                                                                                                                                                                                                                                   |
| `ADO_TEST_CASE_WORK_ITEM_TYPE`           | Defaults to `Test Case` (change if your process renames the type)                                                                                                                                                                                                                           |
| `ADO_JIRA_TAG_PREFIX`                    | Defaults to `Jira`; tag becomes `Jira:STORY-KEY`                                                                                                                                                                                                                                            |
| `ADO_ACTIVE_TEST_PLAN_ID`                | **Required for automatic approval sync** — Test Plan id where new cases are linked (same as `**ADO_ACTIVE_TEST_PLAN_ID`** for export/list). **Not** used by manual `ado:sync-csv` (that uses `ADO_SYNC_PLAN_ID` / `ADO_SYNC_TEST_PLAN_URL` / `-p`). Legacy `ADO_TEST_PLAN_ID` if unset.     |
| `ADO_SYNC_PLAN_ID` / `ADO_SYNC_SUITE_ID` | Same numbers as `**planId` / `suiteId`** in the Test Plan page URL — **manual** `ado:sync-csv` and CLI. **Automatic approval sync:** set `**ADO_SYNC_SUITE_ID`** (and suite from URL if needed); **do not** rely on `**ADO_SYNC_PLAN_ID`** for the plan (use `**ADO_ACTIVE_TEST_PLAN_ID**`) |
| `ADO_SYNC_TEST_PLAN_URL`                 | Full browser URL `…/define?planId=…&suiteId=…` — **manual** sync: full plan/suite. **Automatic approval sync:** **suite id** from URL is used as **fallback** when no suite matches the Jira key; **plan id in URL is ignored**                                                             |
| `ADO_SYNC_SUITE_MATCH_CSV_KEY`           | Default **on** (set to `false` to disable). When on, automatic sync lists suites and matches **Jira key from CSV filename** to suite name/path                                                                                                                                              |
| `ADO_SYNC_SUITE_LIST_VERBOSE`            | `true` to print many suite id/path lines after load (default: **one** line — match or **Not found**)                                                                                                                                                                                        |
| `ADO_SYNC_SUITE_LIST_MAX`                | With verbose: max suite lines printed (default `**50`**; full list is still loaded for matching)                                                                                                                                                                                            |
| `ADO_SYNC_SUITE_USE_TREE_WALK`           | `true` = do **not** use bulk `GET .../test/Plans/.../suites`; use slow per-node tree API only                                                                                                                                                                                               |
| `ADO_TEST_PLAN_BULK_API_VERSION`         | API version for bulk suite list (default `**5.0`** only — no 7.x probe; override if your server requires another version)                                                                                                                                                                   |


---

## 8. Files in the repository


| File                    | Role                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ado-client.js`         | Plans, suites, cases, **WIQL**, get work items, **create work items**, **add cases to suite**, `**listFlatSuitesInPlan`** (suite tree for sync matching) |
| `ado-plan-tools.js`     | CLI: `list` / `suites` / `export` (optional snapshot)                                                                                                    |
| `ado-sync-csv.js`       | Parse approved CSV → create Test Cases in Azure DevOps; CLI `ado:sync-csv`                                                                               |
| `ado-export-tag-csv.js` | WIQL by tag → CSV in `Test cases/`; CLI `ado:export-tag-csv`                                                                                       |
| `ADO_TEST_PLANS.md`     | This guide                                                                                                                                               |


`ado-exports/` is in `.gitignore` for optional JSON snapshots.