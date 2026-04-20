# Reference

**Operations / commands:** [GUIDE.md](GUIDE.md) · **Azure DevOps:** [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)

---

## Test case format (Azure DevOps)

**Pipeline:** [GUIDE.md](GUIDE.md) (generate → approve → CSV → optional Azure DevOps).

This format is used when the agent generates **test cases** (`GENERATE_MODE=testcases`) and for the approved-checklist CSV output. Test cases can be generated in one run (no checklist step), then reviewed in Jira; after you comment `APPROVED: 1,2,5` (or `APPROVED: all`) and run with `CHECK_APPROVAL=true`, the agent produces a CSV with only the approved test cases (including steps).

When **creating new** test cases or **updating existing** ones (with or without a reference CSV), follow the instruction block in **[Prompt: match existing CSV style (Senior QA)](#prompt-match-existing-csv-style-senior-qa)** so steps, expected results, and **Preconditions** (one requirement per line, each line prefixed with `- `) stay consistent with the learned ADO style.

**BDD / Gherkin (Azure DevOps):** canonical rules are in the section **Prompt: BDD / Gherkin generation (Senior QA Automation)** later in this file. That subsection is **excluded** from the text injected into the Jira LLM; it is meant for the **CSV → Azure DevOps** import path (see that section).

## Azure DevOps CSV format

CSV columns: **ID**, **Work Item Type**, **Title**, **Test Step**, **Step Action**, **Step Expected**, **Priority**, **Area Path**, **Assigned To**, **State**.

- One row per test case header (ID + Title); following rows with empty ID are steps for that test case.
- Each step has: **Test Step** (number), **Step Action**, **Step Expected**.
- **Preconditions (step 1):** In **Step Action**, after the `Preconditions:` prefix, each separate sentence or requirement must be on its **own line**, and **each line starts with `- `** (hyphen and space). Do not collapse preconditions into one semicolon-separated paragraph. Quote the CSV cell so embedded newlines are preserved. 

---

## Prompt: match existing CSV style (Senior QA)

**Use this instruction** whenever you generate **new** test cases or **revise** existing ones in this project’s CSV layout (especially when the user supplies a sample or full reference CSV). If no reference CSV is provided, default to the step-action/expected-result tone, granularity, and terminology described in the format above. **Preconditions** always use the multi-line `- ` list rule below, even when reference CSVs use an older one-line semicolon style.

Copy or apply the following to the model / assistant:

```text
You are a Senior QA Engineer specializing in writing high-quality, structured test cases.

Your task is to analyze the provided CSV file with existing test cases and strictly learn the writing style, structure, and level of detail used in the following fields:

* Steps
* Expected Result (or Steps Expected)

Do NOT summarize or simplify. Instead, extract and replicate the exact patterns.

Focus on:

1. Step granularity (how detailed each step is)
2. Sentence structure and wording style
3. Action verbs used (e.g., "Click", "Verify", "Enter")
4. Whether steps are atomic or grouped
5. Formatting conventions (numbering, punctuation, capitalization)
6. Level of detail in expected results (high-level vs very specific UI/system behavior)
7. **Preconditions (step 1):** Each distinct precondition must be on its **own line** in Step Action, and **every line must start with "- "** (hyphen + space) after the `Preconditions:` header line; never a single semicolon-separated run-on line for new or updated cases

After analyzing, you must generate new test cases that:

* Follow the EXACT same structure and tone
* Match the SAME level of detail
* Use SIMILAR phrasing patterns
* Keep consistency in terminology

Rules:

* Do not invent a new style
* Do not generalize steps if original cases are detailed
* Do not make steps shorter or longer than the learned pattern
* Maintain 1:1 consistency with the original approach
* **Preconditions override:** If the reference CSV uses preconditions on one line with semicolons, still output preconditions using the newline + `- ` rule for this project; wording and order of items should match the reference content

If multiple styles are detected, choose the dominant one.

Before generating new test cases:

* Briefly describe (in 3-5 bullet points) the detected style rules

Then:

* Generate new test cases based on the provided feature/request

Output format must match the original CSV structure exactly.

If something is unclear, ask clarifying questions instead of guessing.

Additionally:
Highlight 1 example test case from the input and explain why it represents the style best.

Strict constraint: Your output must be indistinguishable in style from the input test cases. Any deviation is considered incorrect.
```

---

## Prompt: BDD / Gherkin generation (Senior QA Automation)

**Scope:** use this prompt in the **Azure DevOps import** context — when approved **CSV** is synced and you want **BDD-style** content (e.g. **System.Description**, or a separate LLM pass over the feature + CSV before/after sync). It is **excluded** from `loadTestCaseFormatRef()` so the default **`GENERATE_MODE=testcases`** flow in `agent-docs.js` only sees the Pixel CSV prompt, not this block.

**Implementation note:** `ado-sync-csv.js` fills **System.Description** with HTML built from CSV steps; when `ADO_SYNC_BDD_JIRA_CONTEXT` is on (default), it also loads the **parent Jira issue** (same key resolution as the sync: filename / env / CSV ID) to enrich **GIVEN** / **WHEN** / **THEN** if the CSV is thin on expected results. No LLM. This markdown prompt remains the **spec** for stricter Gherkin or a future LLM pass at sync time.

Copy or apply the following to the model / assistant when working **on BDD for ADO import** (replace the feature description placeholder as needed):

```text
You are a Senior QA Automation Engineer with deep expertise in Behavior-Driven Development (BDD), Gherkin syntax, and test automation best practices.

Your task is to generate high-quality BDD test scenarios based on the provided feature description.

Follow these strict rules:

1. Use proper Gherkin structure:
   - Feature
   - Background (only if necessary)
   - Scenario / Scenario Outline
   - Given / When / Then / And

1a. Use **And** deliberately to separate steps (do not pack everything into one long Given/When/Then):
   - After the first **Given**, add **And** for each additional precondition or context clause (one logical clause per line).
   - After the first **When**, add **And** for each additional action or event in the same scenario (same actor/system, same flow).
   - After the first **Then**, add **And** for each separate observable outcome or assertion (one verifiable fact per **And**).
   - Do not merge unrelated checks into a single sentence; prefer several short **And** lines over one comma-heavy sentence.

2. Scenarios must be:
   - Clear and human-readable
   - Deterministic (no ambiguity or vague wording)
   - Atomic (each scenario tests one behavior only)
   - Suitable for automation

3. Step definitions must:
   - Avoid UI-specific language (e.g., avoid "click button", prefer logical actions)
   - Be reusable across scenarios
   - Avoid hardcoded values unless required
   - Use placeholders when appropriate (e.g., "<email>", "<password>")

4. Test coverage must include:
   - Positive scenarios
   - Negative scenarios
   - Edge cases
   - Validation of both successful and failed outcomes

5. Use Scenario Outline when:
   - The same flow is tested with multiple datasets
   - Include an Examples table where appropriate

6. Assertions (Then steps) must:
   - Be explicit and verifiable
   - Clearly define expected system behavior
   - Avoid vague statements like "works correctly" or "is successful"

7. Maintain consistency:
   - Use consistent domain terminology from the feature
   - Avoid synonyms for the same entities or actions

8. Keep output clean:
   - Proper formatting and indentation
   - No explanations or comments
   - Output only valid Gherkin code
```

---

## Prompt: BDD / Gherkin from approved checklist (Summary bundle)

**Scope:** use this prompt when you want a **single consolidated Gherkin document** (“Summary bundle”) built **from an approved checklist** (the checklist items that become CSV `Step Action` rows with empty `Step Expected`).

**Where this output is intended to land:** treat the generated Gherkin as the **human-facing summary** you paste into the destination “Summary/Description” field you use for BDD in your workflow (commonly **Azure DevOps `System.Description`**, sometimes a Jira field — pick one convention for your team and keep it consistent).

**Exclusions:** this section is also **excluded** from `loadTestCaseFormatRef()` because it starts with the same marker prefix as the other BDD prompt block (`## Prompt: BDD / Gherkin ...`) and is stripped by `stripBddPromptSectionFromTestCaseFormat()` in `agent-docs.js`.

Copy or apply the following to the model / assistant (replace placeholders):

```text
You are a Senior QA Engineer + BDD author.

INPUT:
- Jira issue metadata: key, summary, description, labels (if provided)
- Approved checklist items in execution order. Each item is typically written like:
  "Functional: ..." / "Negative: ..." / "Boundary: ..." / "Integration: ..."
  (Change requests may use "Updated Tests:" / "New Tests:" instead.)

GOAL:
Produce ONE Gherkin document that reads as a complete test design summary for the feature.
It must be suitable to paste as a single "Summary bundle" (not scattered fragments).

NON-GOALS:
- Do not output CSV.
- Do not output JSON.
- Do not add commentary outside the Gherkin.

STYLE (match this structure and depth):
Feature: <short product feature name>
  As a <role>
  I want <capability>
  So that <benefit>

  Background:
    Given <minimal shared context>
    And <only stable facts needed by most scenarios>

  Scenario: <atomic scenario title>
    When ...
    Then ...
    And ...

  Scenario Outline: <when parameterization is natural>
    When ...
    Then ...
    Examples:
      | col1 | col2 |

  Rule: <optional grouping title>
    Scenario: ...
      ...

COVERAGE RULES:
1) Default mapping: **each checklist item becomes its own Scenario** (atomic).
2) Merge priority: if adjacent checklist items are clearly ONE end-to-end flow, merge them into a single Scenario **only when ALL are true**:
   - same category prefix (Functional/Negative/Boundary/Integration/Updated Tests/New Tests)
   - the later item reads as a continuation (starts with And/Then/Next/After that OR clearly completes the previous step)
   - merged scenario remains logically “finished” (setup → action → observable outcome), not a grab-bag
3) If a checklist item is a long “catalog/enum” verification (many named sub-items), prefer **Scenario Outline + Examples tables** rather than one giant Then line.
4) Assertions must be verifiable. Prefer multiple short **And** lines over one comma-stuffed sentence.
5) Preserve checklist intent: do not invent new requirements. You may rephrase for Gherkin clarity, but do not add new business rules.
6) Language: English only.

OUTPUT:
- Output ONLY valid Gherkin (no markdown fences, no headings, no explanations).
```

---

## How your QA MCP agent works (documentation-based)

**Operational flow + commands:** [GUIDE.md](GUIDE.md).

Below is a high-level description of what happens when Cursor calls the MCP tool `qa_register_tool`.

### 1. Overall architecture

The agent works with **documentation** (Jira + Confluence) instead of browser automation:

- `agent-docs.js` — main **documentation-based QA agent**:
  - fetches data from Jira via REST API;
  - searches related documentation in Confluence by labels;
  - validates requirements (labels, description);
  - **Stage 1 choice:** generates either a **test checklist** (default) or **test cases** via LLM (`GENERATE_MODE=checklist` or `GENERATE_MODE=testcases`). Test cases use Azure DevOps / Pixel CSV format (Test Step, Step Action, Step Expected); see `REFERENCE.md`;
  - posts checklist or test cases to Jira;
  - checks comments for approval (same for checklist and test cases);
  - generates a CSV file with the approved checklist or approved test cases (including steps for test cases) under **`CHECKLIST_OUTPUT_DIR`**;
  - optionally syncs that CSV to **Azure DevOps Test Case** work items when **`ADO_SYNC_APPROVED_CSV=true`**: the Test Plan id for that automatic run must be **`ADO_ACTIVE_TEST_PLAN_ID`** (not **`ADO_SYNC_PLAN_ID`**); the target **test suite** is found by matching the **Jira key in the CSV file name** (e.g. `PROJ-123`) to suite **titles/paths** in that plan, with **`ADO_SYNC_SUITE_ID`** / URL as fallback (see `ado-sync-csv.js`, `ADO_TEST_PLANS.md` §9);
  - saves result to `report.yaml`.

- `jira-client.js` — client for Jira API:
  - get issue by key;
  - search issues by JQL;
  - add comments;
  - update labels;
  - get comments.

- `confluence-client.js` — client for Confluence API:
  - search pages by labels (CQL);
  - get page content;
  - extract metadata (labels, versions).

- `prompts-docs.js` — builds prompts for LLM:
  - `generateTestChecklistPrompt` — for test checklist generation;
  - supports regular issues and change requests.

- `mcp-server.js` — **MCP server**:
  - runs as a standalone process (`npm run mcp-server` or via Cursor);
  - registers the tool `qa_register_tool`;
  - when called, it launches `node agent-docs.js`, waits for it to finish, reads `report.yaml` and returns it to Cursor.

### 2. Lifecycle of an MCP call

1. In Cursor you write a prompt with Jira issue key, e.g.:  
   > "Call MCP tool `qa_register_tool` from server `ai-test-agent` with issueKey: 'PROJ-123'"
2. The Cursor chat agent decides to call MCP tool `qa_register_tool` and passes:
   - `issueKey` or `goal` — Jira issue key (e.g., "PROJ-123");
   - optionally `checkApproval` — whether to check approval comments.
3. `mcp-server.js`:
   - builds `envOverrides` (sets `JIRA_ISSUE_KEY` for the child process);
   - starts `node agent-docs.js` with those environment variables;
   - waits until `agent-docs.js` writes `report.yaml`;
   - reads `report.yaml` and returns it as text to Cursor.
4. Cursor displays the report in the chat; you can then:
   - review the generated checklist;
   - add an approval comment in Jira;
   - run the agent again to generate CSV with the approved checklist.

### 3. More details about `agent-docs.js`

- **Environment variables**:
  - `JIRA_BASE_URL` or `BASE_URL` — Jira base URL (e.g., "https://yourcompany.atlassian.net");
  - `JIRA_EMAIL` or `LOGIN_EMAIL` — email for Jira authentication;
  - `JIRA_API_TOKEN` — API token for Jira (obtained from Jira Account Settings → Security → API tokens);
  - `CONFLUENCE_BASE_URL` — Confluence base URL (usually same as Jira);
  - `OPENROUTER_API_KEY` — API key for LLM via OpenRouter;
  - `JIRA_PROJECT_KEY` — project key (e.g., "PROJ");
  - `JIRA_ISSUE_KEY` — issue key to process (e.g., "PROJ-123");
  - `GENERATE_MODE` — what to generate in Stage 1: `checklist` (default) or `testcases`;
  - `REQUIRED_LABELS` — JSON array of required labels (optional);
  - `CHANGE_REQUEST_LABEL` — label for change requests (default: "change-request");
  - `CHECK_APPROVAL` — whether to check approval comments (default: "false").

- **Main steps**:
  1. Fetches issue from Jira by `issueKey`.
  2. Validates requirements (checks description; checks labels only if `REQUIRED_LABELS` is configured).
  3. Searches related documentation:
     - Confluence pages by labels;
     - related Jira issues by labels.
  4. Determines if it's a change request (by label).
  5. Generates test checklist or test cases via LLM (depending on `GENERATE_MODE`).
  6. Posts checklist or test cases as Jira comment/attachment.
  7. (Optional) Checks comments for approval (format: "APPROVED: 1,2,3" or "APPROVED: all").
  8. (If approval found) Generates CSV file with approved checklist or approved test cases (`approved-checklist-<ISSUE_KEY>.csv`; for test cases the CSV includes steps).
  9. Saves report to `report.yaml`.

### 4. Prompt design principles

- **For test checklist**:
  - Input: issue key, description, labels, Confluence pages, related Jira issues.
  - LLM generates JSON with `checklistItems` (categories: Functional, Negative, Boundary, Integration — no Regression) and `reasoning`. Functional is the largest category by item count.
  - Supports change requests (categories: Updated Tests, New Tests only — no Regression Tests; New Tests is the larger set).

### 5. Approval workflow

1. Agent generates checklist and posts it as Jira comment.
2. User reviews checklist and adds a comment in format:
   ```
   APPROVED: 1,2,3,5
   ```
   or
   ```
   APPROVED: all
   ```
3. On next run (or if `CHECK_APPROVAL=true`), agent:
   - reads issue comments;
   - finds the latest approval comment;
   - parses approved item numbers;
   - generates CSV file `approved-checklist-<ISSUE_KEY>.csv` with the approved items.


---

## Example prompts for running the `ai-test-agent` MCP tool

**CLI / batch command reference:** [GUIDE.md](GUIDE.md).

In Cursor you can describe the task in natural language. The chat agent will call the MCP tool `qa_register_tool` with your `issueKey` (or `goal`).

### Master prompt for restoring context (recommended first message in a new chat)

- *Prompt for Cursor:*  
  > I am resuming work on the QA MCP agent in the AI Test Agent project. First, read `REFERENCE.md`, `GUIDE.md`, `mcp-server.js`, `agent-docs.js`, `jira-client.js`, `confluence-client.js`, `prompts-docs.js` and the latest `report.yaml` in the project root. Use these files to reconstruct how the MCP server `ai-test-agent` and the tool `qa_register_tool` work, and how the agent generates checklists and, after approval, CSV with the approved checklist from Jira issue descriptions. Then answer my requests as if you implemented this agent: keep the architecture intact, add new code alongside it, and only update guide files when I explicitly ask. All new reports and descriptions should be generated in English.

### Basic usage examples

- **Generate a test checklist for a Jira issue**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `ai-test-agent` with issueKey: "PROJ-123"
  
  The agent will:
  - fetch issue `PROJ-123` from Jira
  - generate a test checklist via LLM (by default, based on the Jira description only)
  - post the checklist as a Jira comment

- **Generate test cases for a Jira issue**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `ai-test-agent` with issueKey: "PROJ-123" and generateMode: "testcases"
  
  The agent will generate **test cases** (Azure DevOps / Pixel CSV format: Test Step, Step Action, Step Expected per step) and add them to the issue. You can then approve with `APPROVED: 1,2,5` and run with `checkApproval: true` to get a CSV with only the approved test cases. See `REFERENCE.md` for format and examples.

- **Generate CSV with approved checklist**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `ai-test-agent` with issueKey: "PROJ-123" and checkApproval: true
  
  The agent will:
  - read the latest `APPROVED:` comment (e.g. `APPROVED: 1,2,3` or `APPROVED: all`)
  - generate file `approved-checklist-PROJ-123.csv` with the approved checklist items

- **Process a change request**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `ai-test-agent` with issueKey: "PROJ-456"
  
  If the issue has a `change-request` label, the agent will adapt the checklist categories to:
  - Updated Tests
  - New Tests (majority of items; no separate Regression category)

### Configuration via environment variables

**Required variables in `.env`:**

```env
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your.email@company.com
JIRA_API_TOKEN=your_api_token_here
OPENROUTER_API_KEY=your_openrouter_key
```

**Optional variables (most common):**

```env
CONFLUENCE_BASE_URL=https://yourcompany.atlassian.net  # If different from Jira
JIRA_PROJECT_KEY=PROJ                               # Jira project key
REQUIRED_LABELS=["example-label-1", "example-label-2"] # JSON array of required labels (optional)
CHANGE_REQUEST_LABEL=change-request                    # Label for change requests

# Stage 1: what to generate (checklist = default, or testcases)
# GENERATE_MODE=checklist                             # default
# GENERATE_MODE=testcases                             # generate test cases in one shot

# Workflow mode (recommended default: false)
CHECK_APPROVAL=false                                  # false: checklist only; true: generate CSV from approvals

# Documentation enrichment (recommended default: false)
ENABLE_CONFLUENCE_SEARCH=false                         # false: use Jira description only
```

### Approval workflow (two-step)

1. **Generate checklist**

```
Call MCP tool with issueKey: "PROJ-123"
```

2. **Review and approve in Jira**

Add a Jira comment under the checklist:

```
APPROVED: 1,2,3,5
```

Or approve all items:

```
APPROVED: all
```

3. **Generate CSV (approved items only)**

```
Call MCP tool with issueKey: "PROJ-123" and checkApproval: true
```

### Process multiple issues (batch)

Use the batch runner for daily processing:
- Day 1: `CHECK_APPROVAL=false` to create checklists
- Day 2: `CHECK_APPROVAL=true` to create TCs for tickets that contain `APPROVED:`

See [GUIDE.md](GUIDE.md) (section **Scheduling**).


---

## Project `Test cases` folder

Place CSV or TXT files here for **single-issue** runs when `ENABLE_TEST_CASES_ANALYSIS=true` (ignored in `npm run batch`). See [GUIDE.md](GUIDE.md).

