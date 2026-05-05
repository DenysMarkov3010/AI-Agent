/**
 * Parse Azure DevOps-style approved CSV and create Test Case work items in Azure DevOps.
 * Used after Jira approval CSV is generated (checklist or test cases format — same columns).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { AdoClient } = require("./ado-client");

const COL = {
  ID: 0,
  TYPE: 1,
  TITLE: 2,
  STEP: 3,
  ACTION: 4,
  EXPECTED: 5,
  PRIORITY: 6,
  AREA: 7,
  ASSIGNED: 8,
  STATE: 9,
};

/** Minimal CSV parser (RFC4180-style quoted fields). */
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

/**
 * @param {string[][]} rows
 * @returns {Array<{ refId: string, title: string, priority: string, areaPath: string, steps: { stepNumber: number, action: string, expected: string }[] }>}
 */
function pixelRowsToTestCases(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((c) => (c || "").trim().toLowerCase());
  if (!header.includes("title") || !header.includes("test step")) {
    throw new Error("CSV does not look like test format (expected Title, Test Step columns)");
  }
  const cases = [];
  /** @type {{ refId: string, title: string, priority: string, areaPath: string, steps: object[] } | null} */
  let current = null;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 10) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const wit = (line[COL.TYPE] || "").trim();
    if (title && wit.toLowerCase() === "test case") {
      current = {
        refId: (line[COL.ID] || "").trim(),
        title,
        priority: (line[COL.PRIORITY] || "2").trim() || "2",
        areaPath: (line[COL.AREA] || "").trim(),
        steps: [],
      };
      cases.push(current);
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
  return cases.filter((c) => c.steps.length > 0 || c.title);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Legacy: BDD was previously appended as a synthetic CSV step with this prefix
 * (when ADO sync auto-built System.Description). That logic is removed — BDD is now
 * generated separately from approved test cases / checklists via the LLM prompt
 * documented in TEST_CASE_FORMAT.md → "Prompt: BDD / Gherkin for Azure DevOps Summary".
 * This filter stays as a defensive cleanup so any old CSVs that still contain such
 * synthetic rows do not produce junk Test Case steps in Azure DevOps.
 */
const LEGACY_BDD_CSV_STEP_PREFIX = "__BDD_HTML__";

function partitionManualStepsForSync(steps) {
  return (steps || []).filter((s) => !String(s.action || "").startsWith(LEGACY_BDD_CSV_STEP_PREFIX));
}

// ---------------------------------------------------------------------------
// BDD / Gherkin generation for ADO Test Case System.Description (Summary tab)
// ---------------------------------------------------------------------------
// Calls OpenRouter with the prompt documented in TEST_CASE_FORMAT.md →
// "Prompt: BDD / Gherkin for Azure DevOps Summary". One LLM call PER imported
// Test Case, producing one focused Scenario in that work item's Description.
// Failure of BDD generation is non-fatal: the imported Test Case is preserved
// and the user gets a console warning.

function adoSyncBddFromPromptEnabled() {
  const v = String(process.env.ADO_SYNC_BDD_FROM_PROMPT ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

let cachedAdoBddPromptText = null;

/**
 * Read the BDD prompt body (the inner ```text block) from TEST_CASE_FORMAT.md.
 * Result is cached for the lifetime of the process.
 */
function loadAdoBddPromptText() {
  if (cachedAdoBddPromptText !== null) return cachedAdoBddPromptText;
  const file = path.join(__dirname, "TEST_CASE_FORMAT.md");
  try {
    if (!fs.existsSync(file)) {
      cachedAdoBddPromptText = "";
      return cachedAdoBddPromptText;
    }
    const md = fs.readFileSync(file, "utf8");
    const sectionMarker = "## Prompt: BDD / Gherkin for Azure DevOps Summary";
    const sectionStart = md.indexOf(sectionMarker);
    if (sectionStart < 0) {
      cachedAdoBddPromptText = "";
      return cachedAdoBddPromptText;
    }
    const section = md.slice(sectionStart);
    const fenceStart = section.indexOf("```text");
    if (fenceStart < 0) {
      cachedAdoBddPromptText = "";
      return cachedAdoBddPromptText;
    }
    const after = section.slice(fenceStart + "```text".length);
    const fenceEnd = after.indexOf("\n```");
    if (fenceEnd < 0) {
      cachedAdoBddPromptText = "";
      return cachedAdoBddPromptText;
    }
    cachedAdoBddPromptText = after.slice(0, fenceEnd).trim();
    return cachedAdoBddPromptText;
  } catch (e) {
    console.warn(`   ADO BDD: could not load prompt from TEST_CASE_FORMAT.md — ${e.message}`);
    cachedAdoBddPromptText = "";
    return cachedAdoBddPromptText;
  }
}

/**
 * Decide BDD mode for one ADO Test Case based on its CSV step rows:
 * if no Step Expected has content → checklist-style (logical phrasing in prompt);
 * else test_case-style (UI-anchored phrasing).
 * @param {{ steps: Array<{ stepNumber: number, action: string, expected: string }> }} tc
 */
function detectBddModeForTestCase(tc) {
  const steps = (tc?.steps || []).filter((s) => Number(s.stepNumber) >= 2);
  if (!steps.length) return "test_case";
  const withExpected = steps.filter((s) => String(s.expected || "").trim().length > 0).length;
  return withExpected === 0 ? "checklist" : "test_case";
}

/**
 * Render one parsed test case as the input artifact text expected by the BDD prompt.
 * @param {{ title: string, priority?: string, areaPath?: string, steps: Array<{ stepNumber: number, action: string, expected: string }> }} tc
 */
function formatTestCaseAsBddArtifact(tc) {
  const lines = [];
  lines.push(`Title: ${String(tc.title || "").trim()}`);
  if (tc.priority) lines.push(`Priority: ${tc.priority}`);
  if (tc.areaPath) lines.push(`Area Path: ${tc.areaPath}`);
  lines.push("");
  lines.push("Steps:");
  const sorted = [...(tc.steps || [])].sort(
    (a, b) => (a.stepNumber || 0) - (b.stepNumber || 0)
  );
  for (const s of sorted) {
    const action = String(s.action || "").trim();
    const expected = String(s.expected || "").trim();
    lines.push(`Step ${s.stepNumber}:`);
    lines.push(`  Action: ${action || "(empty)"}`);
    lines.push(`  Expected: ${expected || "(empty)"}`);
  }
  return lines.join("\n");
}

/**
 * Compose the full LLM prompt: the prompt body + a single test case as artifact + meta.
 * @param {object} args
 * @param {string} args.promptBody
 * @param {string} args.mode
 * @param {object} args.tc
 * @param {string} [args.jiraKey]
 */
function buildLlmPromptForTestCaseBdd({ promptBody, mode, tc, jiraKey }) {
  const artifact = formatTestCaseAsBddArtifact(tc);
  const metaLines = [];
  if (jiraKey) metaLines.push(`jira_key: ${jiraKey}`);
  if (tc.areaPath) metaLines.push(`area_path: ${tc.areaPath}`);
  const meta = metaLines.length ? metaLines.join("\n") : "(none)";

  return [
    promptBody,
    "",
    "---",
    "",
    "INPUT (the artifact to convert):",
    `mode: ${mode}`,
    `meta:\n${meta}`,
    "",
    "artifact:",
    artifact,
    "",
    "ADO-SUMMARY OVERRIDE (this invocation only):",
    "- Do PHASE 1 and PHASE 2 silently, internally — DO NOT include them in the response.",
    "- Output ONLY the PHASE 3 artifact: a single Gherkin Feature block.",
    "- Your response MUST start with the literal token `Feature:` on the very first line.",
    "- No markdown headings (no `#`, no `##`). No prose. No markdown fences. No JSON.",
  ].join("\n");
}

const ADO_BDD_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function bddDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call OpenRouter once with the assembled prompt; one retry on retryable error.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callOpenRouterForBdd(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const models = (process.env.OPENROUTER_MODELS || "openai/gpt-oss-20b:free")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const maxTokens = parseInt(process.env.ADO_SYNC_BDD_MAX_TOKENS || "2000", 10);
  const fetchFn = globalThis.fetch || require("node-fetch");

  let lastError = null;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const isLastModel = modelIndex === models.length - 1;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
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
          const errText = await res.text();
          const message = `OpenRouter error: ${res.status} ${res.statusText}. ${errText}`;
          lastError = new Error(message);
          const retryable = ADO_BDD_RETRYABLE_STATUS.has(res.status);
          if (retryable && attempt < 2) {
            await bddDelay(1200 * attempt);
            continue;
          }
          if (retryable && !isLastModel) {
            console.warn(`   ADO BDD: model "${model}" rate-limited; trying next model`);
            break;
          }
          throw lastError;
        }
        const data = await res.json();
        if (!data.choices || !data.choices[0]) {
          throw new Error("OpenRouter returned no choices");
        }
        return String(data.choices[0].message?.content || "").trim();
      } catch (e) {
        lastError = e;
        if (attempt < 2) {
          await bddDelay(1200 * attempt);
          continue;
        }
        if (!isLastModel) {
          console.warn(`   ADO BDD: model "${model}" failed; trying next model — ${e.message}`);
          break;
        }
        throw lastError;
      }
    }
  }
  throw lastError || new Error("OpenRouter call failed");
}

