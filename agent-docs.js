const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { JiraClient } = require("./jira-client");
const { ConfluenceClient } = require("./confluence-client");
const { generateTestChecklistPrompt, generateTestCasesPrompt } = require("./prompts-docs");

const fetch = globalThis.fetch || require("node-fetch");

// Environment variables
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || JIRA_BASE_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "PROJ";
const REQUIRED_LABELS = process.env.REQUIRED_LABELS 
  ? JSON.parse(process.env.REQUIRED_LABELS) 
  : [];
const CHANGE_REQUEST_LABEL = process.env.CHANGE_REQUEST_LABEL || "change-request";
// Folder where approved checklist CSV files are saved (not in project). Use CHECKLIST_OUTPUT_DIR in .env to override.
const CHECKLIST_OUTPUT_DIR = process.env.CHECKLIST_OUTPUT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", "OneDrive", "Desktop", "Checklists and Test cases");
// Project folder with test case files (CSV/TXT) for analysis before checklist. Use when ENABLE_TEST_CASES_ANALYSIS=true.
const TEST_CASES_FOLDER = process.env.TEST_CASES_FOLDER || path.join(__dirname, "Test cases");
/** Only for single-issue runs (`node agent-docs.js`). Batch (`agent-batch.js`) sets AGENT_BATCH_RUN=true and skips this. */
const ENABLE_TEST_CASES_ANALYSIS =
  process.env.ENABLE_TEST_CASES_ANALYSIS === "true" && process.env.AGENT_BATCH_RUN !== "true";
const GENERATE_MODE = (process.env.GENERATE_MODE || "checklist").toLowerCase().replace(/\s+/g, "");

// Validate required environment variables
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

const OPENROUTER_MODEL_CANDIDATES = (
  process.env.OPENROUTER_MODELS || "openai/gpt-oss-20b:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const RETRYABLE_LLM_STATUS = new Set([429, 500, 502, 503, 504]);

function llmDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLLM(prompt, maxTokens = 4000) {
  const models = OPENROUTER_MODEL_CANDIDATES.length
    ? OPENROUTER_MODEL_CANDIDATES
    : ["openai/gpt-oss-20b:free"];
  let lastError = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const isLastModel = modelIndex === models.length - 1;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          const retryable = RETRYABLE_LLM_STATUS.has(res.status);
          lastError = new Error(message);

          if (retryable && attempt < 2) {
            await llmDelay(1200 * attempt);
            continue;
          }
          if (retryable && !isLastModel) {
            console.warn(`LLM model "${model}" is rate-limited/unavailable. Switching to next fallback model.`);
            break;
          }
          throw lastError;
        }

        const data = await res.json();
        if (!data.choices || !data.choices[0]) {
          console.error("LLM raw response:", JSON.stringify(data, null, 2));
          throw new Error("LLM returned no choices");
        }
        return data.choices[0].message.content;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await llmDelay(1200 * attempt);
          continue;
        }
        if (!isLastModel) {
          console.warn(`LLM model "${model}" failed (${error.message}). Trying next fallback model.`);
          break;
        }
      }
    }
  }

  console.error("Error calling LLM:", lastError && lastError.message ? lastError.message : String(lastError));
  throw lastError || new Error("LLM failed with unknown error");
}

