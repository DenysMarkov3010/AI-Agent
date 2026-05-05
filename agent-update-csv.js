const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

const { JiraClient } = require("./jira-client");
const { mergePreconditionStepsForTestCase } = require("./merge-precondition-steps");

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "PROJ";
const UPDATED_TEST_CASES_FOLDER =
  process.env.UPDATED_TEST_CASES_FOLDER || path.join(__dirname, "Updated test cases");
const UPDATED_FLOW_MODE = (process.env.UPDATED_FLOW_MODE || "auto").toLowerCase().trim();
const UPDATED_FLOW_INPUT_FILE = (process.env.UPDATED_FLOW_INPUT_FILE || "").trim();

if (!JIRA_BASE_URL) {
  console.error("❌ Error: JIRA_BASE_URL or BASE_URL is not set");
  process.exit(1);
}
if (!JIRA_EMAIL) {
  console.error("❌ Error: JIRA_EMAIL or LOGIN_EMAIL is not set");
  process.exit(1);
}
if (!JIRA_API_TOKEN) {
  console.error("❌ Error: JIRA_API_TOKEN is not set");
  process.exit(1);
}
if (!OPENROUTER_API_KEY) {
  console.error("❌ Error: OPENROUTER_API_KEY is not set");
  process.exit(1);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < normalized.length) {
    const c = normalized[i];
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  pushField();
  if (row.length > 1 || (row[0] && row[0].length > 0)) pushRow();
  return rows;
}

function rowsToTestCases(rows) {
  const COL = {
    TYPE: 1,
    TITLE: 2,
    STEP: 3,
    ACTION: 4,
    EXPECTED: 5,
    PRIORITY: 6,
    AREA: 7,
  };
  const out = [];
  let current = null;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 10) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const wit = (line[COL.TYPE] || "").trim().toLowerCase();
    if (title && wit === "test case") {
      current = {
        title,
        priority: parseInt((line[COL.PRIORITY] || "2").trim(), 10) || 2,
        areaPath: (line[COL.AREA] || "YourProject").trim() || "YourProject",
        steps: [],
      };
      out.push(current);
    }
    const stepNumRaw = (line[COL.STEP] || "").trim();
    const action = (line[COL.ACTION] || "").trim();
    const expected = (line[COL.EXPECTED] || "").trim();
    if (current && stepNumRaw && (action || expected)) {
      const stepNumber = parseInt(stepNumRaw, 10);
      current.steps.push({
        stepNumber: Number.isFinite(stepNumber) ? stepNumber : current.steps.length + 1,
        action,
        expected,
      });
    }
  }
  for (const tc of out) {
    if (tc.steps && tc.steps.length > 1) {
      tc.steps = mergePreconditionStepsForTestCase(tc.steps);
    }
  }
  return out;
}

function rowsToChecklist(rows) {
  const COL = { TITLE: 2, ACTION: 4 };
  const items = [];
  let n = 1;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 6) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const action = (line[COL.ACTION] || "").trim();
    if (title && action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  return items;
}

/** True when row looks like an Azure DevOps parent row (ID / Work Item Type / Title). */
function isCsvWorkItemParentRow(line) {
  const TYPE = 1;
  const TITLE = 2;
  const copy = [...line];
  while (copy.length < 10) copy.push("");
  const title = (copy[TITLE] || "").trim();
  const wit = (copy[TYPE] || "").trim().toLowerCase();
  if (!title || !wit) return false;
  if (wit === "test case") return true;
  if (wit.includes("checklist")) return true;
  return false;
}

/**
 * Split CSV into separate checklist blocks (same file can contain multiple checklists).
 * A new block starts at each row with Work Item Type + Title (e.g. Test Case).
 * If the file has no such parent rows, returns a single segment from legacy flat parsing.
 * @returns {Array<{ workItemTitle: string | null, workItemType: string | null, items: object[] }>}
 */
