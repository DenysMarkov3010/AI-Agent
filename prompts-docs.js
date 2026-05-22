/** Instructs the model to infer domain/area context before writing outputs (checklist). */
const CHECKLIST_DEEP_AREA_BLOCK = `
DEEP AREA UNDERSTANDING (do this mentally BEFORE you write any checklist items):
1. Synthesize the broader feature/domain: primary user roles, product vocabulary, key entities, typical workflows, and where this ticket sits in the end-to-end journey (not only the single story text).
2. Combine the issue description, labels, any Confluence/Jira context, and any "project folder" test excerpts to infer implicit rules, constraints, data dependencies, permission boundaries, and integration touchpoints—even when not stated as formal acceptance criteria.
3. Use that synthesis so checklist items are concrete and area-specific (real screens, states, roles, data) rather than generic placeholders like "verify feature works".
4. In "reasoning", start with a short paragraph (3–5 sentences) summarizing this area context and how it shaped your coverage; then explain which sources you prioritized (labels, related issues, Confluence, project files) and why.`;

/** Same intent for full test-case generation with steps. */
const TESTCASES_DEEP_AREA_BLOCK = `
DEEP AREA UNDERSTANDING (do this mentally BEFORE you design test cases):
1. Build a coherent picture of the product area: actors, terminology, main flows, edge cases typical for this domain, and how this change connects to adjacent features or data.
2. Cross-read the issue, related documentation, and any existing test excerpts from the project folder to extract domain language, Preconditions style, and realistic flows—so new cases feel consistent with how this area is actually tested.
3. Let that context drive step granularity: steps should reflect real navigation, inputs, and observable outcomes for this area, not vague "validate behavior" wording.
4. In "reasoning", begin with 3–5 sentences on area/domain context and coverage strategy; then map major requirements to test case titles as already required.`;

/**
 * Classical test-design techniques — shared between checklist and full test-case generation.
 * Apply WHERE APPLICABLE (don't force a technique when the story does not call for it).
 * The model must briefly note in "reasoning" which techniques informed which parts of coverage.
 */
const TEST_DESIGN_TECHNIQUES = `
TEST DESIGN TECHNIQUES (apply WHERE APPLICABLE — not every technique fits every story; in "reasoning", briefly note which techniques informed which items / test cases):

1) Equivalence Partitioning (EP)
   Partition inputs, outputs, roles, configurations, and environmental factors into equivalence classes (valid vs invalid, or distinct business meanings). For each class that changes expected behavior include one representative item / test case — avoid redundant copies of the same class unless the workflow genuinely differs.

2) Boundary Value Analysis (BVA)
   For ordered domains (numeric ranges, min/max lengths, pagination limits, thresholds, dates, quotas, counts), defects cluster at edges. Add items / cases for values at and immediately adjacent to boundaries (just below min, at min, just inside valid range, just inside max, at max, just above max) wherever the requirement defines inclusivity or exclusivity.

3) Decision Table Testing
   When behavior depends on combinations of conditions (e.g. role AND state AND feature flag AND data type), treat it as a decision table: every combination that produces a different action or outcome must be covered by at least one item / case. Impossible or explicitly unsupported combinations may be a single negative item with a clear expected response.

4) State Transition Testing
   When the work item implies states and transitions (e.g. draft → submitted → approved, online/offline, locked/unlocked, subscription/order status), cover valid transitions, invalid or disallowed transitions, and events received in the wrong state — including guard conditions and error messages.

5) Use Case Testing
   Derive scenarios from primary user goals: cover the main success path end-to-end, plus alternative and exception flows (validation errors, cancellations, timeouts, payment or save failures, partial completion, concurrency where stated) as separate items / cases with concrete expected outcomes.

GUIDANCE:
- Do NOT invent a technique application that is not supported by the description or supplementary context.
- Do NOT add an item / test case solely to "demonstrate a technique" if the requirement does not need it.
- Prefer combining techniques inside one well-scoped scenario when natural (e.g. a single BVA case can also cover a state transition guard).`;

function generateTestChecklistPrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels,
    confluencePages = [],
    relatedJiraIssues = [],
    projectTestCases = [],
    existingTestCases = [],
    isChangeRequest = false,
  } = context;

  const confluenceJson = JSON.stringify(confluencePages, null, 2);
  const jiraIssuesJson = JSON.stringify(relatedJiraIssues, null, 2);
  const hasProjectTestCases = projectTestCases && projectTestCases.length > 0;
  const projectTestCasesSection = hasProjectTestCases
    ? projectTestCases.map((f) => `--- ${f.filename}\n${f.content}`).join("\n\n")
    : "";
  const existingTestCasesJson = existingTestCases.length > 0 
    ? JSON.stringify(existingTestCases, null, 2)
    : null;

  if (isChangeRequest && existingTestCasesJson) {
    return `You are a QA expert specializing in change impact analysis and test design.

CHANGE REQUEST ANALYSIS:
0. AREA CONTEXT: From the change description and existing test documentation, infer the affected product area, impacted surfaces, and domain vocabulary before proposing updates—so recommendations are specific to that area, not generic.
1. COMPARE: Carefully compare the change request description with existing test documentation
2. IDENTIFY CHANGES: Determine what functionality is being modified, added, or removed
3. IMPACT ASSESSMENT: Identify which existing test cases are affected
4. PROPOSE UPDATES: Suggest specific updates to existing test cases
5. NEW COVERAGE: Identify gaps requiring new test cases (functional behavior, acceptance criteria, roles, integrations). Put the bulk of coverage here.

Issue Key: ${issueKey}
Description: ${issueDescription}
Labels: ${issueLabels.join(", ")}

Existing Test Documentation:
${existingTestCasesJson}
${TEST_DESIGN_TECHNIQUES}

IMPORTANT: This is a CHANGE REQUEST. Analyze what has changed compared to existing documentation and propose:
1. Which existing test cases need to be updated (Updated Tests)
2. New test cases required for new or changed behavior (New Tests) — this must be the largest set

REQUIREMENTS:
- Do NOT create a separate "Regression" or "Regression Tests" category. Do NOT label any item as regression-only. If related areas must be re-verified, express that as an Updated Test or as a concrete New Test tied to the change—never as a standalone regression bucket.
- You MUST generate items for BOTH categories below:
  - Updated Tests — at least 3 items (existing cases or flows that must change because of this request)
  - New Tests — at least 7 items (primary focus: functional coverage of new/changed behavior, roles, data, UI, APIs; this category must have strictly more items than Updated Tests)
- Return the result as valid JSON matching this exact schema:

{
  "checklistItems": [
    {
      "id": "string",
      "description": "string",
      "category": "Updated Tests" | "New Tests",
      "affectedTestCase": "string (optional, for Updated Tests)"
    }
  ],
  "reasoning": "string explaining label matching, prioritization, and which test design techniques (EP, BVA, decision tables, state transitions, use cases) informed which Updated / New items",
  "changeImpactSummary": "string summarizing the impact of changes"
}

IMPORTANT: 
- Generate ALL content in English only. Do NOT use asterisks or any other markdown formatting in descriptions.
- Return ONLY valid JSON output that exactly matches the required schema.
- Ensure all required fields are present: checklistItems, reasoning, and changeImpactSummary.
- Each checklistItem must have: id, description, category (one of: Updated Tests, New Tests only), and affectedTestCase (optional for Updated Tests).`;
  }

  const hasConfluenceDocs = confluencePages && confluencePages.length > 0;
  const hasRelatedIssues = relatedJiraIssues && relatedJiraIssues.length > 0;
  
  let contextSection = "";
  
  if (hasConfluenceDocs || hasRelatedIssues) {
    contextSection = `
LABEL MATCHING STRATEGY:
1. PRIORITIZE EXACT MATCHES: Look for Confluence pages and Jira tickets with labels that exactly match the current issue's labels
2. RECOGNIZE COMPREHENSIVE SOURCES: If a source has MORE labels than the current ticket, it likely contains more comprehensive documentation that covers multiple scenarios
3. PARTIAL MATCHES: Consider sources where labels partially overlap - they may contain relevant context
4. DYNAMIC LABEL FORMAT: Work with any label format provided in the context (e.g., category/subcategory, simple tags, etc.)
5. EXPLAIN YOUR REASONING: In the reasoning field, explain which sources you prioritized based on label matching and why

${hasConfluenceDocs ? `Related Confluence Pages:\n${confluenceJson}\n` : ""}
${hasRelatedIssues ? `Related Jira Issues:\n${jiraIssuesJson}\n` : ""}`;
  } else {
    contextSection = `
NOTE: No additional documentation found. Base your analysis ONLY on the issue description below.
Focus on extracting test scenarios directly from the user story format (As a... I want... So that...) and acceptance criteria if present.`;
  }

  if (hasProjectTestCases) {
    contextSection += `

EXISTING TEST CASES FROM PROJECT FOLDER (use for analysis):
Consider these test cases when generating the checklist: align coverage, avoid duplication, and extend or complement where relevant. Do not copy them verbatim. Treat them as samples of how this product area is described—terminology, flow depth, and risk focus—so your checklist matches that area’s reality.

${projectTestCasesSection}`;
  }

  contextSection += `\n${CHECKLIST_DEEP_AREA_BLOCK}`;
  contextSection += `\n${TEST_DESIGN_TECHNIQUES}`;

  return `You are a QA expert specializing in test design based on user stories and acceptance criteria.

Generate comprehensive test checklists using industry best practices: functional tests (primary), negative scenarios, boundary cases, and critical integration points. Do not produce regression-only checklist items.

Issue Key: ${issueKey}
Description: ${issueDescription}
Labels: ${issueLabels.join(", ") || "none"}
${contextSection}

REQUIREMENTS:
- FUNCTIONAL (highest priority): Generate the MOST items in this category—at least 8–12 concrete checklist items covering happy paths, main user goals, acceptance criteria, roles, and observable outcomes. Functional count must be greater than the count in any other single category.
- NEGATIVE: Second priority—at least 5–8 items (errors, validation, permissions, invalid data).
- BOUNDARY: At least 2–4 items (limits, edge values, empty/max volume where relevant).
- INTEGRATION: Only the most important points—1–3 essential items. Do not add marginal integration cases.
- FORBIDDEN: Do NOT use category "Regression". Do NOT add items whose sole purpose is generic "regression" or "nothing else broke" wording. Fold any necessary re-check of adjacent behavior into Functional or Integration with a specific scenario.
- You MUST include items in ALL of these categories only: Functional, Negative, Boundary, Integration. Do NOT skip any of these four.
- Return the result as valid JSON matching this exact schema:

{
  "checklistItems": [
    {
      "id": "string",
      "description": "string",
      "category": "Functional" | "Negative" | "Boundary" | "Integration"
    }
  ],
  "reasoning": "string: start with area/domain context summary (3–5 sentences), then label/source matching and prioritization, then briefly state which test design techniques (EP, BVA, decision tables, state transitions, use cases) shaped which checklist categories — only those that were applicable"
}

IMPORTANT: 
- Generate ALL content in English only. Do NOT use asterisks or any other markdown formatting in descriptions.
- Return ONLY valid JSON output that exactly matches the required schema.
- Ensure all required fields are present: checklistItems and reasoning.
- Each checklistItem must have: id, description, and category.`;
}