/**
 * Clean up the model output: drop any markdown fences and any preamble the LLM
 * may have emitted (Phase 1 "Detected mode and inputs", Phase 2 "Scenario plan",
 * etc.) so that the result starts at the first `Feature:` line. Also drops any
 * trailing markdown sections that some models append after the Feature block.
 */
function extractGherkinFromLlmResponse(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:gherkin|cucumber|text)?\s*\n/i, "").replace(/\n```\s*$/i, "");
  const featureIdx = s.search(/^Feature:/m);
  if (featureIdx > 0) {
    s = s.slice(featureIdx);
  }
  // Drop a trailing markdown section if one slipped through (e.g. "# Self-check ...").
  const trailingHeading = s.search(/\n#{1,6}\s+\w/);
  if (trailingHeading > 0) {
    s = s.slice(0, trailingHeading);
  }
  return s.trim();
}

/**
 * Wrap plain Gherkin text into ADO HTML (Description renders <pre>).
 * Prepends one empty line (`<p><br/></p>`) so the BDD block does not stick to the
 * top of the Summary tab > Description field.
 */
function wrapGherkinAsAdoDescription(gherkin) {
  const escaped = String(gherkin || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div><p><br/></p><pre>${escaped}</pre></div>`;
}

/**
 * End-to-end BDD generation for one parsed Test Case. Returns the HTML to put
 * into /fields/System.Description, or null on failure (caller should warn).
 * @param {object} args
 * @param {object} args.tc
 * @param {string} [args.jiraKey]
 * @param {string} args.promptBody
 */