function rowsToChecklistSegments(rows) {
  if (!rows || rows.length < 2) return [];
  let anyParent = false;
  for (let r = 1; r < rows.length; r++) {
    if (isCsvWorkItemParentRow(rows[r])) {
      anyParent = true;
      break;
    }
  }
  if (!anyParent) {
    const flat = rowsToChecklist(rows);
    return flat.length ? [{ workItemTitle: null, workItemType: null, items: flat }] : [];
  }

  const COL = { TITLE: 2, ACTION: 4 };
  const segments = [];
  let current = null;
  let n = 1;

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const lineCopy = [...line];
    while (lineCopy.length < 10) lineCopy.push("");

    if (isCsvWorkItemParentRow(line)) {
      if (current && current.items.length) segments.push(current);
      current = {
        workItemTitle: (lineCopy[COL.TITLE] || "").trim(),
        workItemType: (lineCopy[1] || "").trim(),
        items: [],
      };
      n = 1;
      continue;
    }

    if (!current) {
      current = { workItemTitle: null, workItemType: null, items: [] };
      n = 1;
    }

    const title = (lineCopy[COL.TITLE] || "").trim();
    const action = (lineCopy[COL.ACTION] || "").trim();
    if (title && action) {
      current.items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      current.items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  if (current && current.items.length) segments.push(current);
  return segments;
}

const COL_WIT = 1;
const COL_TITLE = 2;
const COL_STEP = 3;
const COL_ACTION = 4;
const COL_EXPECTED = 5;
const COL_PRIORITY = 6;
const COL_AREA = 7;

function padCsvLine(line) {
  const copy = [...(line || [])];
  while (copy.length < 10) copy.push("");
  return copy;
}

/** Child rows under a parent work item → checklist-shaped items (same rules as rowsToChecklistSegments). */
function childRowsToChecklistItems(childRows) {
  const items = [];
  let n = 1;
  for (const row of childRows) {
    const lineCopy = padCsvLine(row);
    const title = (lineCopy[COL_TITLE] || "").trim();
    const action = (lineCopy[COL_ACTION] || "").trim();
    if (title && action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  return items;
}

/**
 * True when this row starts a new work-item block (Test Case or checklist work item).
 * Used only for UPDATED_FLOW_MODE=auto ordered parsing.
 */
function isAutoBlockParentRow(line) {
  const ln = padCsvLine(line);
  const title = (ln[COL_TITLE] || "").trim();
  const wit = (ln[COL_WIT] || "").trim().toLowerCase();
  if (!title || !wit) return false;
  if (wit === "test case") return true;
  if (wit.includes("checklist")) return true;
  return false;
}

/**
 * For auto mode: walk CSV top-to-bottom and classify each parent block.
 * - Work Item Type contains "checklist" → checklist segment (child rows only).
 * - Work Item Type is "test case":
 *   - If every step has empty Step Expected → checklist segment (ADO-style checklist rows).
 *   - Otherwise → test case (steps merged like rowsToTestCases).
 * - No parent rows in file → single legacy checklist segment from rowsToChecklist (if any).
 */
function parseUpdatedCsvBlocksForAuto(rows) {
  if (!rows || rows.length < 2) return [];

  let hasParent = false;
  for (let r = 1; r < rows.length; r++) {
    if (isAutoBlockParentRow(rows[r])) {
      hasParent = true;
      break;
    }
  }

  if (!hasParent) {
    const flat = rowsToChecklist(rows);
    return flat.length
      ? [{ type: "checklist", segment: { workItemTitle: null, workItemType: null, items: flat } }]
      : [];
  }

  const blocks = [];
  let r = 1;
  while (r < rows.length) {
    const parentLine = padCsvLine(rows[r]);
    const title = (parentLine[COL_TITLE] || "").trim();
    const witLower = (parentLine[COL_WIT] || "").trim().toLowerCase();
    if (!title || !(witLower === "test case" || witLower.includes("checklist"))) {
      r++;
      continue;
    }

    const isChecklistWit = witLower.includes("checklist");
    const blockTitle = title;
    const blockWitRaw = (parentLine[COL_WIT] || "").trim();
    const priority = parseInt((parentLine[COL_PRIORITY] || "2").trim(), 10) || 2;
    const areaPath = (parentLine[COL_AREA] || "YourProject").trim() || "YourProject";
    r++;

    const childRows = [];
    while (r < rows.length) {
      if (isAutoBlockParentRow(rows[r])) break;
      childRows.push(rows[r]);
      r++;
    }

    if (isChecklistWit) {
      const items = childRowsToChecklistItems(childRows);
      if (items.length) {
        blocks.push({
          type: "checklist",
          segment: { workItemTitle: blockTitle, workItemType: blockWitRaw, items },
        });
      }
      continue;
    }

    const steps = [];
    for (const cl of childRows) {
      const ln = padCsvLine(cl);
      const stepNumRaw = (ln[COL_STEP] || "").trim();
      const action = (ln[COL_ACTION] || "").trim();
      const expected = (ln[COL_EXPECTED] || "").trim();
      if (stepNumRaw && (action || expected)) {
        const stepNumber = parseInt(stepNumRaw, 10);
        steps.push({
          stepNumber: Number.isFinite(stepNumber) ? stepNumber : steps.length + 1,
          action,
          expected,
        });
      }
    }

    if (!steps.length) continue;

    const allExpectedEmpty = steps.every((s) => !String(s.expected || "").trim());
    if (allExpectedEmpty) {
      const items = childRowsToChecklistItems(childRows);
      if (items.length) {
        blocks.push({
          type: "checklist",
          segment: { workItemTitle: blockTitle, workItemType: blockWitRaw, items },
        });
      }
    } else {
      const merged = steps.length > 1 ? mergePreconditionStepsForTestCase(steps) : steps;
      blocks.push({
        type: "testcase",
        case: {
          title: blockTitle,
          priority,
          areaPath,
          steps: merged,
        },
      });
    }
  }

  return blocks;
}

async function callLLM(prompt, maxTokens = 6000) {
  const fetch = globalThis.fetch || require("node-fetch");
  const models = (process.env.OPENROUTER_MODELS || "openai/gpt-oss-20b:free")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const fallbackModels = models.length ? models : ["openai/gpt-oss-20b:free"];
  const retryableStatus = new Set([429, 500, 502, 503, 504]);
  let lastError = null;

  for (let modelIndex = 0; modelIndex < fallbackModels.length; modelIndex += 1) {
    const model = fallbackModels[modelIndex];
    const isLastModel = modelIndex === fallbackModels.length - 1;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: maxTokens,
          }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          const message = `LLM API error: ${res.status} ${res.statusText}. ${errorText}`;
          const retryable = retryableStatus.has(res.status);
          lastError = new Error(message);

          if (retryable && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
            continue;
          }
          if (retryable && !isLastModel) {
            console.warn(`LLM model "${model}" is rate-limited/unavailable. Switching to next fallback model.`);
            break;
          }
          throw lastError;
        }
        const data = await res.json();
        if (!data.choices || !data.choices[0]) throw new Error("LLM returned no choices");
        return data.choices[0].message.content;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
          continue;
        }
        if (!isLastModel) {
          console.warn(`LLM model "${model}" failed (${error.message}). Trying next fallback model.`);
          break;
        }
      }
    }
  }

  throw lastError || new Error("LLM failed with unknown error");
}