function validateRequirements(issueData) {
  const errors = [];
  
  if (!issueData.description || issueData.description.trim().length === 0) {
    errors.push("Missing description");
  }
  
  // Check for required labels if specified
  if (REQUIRED_LABELS.length > 0) {
    const issueLabels = (issueData.labels || []).map(l => l.toLowerCase());
    const missingLabels = REQUIRED_LABELS.filter(
      reqLabel => !issueLabels.includes(reqLabel.toLowerCase())
    );
    if (missingLabels.length > 0) {
      errors.push(`Missing required labels: ${missingLabels.join(", ")}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

function isChangeRequest(issueData) {
  const labels = (issueData.labels || []).map(l => l.toLowerCase());
  return labels.some(l => 
    l === CHANGE_REQUEST_LABEL.toLowerCase() || 
    l === "change-request" || 
    l === "change_request" || 
    l === "changerequest"
  );
}

// Stop words to skip when building title-based JQL (reduces noise)
const RELATED_ISSUES_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "are", "but", "not", "you", "all", "can", "had", "her", "his",
  "was", "one", "our", "out", "has", "have", "this", "that", "what", "when", "which", "who", "will",
  "your", "about", "into", "than", "them", "then", "some", "would", "could", "should", "there", "their"
]);

/**
 * Extract significant words from issue summary (title) for similar-title JQL search.
 * @param {string} summary - Issue summary/title
 * @param {number} maxWords - Max words to use in JQL (default 5)
 * @returns {string[]} Words of length >= 3, not stop words
 */
function getTitleSearchWords(summary, maxWords = 5) {
  if (!summary || typeof summary !== "string") return [];
  const words = summary
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 3 && !RELATED_ISSUES_STOP_WORDS.has(w));
  const seen = new Set();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return unique.slice(0, maxWords);
}

/**
 * Parse optional RELATED_ISSUES_KEYWORDS from env.
 * Supports comma/semicolon/newline separated values (phrases allowed).
 * Example: "payment, verification dashboard, status".
 * @param {string} raw
 * @param {number} maxWords
 * @returns {string[]}
 */
function parseRelatedIssuesKeywords(raw, maxWords = 10) {
  const input = String(raw || "").trim();
  if (!input) return [];
  const parts = input
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const normalized = p.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= maxWords) break;
  }
  return unique;
}

function getBaseOrigin(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeConfluenceUrl(baseUrl, rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).toString();
    return new URL(s, String(baseUrl || "")).toString();
  } catch {
    return "";
  }
}

function extractConfluenceUrlsFromAdf(adf) {
  const out = [];
  const seen = new Set();
  const push = (url) => {
    const normalized = String(url || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node.marks)) {
      for (const m of node.marks) {
        if (m?.type === "link" && m?.attrs?.href) {
          push(m.attrs.href);
        }
      }
    }
    if (node.type === "inlineCard" && node.attrs?.url) {
      push(node.attrs.url);
    }
    if (node.type === "link" && node.attrs?.href) {
      push(node.attrs.href);
    }
    if (node.content) walk(node.content);
  };
  walk(adf);
  return out;
}

function extractUrlsFromText(text) {
  const s = String(text || "");
  if (!s) return [];
  const seen = new Set();
  const out = [];
  const matches = s.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  for (const m of matches) {
    const u = m.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Load test case files from the project "Test cases" folder (CSV and TXT).
 * Used when ENABLE_TEST_CASES_ANALYSIS is effective (single-issue runs only; not batch).
 * @returns {Array<{ filename: string, content: string }>}
 */
function loadProjectTestCases() {
  const results = [];
  try {
    if (!fs.existsSync(TEST_CASES_FOLDER)) {
      return results;
    }
    const entries = fs.readdirSync(TEST_CASES_FOLDER, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (ext !== ".csv" && ext !== ".txt") continue;
      const filePath = path.join(TEST_CASES_FOLDER, ent.name);
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content) results.push({ filename: ent.name, content });
    }
  } catch (err) {
    console.warn(`⚠️  Could not read Test cases folder: ${err.message}`);
  }
  return results;
}

async function searchRelatedDocumentation(jiraClient, confluenceClient, issueData) {
  const results = {
    confluencePages: [],
    relatedJiraIssues: [],
  };

  // Skip Confluence search if ENABLE_CONFLUENCE_SEARCH is not set to "true"
  const enableConfluenceSearch = process.env.ENABLE_CONFLUENCE_SEARCH === "true";
  
  if (enableConfluenceSearch && confluenceClient) {
    try {
      const baseOrigin = getBaseOrigin(CONFLUENCE_BASE_URL);
      const adfUrls = extractConfluenceUrlsFromAdf(issueData.descriptionAdf);
      const textUrls = extractUrlsFromText(issueData.description);
      const merged = [...adfUrls, ...textUrls];
      const confluenceUrls = [];
      const urlSeen = new Set();
      for (const rawUrl of merged) {
        const absUrl = normalizeConfluenceUrl(CONFLUENCE_BASE_URL, rawUrl);
        if (!absUrl) continue;
        const isConfluence = baseOrigin
          ? absUrl.toLowerCase().startsWith(baseOrigin) && absUrl.toLowerCase().includes("/wiki/")
          : absUrl.toLowerCase().includes("/wiki/");
        if (!isConfluence) continue;
        if (urlSeen.has(absUrl)) continue;
        urlSeen.add(absUrl);
        confluenceUrls.push(absUrl);
      }

      if (confluenceUrls.length === 0) {
        console.log("📄 No Confluence links found in Jira requirements/description.");
      } else {
        console.log(`🔍 Reading Confluence docs from Jira links: ${confluenceUrls.length} URL(s)`);
        for (const link of confluenceUrls) {
          const pageIdMatch = link.match(/\/pages\/(\d+)(?:\/|$|[?#])/i);
          const pageId = pageIdMatch ? pageIdMatch[1] : "";
          if (!pageId) {
            console.warn(`   ⚠️  Skipping Confluence link (no pageId in URL): ${link}`);
            continue;
          }
          try {
            const page = await confluenceClient.getPageContent(pageId);
            const data = confluenceClient.extractPageData(page);
            data.url = link;
            results.confluencePages.push(data);
          } catch (e) {
            console.warn(`   ⚠️  Could not read Confluence page ${pageId}: ${e.message}`);
          }
        }
      }

      if (results.confluencePages.length > 0) {
        console.log(`📄 Read ${results.confluencePages.length} Confluence document(s):`);
        results.confluencePages.forEach((p, i) => {
          console.log(`   ${i + 1}. ${p.title || "(untitled)"}${p.space ? ` [${p.space}]` : ""}`);
        });
      } else if (confluenceUrls.length > 0) {
        console.log("📄 No Confluence documents were read from Jira links.");
      }
    } catch (error) {
      console.warn(`⚠️  Error reading Confluence docs from Jira links: ${error.message}`);
      console.log(`ℹ️  Continuing without Confluence documentation...`);
    }
  } else {
    console.log(`ℹ️  Confluence search disabled. Working with Jira issue description only.`);
  }

  // Search related Jira issues by custom keywords (if provided) or by similar title.
  const enableRelatedIssuesSearch = process.env.ENABLE_RELATED_ISSUES_SEARCH !== "false";
  const inputKeywords = parseRelatedIssuesKeywords(process.env.RELATED_ISSUES_KEYWORDS || "", 10);
  const queryWords = inputKeywords.length > 0
    ? inputKeywords
    : getTitleSearchWords(issueData.summary);
  const searchMode = inputKeywords.length > 0 ? "custom keywords" : "similar title";

  if (enableRelatedIssuesSearch && queryWords.length > 0) {
    try {
      // JQL: summary contains any provided keywords (or title-derived words), only Story / Improvement / Pixel Improvement.
      const summaryConditions = queryWords
        .map(w => w.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))
        .map(w => `summary ~ "${w}"`)
        .join(" OR ");
      const jql = `project = ${PROJECT_KEY} AND issuetype in ("Story", "Improvement", "Pixel Improvement") AND (${summaryConditions}) AND key != ${issueData.key} ORDER BY updated DESC`;
      console.log(`🔍 Searching related Jira issues with JQL (${searchMode}): ${jql}`);
      const jiraResults = await jiraClient.searchIssues(jql, [
        "key", "summary", "status", "labels", "description", "issuetype"
      ], 30);

      if (jiraResults.issues && jiraResults.issues.length > 0) {
        results.relatedJiraIssues = jiraResults.issues.map(issue => ({
          key: issue.key,
          summary: issue.fields.summary,
          labels: issue.fields.labels || [],
          status: issue.fields.status?.name || null,
          description: issue.fields.description || null,
        }));
        console.log(`📋 Found ${results.relatedJiraIssues.length} related Jira issue(s) (by ${searchMode}):`);
        results.relatedJiraIssues.forEach((issue, i) => {
          console.log(`   ${i + 1}. ${issue.key} — ${issue.summary || "(no summary)"}`);
        });
      } else {
        console.log(`📋 No related Jira issues found`);
      }
    } catch (error) {
      console.warn(`⚠️  Error searching related Jira issues: ${error.message}`);
    }
  } else if (enableRelatedIssuesSearch && queryWords.length === 0) {
    console.log(`ℹ️  No search keywords provided and no significant words in summary for related issues search.`);
  } else {
    console.log(`ℹ️  Related issues search disabled.`);
  }

  return results;
}

async function generateTestChecklist(issueData, relatedDocs) {
  console.log("🤖 Generating test checklist with LLM...");
  
  const projectTestCases = ENABLE_TEST_CASES_ANALYSIS ? loadProjectTestCases() : [];
  if (ENABLE_TEST_CASES_ANALYSIS) {
    if (projectTestCases.length > 0) {
      console.log(`📂 Using ${projectTestCases.length} test case file(s) from project folder for analysis`);
    } else {
      console.log(`ℹ️  Test cases analysis enabled but no .csv/.txt files found in "${TEST_CASES_FOLDER}"`);
    }
  }

  const prompt = generateTestChecklistPrompt({
    issueKey: issueData.key,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    confluencePages: relatedDocs.confluencePages,
    relatedJiraIssues: relatedDocs.relatedJiraIssues,
    projectTestCases,
  });

  const response = await callLLM(prompt, 4000);
  
  // Try to parse JSON from response
  try {
    // Remove markdown code blocks if present
    const cleanedResponse = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleanedResponse);
  } catch (error) {
    console.error("Failed to parse LLM response as JSON:", error.message);
    console.error("Response:", response);
    throw new Error("LLM did not return valid JSON");
  }
}

/**
 * BDD/Gherkin prompt block in TEST_CASE_FORMAT.md is for Azure DevOps CSV import / Description only —
 * do not inject it into GENERATE_MODE=testcases LLM context.
 */
function stripBddPromptSectionFromTestCaseFormat(md) {
  const marker = "\n## Prompt: BDD / Gherkin generation (Senior QA Automation)";
  const start = md.indexOf(marker);
  if (start === -1) return md;
  const howIdx = md.indexOf("\n## How your QA MCP agent works (documentation-based)", start);
  if (howIdx === -1) return md.slice(0, start).trim();
  const head = md.slice(0, start).replace(/\n---\s*$/, "").trimEnd();
  return `${head}\n\n${md.slice(howIdx + 1).trimStart()}`.trim();
}

function loadTestCaseFormatRef() {
  const legacyPath = path.join(__dirname, "TEST_CASE_FORMAT.md");
  const refPath = path.join(__dirname, "REFERENCE.md");
  try {
    if (fs.existsSync(legacyPath)) {
      return stripBddPromptSectionFromTestCaseFormat(fs.readFileSync(legacyPath, "utf8").trim());
    }
    if (fs.existsSync(refPath)) {
      const full = fs.readFileSync(refPath, "utf8");
      const start = full.indexOf("## Test case format");
      if (start === -1) return "";
      const slice = full.slice(start);
      const nextSection = slice.search(/\n## How your QA MCP agent\b/);
      if (nextSection === -1) return slice.trim();
      return slice.slice(0, nextSection).trim();
    }
  } catch (e) {
    console.warn("⚠️  Could not load test case format reference:", e.message);
  }
  return "";
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

async function generateTestCases(issueData, relatedDocs) {
  console.log("🤖 Generating test cases with LLM...");

  const projectTestCases = ENABLE_TEST_CASES_ANALYSIS ? loadProjectTestCases() : [];
  if (ENABLE_TEST_CASES_ANALYSIS && projectTestCases.length > 0) {
    console.log(`📂 Using ${projectTestCases.length} test case file(s) from project folder for analysis`);
  }

  const testCaseFormatRef = loadTestCaseFormatRef();
  if (testCaseFormatRef) {
    console.log("📋 Using REFERENCE.md (Test case format section) as mandatory format reference");
  }

  const prompt = generateTestCasesPrompt({
    issueKey: issueData.key,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    confluencePages: relatedDocs.confluencePages || [],
    relatedJiraIssues: relatedDocs.relatedJiraIssues || [],
    projectTestCases,
    testCaseFormatRef,
  });

  const response = await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "12000", 10));

  try {
    const cleanedResponse = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleanedResponse);
    if (!parsed.testCases || !Array.isArray(parsed.testCases)) {
      throw new Error("LLM response missing testCases array");
    }
    parsed.testCases = normalizeExpectedInTestCases(parsed.testCases);
    return parsed;
  } catch (error) {
    console.error("Failed to parse LLM test cases response:", error.message);
    console.error("Response:", response);
    throw new Error("LLM did not return valid test cases JSON");
  }
}

function formatTestCasesComment(testCasesResult) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const humanList = testCases
    .map((tc, idx) => `${idx + 1}. ${(tc.title || "").trim()} (${(tc.steps || []).length} steps)`)
    .join("\n");
  const payload = JSON.stringify({ testCases, reasoning }, null, 2);
  return `🤖 AI-Generated Test Cases

To approve specific test cases, reply with:

APPROVED: 1,2,3

(or APPROVED: all). Then run the agent again with CHECK_APPROVAL=true to generate a CSV with only approved test cases.

---
${reasoning ? `Reasoning:\n${reasoning}\n---\n` : ""}
Proposed test cases (summary):
${humanList}

---
📌 Generated automatically from Jira issue.

\`\`\`json
${payload}
\`\`\``;
}

/**
 * Build ADF document for test cases comment (heading + approval + optional reasoning, then tables).
 * JSON is stored in an attachment, not in the comment. Reasoning stays above tables so nothing
 * long appears after the generated steps (avoids looking like “instructions after” the cases).
 */
function buildTestCasesCommentAdf(testCasesResult) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const content = [
    JiraClient.buildAdfHeading("🤖 AI-Generated Test Cases", 3),
    JiraClient.buildAdfParagraph(
      "To approve specific test cases, reply with: APPROVED: 1,2,3 or APPROVED: all. Then run the agent again with CHECK_APPROVAL=true to generate CSV. Proposed cases follow below."
    ),
  ];
  if (reasoning) {
    content.push(JiraClient.buildAdfHeading("Reasoning", 4));
    content.push(JiraClient.buildAdfParagraph(reasoning));
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

function parseTestCasesFromComment(commentText) {
  if (!commentText || typeof commentText !== "string") return null;
  let jsonStr = null;
  const codeBlockMatch = commentText.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const idx = commentText.indexOf('"testCases"');
    if (idx !== -1) {
      let start = commentText.lastIndexOf("{", idx);
      if (start !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < commentText.length; i++) {
          if (commentText[i] === "{") depth++;
          else if (commentText[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end !== -1) jsonStr = commentText.slice(start, end + 1);
      }
    }
  }
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.testCases && Array.isArray(parsed.testCases) ? parsed.testCases : null;
  } catch {
    return null;
  }
}

function formatChecklistComment(checklist, reasoning) {
  const items = checklist.checklistItems || [];
  const itemsList = items
    .map((item, idx) => `${idx + 1}. [${item.category}] ${item.description}`)
    .join("\n");

  return `🤖 AI-Generated Test Checklist

Approval Instructions:
Please review the proposed test scenarios below. To approve specific items, reply to this comment in the format:

APPROVED: 1,2,3

Where numbers correspond to the item numbers below. For example:
- APPROVED: 1,2,3,5 — approve items 1, 2, 3 and 5
- APPROVED: all — approve all items

After adding your approval comment, run the agent again with CHECK_APPROVAL=true to generate a CSV file with the approved checklist.

---
Proposed test scenarios:
${itemsList}

---
Label Matching Analysis:
${reasoning || "N/A"}

---
📌 Generated automatically from Jira issue + related Confluence pages`;
}

function parseApprovalComment(commentBody, totalItems) {
  if (!commentBody) return null;

  // Safety: do not treat checklist instructions as approval.
  // We only accept approval if the FIRST non-empty line starts with "APPROVED:".
  // This prevents matching example text like "APPROVED: 1,2,3" embedded in the checklist comment.
  const firstNonEmptyLine =
    commentBody
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";

  if (!/^approved:/i.test(firstNonEmptyLine)) {
    return null;
  }

  // Look for APPROVED: pattern (case-insensitive, flexible whitespace)
  // Supports formats like:
  // - APPROVED: 1,2,3
  // - APPROVED: 1, 2, 3
  // - APPROVED: all
  // - Approved: 1,2,3
  // - approved: 1,2,3
  const approvalMatch = firstNonEmptyLine.match(/^APPROVED:\s*([\d,\s]+|all)\s*$/i);
  
  if (!approvalMatch) {
    return null;
  }

  const approvedValue = approvalMatch[1].toLowerCase().trim();
  
  if (approvedValue === "all") {
    // Return all item indices (1-based)
    console.log(`   📋 Approval: ALL items (${totalItems} total)`);
    return Array.from({ length: totalItems }, (_, i) => String(i + 1));
  }

  // Parse comma-separated numbers
  const approvedItems = approvedValue
    .split(",")
    .map(n => n.trim())
    .filter(n => n.length > 0 && !isNaN(n))
    .map(n => {
      const num = parseInt(n, 10);
      // Validate that the number is within range
      if (num < 1 || num > totalItems) {
        console.warn(`   ⚠️  Warning: Item ${num} is out of range (1-${totalItems})`);
        return null;
      }
      return String(num);
    })
    .filter(n => n !== null);

  if (approvedItems.length > 0) {
    console.log(`   📋 Approval: Items ${approvedItems.join(", ")}`);
    return approvedItems;
  }
  
  return null;
}

/**
 * Escape a CSV field (quote if contains comma, newline, or double quote).
 */
function escapeCSV(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Build a safe CSV filename from issue title (summary) and key, e.g. "Search field improvements (PROJ-99).csv"
 */
function approvedChecklistCsvFilename(issueKey, summary) {
  const raw = (summary || issueKey || "Checklist").trim();
  const safe = raw
    .replace(/[\s\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const base = safe || issueKey;
  return `${base} (${issueKey}).csv`;
}

/**
 * One CSV file with multiple Test Case blocks — one Azure DevOps work item per checklist.
 * @param {Object} issueData
 * @param {Array<{ partLabel?: string, approvedItems: Array<{ number: number, item: { category, description } }> }>} groups
 * @param {string} outputPath
 */
function generateApprovedMultiChecklistCSV(issueData, groups, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const baseTitle = (issueData.summary || issueData.key || "Checklist").trim();
  const assignedTo = issueData.assignee || "";
  const rows = [];

  groups.forEach((group, gi) => {
    const partLabel = String(group.partLabel || "").trim();
    let title = baseTitle;
    if (partLabel) title = `${baseTitle} (${partLabel})`;
    else if (groups.length > 1) title = `${baseTitle} (checklist ${gi + 1})`;

    rows.push(
      [
        escapeCSV(issueData.key),
        "Test Case",
        escapeCSV(title),
        "",
        "",
        "",
        escapeCSV(priority),
        escapeCSV(areaPath),
        escapeCSV(assignedTo),
        escapeCSV(state),
      ].join(",")
    );

    (group.approvedItems || []).forEach(({ item }, index) => {
      const stepNum = String(index + 1);
      const stepAction = (item.description || "").trim();
      rows.push(
        [
          "",
          "",
          "",
          escapeCSV(stepNum),
          escapeCSV(stepAction),
          "",
          "",
          "",
          "",
          "",
        ].join(",")
      );
    });
  });

  fs.writeFileSync(outputPath, [header, ...rows].join("\r\n"), "utf8");
  return outputPath;
}

/**
 * Generate CSV file with approved checklist items.
 * Format matches Azure DevOps / test checklist CSV: ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path, Assigned To, State
 * @param {Object} issueData - { key, summary, assignee, ... }
 * @param {Array<{ number: number, item: { category, description } }>} approvedItems - list of approved checklist items
 * @param {string} outputPath - path for the CSV file (e.g. approved-checklist-PROJ-95.csv)
 * @returns {string} path to written file
 */
function generateApprovedChecklistCSV(issueData, approvedItems, outputPath) {
  return generateApprovedMultiChecklistCSV(issueData, [{ partLabel: "", approvedItems }], outputPath);
}

/**
 * Generate CSV with approved test cases (Azure DevOps / Pixel format).
 * Each test case: one header row (ID, Title) then step rows (Test Step, Step Action, Step Expected).
 */
function generateApprovedTestCasesCSV(issueData, approvedTestCases, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const assignedTo = issueData.assignee || "";
  const rows = [];

  approvedTestCases.forEach((tc) => {
    const title = (tc.title || "Test case").trim();
    const tcPriority = tc.priority != null ? String(tc.priority) : priority;
    const tcAreaPath = (tc.areaPath || areaPath).trim() || areaPath;
    rows.push([
      escapeCSV(issueData.key),
      "Test Case",
      escapeCSV(title),
      "",
      "",
      "",
      escapeCSV(tcPriority),
      escapeCSV(tcAreaPath),
      escapeCSV(assignedTo),
      escapeCSV(state),
    ].join(","));
    const steps = (tc.steps || []).slice().sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
    steps.forEach((step, stepIdx) => {
      const stepNum = String(step.stepNumber != null ? step.stepNumber : stepIdx + 1);
      const action = (step.action || "").trim();
      const expected = normalizeExpectedResultText(step.expected);
      rows.push([
        "",
        "",
        "",
        escapeCSV(stepNum),
        escapeCSV(action),
        escapeCSV(expected),
        "",
        "",
        "",
        "",
      ].join(","));
    });
  });

  const csv = [header, ...rows].join("\r\n");
  fs.writeFileSync(outputPath, csv, "utf8");
  return outputPath;
}

function approvedTestCasesCsvFilename(issueKey, summary) {
  const safe = (summary || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const base = safe || issueKey;
  return `${base} (${issueKey}).csv`;
}

function parseChecklistItemsFromChecklistComment(checklistCommentText) {
  // Expects lines like:
  // 1. [Functional] Some description
  // 2. [Negative] Another description
  if (!checklistCommentText || typeof checklistCommentText !== "string") return [];

  const lines = checklistCommentText.split(/\r?\n/);
  const itemsByNumber = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\s*(.+)$/);
    if (!m) continue;

    const num = parseInt(m[1], 10);
    const category = (m[2] || "").trim();
    const description = (m[3] || "").trim();

    if (!Number.isFinite(num) || num < 1) continue;
    if (!description) continue;

    // Keep first occurrence per number
    if (!itemsByNumber.has(num)) {
      itemsByNumber.set(num, { id: `CL-${String(num).padStart(3, "0")}`, category, description });
    }
  }

  // Return dense array in numeric order (1..N), skipping gaps if any
  return Array.from(itemsByNumber.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
}

function findLatestCommentTextContaining(comments, needle) {
  const needleLower = String(needle || "").toLowerCase();
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const text = (c.bodyText || c.body || "").toString();
    if (text.toLowerCase().includes(needleLower)) {
      return { comment: c, text };
    }
  }
  return null;
}

/** All comments containing needle, oldest first (matches post order for updated CSV segments). */
function findAllCommentsTextContaining(comments, needle) {
  const needleLower = String(needle || "").toLowerCase();
  const out = [];
  for (const c of comments) {
    const text = (c.bodyText || c.body || "").toString();
    if (text.toLowerCase().includes(needleLower)) {
      out.push({ comment: c, text });
    }
  }
  out.sort((a, b) => new Date(a.comment.created || 0) - new Date(b.comment.created || 0));
  return out;
}

const UPDATED_CSV_FLOW_TC_MARKER = "ai-generated test cases (updated csv flow)";

/**
 * Ordered JSON attachments for generated-testcases-*.json (same sort as merge).
 * @returns {Promise<Array<{ filename: string, created: number, testCases: object[] }>>}
 */
async function loadOrderedTestCaseJsonSlices(jiraClient, issueKey) {
  try {
    const attachments = await jiraClient.getAttachments(issueKey);
    if (!attachments || !attachments.length) return [];
    const jsonAtts = attachments.filter(
      (a) =>
        (a.filename || "").startsWith("generated-testcases-") && (a.filename || "").endsWith(".json")
    );
    if (!jsonAtts.length) return [];
    jsonAtts.sort((a, b) => {
      const fa = a.filename || "";
      const fb = b.filename || "";
      const ma = fa.match(/-seg(\d+)\.json$/i);
      const mb = fb.match(/-seg(\d+)\.json$/i);
      if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
      if (ma && !mb) return 1;
      if (!ma && mb) return -1;
      return fa.localeCompare(fb);
    });
    const slices = [];
    for (const att of jsonAtts) {
      if (!att.content) continue;
      try {
        const raw = await jiraClient.getAttachmentContent(att.content);
        const parsed = JSON.parse(raw);
        if (parsed.testCases && Array.isArray(parsed.testCases) && parsed.testCases.length) {
          const created = Date.parse(att.created) || 0;
          slices.push({ filename: att.filename || "", created, testCases: parsed.testCases });
        }
      } catch (e) {
        console.warn(`   ⚠️  Skip attachment ${att.filename}: ${e.message}`);
      }
    }
    return slices;
  } catch (e) {
    console.warn(`   ⚠️  Could not read test case attachments: ${e.message}`);
    return [];
  }
}

/**
 * Blocks from Update test design / updated CSV flow only (detected via comment markers).
 * Order = chronological merge of checklist comments and test-case JSON posts (by Jira timestamps).
 * @returns {Promise<Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', items: object[], partLabel: string }>>}
 */
async function buildUpdatedDesignApprovalBlocks(jiraClient, commentHostKey, comments) {
  const checklistHits = findAllCommentsTextContaining(
    comments,
    "AI-Generated Test Checklist (Updated CSV flow)"
  );
  const clEvents = checklistHits.map((h) => ({
    t: new Date(h.comment.created || 0).getTime(),
    type: "checklist",
    text: h.text,
  }));

  const jsonSlices = await loadOrderedTestCaseJsonSlices(jiraClient, commentHostKey);
  const tcMarkerComments = comments
    .filter((c) => {
      const body = (c.bodyText || c.body || "").toString().toLowerCase();
      return body.includes(UPDATED_CSV_FLOW_TC_MARKER);
    })
    .sort((a, b) => new Date(a.created || 0).getTime() - new Date(b.created || 0).getTime());

  const tcEvents = [];
  for (let i = 0; i < tcMarkerComments.length; i++) {
    const c = tcMarkerComments[i];
    const slice = jsonSlices[i];
    if (!slice || !slice.testCases.length) {
      console.warn(`   ⚠️  Updated-design test case comment without matching JSON attachment (index ${i + 1})`);
      continue;
    }
    tcEvents.push({
      t: new Date(c.created || 0).getTime(),
      type: "testcases",
      testCases: slice.testCases,
    });
  }
  if (jsonSlices.length > tcMarkerComments.length) {
    console.warn(
      `   ⚠️  ${jsonSlices.length - tcMarkerComments.length} test case JSON attachment(s) have no matching "(Updated CSV flow)" comment — ignored for block ordering`
    );
  }

  const merged = [...clEvents, ...tcEvents].sort((a, b) => a.t - b.t);
  const blocks = [];
  for (const e of merged) {
    if (e.type === "checklist") {
      const items = parseChecklistItemsFromChecklistComment(e.text);
      if (!items.length) continue;
      blocks.push({
        type: "checklist",
        items,
        partLabel: parseChecklistPartLabelFromComment(e.text),
      });
    } else {
      blocks.push({ type: "testcases", testCases: e.testCases });
    }
  }
  return blocks;
}

/**
 * Approval for Update test design only. Block indices are 1-based in post order (see summary comment).
 * - First line "APPROVED" or "APPROVED:" / "APPROVED: all" → all blocks fully approved.
 * - "APPROVED (n)" → whole block n (checklist or test-case segment).
 * - "APPROVED (n): 1,2,3" → only items 1,2,3 inside block n (checklist lines or numbered test cases in that post).
 * - "APPROVED (n): all" → whole block n (same as plain APPROVED (n)).
 * - If exactly one block: "APPROVED: 1,2,3" still means approve items 1..n within that block (legacy).
 * When there are 2+ blocks, `processUpdatedDesignApprovalFromBlocks` requires every block index to be covered (see getBlockIndicesRequiringExplicitApproval) unless the comment is blanket APPROVED / APPROVED: all.
 */
function parseUpdatedDesignApprovalComment(commentBody, blocks) {
  if (!commentBody || !blocks || !blocks.length) return null;
  const lines = String(commentBody)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return null;

  const first = lines[0];
  if (
    /^APPROVED\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*all\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*[.!]*\s*$/i.test(first)
  ) {
    return { kind: "all" };
  }

  const blockCount = blocks.length;
  /** @type {Map<number, { mode: 'all' } | { mode: 'pick', items: Set<number> }>} */
  const byBlock = new Map();

  for (const line of lines) {
    const withColon = line.match(/^APPROVED\s*\(\s*(\d+)\s*\)\s*:\s*(.+)$/i);
    if (withColon) {
      const bi = parseInt(withColon[1], 10);
      const rhs = String(withColon[2] || "").trim();
      if (!Number.isFinite(bi) || bi < 1 || bi > blockCount) continue;
      if (/^all\s*[.!]*$/i.test(rhs)) {
        byBlock.set(bi, { mode: "all" });
      } else {
        const nums = rhs
          .split(/[,;]+/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (!nums.length) continue;
        const cur = byBlock.get(bi);
        if (cur && cur.mode === "all") continue;
        const set = cur && cur.mode === "pick" ? new Set(cur.items) : new Set();
        nums.forEach((n) => set.add(n));
        byBlock.set(bi, { mode: "pick", items: set });
      }
      continue;
    }
    const onlyParen = line.match(/^APPROVED\s*\(\s*(\d+)\s*\)\s*[.!]*$/i);
    if (onlyParen) {
      const bi = parseInt(onlyParen[1], 10);
      if (!Number.isFinite(bi) || bi < 1 || bi > blockCount) continue;
      byBlock.set(bi, { mode: "all" });
    }
  }

  if (byBlock.size > 0) {
    /** @type {Array<{ blockIndex: number, mode: 'all' } | { blockIndex: number, mode: 'pick', items: number[] }>} */
    const entries = [];
    for (const bi of [...byBlock.keys()].sort((a, b) => a - b)) {
      const spec = byBlock.get(bi);
      const b = blocks[bi - 1];
      const max =
        b.type === "checklist" ? b.items.length : ((b.testCases || []).length || 0);
      if (spec.mode === "all") {
        entries.push({ blockIndex: bi, mode: "all" });
      } else {
        const ok = [...spec.items].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b);
        if (!ok.length) continue;
        entries.push({ blockIndex: bi, mode: "pick", items: ok });
      }
    }
    if (entries.length) return { kind: "byBlock", entries };
  }

  if (blocks.length === 1) {
    const b0 = blocks[0];
    const total =
      b0.type === "checklist" ? b0.items.length : (b0.testCases || []).length;
    if (total < 1) return null;
    const approvedKeys = parseApprovalComment(commentBody, total);
    if (approvedKeys && approvedKeys.length) {
      return { kind: "items", approvedKeys };
    }
  }

  return null;
}

function isUpdatedFlowSummaryCommentBody(text) {
  return String(text || "").includes("Updated CSV flow: source file");
}

/** Latest `Updated CSV flow: source file …` summary comment time (ms), or 0 if none. */
function findLatestUpdatedCsvSummaryCommentMs(comments) {
  let max = 0;
  for (const c of comments || []) {
    const body = (c.bodyText || c.body || "").toString();
    if (!isUpdatedFlowSummaryCommentBody(body)) continue;
    const ms = new Date(c.created || 0).getTime();
    if (Number.isFinite(ms) && ms >= max) max = ms;
  }
  return max;
}

function isBlanketApprovalFirstLineOfComment(text) {
  const first =
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  return (
    /^APPROVED\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*all\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*[.!]*\s*$/i.test(first)
  );
}

/**
 * Lines that are approval directives only (avoids bullets like "• … APPROVED …" in footers).
 */
function extractApprovedDirectiveLines(text) {
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      /^APPROVED\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*all\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*[\d,\s]+$/i.test(line) ||
      /^APPROVED\s*\(\s*\d+\s*\)/i.test(line)
    ) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Merge APPROVED… directives from one or more Jira comments (same or separate comments).
 * - After the latest "Updated CSV flow: source file" summary, all matching lines are concatenated in time order.
 * - If there is no summary anchor, only the last 30 non-summary comments are considered.
 * - If the newest matching comment is a blanket APPROVED / APPROVED: all, only that comment body is used.
 */
function getMergedApprovalTextForUpdatedDesign(comments, blocks) {
  if (!comments || !comments.length || !blocks || !blocks.length) return null;

  const sorted = [...comments].sort(
    (a, b) => new Date(a.created || 0).getTime() - new Date(b.created || 0).getTime()
  );
  const anchorMs = findLatestUpdatedCsvSummaryCommentMs(sorted);

  let pool = sorted.filter((c) => !isUpdatedFlowSummaryCommentBody(c.bodyText || c.body || ""));
  if (anchorMs > 0) {
    pool = pool.filter((c) => new Date(c.created || 0).getTime() >= anchorMs);
  } else {
    pool = pool.slice(-30);
  }

  for (let i = pool.length - 1; i >= 0; i--) {
    const t = (pool[i].bodyText || pool[i].body || "").toString();
    if (isBlanketApprovalFirstLineOfComment(t)) {
      const parsed = parseUpdatedDesignApprovalComment(t.trim(), blocks);
      if (parsed) return t.trim();
    }
  }

  const lines = [];
  for (const c of pool) {
    lines.push(...extractApprovedDirectiveLines(c.bodyText || c.body || ""));
  }
  if (!lines.length) return null;
  const merged = lines.join("\n");
  return parseUpdatedDesignApprovalComment(merged, blocks) ? merged : null;
}

/**
 * One CSV for approved sections from Update test design (test cases + checklist blocks in order).
 * @param {Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', partLabel: string, approvedItems: { number: number, item: object }[] }>} sections
 */
function generateApprovedUpdatedDesignCsv(issueData, sections, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const assignedTo = issueData.assignee || "";
  const baseTitle = (issueData.summary || issueData.key || "Export").trim();
  const rows = [];

  const checklistSectionCount = sections.filter((s) => s.type === "checklist").length;
  let checklistIndex = 0;

  for (const sec of sections) {
    if (sec.type === "testcases") {
      for (const tc of sec.testCases || []) {
        const title = (tc.title || "Test case").trim();
        const tcPriority = tc.priority != null ? String(tc.priority) : priority;
        const tcAreaPath = (tc.areaPath || areaPath).trim() || areaPath;
        rows.push(
          [
            escapeCSV(issueData.key),
            "Test Case",
            escapeCSV(title),
            "",
            "",
            "",
            escapeCSV(tcPriority),
            escapeCSV(tcAreaPath),
            escapeCSV(assignedTo),
            escapeCSV(state),
          ].join(",")
        );
        const steps = (tc.steps || []).slice().sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
        steps.forEach((step, stepIdx) => {
          const stepNum = String(step.stepNumber != null ? step.stepNumber : stepIdx + 1);
          const action = (step.action || "").trim();
          const expected = normalizeExpectedResultText(step.expected);
          rows.push(
            [
              "",
              "",
              "",
              escapeCSV(stepNum),
              escapeCSV(action),
              escapeCSV(expected),
              "",
              "",
              "",
              "",
            ].join(",")
          );
        });
      }
    } else {
      checklistIndex += 1;
      const partLabel = String(sec.partLabel || "").trim();
      let title = baseTitle;
      if (partLabel) title = `${baseTitle} (${partLabel})`;
      else if (checklistSectionCount > 1) title = `${baseTitle} (checklist ${checklistIndex})`;

      rows.push(
        [
          escapeCSV(issueData.key),
          "Test Case",
          escapeCSV(title),
          "",
          "",
          "",
          escapeCSV(priority),
          escapeCSV(areaPath),
          escapeCSV(assignedTo),
          escapeCSV(state),
        ].join(",")
      );
      (sec.approvedItems || []).forEach(({ item }, index) => {
        const stepNum = String(index + 1);
        const stepAction = (item.description || "").trim();
        rows.push(
          [
            "",
            "",
            "",
            escapeCSV(stepNum),
            escapeCSV(stepAction),
            "",
            "",
            "",
            "",
            "",
          ].join(",")
        );
      });
    }
  }

  fs.writeFileSync(outputPath, [header, ...rows].join("\r\n"), "utf8");
  return outputPath;
}

/** First line e.g. "Part 1/3 — Title" from updated CSV flow checklist comments. */
function parseChecklistPartLabelFromComment(commentText) {
  const first = String(commentText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  const m = first.match(/^Part\s+(\d+)\/(\d+)\s*(?:[—\-]\s*(.+))?$/i);
  if (!m) return "";
  const subtitle = (m[3] || "").trim();
  return subtitle ? `Part ${m[1]}/${m[2]}: ${subtitle}` : `Part ${m[1]}/${m[2]}`;
}

/**
 * When the update posted more than one block (any mix of test-case segments + checklists),
 * each global block index 1..N must appear in the approval before CSV export (unless APPROVED / APPROVED: all).
 */
function getBlockIndicesRequiringExplicitApproval(blocks) {
  if (!blocks || blocks.length <= 1) return new Set();
  return new Set(blocks.map((_, i) => i + 1));
}

function explicitApprovalCoversBlockIndices(spec, blocks, requiredIndices) {
  if (!requiredIndices || requiredIndices.size === 0) return true;
  if (spec.kind === "all") return true;

  const covered = new Set();
  if (spec.kind === "byBlock") {
    for (const ent of spec.entries) {
      if (requiredIndices.has(ent.blockIndex)) covered.add(ent.blockIndex);
    }
  } else if (spec.kind === "items" && blocks.length === 1 && requiredIndices.has(1)) {
    covered.add(1);
  }

  for (const idx of requiredIndices) {
    if (!covered.has(idx)) return false;
  }
  return true;
}

/**
 * Merge test cases from all generated-testcases-*.json attachments (base + -seg2, -seg3, …).
 * @returns {Promise<object[]|null>}
 */
async function mergeTestCasesFromAttachments(jiraClient, issueKey) {
  const slices = await loadOrderedTestCaseJsonSlices(jiraClient, issueKey);
  if (!slices.length) return null;
  const all = [];
  for (const s of slices) all.push(...s.testCases);
  return all.length ? all : null;
}

/**
 * Resolve the issue key where CSV (attachment + comment) must be added:
 * the QA Sub-task with title "Test design" that belongs to the same story/improvement
 * to which the checklist was created (parent of the current issue, or current issue if it is the parent).
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} issueKey - Current issue (where checklist was created or where we're processing)
 * @param {object} issue - Full Jira issue (must have fields.parent when it's a subtask)
 * @returns {Promise<string>} Issue key of the Test design subtask, or issueKey if not found
 */
async function resolveCsvTargetIssueKey(jiraClient, issueKey, issue) {
  const mainIssueKey = issue.fields?.parent?.key || issueKey;
  const testDesignKey = await jiraClient.getTestDesignSubtaskKey(mainIssueKey, PROJECT_KEY);
  const target = testDesignKey || issueKey;
  if (target !== issueKey) {
    console.log(`   📎 CSV will be added to Test design subtask: ${target} (of story ${mainIssueKey})`);
  }
  return target;
}

/**
 * Resolve the issue key where the checklist comment must be posted:
 * the QA Sub-task with title "Test design" of the same story/improvement (parent or self).
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} issueKey - Trigger issue (parent or Test design subtask)
 * @returns {Promise<string>} Issue key of the Test design subtask
 */
async function getChecklistPostTargetKey(jiraClient, issueKey) {
  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = issue.fields?.parent?.key || issueKey;
  const testDesignKey = await jiraClient.getTestDesignSubtaskKey(contextIssueKey, PROJECT_KEY);
  return testDesignKey || contextIssueKey;
}

async function processApprovalAndGenerateTestCases(issueKey, checklistResult, jiraClient, confluenceClient, issueData, relatedDocs) {
  console.log("⏳ Checking for approval comments...");
  
  // Get all comments
  const comments = await jiraClient.getComments(issueKey);
  console.log(`   📝 Found ${comments.length} comment(s) in issue`);
  
  if (comments.length === 0) {
    console.log("ℹ️  No comments found. Skipping CSV generation.");
    console.log("   To generate CSV, add a comment with: APPROVED: 1,2,3 or APPROVED: all");
    return null;
  }
  
  // Find the most recent approval comment (check from newest to oldest)
  let approvedItems = null;
  let approvalCommentAuthor = null;
  let approvalCommentDate = null;
  
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    // Jira API v3 comment body is ADF; jira-client adds bodyText for convenience
    const commentBody = comment.bodyText || comment.body || "";
    
    // Check if this comment contains approval
    approvedItems = parseApprovalComment(commentBody, checklistResult.checklistItems.length);
    
    if (approvedItems) {
      approvalCommentAuthor = comment.author?.displayName || "Unknown";
      approvalCommentDate = comment.created || "Unknown";
      console.log(`✅ Found approval comment from ${approvalCommentAuthor} (${approvalCommentDate})`);
      console.log(`   Approved items: ${approvedItems.join(", ")}`);
      break;
    }
  }

  if (!approvedItems || approvedItems.length === 0) {
    console.log("ℹ️  No approval comment found. Skipping CSV generation.");
    console.log("   To generate CSV, add a comment with: APPROVED: 1,2,3 or APPROVED: all");
    console.log(`   Current checklist has ${checklistResult.checklistItems.length} items`);
    return null;
  }

  // Build list of approved checklist items { number, item }
  const approvedItemsList = approvedItems
    .map((idx) => parseInt(idx, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= checklistResult.checklistItems.length)
    .map((n) => ({ number: n, item: checklistResult.checklistItems[n - 1] }));

  // CSV must be added to the Test design subtask of the same story/improvement
  const issueForTarget = await jiraClient.getIssueWithExpand(issueKey);
  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issueForTarget);

  // Generate CSV file with approved checklist (save to CHECKLIST_OUTPUT_DIR, not in project)
  const csvFileName = approvedChecklistCsvFilename(issueKey, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedChecklistCSV(issueData, approvedItemsList, csvFilePath);
    console.log(`\n📄 Generated CSV: ${csvFilePath}`);
    // Upload CSV as attachment to Jira (on Test design subtask)
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    // Add comment with link to the CSV attachment (on Test design subtask)
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved checklist (CSV)", attachmentUrl, attachmentFileName);
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
  }

  return { csvPath: csvFilePath, approvedCount: approvedItemsList.length };
}

/**
 * If ADO_SYNC_APPROVED_CSV=true, create Test Case work items in Azure DevOps from the approved CSV.
 * Requires ADO_ORG, ADO_PROJECT, ADO_PAT and Work Items **Write** on the PAT.
 */
async function maybeSyncCsvToAzureDevOps(csvFilePath, jiraIssueKey) {
  if (process.env.ADO_SYNC_APPROVED_CSV !== "true") return null;
  if (!csvFilePath || !fs.existsSync(csvFilePath)) {
    console.warn("⚠️  ADO_SYNC_APPROVED_CSV: CSV file not found, skipping Azure DevOps");
    return null;
  }
  try {
    const { syncApprovedPixelCsvToAzureDevOps } = require("./ado-sync-csv");
    console.log("📤 Syncing approved CSV to Azure DevOps...");
    const r = await syncApprovedPixelCsvToAzureDevOps(csvFilePath, {
      jiraIssueKey: jiraIssueKey || "",
      syncFromApprovalRun: true,
    });
    r.created.forEach((c) => console.log(`   ✅ Azure DevOps Test Case #${c.id}: ${c.title}`));
    if (r.errors.length) {
      r.errors.forEach((e) => console.warn(`   ⚠️  ADO sync: ${e}`));
    }
    return r;
  } catch (e) {
    console.warn(`⚠️  Azure DevOps sync failed: ${e.message}`);
    return null;
  }
}

/**
 * Approval + CSV when the Test design subtask has Update test design / "(Updated CSV flow)" blocks.
 */
async function processUpdatedDesignApprovalFromBlocks(
  issueKey,
  jiraClient,
  issue,
  issueData,
  commentHostKey,
  comments,
  blocks
) {
  const approvalText = getMergedApprovalTextForUpdatedDesign(comments, blocks);
  if (!approvalText) {
    console.log(
      "ℹ️  No approval comment found for Update test design flow. Use APPROVED / APPROVED: all, or APPROVED (n) / APPROVED (n): 1,2,3 (directives can be in one comment or split across several comments after the latest \"Updated CSV flow: source file\" summary)."
    );
    return { status: "skipped", reason: "No approval comment" };
  }

  const spec = parseUpdatedDesignApprovalComment(approvalText, blocks);
  if (!spec) {
    console.log(
      "ℹ️  Approval text not recognized for this flow. Examples: APPROVED (1), APPROVED (2): 1,3,5, APPROVED (1): 1,2,3,4. With a single block you may use APPROVED: 1,2,3 for items."
    );
    return { status: "skipped", reason: "No valid approval" };
  }

  const requiredBlockIndices = getBlockIndicesRequiringExplicitApproval(blocks);
  if (!explicitApprovalCoversBlockIndices(spec, blocks, requiredBlockIndices)) {
    const sortedNeed = [...requiredBlockIndices].sort((a, b) => a - b);
    const example = sortedNeed.map((i) => `APPROVED (${i})`).join(" and ");
    const covered = new Set();
    if (spec.kind === "byBlock") {
      for (const ent of spec.entries) {
        if (requiredBlockIndices.has(ent.blockIndex)) covered.add(ent.blockIndex);
      }
    } else if (spec.kind === "items" && blocks.length === 1 && requiredBlockIndices.has(1)) {
      covered.add(1);
    }
    const missing = sortedNeed.filter((idx) => !covered.has(idx));
    console.log(
      `ℹ️  This update posted ${blocks.length} block(s) (test case groups and/or checklists). Each block needs its own approval line before a CSV is generated (for example: ${example}), or use a first line APPROVED or APPROVED: all for everything. Missing block index(es): ${missing.join(
        ", "
      )}. CSV not generated.`
    );
    return { status: "skipped", reason: "Incomplete multi-block approval" };
  }

  /** @type {Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', partLabel: string, approvedItems: { number: number, item: object }[] }>} */
  const sections = [];

  if (spec.kind === "all") {
    for (const b of blocks) {
      if (b.type === "testcases") {
        sections.push({ type: "testcases", testCases: [...b.testCases] });
      } else {
        const approvedItems = b.items.map((item, idx) => ({ number: idx + 1, item }));
        sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
      }
    }
    console.log(`✅ Approval: all ${blocks.length} block(s) (Update test design flow)`);
  } else if (spec.kind === "byBlock") {
    const parts = [];
    for (const ent of spec.entries) {
      const b = blocks[ent.blockIndex - 1];
      if (!b) continue;
      if (ent.mode === "all") {
        parts.push(String(ent.blockIndex));
        if (b.type === "testcases") {
          sections.push({ type: "testcases", testCases: [...b.testCases] });
        } else {
          const approvedItems = b.items.map((item, idx) => ({ number: idx + 1, item }));
          sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
        }
      } else if (ent.mode === "pick" && ent.items && ent.items.length) {
        parts.push(`${ent.blockIndex}:${ent.items.join(",")}`);
        if (b.type === "checklist") {
          const approvedItems = ent.items
            .map((n) => ({ number: n, item: b.items[n - 1] }))
            .filter((x) => x.item);
          if (approvedItems.length) {
            sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
          }
        } else {
          const approvedTCs = ent.items.map((n) => b.testCases[n - 1]).filter(Boolean);
          if (approvedTCs.length) {
            sections.push({ type: "testcases", testCases: approvedTCs });
          }
        }
      }
    }
    console.log(`✅ Approval: by-block ${parts.join(" | ")} (${blocks.length} block(s) on issue) — Update test design flow`);
  } else if (spec.kind === "items") {
    const b0 = blocks[0];
    const keys = spec.approvedKeys;
    if (b0.type === "checklist") {
      const approvedItems = keys
        .map((k) => parseInt(k, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= b0.items.length)
        .map((n) => ({ number: n, item: b0.items[n - 1] }))
        .filter((x) => x.item);
      sections.push({ type: "checklist", partLabel: b0.partLabel || "", approvedItems });
    } else {
      const approvedTCs = keys
        .map((k) => parseInt(k, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= b0.testCases.length)
        .map((n) => b0.testCases[n - 1])
        .filter(Boolean);
      sections.push({ type: "testcases", testCases: approvedTCs });
    }
    console.log(`✅ Approval: items ${keys.join(", ")} within the only block (Update test design flow)`);
  }

  if (!sections.length) {
    return { status: "skipped", reason: "No approved content after filtering" };
  }

  let totalLines = 0;
  for (const s of sections) {
    if (s.type === "testcases") totalLines += (s.testCases || []).length;
    else totalLines += (s.approvedItems || []).length;
  }

  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
  const csvFileName = approvedChecklistCsvFilename(issueData.key, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedUpdatedDesignCsv(issueData, sections, csvFilePath);
    console.log(`\n📄 Generated CSV (Update test design): ${csvFilePath}`);
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl =
          att.content ||
          `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(
          csvTargetKey,
          "Approved test design (CSV)",
          attachmentUrl,
          attachmentFileName
        );
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
    return { status: "skipped", reason: err.message };
  }

  const azureDevOps = await maybeSyncCsvToAzureDevOps(csvFilePath, issueData.key);
  return {
    status: "success",
    csvPath: csvFilePath,
    approvedCount: totalLines,
    azureDevOps,
  };
}

async function processApprovalOnlyFromExistingChecklist(issueKey) {
  console.log(`🚀 Processing approvals-only for: ${issueKey}`);

  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);

  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = issue.fields?.parent?.key || issueKey;

  // CSV rows: parent story key/title (same as checklist generation context).
  let parentIssueForData = issue;
  if (issue.fields?.parent?.key) {
    try {
      parentIssueForData = await jiraClient.getIssueWithExpand(issue.fields.parent.key);
    } catch (e) {
      console.warn(`⚠️  Could not load parent for CSV metadata: ${e.message}`);
    }
  }
  const issueData = jiraClient.extractIssueData(parentIssueForData);

  // Checklist / test case comments and generated-testcases JSON are on the Test design subtask.
  const testDesignKey = await jiraClient.getTestDesignSubtaskKey(contextIssueKey, PROJECT_KEY);
  const commentHostKey = testDesignKey || issueKey;
  if (commentHostKey !== issueKey) {
    console.log(`   Reading comments/attachments from Test design subtask ${commentHostKey} (story ${contextIssueKey})`);
  }
  const comments = await jiraClient.getComments(commentHostKey);

  const updatedDesignBlocks = await buildUpdatedDesignApprovalBlocks(jiraClient, commentHostKey, comments);
  if (updatedDesignBlocks.length > 0) {
    console.log(
      `📌 Update test design flow: ${updatedDesignBlocks.length} posted block(s) in chronological order (checklist comments + test case JSON segments)`
    );
    return await processUpdatedDesignApprovalFromBlocks(
      issueKey,
      jiraClient,
      issue,
      issueData,
      commentHostKey,
      comments,
      updatedDesignBlocks
    );
  }

  const approvalHit = findLatestCommentTextContaining(comments, "APPROVED:");
  if (!approvalHit) {
    console.log("ℹ️  No approval comment found. Skipping.");
    return { status: "skipped", reason: "No approval comment" };
  }

  // 1) Try test cases: all generated-testcases-*.json attachments (seg2, seg3, …) then fallback to comment body
  let testCases = await mergeTestCasesFromAttachments(jiraClient, commentHostKey);
  const testCasesHit = findLatestCommentTextContaining(comments, "AI-Generated Test Cases");
  if (!testCases || testCases.length === 0) {
    if (testCasesHit) testCases = parseTestCasesFromComment(testCasesHit.text);
  }
  if (testCases && testCases.length > 0) {
      console.log(`📋 Loaded ${testCases.length} test case(s) for approval (all segments / attachments merged)`);
      const approvedNumbers = parseApprovalComment(approvalHit.text, testCases.length);
      if (!approvedNumbers || approvedNumbers.length === 0) {
        console.log("ℹ️  Approval comment present, but no valid approved numbers. Skipping.");
        return { status: "skipped", reason: "No valid approved numbers" };
      }
      console.log(`✅ Approved test case numbers: ${approvedNumbers.join(", ")}`);
      const approvedTestCases = approvedNumbers
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= testCases.length)
        .map((n) => testCases[n - 1])
        .filter(Boolean);
      if (approvedTestCases.length === 0) {
        return { status: "skipped", reason: "Approved test cases empty after validation" };
      }
      const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
      const csvFileName = approvedTestCasesCsvFilename(issueData.key, issueData.summary);
      const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
      try {
        fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
        generateApprovedTestCasesCSV(issueData, approvedTestCases, csvFilePath);
        console.log(`📄 Generated CSV (test cases): ${csvFilePath}`);
        let attachmentUrl = null;
        let attachmentFileName = csvFileName;
        try {
          const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
          console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
          if (attachments && attachments[0]) {
            const att = attachments[0];
            attachmentFileName = att.filename || csvFileName;
            attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
          }
        } catch (attachErr) {
          console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
        }
        if (attachmentUrl) {
          try {
            await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved test cases (CSV)", attachmentUrl, attachmentFileName);
            console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
          } catch (commentErr) {
            console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️  Could not write CSV: ${err.message}`);
      }
      const azureDevOps = await maybeSyncCsvToAzureDevOps(csvFilePath, issueData.key);
      return {
        status: "success",
        csvPath: csvFilePath,
        approvedCount: approvedTestCases.length,
        azureDevOps,
      };
  }

  // 2) Fallback: all checklist comments (updated CSV flow may post several) → one CSV, N Test Case blocks → N ADO work items
  const checklistHits = findAllCommentsTextContaining(comments, "AI-Generated Test Checklist");
  if (!checklistHits.length) {
    console.log("ℹ️  No checklist or test cases comment found. Skipping.");
    return { status: "skipped", reason: "No checklist comment" };
  }

  /** @type {{ partLabel: string, approvedItems: { number: number, item: object }[] }[]} */
  const checklistGroups = [];
  let totalApprovedItems = 0;

  for (const { text } of checklistHits) {
    const checklistItems = parseChecklistItemsFromChecklistComment(text);
    if (checklistItems.length === 0) {
      console.log("ℹ️  One checklist comment skipped (no numbered items parsed).");
      continue;
    }
    const approvedNumbers = parseApprovalComment(approvalHit.text, checklistItems.length);
    if (!approvedNumbers || approvedNumbers.length === 0) {
      console.log(
        `ℹ️  Approval does not apply to one checklist (${checklistItems.length} item(s)); skipped that block.`
      );
      continue;
    }
    const approvedItems = approvedNumbers
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= checklistItems.length)
      .map((n) => ({ number: n, item: checklistItems[n - 1] }))
      .filter((x) => x.item);

    if (approvedItems.length === 0) continue;

    const partLabel = parseChecklistPartLabelFromComment(text);
    checklistGroups.push({ partLabel, approvedItems });
    totalApprovedItems += approvedItems.length;
  }

  if (checklistGroups.length === 0) {
    console.log("ℹ️  No checklist blocks with valid approval. Skipping.");
    return { status: "skipped", reason: "No approved checklist blocks" };
  }

  console.log(
    `📋 ${checklistGroups.length} checklist block(s) → CSV with ${checklistGroups.length} Test Case header(s) (${totalApprovedItems} approved line(s) total)`
  );

  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
  const csvFileName = approvedChecklistCsvFilename(issueData.key, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedMultiChecklistCSV(issueData, checklistGroups, csvFilePath);
    console.log(`📄 Generated CSV: ${csvFilePath}`);
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved checklist (CSV)", attachmentUrl, attachmentFileName);
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
  }

  const azureDevOps = await maybeSyncCsvToAzureDevOps(csvFilePath, issueData.key);
  return {
    status: "success",
    csvPath: csvFilePath,
    approvedCount: totalApprovedItems,
    azureDevOps,
  };
}

async function processIssue(issueKey) {
  console.log(`🚀 Processing Jira issue: ${issueKey}`);
  
  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  
  // Only create Confluence client if Confluence search is enabled
  const enableConfluenceSearch = process.env.ENABLE_CONFLUENCE_SEARCH === "true";
  const confluenceClient = enableConfluenceSearch 
    ? new ConfluenceClient(CONFLUENCE_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)
    : null;

  // Step 1: Get issue details and resolve context (parent) + where to post checklist
  console.log("📋 Fetching issue details...");
  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = issue.fields?.parent?.key || issueKey;
  let issueData;
  if (contextIssueKey !== issueKey) {
    console.log(`   Trigger: ${issueKey} (Test design subtask) → scanning parent ${contextIssueKey}`);
    const contextIssue = await jiraClient.getIssueWithExpand(contextIssueKey);
    issueData = jiraClient.extractIssueData(contextIssue);
  } else {
    issueData = jiraClient.extractIssueData(issue);
    console.log(`   Trigger: ${issueKey} (parent) → scanning parent for checklist`);
  }
  let checklistPostTargetKey = await jiraClient.getTestDesignSubtaskKey(contextIssueKey, PROJECT_KEY);
  if (!checklistPostTargetKey) {
    if (contextIssueKey === issueKey) {
      throw new Error("No QA Sub-task with title 'Test design' found for this issue. Create one to post the checklist.");
    }
    checklistPostTargetKey = issueKey;
  } else {
    console.log(`   Checklist will be posted to Test design subtask: ${checklistPostTargetKey}`);
  }

  console.log(`   Issue (context): ${issueData.key} - ${issueData.summary}`);
  console.log(`   Status: ${issueData.status}`);
  console.log(`   Labels: ${issueData.labels.join(", ") || "none"}`);

  const checkApproval = process.env.CHECK_APPROVAL === "true";

  // When CHECK_APPROVAL=true: only look for existing checklist in comments + approval → CSV. Do NOT generate or post checklist again.
  if (checkApproval) {
    console.log("🔍 Approval mode: looking for existing checklist and APPROVED comment (no new checklist will be posted)...");
    const approvalResult = await processApprovalOnlyFromExistingChecklist(issueKey);
    const report = {
      issueKey: issueData.key,
      issueSummary: issueData.summary,
      issueDescription: issueData.description,
      issueLabels: issueData.labels,
      isChangeRequest: isChangeRequest(issueData),
      checklist: null,
      approvalCsv: approvalResult.status === "success" ? { csvPath: approvalResult.csvPath, approvedCount: approvalResult.approvedCount } : null,
      relatedDocumentation: { confluencePages: 0, relatedJiraIssues: 0 },
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync("report.yaml", JSON.stringify(report, null, 2));
    console.log("✅ Report saved to report.yaml");
    return report;
  }

  // Step 2: Validate requirements (only when generating checklist)
  console.log("✅ Validating requirements...");
  const validation = validateRequirements(issueData);
  
  if (!validation.valid) {
    const errorComment = `⚠️ Validation Error

This task does not meet the minimum requirements for test case generation:

${validation.errors.map(e => `☐ ${e}`).join("\n")}

Please add the necessary information and try again.`;
    
    await jiraClient.addComment(checklistPostTargetKey, errorComment);
    throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
  }

  // Step 3: Search related documentation (optional, can be disabled)
  const relatedDocs = await searchRelatedDocumentation(jiraClient, confluenceClient, issueData);
  
  console.log(`📊 Documentation context: ${relatedDocs.confluencePages.length} Confluence pages, ${relatedDocs.relatedJiraIssues.length} related issues`);

  // Step 4: Check if it's a change request
  const isChangeReq = isChangeRequest(issueData);
  
  if (isChangeReq && confluenceClient) {
    console.log("🔄 Detected change request - reusing Confluence docs from Jira-linked requirements...");
    if (relatedDocs.confluencePages.length > 0) {
      relatedDocs.existingTestCases = relatedDocs.confluencePages;
      console.log(`📚 Using ${relatedDocs.existingTestCases.length} Jira-linked Confluence document(s) as existing test context`);
    } else {
      console.log("ℹ️  No Jira-linked Confluence documents found for change request context.");
    }
  } else if (isChangeReq && !confluenceClient) {
    console.log("ℹ️  Change request detected, but Confluence search is disabled. Working with issue description only.");
  }

  let checklistResult = null;
  let testCasesResult = null;

  if (GENERATE_MODE === "testcases") {
    // Step 5b: Generate test cases and post as ADF (tables only); JSON stored in attachment for approval
    testCasesResult = await generateTestCases(issueData, relatedDocs);
    const adfBody = buildTestCasesCommentAdf(testCasesResult);
    console.log("💬 Posting test cases comment to Jira (tables only)...");
    await jiraClient.addCommentAdf(checklistPostTargetKey, adfBody);
    const jsonPayload = JSON.stringify({ testCases: testCasesResult.testCases, reasoning: testCasesResult.reasoning }, null, 2);
    const jsonFileName = `generated-testcases-${checklistPostTargetKey}.json`;
    const jsonTempPath = path.join(__dirname, jsonFileName);
    try {
      fs.writeFileSync(jsonTempPath, jsonPayload, "utf8");
      await jiraClient.addAttachment(checklistPostTargetKey, jsonTempPath);
      console.log(`   📎 Test cases data attached as ${jsonFileName} (for approval step).`);
    } catch (err) {
      console.warn(`⚠️  Could not attach test cases JSON: ${err.message}`);
    } finally {
      try { fs.unlinkSync(jsonTempPath); } catch (_) {}
    }
    console.log("ℹ️  Test cases posted. Review and add approval comment (APPROVED: 1,2,3).");
    console.log("   Then run the agent again with CHECK_APPROVAL=true to generate CSV.");
  } else {
    // Step 5a: Generate test checklist and post
    checklistResult = await generateTestChecklist(issueData, relatedDocs);
    const checklistComment = formatChecklistComment(
      checklistResult,
      checklistResult.reasoning
    );
    console.log("💬 Posting checklist comment to Jira...");
    await jiraClient.addComment(checklistPostTargetKey, checklistComment);
    console.log("ℹ️  Checklist posted. Please review and add approval comment (APPROVED: 1,2,3).");
    console.log("   Then run the agent again with CHECK_APPROVAL=true to generate CSV.");
  }

  const report = {
    issueKey: issueData.key,
    issueSummary: issueData.summary,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    isChangeRequest: isChangeReq,
    checklist: checklistResult,
    testCases: testCasesResult ? { testCases: testCasesResult.testCases, reasoning: testCasesResult.reasoning } : null,
    approvalCsv: null,
    relatedDocumentation: {
      confluencePages: relatedDocs.confluencePages.length,
      relatedJiraIssues: relatedDocs.relatedJiraIssues.length,
      relatedJiraIssuesUsed: relatedDocs.relatedJiraIssues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
      })),
    },
    generatedAt: new Date().toISOString(),
  };

  // Save report
  fs.writeFileSync("report.yaml", JSON.stringify(report, null, 2));
  console.log("✅ Report saved to report.yaml");

  return report;
}

async function run() {
  const issueKey = process.env.JIRA_ISSUE_KEY || process.env.AGENT_GOAL;
  
  if (!issueKey) {
    console.error("❌ Error: JIRA_ISSUE_KEY or AGENT_GOAL must be set");
    console.error("   Set JIRA_ISSUE_KEY to a Jira issue key (e.g., PROJ-123)");
    process.exit(1);
  }

  try {
    await processIssue(issueKey);
    console.log("✅ Agent completed successfully");
  } catch (error) {
    console.error("❌ Agent error:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  run();
}

module.exports = { processIssue, processApprovalOnlyFromExistingChecklist, getChecklistPostTargetKey, run };