/**
 * Build prompt for generating full test cases (Azure DevOps format) with steps.
 * Used when GENERATE_MODE=testcases. Must follow TEST_CASE_FORMAT.md.
 */
function generateTestCasesPrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels,
    confluencePages = [],
    relatedJiraIssues = [],
    projectTestCases = [],
    testCaseFormatRef = "",
    testCasesLimit = 10,
  } = context;

  // null / 0 / negative / non-finite -> "unlimited"; otherwise an explicit cap.
  const limitNum =
    testCasesLimit === null ||
    testCasesLimit === undefined ||
    !Number.isFinite(Number(testCasesLimit)) ||
    Number(testCasesLimit) <= 0
      ? null
      : Math.floor(Number(testCasesLimit));
  const isUnlimited = limitNum === null;
  const limitHeaderClause = isUnlimited ? "" : ` (maximum ${limitNum} test cases total)`;
  const limitRequirementBullet = isUnlimited
    ? "- Generate as many test cases as the story actually requires—no fixed cap. Prefer fewer, deeper cases over many shallow ones: pack functional, negative, validation, boundary, permission/role, and error handling into well-scoped scenarios with rich step-by-step detail. Favor functional and end-to-end story coverage; do not dedicate test cases solely to generic \"regression\"—if adjacent behavior matters, cover it inside a functional scenario with explicit steps."
    : `- Generate at most ${limitNum} test cases (hard cap: never more than ${limitNum}). Prefer fewer, deeper cases over many shallow ones: pack functional, negative, validation, boundary, permission/role, and error handling into well-scoped scenarios with rich step-by-step detail. Favor functional and end-to-end story coverage; do not dedicate test cases solely to generic "regression"—if adjacent behavior matters, cover it inside a functional scenario with explicit steps.`;
  const limitImportantBullet = isUnlimited
    ? "- The testCases array length is up to you—size it to the story; do not pad with redundant cases."
    : `- The testCases array MUST contain no more than ${limitNum} items.`;

  const confluenceJson = JSON.stringify(confluencePages, null, 2);
  const jiraIssuesJson = JSON.stringify(relatedJiraIssues, null, 2);
  const hasProjectTestCases = projectTestCases && projectTestCases.length > 0;
  const projectTestCasesSection = hasProjectTestCases
    ? projectTestCases.map((f) => `--- ${f.filename}\n${f.content}`).join("\n\n")
    : "";

  let contextSection = "";
  if (confluencePages.length > 0 || relatedJiraIssues.length > 0) {
    contextSection = `
Related Confluence Pages:
${confluencePages.length ? confluenceJson : "None"}

Related Jira Issues:
${relatedJiraIssues.length ? jiraIssuesJson : "None"}`;
  } else {
    contextSection = "\nNo additional documentation. Base test cases ONLY on the issue description.";
  }
  if (hasProjectTestCases) {
    contextSection += `

EXISTING TEST CASES (use for style and coverage alignment, do not copy):
Use them to infer how this product area is usually specified—language, Preconditions, step depth, and typical risks—then design new cases that fit that area.

${projectTestCasesSection}`;
  }

  contextSection += `\n${TESTCASES_DEEP_AREA_BLOCK}`;
  contextSection += `\n${TEST_DESIGN_TECHNIQUES}`;

  const formatSection = testCaseFormatRef
    ? `

MANDATORY FORMAT (follow exactly as in reference):
${testCaseFormatRef}

You MUST output test cases that match this format: CSV columns ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path. First step of each test case is usually Preconditions with expected "—". Use clear Step Action and Step Expected like in the examples.`
    : "";

  return `You are a senior QA engineer. Generate thorough, high-detail test cases in Azure DevOps format${limitHeaderClause}. Prioritize depth of each case over count: do not omit important scenarios—express them in granular steps. Each test case has a Title, Priority (1 or 2), Area Path (e.g. YourProject), and ordered Steps. Each step has Test Step (number), Step Action, Step Expected. Preconditions are step 1 with expected "—".
${formatSection}

Issue Key: ${issueKey}
Description: ${issueDescription}
Labels: ${issueLabels.join(", ") || "none"}
${contextSection}

REQUIREMENTS:
${limitRequirementBullet}
- Be exhaustive with the issue description and any related context: every explicit rule, field, button, state, acceptance criterion, URL, role, or error message mentioned must appear in at least one concrete step (or explain in reasoning why it is out of scope).
- Steps must be detailed and executable: spell out where to navigate, what to enter, what to observe. Avoid vague actions like "verify it works" or "check the feature". Expected results must name observable UI text, control states (enabled/disabled/visible), counts, messages, or outcomes where inferable from context.
- Expected formatting rule: if a single step has more than one expected sentence/outcome, write each sentence as a separate bullet line starting with "- ".
- Do NOT reduce expected-result detail for formatting reasons. Keep full specificity (UI labels, limits, button states, validation text, counters, side effects) from the scenario; formatting into bullets must preserve all details, not summarize.
- Happy-path and complex flows: use enough steps (often 8 to 22 per case when the story is non-trivial) so a tester can follow without guessing. Simpler negative checks may use fewer steps but must still state exact trigger and exact expected system response.
- Cover combinations: empty/invalid input, max length, wrong role, missing prerequisites, concurrent edits, cancel vs save, refresh/back navigation if relevant.
- Each test case MUST have: "title", "priority" (1 or 2), "areaPath" (e.g. "YourProject"), "steps" (array).
- Each step MUST have: "stepNumber" (1-based), "action", "expected" (use "—" or "" for preconditions).
- First step is usually preconditions: action = "Preconditions: ...", expected = "—".
- In "reasoning", first summarize area/domain context and how it informed the suite (3–5 sentences); then map major requirements from the story to test case titles; then briefly note which test design techniques (EP, BVA, decision tables, state transitions, use cases) shaped which test cases — only the techniques that were genuinely applicable; finally note deliberate gaps only if information was truly missing.
- Return ONLY valid JSON matching this schema:

{
  "testCases": [
    {
      "title": "string",
      "priority": 1,
      "areaPath": "YourProject",
      "steps": [
        { "stepNumber": 1, "action": "string", "expected": "string" }
      ]
    }
  ],
  "reasoning": "string"
}

IMPORTANT:
- Generate ALL content in English. No markdown in action/expected.
- Return ONLY valid JSON. No code fences or extra text.
${limitImportantBullet}
- Every test case must have at least one step. Match the style and structure of the reference format.`;
}

module.exports = {
  generateTestChecklistPrompt,
  generateTestCasesPrompt,
  TEST_DESIGN_TECHNIQUES,
};