function buildUpdatedTestCasesPrompt(issueData, existingCases, segmentMeta) {
  const sm = segmentMeta || {};
  const segmentNote =
    sm.total > 1
      ? `This is test case group ${sm.index} of ${sm.total} in the same CSV file${
          sm.caseTitle ? ` ("${sm.caseTitle}")` : ""
        }. Update ONLY the case(s) below — do not merge, drop, or combine with other groups.\n\n`
      : "";
  return `You are a senior QA engineer.

Task:
1) Analyze Jira requirements.
2) Analyze existing CSV-based test cases.
3) Update and improve test cases to reflect new/changed requirements.

${segmentNote}Issue key: ${issueData.key}
Summary: ${issueData.summary || ""}
Labels: ${(issueData.labels || []).join(", ") || "none"}
Description:
${issueData.description || ""}

Existing test cases (from CSV):
${JSON.stringify(existingCases, null, 2)}

Output rules:
- Return ONLY valid JSON (no markdown/code fences).
- Keep test cases focused and deduplicated.
- Preserve practical style (clear actions + expected results).
- Keep Step Expected highly detailed. Do not summarize or shorten specifics (UI labels, limits, counters, exact states/messages). If there are multiple expected sentences, each should be on its own "- " bullet line, while preserving full detail.
- Use this JSON schema:
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
  "reasoning": "string",
  "changeSummary": {
    "added": [
      {
        "item": "string",
        "why": "string"
      }
    ],
    "changed": [
      {
        "item": "string",
        "why": "string"
      }
    ]
  }
}`;
}

function buildUpdatedChecklistPrompt(issueData, existingItems, segmentMeta) {
  const sm = segmentMeta || {};
  const segmentNote =
    sm.total > 1
      ? `This is checklist segment ${sm.index} of ${sm.total} in the same CSV file${
          sm.workItemTitle ? ` (source title: "${sm.workItemTitle}")` : ""
        }. Update ONLY the items listed below — do not merge, drop, or combine with other segments.\n\n`
      : "";
  return `You are a QA engineer.

Task:
1) Analyze Jira requirements.
2) Analyze existing CSV checklist/test content.
3) Produce updated checklist items that reflect current requirements.

${segmentNote}Issue key: ${issueData.key}
Summary: ${issueData.summary || ""}
Labels: ${(issueData.labels || []).join(", ") || "none"}
Description:
${issueData.description || ""}

Existing checklist candidates:
${JSON.stringify(existingItems, null, 2)}

Rules:
- Use categories Functional, Negative, Boundary, Integration only. Do NOT output Regression.
- Functional must be the largest group (more items than any other single category).

Return ONLY valid JSON (no markdown/code fences), schema:
{
  "checklistItems": [
    {
      "id": "CL-001",
      "description": "string",
      "category": "Functional" | "Negative" | "Boundary" | "Integration"
    }
  ],
  "reasoning": "string",
  "changeSummary": {
    "added": [
      {
        "item": "string",
        "why": "string"
      }
    ],
    "changed": [
      {
        "item": "string",
        "why": "string"
      }
    ]
  }
}`;
}

function normalizeChangeSummary(changeSummary) {
  const toList = (arr) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      if (x && typeof x === "object") {
        const item = String(x.item || "").trim();
        const why = String(x.why || "").trim();
        if (item) out.push({ item, why });
      } else if (typeof x === "string") {
        const item = x.trim();
        if (item) out.push({ item, why: "" });
      }
      if (out.length >= 7) break;
    }
    return out;
  };
  const added = toList(changeSummary?.added);
  const changed = toList(changeSummary?.changed);
  return { added, changed };
}