async function generateBddDescriptionHtmlForTestCase({ tc, jiraKey, promptBody }) {
  const mode = detectBddModeForTestCase(tc);
  const prompt = buildLlmPromptForTestCaseBdd({ promptBody, mode, tc, jiraKey });
  const raw = await callOpenRouterForBdd(prompt);
  const gherkin = extractGherkinFromLlmResponse(raw);
  if (!gherkin || !/^Feature:/m.test(gherkin)) {
    throw new Error("LLM response did not contain a Feature block");
  }
  return wrapGherkinAsAdoDescription(gherkin);
}

/**
 * Azure DevOps Test Case steps field (HTML/XML).
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} steps
 */
function buildTcmStepsXml(steps) {
  const sorted = [...steps].sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
  const last = sorted.length;
  const stepNodes = sorted.map((s, idx) => {
    const id = idx + 1;
    const act = escapeXml(s.action);
    const exp = escapeXml(s.expected || "");
    return `<step id="${id}" type="ValidateStep"><parameterizedString isformatted="true">${act}</parameterizedString><parameterizedString isformatted="true">${exp}</parameterizedString><description/></step>`;
  });
  return `<steps id="0" last="${last}">${stepNodes.join("")}</steps>`;
}

function resolveAreaPath(rowArea) {
  const fromRow = (rowArea || "").trim();
  const prefix = (process.env.ADO_AREA_PATH_PREFIX || "").trim();
  if (prefix && fromRow) {
    if (fromRow.includes("\\")) return fromRow;
    return `${prefix}\\${fromRow}`;
  }
  if (fromRow) return fromRow;
  return (process.env.ADO_DEFAULT_AREA_PATH || "").trim();
}

function getAdoClientFromEnv() {
  const org = process.env.ADO_ORG || process.env.AZURE_DEVOPS_ORG;
  const project = process.env.ADO_PROJECT || process.env.AZURE_DEVOPS_PROJECT;
  const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
  if (!org || !project || !pat) {
    throw new Error("Set ADO_ORG, ADO_PROJECT, ADO_PAT for Azure DevOps sync");
  }
  const baseUrl = process.env.ADO_SERVER_URL;
  return new AdoClient(org, project, pat, baseUrl ? { baseUrl } : {});
}

