require("dotenv").config();
/** Set before loading agent-docs so ENABLE_TEST_CASES_ANALYSIS is not applied in batch (single runs only). */
process.env.AGENT_BATCH_RUN = "true";

const fs = require("fs");
const path = require("path");
const { JiraClient } = require("./jira-client");
const { processIssue, processApprovalOnlyFromExistingChecklist, getChecklistPostTargetKey } = require("./agent-docs");

const BATCH_SUMMARY_DIR =
  process.env.BATCH_SUMMARY_DIR || path.join(__dirname, "Batch Summary Archive");

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "PROJ";

/** Jira status name for the Test design QA Sub-task (must match your workflow exactly in JQL). */
const BATCH_QA_STATUS = process.env.BATCH_QA_STATUS || "QA IN PROGRESS";
const BATCH_ISSUE_TYPE_QA_SUBTASK = process.env.BATCH_ISSUE_TYPE_QA_SUBTASK || "QA Sub-task";
const BATCH_TEST_DESIGN_SUMMARY_MATCH = process.env.BATCH_TEST_DESIGN_SUMMARY_MATCH || "Test design";

function escapeJqlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Maximum number of issues to process per run
const MAX_ISSUES = parseInt(process.env.BATCH_MAX_ISSUES || "10", 10);

// Whether to generate checklist only or also check for approval
const CHECK_APPROVAL = process.env.CHECK_APPROVAL === "true";

// JQL query to find issues for daily processing — only QA Sub-task "Test design" in the configured QA status.
// We support two independent queries so you can schedule "Day 1: checklist" and "Day 2: approved -> TC" safely.
const JQL_CHECKLIST =
  process.env.BATCH_JQL_CHECKLIST ||
  process.env.BATCH_JQL ||
  `project = ${PROJECT_KEY} AND issuetype = "${escapeJqlString(BATCH_ISSUE_TYPE_QA_SUBTASK)}" AND summary ~ "${escapeJqlString(BATCH_TEST_DESIGN_SUMMARY_MATCH)}" AND status = "${escapeJqlString(BATCH_QA_STATUS)}" ORDER BY updated DESC`;

const JQL_APPROVAL =
  process.env.BATCH_JQL_APPROVAL ||
  `project = ${PROJECT_KEY} AND issuetype = "${escapeJqlString(BATCH_ISSUE_TYPE_QA_SUBTASK)}" AND summary ~ "${escapeJqlString(BATCH_TEST_DESIGN_SUMMARY_MATCH)}" AND status = "${escapeJqlString(BATCH_QA_STATUS)}" AND comment ~ "APPROVED:" ORDER BY updated DESC`;

const DEFAULT_JQL = CHECK_APPROVAL ? JQL_APPROVAL : JQL_CHECKLIST;

// Whether to skip issues that already have checklist comments
const SKIP_WITH_CHECKLIST = process.env.SKIP_WITH_CHECKLIST !== "false";

/**
 * Batch must only process QA Sub-tasks whose summary matches Test design and status matches BATCH_QA_STATUS
 * (defense in depth if BATCH_JQL overrides the default query).
 */
function isEligibleBatchTestDesignIssue(issue) {
  const type = issue.fields?.issuetype?.name;
  const summary = (issue.fields?.summary || "").trim();
  const status = (issue.fields?.status?.name || "").trim();
  if (type !== BATCH_ISSUE_TYPE_QA_SUBTASK) return false;
  if (!summary.toLowerCase().includes(BATCH_TEST_DESIGN_SUMMARY_MATCH.toLowerCase())) return false;
  if (status.toLowerCase() !== BATCH_QA_STATUS.toLowerCase()) return false;
  return true;
}

async function findIssuesToProcess(jiraClient) {
  console.log(`🔍 Searching for issues with JQL: ${DEFAULT_JQL}`);
  
  const results = await jiraClient.searchIssues(DEFAULT_JQL, [
    "key", "summary", "status", "labels", "description", "comment", "issuetype", "parent"
  ], MAX_ISSUES);
  
  if (!results.issues || results.issues.length === 0) {
    console.log("ℹ️  No issues found matching the criteria");
    return [];
  }
  
  console.log(`📋 Found ${results.issues.length} issue(s) to process`);
  return results.issues;
}

async function hasChecklistComment(jiraClient, issueKey) {
  if (!SKIP_WITH_CHECKLIST) {
    return false;
  }
  
  try {
    const comments = await jiraClient.getComments(issueKey);
    // Check if any comment contains "AI-Generated Test Checklist"
    return comments.some(comment => 
      (comment.bodyText || comment.body || "").includes("AI-Generated Test Checklist")
    );
  } catch (error) {
    console.warn(`⚠️  Could not check comments for ${issueKey}: ${error.message}`);
    return false;
  }
}