function normalizeExpectedResultText(expectedRaw) {
  const raw = String(expectedRaw || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  const bulletLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (bulletLines.length > 1 && bulletLines.every((l) => /^[-•]\s+/.test(l))) {
    return bulletLines.map((l) => l.replace(/^•\s+/, "- ")).join("\n");
  }
  let parts = [];
  if (raw.includes("\n")) {
    parts = bulletLines;
  } else {
    parts = raw.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  }
  if (parts.length <= 1) return raw;
  return parts
    .map((p) => p.replace(/^[-•]\s+/, "").trim())
    .filter(Boolean)
    .map((p) => `- ${p}`)
    .join("\n");
}

function normalizeExpectedInTestCases(testCases) {
  if (!Array.isArray(testCases)) return [];
  return testCases.map((tc) => ({
    ...tc,
    steps: Array.isArray(tc.steps)
      ? tc.steps.map((s) => ({
          ...s,
          expected: normalizeExpectedResultText(s.expected),
        }))
      : [],
  }));
}

function renderChangeSummaryLines(changeSummary) {
  const lines = [];
  if (changeSummary.added.length) {
    lines.push("Added:");
    changeSummary.added.forEach((x, idx) => {
      lines.push(`${idx + 1}. ${x.item}${x.why ? ` — Why: ${x.why}` : ""}`);
    });
  }
  if (changeSummary.changed.length) {
    lines.push("Changed:");
    changeSummary.changed.forEach((x, idx) => {
      lines.push(`${idx + 1}. ${x.item}${x.why ? ` — Why: ${x.why}` : ""}`);
    });
  }
  return lines;
}

/**
 * @param {{ blockIndex: number, totalBlocks: number } | null} placement - global post order in this run (1..N).
 * @param {{ index: number, total: number, caseTitle?: string | null } | null} tcSegmentMeta - among test-case groups in CSV (when nGroups>1).
 */
function buildUpdatedFlowApprovalAdfParagraphs(placement, tcSegmentMeta) {
  const pi =
    placement && placement.blockIndex >= 1 && placement.totalBlocks >= 1 ? placement : null;
  const out = [];

  if (pi && pi.totalBlocks === 1) {
    out.push(
      JiraClient.buildAdfParagraph(
        "This is the only block in this update. Add a new Jira comment: the first line of that comment should be APPROVED or APPROVED: all to approve this whole post. To pick only some of the numbered test cases in the tables below, use APPROVED: 1,2,3 (numbers = 1., 2., 3. in this comment) or APPROVED: all."
      )
    );
  } else if (pi) {
    out.push(
      JiraClient.buildAdfParagraph(
        `This post is block ${pi.blockIndex} of ${pi.totalBlocks} in this update (counted in the order posts appear on this sub-task). To approve only this whole post, add a new Jira comment with a line exactly like: APPROVED (${pi.blockIndex}). To approve only some numbered test cases in the tables below, use: APPROVED (${pi.blockIndex}): 1,2,3,… (numbers = 1., 2., 3. in this comment). To approve every block from this update, the first line of your new Jira comment should be APPROVED or APPROVED: all.`
      )
    );
  } else {
    out.push(
      JiraClient.buildAdfParagraph(
        "Approval (Update test design only). Add a new Jira comment on this sub-task. The first line of that comment should be APPROVED or APPROVED: all to approve every block from this update."
      )
    );
    out.push(
      JiraClient.buildAdfParagraph(
        "To approve only some blocks, use APPROVED (1), APPROVED (2), … (parentheses = block index in post order)."
      )
    );
  }

  if (tcSegmentMeta && tcSegmentMeta.total > 1) {
    const title = (tcSegmentMeta.caseTitle || "").trim();
    out.push(
      JiraClient.buildAdfParagraph(
        `Among test case groups in this CSV file: segment ${tcSegmentMeta.index}/${tcSegmentMeta.total}${
          title ? ` — ${title}` : ""
        }.`
      )
    );
  }

  if (pi && pi.totalBlocks > 1) {
    out.push(
      JiraClient.buildAdfParagraph(
        "Note: APPROVED: 1,2,3 applies only when this thread has a single generated block (numbers = numbered test cases in this post). With multiple blocks, use APPROVED (n) for a whole block or APPROVED (n): 1,2,3 for specific lines inside block n."
      )
    );
  }

  out.push(
    JiraClient.buildAdfParagraph(
      "Then run the update flow again with CHECK_APPROVAL=true to generate the approved CSV and optional Azure DevOps sync. Proposed cases follow below."
    )
  );
  return out;
}

/**
 * @param {{ blockIndex: number, totalBlocks: number } | null} placement
 * @param {{ index: number, total: number, workItemTitle?: string | null } | null} checklistSegmentMeta
 */
function formatChecklistBlockApprovalSection(placement, checklistSegmentMeta) {
  const pi =
    placement && placement.blockIndex >= 1 && placement.totalBlocks >= 1 ? placement : null;
  const lines = [];
  if (pi && pi.totalBlocks === 1) {
    lines.push(
      "This is the only block in this update. Add a new comment: first line APPROVED or APPROVED: all approves this whole checklist. To pick only some numbered items below, use APPROVED: 1,2,3 (numbers = 1., 2., 3. in this comment) or APPROVED: all."
    );
  } else if (pi) {
    lines.push(
      `This post is block ${pi.blockIndex} of ${pi.totalBlocks} in this update (order = how posts appear on this sub-task). To approve only this whole checklist post, add a new Jira comment with a line exactly like: APPROVED (${pi.blockIndex}). To approve only some numbered items in this post, use: APPROVED (${pi.blockIndex}): 1,2,3,… (numbers = the checklist lines below). To approve every block from this update, the first line of your new Jira comment should be APPROVED or APPROVED: all.`
    );
  } else {
    lines.push(
      "Approval (Update test design only). APPROVED or APPROVED: all on the first line approves every block. APPROVED (1), APPROVED (2), … approve only those blocks."
    );
  }
  const sm = checklistSegmentMeta || {};
  if (sm.total > 1 && sm.index) {
    lines.push(
      `Among checklist segments in this CSV export: Part ${sm.index}/${sm.total}${
        sm.workItemTitle ? ` — ${sm.workItemTitle}` : ""
      }.`
    );
  }
  lines.push(
    "Then run the update flow again with CHECK_APPROVAL=true to generate the CSV and optional Azure DevOps sync."
  );
  return lines.join("\n\n");
}

function updatedFlowSummaryApprovalFooter() {
  return `\n\nApproval (Update test design only): add a new comment on this sub-task.
• First line APPROVED or APPROVED: all — approves every posted block (checklists + test case groups) in chronological order.
• If this update posted more than one block, each block index 1…N must appear in the approval (e.g. APPROVED (1) and APPROVED (2)), unless you use APPROVED / APPROVED: all above. You may put those directives in one comment (several lines) or in separate comments after the latest \"Updated CSV flow: source file\" summary — they are merged in time order.
• APPROVED (n) — whole n-th block. APPROVED (n): 1,2,3,… — only those numbered lines inside block n (checklist items or numbered test cases in that post).
• If this thread has exactly one generated block, APPROVED: 1,2,3 still selects individual items inside that block.
Then rerun with CHECK_APPROVAL=true.`;
}

function buildTestCasesCommentAdf(testCasesResult, placement, tcSegmentMeta) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const changeSummary = normalizeChangeSummary(testCasesResult.changeSummary);
  const content = [
    JiraClient.buildAdfHeading("🤖 AI-Generated Test Cases (Updated CSV flow)", 3),
    ...buildUpdatedFlowApprovalAdfParagraphs(placement || null, tcSegmentMeta || null),
  ];
  if (reasoning) {
    content.push(JiraClient.buildAdfHeading("Reasoning", 4));
    content.push(JiraClient.buildAdfParagraph(reasoning));
  }
  if (changeSummary.added.length || changeSummary.changed.length) {
    content.push(JiraClient.buildAdfHeading("What was added / changed", 4));
    const lines = renderChangeSummaryLines(changeSummary);
    lines.forEach((line) => content.push(JiraClient.buildAdfParagraph(line)));
  }
  testCases.forEach((tc, idx) => {
    content.push(JiraClient.buildAdfParagraph(`${idx + 1}. ${(tc.title || "").trim()}`));
    const steps = (tc.steps || []).slice().sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
    const tableRows = [
      ["Test Step", "Step Action", "Step Expected"],
      ...steps.map((s) => [
        String(s.stepNumber != null ? s.stepNumber : ""),
        (s.action || "").trim(),
        normalizeExpectedResultText(s.expected),
      ]),
    ];
    const table = JiraClient.buildAdfTable(tableRows);
    if (table) content.push(table);
  });
  return { type: "doc", version: 1, content };
}