const WORK_ITEM_TYPE = process.env.ADO_TEST_CASE_WORK_ITEM_TYPE || "Test Case";

/**
 * Parse planId/suiteId from the Test Plan page address bar (e.g.
 * `.../_testPlans/define?planId=12686&suiteId=14213` or a full https URL).
 * Same values as ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID and the REST API.
 * @param {string} raw
 * @returns {{ planId: number, suiteId: number }} NaN for a parameter when missing
 */
function parsePlanSuiteFromAdoUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { planId: NaN, suiteId: NaN };
  let search = "";
  try {
    if (/^https?:\/\//i.test(s)) {
      search = new URL(s).search || "";
    } else if (s.includes("?")) {
      search = s.slice(s.indexOf("?"));
    } else if (/planId=/i.test(s)) {
      search = s.startsWith("?") ? s : `?${s}`;
    }
  } catch {
    search = "";
  }
  const q = search.startsWith("?") ? search : search ? `?${search}` : "";
  const params = new URLSearchParams(q || "?");
  const planId = parseInt(params.get("planId") || params.get("planid") || "", 10);
  const suiteId = parseInt(params.get("suiteId") || params.get("suiteid") || "", 10);
  return {
    planId: Number.isFinite(planId) && planId > 0 ? planId : NaN,
    suiteId: Number.isFinite(suiteId) && suiteId > 0 ? suiteId : NaN,
  };
}

/**
 * Precedence: CLI -p/-s → --ado-url → ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID → ADO_SYNC_TEST_PLAN_URL.
 * Numeric .env values match the browser query planId=…&suiteId=….
 */
function resolvePlanSuiteIds({ cliPlan, cliSuite, cliAdoUrl }) {
  const fromCliUrl = parsePlanSuiteFromAdoUrl(cliAdoUrl || "");
  const fromEnvUrl = parsePlanSuiteFromAdoUrl(process.env.ADO_SYNC_TEST_PLAN_URL || "");
  const envP = parseInt(process.env.ADO_SYNC_PLAN_ID || "", 10);
  const envS = parseInt(process.env.ADO_SYNC_SUITE_ID || "", 10);
  const basePlan = Number.isFinite(envP) && envP > 0 ? envP : fromEnvUrl.planId;
  const baseSuite = Number.isFinite(envS) && envS > 0 ? envS : fromEnvUrl.suiteId;

  const planId = Number.isFinite(cliPlan) && cliPlan > 0
    ? cliPlan
    : Number.isFinite(fromCliUrl.planId) && fromCliUrl.planId > 0
      ? fromCliUrl.planId
      : basePlan;
  const suiteId = Number.isFinite(cliSuite) && cliSuite > 0
    ? cliSuite
    : Number.isFinite(fromCliUrl.suiteId) && fromCliUrl.suiteId > 0
      ? fromCliUrl.suiteId
      : baseSuite;
  return { planId, suiteId };
}

