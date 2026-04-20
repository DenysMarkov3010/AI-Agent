/**
 * Parse Pixel / Azure DevOps-style approved CSV and create Test Case work items in Azure DevOps.
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
    throw new Error("CSV does not look like Pixel test format (expected Title, Test Step columns)");
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

/** Legacy: BDD was appended as one CSV step with this prefix — strip from TCM steps, BDD is rebuilt in Description. */
const LEGACY_BDD_CSV_STEP_PREFIX = "__BDD_HTML__";

function partitionManualStepsForSync(steps) {
  return (steps || []).filter((s) => !String(s.action || "").startsWith(LEGACY_BDD_CSV_STEP_PREFIX));
}

function adoSyncBddDescriptionEnabled() {
  const v = String(process.env.ADO_SYNC_BDD_DESCRIPTION ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

function bddDescriptionEscapeText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One BDD line for System.Description: bold uppercase keyword + escaped body. */
function bddDescriptionLine(keyword, body) {
  const kw = String(keyword || "").toUpperCase().trim();
  const b = String(body || "").trim();
  const tail = b ? ` ${bddDescriptionEscapeText(b)}` : "";
  return `<b>${bddDescriptionEscapeText(kw)}</b>${tail}`;
}

/**
 * First line uses primaryKeyword (GIVEN/WHEN/THEN); continuations use AND.
 * @param {string} primaryKeyword
 * @param {string[]} clauses
 * @param {{ maxClauses?: number, maxClauseLen?: number }} [opts]
 */
function bddDescriptionStepLines(primaryKeyword, clauses, opts = {}) {
  const maxClauses = opts.maxClauses ?? 8;
  const maxClauseLen = opts.maxClauseLen ?? 480;
  const cleaned = (clauses || [])
    .map((c) => bddWhitespace(c))
    .filter((c) => c.length > 8)
    .slice(0, maxClauses)
    .map((c) => c.slice(0, maxClauseLen));
  if (!cleaned.length) return [];
  const lines = [bddDescriptionLine(primaryKeyword, cleaned[0])];
  for (let i = 1; i < cleaned.length; i++) {
    lines.push(bddDescriptionLine("AND", cleaned[i]));
  }
  return lines;
}

/**
 * Split work item title into broader FEATURE vs specific SCENARIO when the title uses a common delimiter.
 * @param {string} title
 * @returns {{ feature: string, scenario: string }}
 */
function splitFeatureAndScenarioFromTitle(title) {
  const t = (title || "").trim() || "Test case";
  const delims = [" — ", " – ", " | ", ": "];
  for (const d of delims) {
    const i = t.indexOf(d);
    if (i > 0 && i < t.length - d.length) {
      const feature = t.slice(0, i).trim();
      const scenario = t.slice(i + d.length).trim();
      return { feature: feature || t, scenario: scenario || t };
    }
  }
  return { feature: t, scenario: t };
}

function bddWhitespace(s) {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer sentences that overlap scenario title tokens (feature behaviour). */
function extractRelevantJiraSentences(description, scenarioTitle, maxLen) {
  const sentences = String(description || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => bddWhitespace(s))
    .filter((s) => s.length > 35);
  const words = new Set(
    String(scenarioTitle || "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3)
  );
  const scored = sentences
    .map((s) => {
      const sl = s.toLowerCase();
      let score = 0;
      for (const w of words) if (sl.includes(w)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const pick = scored[0]?.s || "";
  return pick.slice(0, maxLen);
}

function extractOutcomeLikeSentences(description, maxLen) {
  const sentences = String(description || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => bddWhitespace(s))
    .filter((s) => s.length > 25);
  const re = /\b(must|shall|should|will be|is set|are set|is displayed|are displayed|equals|updated|transitioned|results in|ensures)\b/i;
  const hits = sentences.filter((s) => re.test(s));
  return hits.slice(0, 5).join(". ").slice(0, maxLen);
}

function bddNormalizeForDedupe(s) {
  return bddWhitespace(String(s || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bddDedupeClauses(clauses) {
  const out = [];
  const seen = new Set();
  for (const c of clauses || []) {
    const t = bddWhitespace(String(c || ""));
    if (t.length < 10) continue;
    const key = bddNormalizeForDedupe(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function bddSubtractClauses(clauses, removeKeys) {
  const out = [];
  for (const c of clauses || []) {
    const t = bddWhitespace(String(c || ""));
    if (t.length < 10) continue;
    const key = bddNormalizeForDedupe(t);
    if (removeKeys && removeKeys.has(key)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Pull stable "where/what scope" snippets from Jira HTML/text to avoid repeating the whole description
 * in every Scenario's GIVEN/THEN.
 */
function bddFlattenJiraDescriptionForExtract(description) {
  return bddWhitespace(
    String(description || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*/gi, "\n")
      .replace(/<\/li>\s*/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function bddExtractLocationsScopeContext(description, maxLen) {
  const d = bddFlattenJiraDescriptionForExtract(description);
  if (!d.trim()) return "";

  const locIdx = d.search(/\bLocations:\s*/i);
  const scopeIdx = d.search(/\bScope:\s*/i);
  const acIdx = d.search(/\bAcceptance\s*criteria\b|\bAcceptance\s*:\b|\bac\s*[:\n]/i);

  let loc = "";
  if (locIdx >= 0) {
    const after = d.slice(locIdx).replace(/^\s*Locations:\s*/i, "");
    const end =
      scopeIdx > locIdx ? scopeIdx - locIdx : acIdx > locIdx ? acIdx - locIdx : after.length;
    loc = bddWhitespace(after.slice(0, end));
  }

  let scope = "";
  if (scopeIdx >= 0) {
    const after = d.slice(scopeIdx).replace(/^\s*Scope:\s*/i, "");
    const relAc = acIdx > scopeIdx ? acIdx - scopeIdx : -1;
    const end = relAc > 0 ? relAc : after.length;
    scope = bddWhitespace(after.slice(0, end));
  }

  let out = "";
  if (loc) out += `Locations: ${loc}`;
  if (scope) out += `${out ? " " : ""}Scope: ${scope}`;
  if (!out) return "";

  out = bddWhitespace(out);
  return out.slice(0, maxLen || 520);
}

function bddListAcceptanceBullets(description, maxItems) {
  const d = bddFlattenJiraDescriptionForExtract(description);
  if (!d.trim()) return [];
  const lower = d.toLowerCase();
  let start = lower.search(/\bacceptance\s*criteria\b|\bacceptance\s*:\b|\bac\s*[:\n]/i);
  const chunk = start >= 0 ? d.slice(start) : d;
  const bullets = [];
  for (const raw of chunk.split(/\n/)) {
    const t = raw
      .replace(/^\s*[-*•]\s+/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .trim();
    if (t.length > 12 && !/^#{1,6}\s/.test(t)) bullets.push(t);
    if (bullets.length >= (maxItems || 30)) break;
  }
  return bullets;
}

function bddScoreTextAgainstTitle(text, title) {
  const t = bddWhitespace(String(text || "")).toLowerCase();
  if (!t) return 0;
  const words = String(title || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  let score = 0;
  for (const w of words) {
    if (t.includes(w)) score += 1;
  }
  return score;
}

function bddPickAcceptanceBulletsForScenario(bullets, scenarioTitle, maxPick) {
  const pick = Math.max(1, Math.min(6, maxPick || 4));
  const scored = (bullets || [])
    .map((b) => ({ b, s: bddScoreTextAgainstTitle(b, scenarioTitle) }))
    .sort((a, b) => b.s - a.s);
  const out = [];
  const seen = new Set();
  for (const x of scored) {
    if (x.s <= 0) break;
    const key = bddNormalizeForDedupe(x.b);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x.b);
    if (out.length >= pick) break;
  }
  return out;
}

/**
 * BDD "Summary" HTML for Azure DevOps System.Description:
 * built ONLY from parent Jira issue summary/description (requirements),
 * not from CSV checklist rows / manual steps.
 */
function buildParentJiraRequirementsBddHtml(workItemTitle, jiraCtx) {
  const { feature, scenario: titleScenario } = splitFeatureAndScenarioFromTitle(workItemTitle);
  const featureName = (jiraCtx?.summary && bddWhitespace(jiraCtx.summary)) || feature;
  const jiraDesc = jiraCtx?.description || "";
  const maxClause = 520;

  const locScope = bddExtractLocationsScopeContext(jiraDesc, maxClause);
  const bullets = bddListAcceptanceBullets(jiraDesc, 40);

  const sharedGivenKeys = new Set();
  const sharedGivenClauses = bddDedupeClauses([
    ...(locScope ? [locScope] : []),
    ...bullets.slice(0, 3).map((b) => b.slice(0, maxClause)),
  ]);
  for (const c of sharedGivenClauses) sharedGivenKeys.add(bddNormalizeForDedupe(c));

  const preamble = [
    bddDescriptionLine("FEATURE", featureName),
    ...bddDescriptionStepLines("GIVEN", sharedGivenClauses.length ? sharedGivenClauses : [
      "Parent Jira issue does not contain extractable Locations/Scope/Acceptance text; rely on the parent issue description directly in Jira.",
    ], { maxClauses: 10, maxClauseLen: maxClause }),
  ].join("<br/>");

  const scenarioName = bddWhitespace(titleScenario || workItemTitle).slice(0, 220) || "Scenario";

  const whenLines = bddDescriptionStepLines(
    "WHEN",
    [`The scenario under test is: ${scenarioName}`],
    { maxClauses: 3, maxClauseLen: maxClause }
  );

  let thenClauses = bddPickAcceptanceBulletsForScenario(bullets, scenarioName, 5).map((b) =>
    bddWhitespace(`Requirement: ${b}`).slice(0, maxClause)
  );
  thenClauses = bddSubtractClauses(thenClauses, sharedGivenKeys);

  if (!thenClauses.length) {
    const rel = extractRelevantJiraSentences(jiraDesc, scenarioName, maxClause);
    if (rel) thenClauses.push(rel);
  }
  if (!thenClauses.length) {
    const out = extractOutcomeLikeSentences(jiraDesc, maxClause);
    if (out) thenClauses.push(out);
  }
  if (!thenClauses.length) {
    thenClauses.push("The parent issue acceptance criteria are satisfied for this scenario (see parent Jira issue for authoritative wording).");
  }

  const thenLines = bddDescriptionStepLines("THEN", bddDedupeClauses(thenClauses), { maxClauses: 10, maxClauseLen: maxClause });

  const block = [
    bddDescriptionLine("SCENARIO", scenarioName),
    ...whenLines,
    ...thenLines,
  ].join("<br/>");

  return [preamble, block].join("<br/><br/>");
}

function adoSyncBddJiraContextEnabled() {
  const v = String(process.env.ADO_SYNC_BDD_JIRA_CONTEXT ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Load parent Jira issue for BDD (System.Description) during ADO sync.
 * @param {string} issueKey
 * @returns {Promise<{ key: string, summary: string, description: string, loadedFromParent: boolean } | null>}
 */
async function fetchParentIssueContextForBdd(issueKey) {
  const key = normalizeJiraIssueKey(issueKey);
  if (!key) return null;
  const base = process.env.JIRA_BASE_URL || process.env.BASE_URL;
  const email = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!base || !email || !token) {
    console.warn("   ADO BDD: JIRA_* env not set — skipping parent issue fetch (System.Description BDD will be skipped)");
    return null;
  }
  const { JiraClient } = require("./jira-client");
  const jc = new JiraClient(base, email, token);
  const child = await jc.getIssueWithExpand(key);
  const parentKey = child.fields?.parent?.key;
  if (!parentKey) {
    console.warn(`   ADO BDD: issue ${key} has no parent — skipping parent-requirements BDD context`);
    return null;
  }
  let loadedFromParent = false;
  let source = null;
  try {
    source = await jc.getIssueWithExpand(parentKey);
    loadedFromParent = true;
  } catch (e) {
    console.warn(`   ADO BDD: could not load parent ${parentKey}: ${e.message}`);
    return null;
  }
  const data = jc.extractIssueData(source);
  console.log(
    `   ADO BDD: Jira context from ${loadedFromParent ? "parent" : "issue"} ${data.key} (${(data.description || "").length} chars description)`
  );
  return {
    key: data.key,
    summary: String(data.summary || "").trim(),
    description: String(data.description || "").trim(),
    loadedFromParent,
  };
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

  let jiraBddCtx = null;
  if (adoSyncBddDescriptionEnabled() && adoSyncBddJiraContextEnabled()) {
    const seedKey =
      normalizeJiraIssueKey(jiraKey) ||
      normalizeJiraIssueKey(testCases.map((tc) => tc.refId).find((id) => id && String(id).trim()) || "") ||
      extractJiraKeyFromCsvFilename(csvFilePath);
    if (seedKey) {
      try {
        jiraBddCtx = await fetchParentIssueContextForBdd(seedKey);
      } catch (e) {
        console.warn(`   ADO BDD: Jira parent fetch failed: ${e.message}`);
      }
    } else {
      console.warn("   ADO BDD: no Jira key (filename, env, or CSV ID column) — parent context skipped");
    }
  }

  const bddDescEnabled = adoSyncBddDescriptionEnabled();
  let bddParentMissingWarned = false;

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
    if (bddDescEnabled) {
      if (jiraBddCtx && jiraBddCtx.loadedFromParent) {
        const bddHtml = buildParentJiraRequirementsBddHtml(tc.title, jiraBddCtx);
        patch.push({
          op: "add",
          path: "/fields/System.Description",
          value: `<div>${bddHtml}</div>`,
        });
      } else if (!bddParentMissingWarned) {
        bddParentMissingWarned = true;
        console.warn(
          "   ADO BDD: skipping System.Description for all imported test cases — parent Jira issue (requirements) could not be loaded"
        );
      }
    }
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