function formatChecklistComment(checklistResult, segmentMeta, placement) {
  const sm = segmentMeta || {};
  const partHeader =
    sm.total > 1
      ? `Part ${sm.index}/${sm.total}${
          sm.workItemTitle ? ` — ${sm.workItemTitle}` : ""
        }\n\n`
      : "";
  const items = checklistResult.checklistItems || [];
  const reasoning = checklistResult.reasoning || "";
  const changeSummary = normalizeChangeSummary(checklistResult.changeSummary);
  const itemsList = items
    .map((item, idx) => `${idx + 1}. [${item.category}] ${item.description}`)
    .join("\n");
  const changeLines = renderChangeSummaryLines(changeSummary);
  const approvalBlock = formatChecklistBlockApprovalSection(
    placement || null,
    sm.total > 1 && sm.index ? sm : null
  );
  return `${partHeader}🤖 AI-Generated Test Checklist (Updated CSV flow)

Approval instructions (Update test design only — this post):

${approvalBlock}

---
Proposed test scenarios:
${itemsList}

---
${reasoning ? `Reasoning:\n${reasoning}\n---\n` : ""}
${changeLines.length ? `What was added / changed (detailed):\n${changeLines.join("\n")}\n---\n` : ""}
📌 Generated automatically from Jira requirements + uploaded CSV`;
}