/** Same as ado-plan-tools `envActiveTestPlanId`: active (feature) plan id from .env. */
function envActiveTestPlanIdNumber() {
  const raw = process.env.ADO_ACTIVE_TEST_PLAN_ID || process.env.ADO_TEST_PLAN_ID || "";
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Automatic sync after Jira approval (`ADO_SYNC_APPROVED_CSV=true`): Test Plan id must come **only**
 * from `ADO_ACTIVE_TEST_PLAN_ID` (legacy: `ADO_TEST_PLAN_ID`). Ignores `ADO_SYNC_PLAN_ID` and plan id from URLs.
 * Suite: `ADO_SYNC_SUITE_ID`, or `suiteId` from `ADO_SYNC_TEST_PLAN_URL` / optional `cliAdoUrl` (suite only).
 */
function resolvePlanSuiteIdsApprovalRun({ cliSuite, cliAdoUrl }) {
  const planId = envActiveTestPlanIdNumber();
  const fromEnvUrl = parsePlanSuiteFromAdoUrl(process.env.ADO_SYNC_TEST_PLAN_URL || "");
  const fromCliUrl = parsePlanSuiteFromAdoUrl(cliAdoUrl || "");
  const envS = parseInt(process.env.ADO_SYNC_SUITE_ID || "", 10);
  const suiteId = Number.isFinite(cliSuite) && cliSuite > 0
    ? cliSuite
    : Number.isFinite(fromCliUrl.suiteId) && fromCliUrl.suiteId > 0
      ? fromCliUrl.suiteId
      : Number.isFinite(envS) && envS > 0
        ? envS
        : Number.isFinite(fromEnvUrl.suiteId) && fromEnvUrl.suiteId > 0
          ? fromEnvUrl.suiteId
          : NaN;
  return { planId, suiteId };
}

/**
 * Jira-style key from CSV basename, e.g. `approved-testcases-PROJ-123.csv` → `PROJ-123`.
 * @param {string} csvFilePath
 */
function extractJiraKeyFromCsvFilename(csvFilePath) {
  const base = path.basename(csvFilePath || "");
  const m = base.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return m ? m[1].toUpperCase() : "";
}

function normalizeJiraIssueKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  const m = s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Jira key as a distinct token in path or suite title (avoids PROJ-1 inside PROJ-123; allows [PROJ-123], (PROJ-123)).
 * Combines path-segment boundaries with a general “non-alphanumeric before / no digit after” rule.
 */
function pathOrNameHasJiraKeyToken(path, name, kUpper) {
  const k = String(kUpper || "").trim().toUpperCase();
  if (!k) return false;
  const esc = escapeRegExp(k);
  const reSegment = new RegExp(`(^|[\\s/])${esc}([\\s/]|$)`, "i");
  const reToken = new RegExp(`(?<![A-Za-z0-9])${esc}(?!\\d)`, "i");
  const hit = (s) => reSegment.test(s) || reToken.test(s);
  if (hit(String(name || ""))) return true;
  return hit(String(path || ""));
}

/**
 * Pick the suite whose name or path contains the Jira key as a token (prefer exact suite name).
 * @param {Array<{ suiteId: number, suiteName: string, path: string }>} flat
 * @param {string} jiraKey e.g. PROJ-123
 */
function pickSuiteForJiraKey(flat, jiraKey) {
  const k = String(jiraKey || "").trim().toUpperCase();
  if (!k || !flat.length) return null;
  const titleOnly = process.env.ADO_SYNC_SUITE_MATCH_TITLE_ONLY === "true";
  const pool = titleOnly
    ? flat.filter((s) => pathOrNameHasJiraKeyToken("", s.suiteName, k))
    : flat;
  if (titleOnly && pool.length === 0) {
    return null;
  }
  const list = titleOnly ? pool : flat;
  const suffix = ` / ${k}`;
  /** @type {{ suite: (typeof flat)[0], score: number } | null} */
  let best = null;
  for (const s of list) {
    const nameU = (s.suiteName || "").toUpperCase();
    const pathU = (s.path || "").toUpperCase();
    if (!pathOrNameHasJiraKeyToken(titleOnly ? "" : s.path, s.suiteName, k)) continue;
    let score = 0;
    if (nameU === k) score = 100;
    else if (pathU.endsWith(suffix)) score = 95;
    else if (pathOrNameHasJiraKeyToken("", s.suiteName, k)) score = 70;
    else score = 40;
    if (
      !best ||
      score > best.score ||
      (score === best.score && s.path.length < best.suite.path.length)
    ) {
      best = { suite: s, score };
    }
  }
  return best ? best.suite : null;
}

/**
 * Automatic sync: load suites under `ADO_ACTIVE_TEST_PLAN_ID`, match key from filename (or issue key).
 * Logs one line: matched suite or `Not found`. Set `ADO_SYNC_SUITE_LIST_VERBOSE=true` to print many suite lines.
 * @param {object} client - AdoClient with listFlatSuitesInPlan
 * @param {number} planId
 * @param {string} csvFilePath
 * @param {string} jiraIssueKey
 * @param {number} fallbackSuiteId
 * @returns {Promise<number>}
 */
async function resolveSuiteIdForApprovalByCsvKey(client, planId, csvFilePath, jiraIssueKey, fallbackSuiteId) {
  if (process.env.ADO_SYNC_SUITE_MATCH_CSV_KEY === "false") {
    return fallbackSuiteId;
  }
  const keyForSuite =
    extractJiraKeyFromCsvFilename(csvFilePath) || normalizeJiraIssueKey(jiraIssueKey);
  if (!keyForSuite) {
    console.warn(
      "   ⚠️  ADO sync: no Jira key in CSV filename (e.g. approved-testcases-PROJ-123.csv) and no issue key — using ADO_SYNC_SUITE_ID / URL only"
    );
    return fallbackSuiteId;
  }

  try {
    const t0 = Date.now();
    const flat = await client.listFlatSuitesInPlan(planId);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const titleOnly = process.env.ADO_SYNC_SUITE_MATCH_TITLE_ONLY === "true";
    const verbose = process.env.ADO_SYNC_SUITE_LIST_VERBOSE === "true";

    if (verbose) {
      const maxLog = parseInt(process.env.ADO_SYNC_SUITE_LIST_MAX || "50", 10) || 50;
      console.log(
        `   Azure DevOps: ${flat.length} suite(s) in ${elapsed}s — "${keyForSuite}" (${titleOnly ? "title only" : "name/path"}), listing up to ${maxLog}:`
      );
      const show = flat.slice(0, maxLog);
      for (const s of show) {
        console.log(`      ${s.suiteId}\t${s.path}`);
      }
      if (flat.length > show.length) {
        console.log(`      … and ${flat.length - show.length} more (raise ADO_SYNC_SUITE_LIST_MAX)`);
      }
    }

    const picked = pickSuiteForJiraKey(flat, keyForSuite);
    if (picked) {
      console.log(
        `   Azure DevOps: "${keyForSuite}" → suite ${picked.suiteId} — ${picked.path}`
      );
      return picked.suiteId;
    }
    console.log(`   Azure DevOps: "${keyForSuite}" → Not found (${flat.length} suites, ${elapsed}s)`);
    console.warn(
      titleOnly
        ? `   ⚠️  No suite in this plan has "${keyForSuite}" in its title (ADO_SYNC_SUITE_MATCH_TITLE_ONLY=true) — using ADO_SYNC_SUITE_ID / URL fallback if set`
        : `   ⚠️  No suite in this plan contains "${keyForSuite}" in name or path — using ADO_SYNC_SUITE_ID / URL fallback if set`
    );
    return fallbackSuiteId;
  } catch (e) {
    console.warn(`   ⚠️  Could not list suites for Jira key match: ${e.message}`);
    return fallbackSuiteId;
  }
}

/**
 * Create Test Cases in Azure DevOps from an on-disk approved CSV file.
 * @param {string} csvFilePath
 * @param {{ jiraIssueKey?: string, planId?: number, suiteId?: number, syncFromApprovalRun?: boolean }} [opts]
 *   When `syncFromApprovalRun` is true (agent after approval), plan id is taken **only** from `ADO_ACTIVE_TEST_PLAN_ID` (not `ADO_SYNC_PLAN_ID` / URL plan).
 * @returns {Promise<{ created: { id: number, title: string }[], errors: string[] }>}
 */
async function syncApprovedPixelCsvToAzureDevOps(csvFilePath, opts = {}) {
  const jiraKey = opts.jiraIssueKey || "";
  const text = fs.readFileSync(csvFilePath, "utf8");
  const rows = parseCsvRows(text);
  const testCases = pixelRowsToTestCases(rows);
  if (testCases.length === 0) {
    return { created: [], errors: ["No test cases parsed from CSV"] };
  }

  const client = getAdoClientFromEnv();
  let planId;
  let suiteId;
  if (opts.syncFromApprovalRun) {
    const r = resolvePlanSuiteIdsApprovalRun({
      cliSuite: opts.suiteId,
      cliAdoUrl: opts.adoUrl || "",
    });
    planId = r.planId;
    suiteId = r.suiteId;
    if (!Number.isFinite(planId) || planId <= 0) {
      throw new Error(
        "ADO_SYNC_APPROVED_CSV: set ADO_ACTIVE_TEST_PLAN_ID to the Test Plan id for automatic sync (ADO_SYNC_PLAN_ID is not used for this flow)."
      );
    }
    console.log(`   Azure DevOps: Test Plan id ${planId} (from ADO_ACTIVE_TEST_PLAN_ID)`);
    const fallbackSuite = suiteId;
    suiteId = await resolveSuiteIdForApprovalByCsvKey(
      client,
      planId,
      csvFilePath,
      jiraKey,
      fallbackSuite
    );
  } else {
    const r = resolvePlanSuiteIds({
      cliPlan: opts.planId,
      cliSuite: opts.suiteId,
      cliAdoUrl: opts.adoUrl || "",
    });
    planId = r.planId;
    suiteId = r.suiteId;
  }
  const tagPrefix = process.env.ADO_JIRA_TAG_PREFIX || "Jira";

  const created = [];
  const errors = [];

  const bddEnabled = adoSyncBddFromPromptEnabled();
  let bddPromptBody = "";
  if (bddEnabled) {
    bddPromptBody = loadAdoBddPromptText();
    if (!bddPromptBody) {
      console.warn(
        "   ADO BDD: prompt body not found in TEST_CASE_FORMAT.md — System.Description will be left empty"
      );
    } else if (!process.env.OPENROUTER_API_KEY) {
      console.warn(
        "   ADO BDD: OPENROUTER_API_KEY is not set — System.Description will be left empty"
      );
      bddPromptBody = "";
    } else {
      console.log(
        `   ADO BDD: per-Test-Case Gherkin generation is ON for ${testCases.length} case(s) (set ADO_SYNC_BDD_FROM_PROMPT=false to disable)`
      );
    }
  }

  for (const tc of testCases) {
    const manualSteps = partitionManualStepsForSync(tc.steps);
    if (!manualSteps.length) {
      errors.push(`Skipped (no steps): ${tc.title}`);
      continue;
    }
    const area = resolveAreaPath(tc.areaPath);
    const stepsXml = buildTcmStepsXml(manualSteps);
    /** @type {Array<{ op: string, path: string, value?: unknown }>} */
    const patch = [
      { op: "add", path: "/fields/System.Title", value: tc.title },
      { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: stepsXml },
    ];
    const pri = parseInt(tc.priority, 10);
    if (Number.isFinite(pri)) {
      patch.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: pri });
    }
    if (area) {
      patch.push({ op: "add", path: "/fields/System.AreaPath", value: area });
    }
    if (jiraKey) {
      patch.push({ op: "add", path: "/fields/System.Tags", value: `${tagPrefix}:${jiraKey}` });
    }

    try {
      const wi = await client.createWorkItem(WORK_ITEM_TYPE, patch);
      const id = wi.id;
      if (id != null) {
        created.push({ id, title: tc.title });
        if (Number.isFinite(planId) && Number.isFinite(suiteId) && planId > 0 && suiteId > 0) {
          try {
            await client.addTestCasesToSuite(planId, suiteId, [id]);
          } catch (e) {
            errors.push(`Work item ${id} created but not linked to suite: ${e.message}`);
          }
        }
        if (bddEnabled && bddPromptBody) {
          try {
            const tcForBdd = { ...tc, steps: manualSteps };
            const descHtml = await generateBddDescriptionHtmlForTestCase({
              tc: tcForBdd,
              jiraKey,
              promptBody: bddPromptBody,
            });
            await client.updateWorkItem(id, [
              { op: "add", path: "/fields/System.Description", value: descHtml },
            ]);
            console.log(`   ADO BDD: Description set for work item ${id} — ${tc.title}`);
          } catch (e) {
            console.warn(
              `   ADO BDD: skipped Description for work item ${id} (${tc.title}) — ${e.message}`
            );
          }
        }
      }
    } catch (e) {
      errors.push(`${tc.title}: ${e.message}`);
    }
  }

  return { created, errors };
}

