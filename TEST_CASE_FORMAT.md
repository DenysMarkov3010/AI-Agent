# Reference

**Operations / commands:** [GUIDE.md](GUIDE.md) · **Azure DevOps:** [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)

---

## Test case format (Azure DevOps)

**Pipeline:** [GUIDE.md](GUIDE.md) (generate → approve → CSV → optional Azure DevOps).

This format is used when the agent generates **test cases** (`GENERATE_MODE=testcases`) and for the approved-checklist CSV output. Test cases can be generated in one run (no checklist step), then reviewed in Jira; after you comment `APPROVED: 1,2,5` (or `APPROVED: all`) and run with `CHECK_APPROVAL=true`, the agent produces a CSV with only the approved test cases (including steps).

When **creating new** test cases or **updating existing** ones (with or without a reference CSV), follow the instruction block in **[Prompt: match existing CSV style (Senior QA)](#prompt-match-existing-csv-style-senior-qa)** so steps, expected results, and **Preconditions** (one requirement per line, each line prefixed with `-` ) stay consistent with the learned ADO style.

**BDD / Gherkin (Azure DevOps Summary):** canonical rules are in the section **[Prompt: BDD / Gherkin for Azure DevOps Summary (Senior QA Automation)](#prompt-bdd--gherkin-for-azure-devops-summary-senior-qa-automation)** later in this file. The output of that prompt is intended to fill the Azure DevOps **Summary / `System.Description`** field of the imported Test Case work item. The prompt supports two input modes — approved **test cases** (one Scenario per test case) and approved **checklists** (curated, merged scenarios — not one Scenario per checklist item). That subsection is **excluded** from the text injected into the Jira LLM for JSON; it is meant for the **CSV → Azure DevOps** import path.

## Azure DevOps CSV format (Prescriptions)

CSV columns: **ID**, **Work Item Type**, **Title**, **Test Step**, **Step Action**, **Step Expected**, **Priority**, **Area Path**, **Assigned To**, **State**.

- One row per test case header (ID + Title); following rows with empty ID are steps for that test case.
- Each step has: **Test Step** (number), **Step Action**, **Step Expected**.
- **Preconditions (step 1):** In **Step Action**, after the `Preconditions:` prefix, each separate sentence or requirement must be on its **own line**, and **each line starts with `-`**  (hyphen and space). Do not collapse preconditions into one semicolon-separated paragraph. Quote the CSV cell so embedded newlines are preserved. The examples below may still show the legacy one-line style; use this format for **all new and updated** test cases.

## Prompt: match existing CSV style (Senior QA)

**Use this instruction** whenever you generate **new** test cases or **revise** existing ones in this project’s CSV layout (especially when the user supplies a sample or full reference CSV). If no reference CSV is provided, default to the patterns in the examples above (Step Action / Step Expected tone, granularity, and terminology). **Preconditions** always use the multi-line `-`  list rule below, even when reference CSVs use an older one-line semicolon style.

The prompt below is **phased**: the model first detects style and asks for missing context, then plans the test cases, only after that emits the CSV, and finally runs a silent self-check. This is intentional — review the plan (Phase 3) before letting it generate the full CSV (Phase 4) on large features.

Copy or apply the following to the model / assistant:

```text
ROLE
You are a Senior QA Engineer for the YourProject (Azure DevOps) project, specializing in writing high-quality, structured test cases and migrating an existing CSV style to new features.

OBJECTIVE
Given (a) an optional reference CSV with existing test cases and (b) a feature/request description, produce new test cases that are stylistically indistinguishable from the reference, while applying a small set of project-level overrides defined below.

INPUT CONTRACT
- reference_csv (optional): CSV with columns, in this exact order:
  ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path, Assigned To, State.
  One header row per case (ID + Title filled), followed by step rows where ID is empty and Test Step is the step number.
- feature_request: free-form description of the feature, change request, user story, bug, or acceptance criteria.
- mode (optional): "test_case" | "checklist". If not provided, auto-detect from reference_csv:
  > 50% of step rows have empty Step Expected → "checklist", else → "test_case".
  If there is no reference CSV, default to "test_case".

OUTPUT CONTRACT
- A single CSV block, UTF-8, CRLF line endings, comma-separated.
- All fields containing commas, quotes, or newlines are wrapped in double quotes; embedded quotes are escaped as "".
- Same column order as the input.
- Header row included only if the user explicitly asks; otherwise output rows only (header case row + step rows for each generated case).
- ID column: leave empty for new cases.
- Default field values when not specified by the user:
    Work Item Type = "Test Case"
    Priority       = 2
    Area Path      = "YourProject"
    Assigned To    = (copy from the dominant value in reference_csv; otherwise leave empty)
    State          = "Ready"
- Language: English.
- Suggested filename (mention once before the CSV block): <ISSUE_KEY-or-feature>_<short-area>.csv

STYLE POLICY
There are two layers. They never conflict because overrides always win.

  A) STYLE_TO_MIMIC — extract from reference_csv and reproduce 1:1:
     1. Step granularity (atomic vs grouped — keep the dominant pattern).
     2. Sentence structure, wording, capitalization, punctuation.
     3. Action verbs (e.g., Click / Enter / Select / Verify / Open / Log in).
     4. Step Expected depth (high-level summary vs detailed UI/system behavior).
     5. Title pattern (imperative or noun phrase, ≤ 80 chars, no trailing period).
     6. Use of bullet/`-` sub-lists inside Step Expected for multi-fact assertions.
     7. Domain terminology (entities, screens, roles) — copy verbatim.

  B) STYLE_OVERRIDES — always apply, even if the reference does it differently.
     These are project policy, not style deviations:
     1. Preconditions (Test Step = 1):
        - Step Action must start with the literal line: Preconditions:
        - Each distinct precondition on its OWN line, every such line starts with "- " (hyphen + space).
        - Never collapse preconditions into one semicolon-separated run-on line.
        - Order and wording of preconditions must match the reference content where applicable.
        - Step Expected for the preconditions row is empty (or "—" if the reference uses a placeholder dash).
     2. Default field values listed in OUTPUT CONTRACT, unless the user overrides them.
     3. ID is empty for new cases.

PHASED EXECUTION (do in order — do not skip or reorder)

PHASE 1 — Style detection
  Output exactly one section titled "Detected style" with 3–5 bullets covering:
  granularity, dominant action verbs, expected-result depth, title pattern, sub-list usage.
  Then output one section titled "Vocabulary" listing:
  - action_verbs: { ... }
  - assertion_patterns: { ... }   # e.g., "is displayed", "is opened", "is updated"
  - negation_patterns: { ... }    # e.g., "is not displayed", "is disabled"
  Use ONLY these verbs/patterns in Phase 4 unless the feature requires a clearly new domain term.
  Then output one section titled "Canonical example" — quote ONE step from the reference (Step Action + Step Expected) and explain in 1–2 sentences why it best represents the style.

PHASE 2 — Feature understanding
  Restate the feature in 2–4 bullets: what is being tested, key actors/roles, key data, key states.
  If any of the items below are missing or ambiguous, STOP and ask clarifying questions; do NOT proceed to Phase 3.
    - Target user role / permissions
    - Pre-existing data state (e.g., "is the event already created?")
    - Expected behavior on validation failure
    - Notification channels (email / push / in-app) — which are required, if any
    - Data ranges, limits, boundaries (e.g., max participants count)

PHASE 3 — Test plan (titles only, no steps yet)
  Output a list of test case titles you will generate, grouped by type:
    - Happy path
    - Negative / validation
    - Boundary / edge state (loading, empty, error)
    - Permissions / role-based
    - Cross-feature interactions (only if explicitly mentioned in the feature)
  Default scope: 5–12 cases per feature unless the user specifies otherwise.
  Each title must trace back to at least one acceptance criterion or stated behavior; do not invent requirements.

  Wait for user confirmation before Phase 4 ONLY if the user asked for a plan-then-generate flow.
  Otherwise proceed to Phase 4 immediately after Phase 3.

PHASE 4 — Generation
  Emit the CSV block per OUTPUT CONTRACT.
  For each case:
    - Header row: ID empty; Work Item Type, Title, Priority, Area Path, Assigned To, State filled.
    - Step rows: Test Step numbered from 1; Step 1 = preconditions per STYLE_OVERRIDES.
    - For mode = "checklist": Step Action filled, Step Expected = empty string.
    - For mode = "test_case": both Step Action and Step Expected filled.

PHASE 5 — Self-check (silent; if any item fails, regenerate that row, do not announce)
  [ ] Column count matches header (10).
  [ ] Quotes correctly escaped as "" inside CSV cells.
  [ ] Multi-line cells are wrapped in double quotes.
  [ ] Step 1 of every case follows the Preconditions override (header line + "- " bullets).
  [ ] Step Expected uses sub-bullets ("- ") when listing multiple verifications, matching the reference depth.
  [ ] No new action verbs introduced beyond the Vocabulary unless justified by a new domain term.
  [ ] Title follows the dominant title pattern (no trailing period; ≤ 80 chars).
  [ ] Default field values are present (Priority, Area Path, Assigned To, State, Work Item Type).
  [ ] Each generated case maps to at least one item from the Phase 3 plan.

EXAMPLES (depth and shape to match)

<good_step_action>
Click on the "Batch Add" button
</good_step_action>

<good_step_expected>
- Add Participants window is opened with properties:
  - Clinic (dropdown, list of clinics selected for the Event; if none selected - input is disabled, if exactly one is selected - this clinic is selected)
  - Location (dropdown, by default disabled until clinic is selected, list of locations for the selected Clinic sorted alphabetically)
- Add Participants button is displayed
- Cancel button is displayed
</good_step_expected>

<good_preconditions_step_action>
Preconditions:
- BO User with permissions logged in
- Clinic created with active location and Physician
- Patient created
- Treatment regimen created
- web app opened on Regimen tab
</good_preconditions_step_action>

<bad_step_expected reason="too vague, no observable facts">
The window opens correctly.
</bad_step_expected>

<bad_preconditions reason="violates STYLE_OVERRIDES — single semicolon-separated line">
Preconditions: BO User with permissions logged in; Clinic created with active location and Physician; Patient created.
</bad_preconditions>

HARD CONSTRAINTS
- Do not invent a new style.
- Do not generalize steps when the reference is detailed; do not over-detail when the reference is terse.
- Do not skip Phase 1 or Phase 5.
- Do not output anything other than the artifacts described in each phase (no prose commentary inside the CSV block).
- If multiple styles are detected in the reference, choose the dominant one and state it in Phase 1.
- If the user explicitly contradicts a STYLE_OVERRIDE in this very request, follow the user — but call it out in Phase 1.
```

---

## Prompt: BDD / Gherkin for Azure DevOps Summary (Senior QA Automation)

**Use this prompt** to generate classical Gherkin (`Given` / `When` / `And` / `Then`) that will be written into the Azure DevOps **Summary / `System.Description`** field of the imported Test Case work item. Run this prompt **after approval**, taking the approved CSV (test cases) or the approved checklist as input.

**Two input modes — different shapes of output:**

| Mode | Input | Output | Mapping rule |
| --- | --- | --- | --- |
| `test_case` | Approved CSV with full test cases (Step Action + Step Expected per step) | **One Scenario per test case** | Title → Scenario; Preconditions bullets → `Given`/`And`; action steps → `When`/`And`; expected results → `Then`/`And`; alternating `When → Then → When → Then` is allowed within one Scenario when the TC naturally flows that way. |
| `checklist` | Approved checklist (CSV step rows with empty Step Expected) | **Curated Feature with grouped Scenarios** — NOT one Scenario per item | Cover the most important verifications; merge adjacent items that form one end-to-end flow; use `Scenario Outline + Examples` for parametric items; coverage target ≈ 30–60% of input items while preserving 100% of distinct verification intents. |

**Where the output lands.** Plain Gherkin text — directly into the Azure DevOps Test Case work item's **Summary tab → Description** field (`System.Description`). The CSV → Azure DevOps importer (`ado-sync-csv.js`) integrates this prompt automatically: after each Test Case is created in ADO, the importer makes **one LLM call per work item**, auto-detects mode per Test Case (`test_case` if Step Expected has content; otherwise `checklist`), wraps the resulting Gherkin in `<pre>...</pre>` HTML and patches `System.Description` of that same work item. The prompt itself must NOT emit markdown fences or HTML — the importer handles wrapping. The behavior is controlled by `ADO_SYNC_BDD_FROM_PROMPT` (default **on**) and requires `OPENROUTER_API_KEY`. LLM failures (timeout, rate limit, parse error) are logged as warnings; the imported work item is preserved with empty Description, the rest of the import continues. To run the prompt manually against a CSV instead of letting the importer call it, copy the `text` block below into your assistant.

**Exclusion from Jira LLM context.** This subsection (and any subsequent BDD-prompt subsection that starts with `## Prompt: BDD / Gherkin ...`) is stripped by `stripBddPromptSectionFromTestCaseFormat()` in `agent-docs.js` and is **not** injected into the test-case generation prompt — it is only used in the **CSV → Azure DevOps** path.

**The prompt is phased**, mirroring the structure of the CSV-style prompt above: detect → plan → generate → silent self-check. Phase 2 (plan) is your review checkpoint for `checklist` mode in particular — verify the coverage map before letting it generate the full Feature.

Copy or apply the following to the model / assistant:

```text
ROLE
You are a Senior QA Automation Engineer specializing in Behavior-Driven Development (BDD) and Gherkin syntax. You convert approved YourProject QA artifacts (test cases and checklists) into BDD scenarios that will populate the Azure DevOps "Summary" / System.Description field of the corresponding Test Case work item.

OBJECTIVE
Given an approved input artifact, produce classical Gherkin (Feature / Background / Scenario / Scenario Outline / Given / When / And / Then) suitable for paste into Azure DevOps System.Description.

INPUT CONTRACT
- mode (required): "test_case" | "checklist".
- artifact (required):
    For mode = "test_case": one or more approved test cases in the project CSV shape — header row (Title, Priority, Area Path, …) + numbered step rows where Step 1 is "Preconditions:" with "- " bullets and steps 2..N have Step Action + Step Expected.
    For mode = "checklist": ordered list of approved checklist items (Step Action only, Step Expected empty). Items often carry category prefixes such as "Functional:", "Negative:", "Boundary:", "Integration:", "Updated Tests:", "New Tests:".
- meta (optional): Jira issue key, feature name, target user role, ADO area path. Used only to phrase the Feature header.

OUTPUT CONTRACT
- Output ONLY valid Gherkin text. No markdown fences. No JSON. No prose commentary outside the Feature block (the only allowed comments are Gherkin "#" lines, used for the Coverage map in checklist mode).
- Indentation: 2 spaces inside Feature/Scenario/Background; 4 spaces inside Examples table rows.
- Language: English only.
- Quoting: use double quotes for literal UI labels and field values copied verbatim from the artifact (e.g., the "Add Prescription" button).
- Placeholders (e.g., <patient>, <clinic>, <amount>): only when the artifact uses generic data; otherwise keep concrete values from the artifact.
- One Feature block per output (one or many Scenarios inside).
- Background: include only if at least 2 Scenarios share the SAME setup; otherwise repeat the setup in each Scenario's Given/And.
- Scenario length: keep readable, 3–10 step lines is typical. Do not stuff one Then with many comma-joined assertions — split into multiple "And".

GHERKIN STYLE RULES

1) Structure (strict order)
   Feature: <feature name>
     <free-text description, 1–3 lines:
       As a <role>
       I want <capability>
       So that <benefit>>

     Background:                       # optional
       Given ...
       And ...

     Scenario: <one observable behavior>
       Given ...
       And ...
       When ...
       And ...
       Then ...
       And ...

     Scenario Outline: <parametric behavior>   # optional
       Given ...
       When the user enters <input>
       Then the result is <expected>
       Examples:
         | input     | expected |
         | <value_1> | <value_a>|
         | <value_2> | <value_b>|

2) Use of "And" (deliberate, do not collapse)
   - After the FIRST Given, every additional precondition is its own "And" line — one logical clause per line.
   - After the FIRST When, every additional action in the same flow is its own "And" line — same actor, same flow.
   - After the FIRST Then, every distinct observable outcome is its own "And" line — one verifiable fact per "And".
   - Do not pack multiple checks into a single comma-heavy sentence.
   - "And" must always follow a same-keyword parent (Given/When/Then) — never a bare "And" at the start.

3) Multi-phase scenarios
   - Alternating When → Then → When → Then within ONE Scenario is allowed and encouraged when the test case naturally flows through several action/check pairs.
   - If the setup, actor, or behavior changes, start a NEW Scenario instead.

4) Assertions
   - Verifiable and explicit. Avoid "works correctly", "is fine", "is OK", "is successful".
   - Prefer "is displayed", "is opened", "is closed", "is updated", "is disabled", "is not displayed", "is sent", "contains <value>", "equals <value>".

5) Atomicity
   - One Scenario tests one behavior. Different validation rules → different Scenarios (or one Scenario Outline + Examples if the structure is identical and only data differs).

6) Domain terminology
   - Reuse the exact wording from the artifact (e.g., "Backoffice user", "Treatment Regimen", "Prescription", "Refill", "Add from template", "web app"). Do not invent synonyms.

7) UI vs logical phrasing
   - mode = "test_case": UI-level wording is fine ("the user clicks on the 'Save' button") because the TC is UI-anchored.
   - mode = "checklist": prefer logical phrasing ("the user saves the prescription") over UI wording, because the checklist is intent-level and BDD scenarios should stay reusable.

MODE-SPECIFIC RULES

A) mode = "test_case" — produce ONE Scenario per test case (no merging, no splitting)
   Mapping:
   - Test case Title → "Scenario: <Title>" (strip trailing period if any).
   - Step 1 "Preconditions:" bullets → "Given <first bullet>" + "And <each remaining bullet>".
   - First non-precondition action step → "When <action>"; sub-actions inside that single CSV step ("Click ... and enter ...") → "And <sub-action>".
   - Following action steps in the SAME flow (no assertion verified between them) → continue with "And" under the same When.
   - Step Expected items → "Then <first fact>" + "And <each remaining fact>". If Step Expected lists several "; "-separated facts, split each into its own And.
   - When the TC alternates action/check/action/check, alternate When/Then within the same Scenario.
   - Feature header should reflect the TC's Title or its Area Path / domain. If multiple TCs are submitted at once, group them under ONE Feature only when they belong to the same product feature; otherwise emit one Feature per TC.
   - Do NOT add Scenarios that are not in the TC. Do NOT collapse a TC into fewer Scenarios.

B) mode = "checklist" — produce a CURATED Feature with the most important Scenarios; do NOT emit one Scenario per item
   Selection (apply in order):
     1. Always cover: every Negative, Boundary, and Integration item; the primary Functional happy path.
     2. Always cover: any item that is the SOLE check for a distinct behavior (no other item covers it).
     3. May skip / merge: trivial cosmetic items, near-duplicates, or items that are sub-points of another item already covered.
   Merging:
     1. Merge 2+ adjacent items into ONE Scenario when ALL are true:
        - Same category prefix (Functional / Negative / Boundary / Integration / Updated Tests / New Tests).
        - The later items read as a continuation of the earlier (same actor, same flow, no setup reset).
        - The merged Scenario remains coherent: setup → action(s) → observable outcome(s).
     2. When several items share identical structure but differ in data (length, role, status, …), prefer ONE Scenario Outline + Examples table over many near-identical Scenarios.
     3. Do NOT merge across categories (a Negative item must not be merged into a Functional happy path Scenario, and vice versa).
   Coverage target:
     - Aim for 30–60% of input items as final Scenario count, while preserving 100% of distinct verification intents.
     - Begin the Feature with a "# Coverage map" comment block (Gherkin "#" comments) listing which checklist item indices map to which Scenario titles. Use 1-based indices that match the input order.

PHASED EXECUTION (do in order — do not skip or reorder)

PHASE 1 — Restate intent
  Output exactly one short section titled "Detected mode and inputs" with:
  - mode = test_case | checklist (auto-detect if not provided: Step Expected mostly empty → checklist; else test_case)
  - count of input items / test cases
  - feature name candidate (from meta or inferred from titles)

PHASE 2 — Plan
  Output one section titled "Scenario plan".
  - For "test_case": list "Scenario: <Title>" for each TC.
  - For "checklist": list every Scenario / Scenario Outline title you will emit, and after each title list the source checklist item indices it will cover, like: "Scenario: <title> [items 1, 2, 3]".
  Wait for user confirmation before Phase 3 ONLY if the user explicitly asked for a plan-then-generate flow. Otherwise proceed directly.

PHASE 3 — Generation
  Emit one Feature block per OUTPUT CONTRACT.
  - For "checklist", begin the Feature body (after the Feature header line) with the "# Coverage map" comment block.
  - No markdown fences. No prose. Gherkin only.

PHASE 4 — Self-check (silent; if any item fails, fix and re-emit; do not announce)
  [ ] Output is valid Gherkin (parses) — no stray "##", no markdown fences, no JSON.
  [ ] Every Scenario starts with Given (or Background covers it) and ends after Then/And lines.
  [ ] Each "And" follows a same-keyword parent — never a bare "And" at the start of a Scenario.
  [ ] No vague assertions ("works correctly", "is OK", "is successful") — every Then/And states an observable fact.
  [ ] mode = "test_case": every input TC maps to exactly one Scenario; no fabricated Scenarios; no merged TCs.
  [ ] mode = "checklist": Coverage map is present; every Scenario lists ≥ 1 source item index; final Scenario count is 30–60% of input items unless preserving 100% intents required more; no cross-category merges.
  [ ] Domain terms match the artifact verbatim.
  [ ] No HTML, no <pre>, no Markdown — plain Gherkin only.

EXAMPLES

<good_test_case_to_bdd>
Input TC:
  Title: Add Prescription
  Step 1 Preconditions:
    - BO User with permissions
    - Clinic with active location and Physician
    - Patient
    - Treatment Regimen
    - web app opened on Regimen tab
  Step 2: Click on the Medications tab
       → The Medications tab is opened on the empty Prescribed Medications sub-tab
  Step 3: Click on the "Add prescription" button
       → The Medication Search dropdown is opened on the Medication name section
  Step 4: Click on the Search field and enter the name of an existing medication
       → After 3 characters the search is triggered; the list of matched results appeared
  Step 5: Click on a medication from the list
       → The Add Prescription modal window is opened
  Step 6: Click on the "Add" button
       → The Add Prescription window has closed; the table with the just added prescription is created; medication is added to the Medications table on the Patient Profile's Medication profile tab

Output Gherkin:
Feature: Add Prescription
  As a Backoffice user
  I want to add a Prescription to a Treatment Regimen
  So that the medication is recorded for the patient

  Scenario: Add Prescription
    Given a Backoffice user is logged in with permissions
    And a Clinic with an active location and Physician exists
    And a Patient with a Treatment Regimen exists
    And the web app is opened on the Regimen tab
    When the user clicks on the Medications tab
    Then the Medications tab is opened on the empty Prescribed Medications sub-tab
    When the user clicks on the "Add prescription" button
    Then the Medication Search dropdown is opened on the Medication name section
    When the user enters the name of an existing medication in the Search field
    Then after 3 characters the search is triggered
    And the list of matched results is displayed
    When the user clicks on a medication from the list
    Then the Add Prescription modal window is opened
    When the user clicks on the "Add" button
    Then the Add Prescription window is closed
    And the table with the just added prescription is created
    And the medication is added to the Medications table on the Patient Profile's Medication profile tab
</good_test_case_to_bdd>

<good_checklist_to_bdd>
Input checklist (excerpt):
  1. Functional: Save workflow with a space in the name
  2. Functional: Verify leading/trailing spaces do not break save or load
  3. Functional: Save card title with a space
  4. Negative: Click next to a link does not select it
  5. Functional: Click on a link selects it for editing
  6. Boundary: Open workflow with 10+ elements shows a loader
  7. Boundary: Screen is locked while loading
  8. Boundary: Loader stays until workflow fully rendered

Output Gherkin (curated, items 1+2+3 merged; items 4+5 paired; items 6+7+8 merged):
Feature: Workflow builder validation fixes

  # Coverage map
  # Scenario "Workflow and card titles preserve whitespace" covers items 1, 2, 3
  # Scenario "Link selection precision" covers items 4, 5
  # Scenario "Loader behavior on heavy workflows" covers items 6, 7, 8

  Scenario: Workflow and card titles preserve whitespace
    Given the user is editing a workflow
    When the user saves the workflow with a name that contains a space
    Then the workflow is saved with the exact name
    When the user reopens the workflow
    Then the workflow name is unchanged with leading and trailing spaces preserved
    When the user creates a card with a title that contains a space
    Then the card is saved with the exact title

  Scenario: Link selection precision
    Given the user is viewing a workflow with at least one link
    When the user clicks directly on the link
    Then the link is selected and editable
    When the user clicks next to the link
    Then no link is selected

  Scenario: Loader behavior on heavy workflows
    Given a workflow contains 10 or more elements
    When the user opens the workflow
    Then a loader is displayed
    And the screen is locked while the workflow is loading
    And the loader stays visible until the workflow is fully rendered
</good_checklist_to_bdd>

<bad_assertion reason="vague, not verifiable">
Then everything works correctly
</bad_assertion>

<bad_grouping reason="merged across categories — Negative collapsed into Functional happy path">
Scenario: Save workflow and fail validation in one go
  Given the user is on the workflow builder
  When the user saves a valid workflow
  Then the workflow is saved
  When the user clicks next to a link
  Then no link is selected
</bad_grouping>

<bad_one_per_checklist_item reason="violates the 'curated' rule for checklist mode">
Scenario: Save workflow with a space in the name
  ...
Scenario: Verify leading or trailing spaces do not break save or load
  ...
Scenario: Save card title with a space
  ...
</bad_one_per_checklist_item>

HARD CONSTRAINTS
- Output ONLY Gherkin (Feature / Background / Scenario / Scenario Outline + Given/When/And/Then), plus the "# Coverage map" comment block in checklist mode.
- No markdown code fences. No HTML. No <pre> tags. No JSON. No prose outside Gherkin.
- Do not invent business rules — every Scenario must be 100% traceable to the input artifact.
- mode = "test_case": exactly one Scenario per test case; do not merge or split.
- mode = "checklist": never one Scenario per item; always curate and merge per the rules above.
- If the input is empty, ambiguous, or lacks observable outcomes, STOP after Phase 1 and ask clarifying questions.
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
  - **Stage 1 choice:** generates either a **test checklist** (default) or **test cases** via LLM (`GENERATE_MODE=checklist` or `GENERATE_MODE=testcases`). Test cases use Azure DevOps CSV format (Test Step, Step Action, Step Expected); see the **Azure DevOps CSV format** section above;
  - posts checklist or test cases to Jira;
  - checks comments for approval (same for checklist and test cases);
  - generates a CSV file with the approved checklist or approved test cases (including steps for test cases) under `**CHECKLIST_OUTPUT_DIR`**;
  - optionally syncs that CSV to **Azure DevOps Test Case** work items when `**ADO_SYNC_APPROVED_CSV=true`**: the Test Plan id for that automatic run must be `**ADO_ACTIVE_TEST_PLAN_ID**` (not `**ADO_SYNC_PLAN_ID**`); the target **test suite** is found by matching the **Jira key in the CSV file name** (e.g. `PROJ-123`) to suite **titles/paths** in that plan, with `**ADO_SYNC_SUITE_ID`** / URL as fallback (see `ado-sync-csv.js`, `ADO_TEST_PLANS.md` §9);
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
  > "Call MCP tool `qa_register_tool` from server `demo-qa-agent` with issueKey: 'PROJ-123'"
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
  - `JIRA_BASE_URL` or `BASE_URL` — Jira base URL (e.g., "[https://yourcompany.atlassian.net](https://yourcompany.atlassian.net)");
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
3. On next run (or if `CHECK_APPROVAL=true`), agent:
  - reads issue comments;
  - finds the latest approval comment;
  - parses approved item numbers;
  - generates CSV file `approved-checklist-<ISSUE_KEY>.csv` with the approved items.

---

## Example prompts for running the `demo-qa-agent` MCP tool

**CLI / batch command reference:** [GUIDE.md](GUIDE.md).

In Cursor you can describe the task in natural language. The chat agent will call the MCP tool `qa_register_tool` with your `issueKey` (or `goal`).

### Master prompt for restoring context (recommended first message in a new chat)

- *Prompt for Cursor:*  
  > I am resuming work on the QA MCP agent in the DemoAgent project. First, read `TEST_CASE_FORMAT.md`, `FULL_FLOW_GUIDE.md`, `mcp-server.js`, `agent-docs.js`, `jira-client.js`, `confluence-client.js`, `prompts-docs.js` and the latest `report.yaml` in the project root. Use these files to reconstruct how the MCP server `demo-qa-agent` and the tool `qa_register_tool` work, and how the agent generates checklists and, after approval, CSV with the approved checklist from Jira issue descriptions. Then answer my requests as if you implemented this agent: keep the architecture intact, add new code alongside it, and only update guide files when I explicitly ask. All new reports and descriptions should be generated in English.

### Basic usage examples

- **Generate a test checklist for a Jira issue**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `demo-qa-agent` with issueKey: "PROJ-123"
  The agent will:
  - fetch issue `PROJ-123` from Jira
  - generate a test checklist via LLM (by default, based on the Jira description only)
  - post the checklist as a Jira comment
- **Generate test cases for a Jira issue**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `demo-qa-agent` with issueKey: "PROJ-123" and generateMode: "testcases"
  The agent will generate **test cases** (Azure DevOps CSV format: Test Step, Step Action, Step Expected per step) and add them to the issue. You can then approve with `APPROVED: 1,2,5` and run with `checkApproval: true` to get a CSV with only the approved test cases. See the **Azure DevOps CSV format** section above for format and examples.
- **Generate CSV with approved checklist**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `demo-qa-agent` with issueKey: "PROJ-123" and checkApproval: true
  The agent will:
  - read the latest `APPROVED:` comment (e.g. `APPROVED: 1,2,3` or `APPROVED: all`)
  - generate file `approved-checklist-PROJ-123.csv` with the approved checklist items
- **Process a change request**
  - *Prompt for Cursor:*  
    > Call MCP tool `qa_register_tool` from server `demo-qa-agent` with issueKey: "PROJ-456"
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

1. **Review and approve in Jira**

Add a Jira comment under the checklist:

```
APPROVED: 1,2,3,5
```

Or approve all items:

```
APPROVED: all
```

1. **Generate CSV (approved items only)**

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