async function postOneUpdatedTestCaseGroup(
  jiraClient,
  testDesignKey,
  issueData,
  oneCase,
  segmentMeta,
  i0based,
  nGroups,
  placement
) {
  const prompt = buildUpdatedTestCasesPrompt(issueData, [oneCase], segmentMeta);
  const response = await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "12000", 10));
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.testCases || !Array.isArray(parsed.testCases)) {
    throw new Error("LLM response missing testCases array");
  }
  parsed.testCases = normalizeExpectedInTestCases(parsed.testCases);
  const tcSeg =
    segmentMeta && segmentMeta.total > 1
      ? {
          index: segmentMeta.index,
          total: segmentMeta.total,
          caseTitle: segmentMeta.caseTitle || null,
        }
      : null;
  const adfBody = buildTestCasesCommentAdf(parsed, placement || null, tcSeg);
  await jiraClient.addCommentAdf(testDesignKey, adfBody);
  const jsonPayload = JSON.stringify(
    { testCases: parsed.testCases, reasoning: parsed.reasoning || "" },
    null,
    2
  );
  const jsonFileName =
    nGroups === 1
      ? `generated-testcases-${testDesignKey}.json`
      : `generated-testcases-${testDesignKey}-seg${i0based + 1}.json`;
  const tmpPath = path.join(__dirname, jsonFileName);
  try {
    fs.writeFileSync(tmpPath, jsonPayload, "utf8");
    await jiraClient.addAttachment(testDesignKey, tmpPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
  console.log(
    `   ✅ Posted test case group ${i0based + 1}/${nGroups}${
      oneCase.title ? ` — ${oneCase.title}` : ""
    }`
  );
}

async function postOneUpdatedChecklistSegment(
  jiraClient,
  testDesignKey,
  issueData,
  seg,
  segmentMeta,
  i0based,
  nSeg,
  placement
) {
  console.log(
    `   Segment ${i0based + 1}/${nSeg}: ${seg.items.length} item(s)${
      seg.workItemTitle ? ` — ${seg.workItemTitle}` : ""
    }`
  );
  const prompt = buildUpdatedChecklistPrompt(issueData, seg.items, segmentMeta);
  const response = await callLLM(prompt, 5000);
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.checklistItems || !Array.isArray(parsed.checklistItems)) {
    throw new Error("LLM response missing checklistItems array");
  }
  await jiraClient.addComment(
    testDesignKey,
    formatChecklistComment(parsed, segmentMeta, placement || null)
  );
}

/** Base name may omit .csv; tries name then name + ".csv". */
function resolveCsvPathInUpdatedFolder(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) {
    if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isFile()) return nameOrPath;
    if (!/\.csv$/i.test(nameOrPath)) {
      const withCsv = `${nameOrPath}.csv`;
      if (fs.existsSync(withCsv) && fs.statSync(withCsv).isFile()) return withCsv;
    }
    return null;
  }
  const p = path.join(UPDATED_TEST_CASES_FOLDER, nameOrPath);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (!/\.csv$/i.test(nameOrPath)) {
    const pCsv = path.join(UPDATED_TEST_CASES_FOLDER, `${nameOrPath}.csv`);
    if (fs.existsSync(pCsv) && fs.statSync(pCsv).isFile()) return pCsv;
  }
  return null;
}

function readInputCsvFile() {
  if (!fs.existsSync(UPDATED_TEST_CASES_FOLDER)) {
    throw new Error(`Updated CSV folder not found: ${UPDATED_TEST_CASES_FOLDER}`);
  }
  if (UPDATED_FLOW_INPUT_FILE) {
    const resolved = resolveCsvPathInUpdatedFolder(UPDATED_FLOW_INPUT_FILE);
    if (!resolved) {
      throw new Error(
        `UPDATED_FLOW_INPUT_FILE not found: ${path.join(UPDATED_TEST_CASES_FOLDER, UPDATED_FLOW_INPUT_FILE)} (also tried .csv)`
      );
    }
    return resolved;
  }
  const files = fs
    .readdirSync(UPDATED_TEST_CASES_FOLDER, { withFileTypes: true })
    .filter((f) => f.isFile() && path.extname(f.name).toLowerCase() === ".csv")
    .map((f) => path.join(UPDATED_TEST_CASES_FOLDER, f.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No CSV files found in ${UPDATED_TEST_CASES_FOLDER}`);
  return files[0];
}

function runExistingApprovalFlow(issueKey) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["agent-docs.js"], {
      cwd: __dirname,
      env: { ...process.env, JIRA_ISSUE_KEY: issueKey, CHECK_APPROVAL: "true" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent-docs.js CHECK_APPROVAL flow exited with code ${code}`));
    });
  });
}

function extractFerKey(...sources) {
  for (const s of sources) {
    const m = String(s || "").match(/\b(PROJ-\d+)\b/i);
    if (m) return m[1].toUpperCase();
  }
  return "";
}