/**
 * CLI args: [options] <path-to-approved.csv>
 * Options: --plan-id / -p, --suite-id / -s, --ado-url / -u, --jira-key / -j, --help
 */
function parseAdoSyncCliArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let planId = NaN;
  let suiteId = NaN;
  let adoUrl = "";
  let jiraKey = process.env.ADO_SYNC_JIRA_KEY || "";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--plan-id" || a === "-p") {
      planId = parseInt(args[++i], 10);
    } else if (a.startsWith("--plan-id=")) {
      planId = parseInt(a.slice("--plan-id=".length), 10);
    } else if (a === "--suite-id" || a === "-s") {
      suiteId = parseInt(args[++i], 10);
    } else if (a.startsWith("--suite-id=")) {
      suiteId = parseInt(a.slice("--suite-id=".length), 10);
    } else if (a === "--ado-url" || a === "-u") {
      adoUrl = args[++i] || "";
    } else if (a.startsWith("--ado-url=")) {
      adoUrl = a.slice("--ado-url=".length);
    } else if (a === "--jira-key" || a === "-j") {
      jiraKey = args[++i] || "";
    } else if (a.startsWith("--jira-key=")) {
      jiraKey = a.slice("--jira-key=".length);
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      help = true;
    } else {
      positional.push(a);
    }
  }

  const csvPath = positional.length ? positional[positional.length - 1] : "";
  if (!help && !csvPath) help = true;
  return { csvPath, planId, suiteId, adoUrl, jiraKey, help };
}