async function processBatch() {
  console.log("🚀 Starting batch processing...");
  if (process.env.ENABLE_TEST_CASES_ANALYSIS === "true") {
    console.log("ℹ️  ENABLE_TEST_CASES_ANALYSIS is ignored in batch mode (use single `node agent-docs.js …` for project Test cases analysis).");
  }
  console.log(`📊 Configuration:`);
  console.log(`   JQL: ${DEFAULT_JQL}`);
  console.log(`   Required QA status (batch guard): ${BATCH_QA_STATUS}`);
  console.log(`   Max issues: ${MAX_ISSUES}`);
  console.log(`   Check approval: ${CHECK_APPROVAL}`);
  console.log(`   Skip with checklist: ${SKIP_WITH_CHECKLIST}`);
  console.log("");
  
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error("❌ Error: JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN must be set");
    process.exit(1);
  }
  
  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  
  // Find issues to process
  const issues = await findIssuesToProcess(jiraClient);
  
  if (issues.length === 0) {
    console.log("✅ No issues to process. Exiting.");
    return;
  }
  
  const results = {
    total: issues.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    details: []
  };
  
  // Process each issue
  for (const issue of issues) {
    const issueKey = issue.key;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📝 Processing issue: ${issueKey} - ${issue.fields.summary}`);
    console.log(`${"=".repeat(60)}`);

    if (!isEligibleBatchTestDesignIssue(issue)) {
      console.log(
        `⏭️  Skipping ${issueKey}: batch only processes "${BATCH_ISSUE_TYPE_QA_SUBTASK}" with title containing "${BATCH_TEST_DESIGN_SUMMARY_MATCH}" and status "${BATCH_QA_STATUS}"`
      );
      results.skipped++;
      results.details.push({
        issueKey,
        status: "skipped",
        reason: "Not a matching Test design sub-task in required QA status",
      });
      continue;
    }
    
    try {
      if (CHECK_APPROVAL) {
        // Approval-only mode: generate CSV with approved checklist for each ticket
        const res = await processApprovalOnlyFromExistingChecklist(issueKey);
        if (res.status === "success") {
          results.processed++;
          results.details.push({
            issueKey,
            status: "success",
            csvPath: res.csvPath,
            approvedCount: res.approvedCount,
            ...(res.azureDevOps && {
              azureDevOpsCreated: (res.azureDevOps.created || []).map((c) => c.id),
            }),
          });
          console.log(`✅ Generated ${res.csvPath} (${res.approvedCount} approved item(s))`);
        } else {
          results.skipped++;
          results.details.push({ issueKey, status: "skipped", reason: res.reason || res.status });
          console.log(`⏭️  Skipping ${issueKey}: ${res.reason || res.status}`);
        }
      } else {
        // Checklist mode: create checklist (scan parent, post to Test design subtask)
        const checklistTargetKey = await getChecklistPostTargetKey(jiraClient, issueKey);
        if (await hasChecklistComment(jiraClient, checklistTargetKey)) {
          console.log(`⏭️  Skipping ${issueKey} - Test design subtask ${checklistTargetKey} already has checklist comment`);
          results.skipped++;
          results.details.push({
            issueKey,
            status: "skipped",
            reason: "Already has checklist"
          });
          continue;
        }

        process.env.JIRA_ISSUE_KEY = issueKey;
        process.env.CHECK_APPROVAL = CHECK_APPROVAL.toString();
        await processIssue(issueKey);
        results.processed++;
        results.details.push({ issueKey, status: "success" });
        console.log(`✅ Successfully processed ${issueKey}`);
      }
      
      // Small delay between issues to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`❌ Failed to process ${issueKey}: ${error.message}`);
      results.failed++;
      results.details.push({
        issueKey,
        status: "failed",
        error: error.message
      });
    }
  }
  
  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("📊 Batch Processing Summary");
  console.log(`${"=".repeat(60)}`);
  console.log(`Total issues found: ${results.total}`);
  console.log(`✅ Processed: ${results.processed}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`${"=".repeat(60)}\n`);
  
  // Save summary to file
  fs.mkdirSync(BATCH_SUMMARY_DIR, { recursive: true });
  const summaryFile = path.join(
    BATCH_SUMMARY_DIR,
    `batch-summary-${new Date().toISOString().split("T")[0]}.json`
  );
  fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2));
  console.log(`📄 Summary saved to ${summaryFile}`);
}

// Run if called directly
if (require.main === module) {
  processBatch().catch(error => {
    console.error("❌ Batch processing error:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}

module.exports = { processBatch };