function buildUpdatedOutputNameFromParent(parentSummary, ferKey, fallbackKey) {
  const baseRaw = String(parentSummary || "").trim() || String(fallbackKey || "updated-cases");
  const safe = String(baseRaw)
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const keyPart = ferKey || String(fallbackKey || "").trim();
  const withKey = keyPart ? `${safe} (${keyPart})` : safe;
  return `${withKey} (updated by AI).csv`;
}

function readReportJsonIfExists() {
  const reportPath = path.join(__dirname, "report.yaml");
  if (!fs.existsSync(reportPath)) return null;
  try {
    const text = fs.readFileSync(reportPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function run() {
  const issueKey = String(process.env.JIRA_ISSUE_KEY || "").trim();
  if (!issueKey) {
    throw new Error("JIRA_ISSUE_KEY is required (e.g. PROJ-12345)");
  }
  const checkApproval = process.env.CHECK_APPROVAL === "true";
  if (checkApproval) {
    console.log("🔍 CHECK_APPROVAL=true: delegating to existing approval flow (CSV + optional ADO sync)...");
    const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
    const issue = await jiraClient.getIssueWithExpand(issueKey);
    const contextIssueKey = issue.fields?.parent?.key || issueKey;
    let parentIssue = issue;
    if (issue.fields?.parent?.key) {
      try {
        parentIssue = await jiraClient.getIssueWithExpand(issue.fields.parent.key);
      } catch {
        parentIssue = issue;
      }
    }
    const parentData = jiraClient.extractIssueData(parentIssue);
    const ferKey = extractFerKey(parentData.key, parentData.summary, contextIssueKey);
    await runExistingApprovalFlow(issueKey);
    const report = readReportJsonIfExists();
    const generatedPath = report?.approvalCsv?.csvPath ? String(report.approvalCsv.csvPath) : "";
    if (generatedPath && fs.existsSync(generatedPath)) {
      const dir = path.dirname(generatedPath);
      const targetName = buildUpdatedOutputNameFromParent(
        parentData.summary,
        ferKey,
        parentData.key || contextIssueKey
      );
      const targetPath = path.join(dir, targetName);
      if (path.resolve(generatedPath) !== path.resolve(targetPath)) {
        // Keep historical file if name already exists.
        const finalPath = fs.existsSync(targetPath)
          ? path.join(
              dir,
              `${path.basename(targetName, ".csv")} (${Date.now()}).csv`
            )
          : targetPath;
        fs.copyFileSync(generatedPath, finalPath);
        console.log(`✅ Renamed approved CSV copy for updated flow: ${finalPath}`);
      }
    } else {
      console.log("ℹ️  Approval flow finished, but generated CSV path not found in report.yaml.");
    }
    return;
  }

  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = issue.fields?.parent?.key || issueKey;
  const contextIssue =
    contextIssueKey !== issueKey ? await jiraClient.getIssueWithExpand(contextIssueKey) : issue;
  const issueData = jiraClient.extractIssueData(contextIssue);

  const testDesignKey = await jiraClient.getTestDesignSubtaskKey(contextIssueKey, PROJECT_KEY);
  if (!testDesignKey) {
    throw new Error("No QA Sub-task with title 'Test design' found for this issue.");
  }

  const csvPath = readInputCsvFile();
  console.log(`📂 Input CSV: ${csvPath}`);
  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvRows(csvText);
  const existingCases = rowsToTestCases(rows);
  const checklistSegments = rowsToChecklistSegments(rows);

  let mode = UPDATED_FLOW_MODE;
  if (!["auto", "testcases", "checklist"].includes(mode)) mode = "auto";

  if (mode === "auto") {
    console.log(`🧭 Updated CSV mode: auto (per-block: test case vs checklist, CSV order)`);
    const blocks = parseUpdatedCsvBlocksForAuto(rows);
    if (!blocks.length) {
      throw new Error("No test case or checklist content found in CSV");
    }
    const tcCount = blocks.filter((b) => b.type === "testcase").length;
    const clCount = blocks.filter((b) => b.type === "checklist").length;
    let tcIdx = 0;
    let clIdx = 0;
    if (tcCount > 1) {
      console.log(`🧪 Test case blocks in CSV: ${tcCount} (sequential LLM runs)`);
    }
    if (clCount > 1) {
      console.log(`📋 Checklist blocks in CSV: ${clCount} (sequential LLM runs)`);
    }
    const totalBlocks = blocks.length;
    let blockPos = 0;
    for (const block of blocks) {
      blockPos += 1;
      const placement = { blockIndex: blockPos, totalBlocks };
      if (block.type === "testcase") {
        const meta =
          tcCount > 1
            ? {
                index: tcIdx + 1,
                total: tcCount,
                caseTitle: (block.case.title || "").trim() || null,
              }
            : null;
        await postOneUpdatedTestCaseGroup(
          jiraClient,
          testDesignKey,
          issueData,
          block.case,
          meta,
          tcIdx,
          tcCount,
          placement
        );
        tcIdx++;
      } else {
        const seg = block.segment;
        const meta =
          clCount > 1
            ? {
                index: clIdx + 1,
                total: clCount,
                workItemTitle: seg.workItemTitle || null,
                workItemType: seg.workItemType || null,
              }
            : null;
        await postOneUpdatedChecklistSegment(
          jiraClient,
          testDesignKey,
          issueData,
          seg,
          meta,
          clIdx,
          clCount,
          placement
        );
        clIdx++;
      }
    }

    const base = path.basename(csvPath);
    let summary;
    if (tcCount && clCount) {
      summary = `Updated CSV flow: source file "${base}" — posted **${tcCount}** test case block(s) and **${clCount}** checklist(s) **in CSV order** (comments may alternate: ADF tables vs checklist text).${updatedFlowSummaryApprovalFooter()}`;
    } else if (tcCount > 1) {
      summary = `Updated CSV flow: source file "${base}" — ${tcCount} test case group(s) from the CSV were analyzed and posted above **in order** (not merged into one run).${updatedFlowSummaryApprovalFooter()}`;
    } else if (clCount > 1) {
      summary = `Updated CSV flow: source file "${base}" — ${clCount} separate checklist(s) from the CSV were analyzed and posted above **in order** (not merged).${updatedFlowSummaryApprovalFooter()}`;
    } else if (tcCount === 1) {
      summary = `Updated CSV flow: source file "${base}" analyzed, test cases posted for approval.${updatedFlowSummaryApprovalFooter()}`;
    } else {
      summary = `Updated CSV flow: source file "${base}" analyzed, checklist posted for approval.${updatedFlowSummaryApprovalFooter()}`;
    }
    await jiraClient.addComment(testDesignKey, summary);
    console.log(
      `✅ Updated CSV (auto): ${tcCount} test case block(s), ${clCount} checklist block(s) → ${testDesignKey}`
    );
    return;
  }

  console.log(`🧭 Updated CSV mode: ${mode}`);

  if (mode === "testcases") {
    const withSteps = existingCases.filter((c) => (c.steps || []).length > 0);
    const caseGroups = withSteps.length ? withSteps : existingCases;
    if (!caseGroups.length) {
      throw new Error("No test cases found in CSV (expected Test Case rows with steps)");
    }
    const nGroups = caseGroups.length;
    if (nGroups > 1) {
      console.log(`🧪 Test case groups in CSV: ${nGroups} (updating sequentially, not merged)`);
    }
    const totalBlocksTc = nGroups;
    for (let i = 0; i < nGroups; i++) {
      const oneCase = caseGroups[i];
      const meta =
        nGroups > 1
          ? { index: i + 1, total: nGroups, caseTitle: (oneCase.title || "").trim() || null }
          : null;
      await postOneUpdatedTestCaseGroup(
        jiraClient,
        testDesignKey,
        issueData,
        oneCase,
        meta,
        i,
        nGroups,
        { blockIndex: i + 1, totalBlocks: totalBlocksTc }
      );
    }
    await jiraClient.addComment(
      testDesignKey,
      nGroups > 1
        ? `Updated CSV flow: source file "${path.basename(
            csvPath
          )}" — ${nGroups} test case group(s) from the CSV were analyzed and posted above **in order** (not merged into one run).${updatedFlowSummaryApprovalFooter()}`
        : `Updated CSV flow: source file "${path.basename(
            csvPath
          )}" analyzed, test cases posted for approval.${updatedFlowSummaryApprovalFooter()}`
    );
    console.log(`✅ Updated test case(s) posted to ${testDesignKey}`);
  } else {
    if (!checklistSegments.length) {
      throw new Error("No checklist content found in CSV");
    }
    const nSeg = checklistSegments.length;
    if (nSeg > 1) {
      console.log(`📋 Checklist segments in CSV: ${nSeg} (updating sequentially, not merged)`);
    }
    for (let i = 0; i < nSeg; i++) {
      const seg = checklistSegments[i];
      const meta =
        nSeg > 1
          ? {
              index: i + 1,
              total: nSeg,
              workItemTitle: seg.workItemTitle || null,
              workItemType: seg.workItemType || null,
            }
          : null;
      await postOneUpdatedChecklistSegment(
        jiraClient,
        testDesignKey,
        issueData,
        seg,
        meta,
        i,
        nSeg,
        { blockIndex: i + 1, totalBlocks: nSeg }
      );
    }
    await jiraClient.addComment(
      testDesignKey,
      nSeg > 1
        ? `Updated CSV flow: source file "${path.basename(
            csvPath
          )}" — ${nSeg} separate checklist(s) from the CSV were analyzed and posted above **in order** (not merged).${updatedFlowSummaryApprovalFooter()}`
        : `Updated CSV flow: source file "${path.basename(
            csvPath
          )}" analyzed, checklist posted for approval.${updatedFlowSummaryApprovalFooter()}`
    );
    console.log(`✅ Updated checklist(s) posted to ${testDesignKey}`);
  }
}

run().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});