function printAdoSyncUsage() {
  console.log(`Usage:
  node ado-sync-csv.js [options] <path-to-approved.csv>

Options:
  -p, --plan-id <id>     Test Plan id (same as planId= in the browser, _testPlans/define?…)
  -s, --suite-id <id>    Test suite id (same as suiteId= in the URL)
  -u, --ado-url <url>    Full URL or query fragment (?planId=&suiteId=); paste from the address bar
  -j, --jira-key <KEY>   Tag each work item as Jira:<KEY> (overrides ADO_SYNC_JIRA_KEY)
  -h, --help             Show this help

Examples:
  node ado-sync-csv.js -p 12686 -s 14213 "C:\\path\\approved-testcases-PROJ-1.csv"
  npm run ado:sync-csv -- -u "https://dev.azure.com/YourOrg/YourProject/_testPlans/define?planId=12686&suiteId=14213" ./export.csv

Precedence: -p/-s → -u → ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID or ADO_SYNC_TEST_PLAN_URL in .env.
The path YourOrg/YourProject/… in the UI is org/project (ADO_ORG / ADO_PROJECT), not the plan id.

List suites for a plan (pick suite id):
  npm run ado:list-suites -- 12686
`);
}

async function cliMain() {
  const parsed = parseAdoSyncCliArgs(process.argv);
  if (parsed.help) {
    printAdoSyncUsage();
    process.exit(0);
  }
  const filePath = parsed.csvPath;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("❌ CSV file not found. Pass a valid path as the last argument.");
    printAdoSyncUsage();
    process.exit(1);
  }
  const { planId: resPlan, suiteId: resSuite } = resolvePlanSuiteIds({
    cliPlan: parsed.planId,
    cliSuite: parsed.suiteId,
    cliAdoUrl: parsed.adoUrl || "",
  });
  const hasPlan = Number.isFinite(resPlan) && resPlan > 0;
  const hasSuite = Number.isFinite(resSuite) && resSuite > 0;
  if (hasPlan !== hasSuite) {
    console.error(
      "❌ Set both planId and suiteId (same as in the browser ?planId=&suiteId=), via -p/-s, --ado-url, ADO_SYNC_PLAN_ID/ADO_SYNC_SUITE_ID, or ADO_SYNC_TEST_PLAN_URL in .env; or leave all unset (no suite link)."
    );
    process.exit(1);
  }
  console.log(`📤 Syncing ${path.basename(filePath)} to Azure DevOps...`);
  if (hasPlan && hasSuite) {
    console.log(`   Target suite: plan ${resPlan}, suite ${resSuite}`);
  }
  const result = await syncApprovedPixelCsvToAzureDevOps(filePath, {
    jiraIssueKey: parsed.jiraKey,
    planId: hasPlan ? resPlan : undefined,
    suiteId: hasSuite ? resSuite : undefined,
  });
  result.created.forEach((c) => console.log(`   ✅ #${c.id} ${c.title}`));
  if (result.errors.length) {
    result.errors.forEach((e) => console.warn(`   ⚠️  ${e}`));
    if (result.created.length === 0) process.exit(1);
  }
  console.log(`Done. Created ${result.created.length} test case(s).`);
}

if (require.main === module) {
  cliMain().catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
}

module.exports = {
  parseCsvRows,
  pixelRowsToTestCases,
  buildTcmStepsXml,
  syncApprovedPixelCsvToAzureDevOps,
  parseAdoSyncCliArgs,
  parsePlanSuiteFromAdoUrl,
  resolvePlanSuiteIds,
  resolvePlanSuiteIdsApprovalRun,
  envActiveTestPlanIdNumber,
  extractJiraKeyFromCsvFilename,
  normalizeJiraIssueKey,
  pickSuiteForJiraKey,
};
