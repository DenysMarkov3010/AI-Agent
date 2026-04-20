/**
 * Command builder + Run (Day 1 / Day 2) — FULL_FLOW_GUIDE.md
 */

const $ = (id) => document.getElementById(id);

const PATH_PLACEHOLDER = "PATH_TO_DEMO_AGENT";

/** API lives on the same machine as web-ui-server.js; Cursor / webview may use a different page origin than the API. */
function apiOrigin() {
  const m = document.querySelector('meta[name="AI Test Agent-api-origin"]');
  const raw = (m && m.getAttribute("content")) || "";
  if (raw && !raw.includes("__AI Test Agent_API_ORIGIN__")) {
    return raw.replace(/\/$/, "");
  }
  if (location.protocol === "http:" || location.protocol === "https:") {
    return `${location.protocol}//${location.host}`;
  }
  return "http://127.0.0.1:3847";
}

function apiUrl(path) {
  const base = apiOrigin();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function vals() {
  const rawJira = ($("jiraKey").value || "").trim();
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraKey: rawJira || "PROJ-123",
    relatedKeywords: ($("relatedKeywords").value || "").trim(),
    day1Scope: $("day1Scope").value,
    generateMode: $("generateMode").value,
    day2Scope: $("day2Scope").value,
  };
}

/** Jira for POST /run-* : empty when UI hides the field (batch modes). */
function jiraKeyForApi() {
  const section = $("mainSection").value;
  if (section === "2" && $("day1Scope").value === "2b") return "";
  if (section === "4" && $("day2Scope").value === "4b") return "";
  return ($("jiraKey").value || "").trim();
}

function escPs(s) {
  return String(s).replace(/`/g, "``").replace(/"/g, '`"');
}

function bashSq(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function cdBash(v) {
  return v.projectPath === PATH_PLACEHOLDER ? "cd /path/to/AI Test Agent" : `cd ${bashSq(v.projectPath)}`;
}

function cdPs(v) {
  if (v.projectPath === PATH_PLACEHOLDER) return `cd ${PATH_PLACEHOLDER}`;
  const p = String(v.projectPath).replace(/'/g, "''");
  return `cd '${p}'`;
}

function buildDay1(v) {
  if (v.day1Scope === "2b") {
    const note =
      v.generateMode === "testcases"
        ? "\n\n# For test cases in batch: set GENERATE_MODE=testcases in .env, then the same commands."
        : "";
    return {
      title: "Step 1 — 2B Batch",
      bash: `${cdBash(v)}\nCHECK_APPROVAL=false npm run batch${note}`,
      ps: `${cdPs(v)}\n$env:CHECK_APPROVAL="false"\nnpm run batch${note}`,
    };
  }

  const envBash = [
    `JIRA_ISSUE_KEY=${bashSq(v.jiraKey)}`,
    "CHECK_APPROVAL=false",
    v.generateMode === "testcases" ? "GENERATE_MODE=testcases" : null,
    v.relatedKeywords ? `RELATED_ISSUES_KEYWORDS=${bashSq(v.relatedKeywords)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const kwPs = v.relatedKeywords ? `\n$env:RELATED_ISSUES_KEYWORDS="${escPs(v.relatedKeywords)}"` : "";
  const genPs = v.generateMode === "testcases" ? `\n$env:GENERATE_MODE="testcases"` : "";

  return {
    title: "Step 1 — 2A Single issue",
    bash: `${cdBash(v)}\n${envBash} node agent-docs.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="false"${genPs}${kwPs}\nnode agent-docs.js`,
  };
}

function buildDay2(v) {
  if (v.day2Scope === "4b") {
    return {
      title: "Step 2 — 4B Batch",
      bash: `${cdBash(v)}\nCHECK_APPROVAL=true npm run batch`,
      ps: `${cdPs(v)}\n$env:CHECK_APPROVAL="true"\nnpm run batch`,
      note: "Batch summary: Batch Summary Archive/batch-summary-YYYY-MM-DD.json",
    };
  }
  return {
    title: "Step 2 — 4A Single issue",
    bash: `${cdBash(v)}\nJIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=true node agent-docs.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="true"\nnode agent-docs.js`,
    note: "CSV output folder: CHECKLIST_OUTPUT_DIR in .env (see guide Day 2).",
  };
}

function buildAdo5b(v) {
  const placeholderCsv = "/path/to/approved-testcases-PROJ-xxx.csv";
  return {
    title: "(Optional) Manual import into Azure DevOps",
    bash: `${cdBash(v)}\n# Set PLAN_ID, SUITE_ID and path to CSV (or configure ADO_SYNC_* in .env)\nnpm run ado:sync-csv -- -p <PLAN_ID> -s <SUITE_ID> ${bashSq(placeholderCsv)}`,
    ps: `${cdPs(v)}\n# Set --plan-id, --suite-id and path to CSV (or use .env):\nnpm run ado:sync-csv -- --plan-id <PLAN_ID> --suite-id <SUITE_ID> "<path-to-csv>"`,
    note:
      "Automatic sync after Step 2: set ADO_SYNC_APPROVED_CSV=true and ADO_ACTIVE_TEST_PLAN_ID in .env, then run the same commands as Step 2 with CHECK_APPROVAL=true. See FULL_FLOW_GUIDE.md and ADO_TEST_PLANS.md.",
  };
}

function render() {
  const v = vals();
  const section = $("mainSection").value;

  let block;
  switch (section) {
    case "2":
      block = buildDay1(v);
      break;
    case "4":
      block = buildDay2(v);
      break;
    case "5":
      block = buildAdo5b(v);
      break;
    default:
      block = buildDay1(v);
  }

  $("outTitle").textContent = block.title;
  $("bashOut").textContent = block.bash;
  $("psOut").textContent = block.ps;
  $("extraNote").textContent = block.note || "";
  $("extraNote").hidden = !block.note;

  $("bashBlock").hidden = false;
  $("psBlock").hidden = false;

  $("day1Row").hidden = section !== "2";
  $("day2Row").hidden = section !== "4";
  $("pathRow").hidden = false;
  const showJira =
    (section === "2" && $("day1Scope").value !== "2b") ||
    (section === "4" && $("day2Scope").value !== "4b");
  $("jiraRow").hidden = !showJira;
  $("keywordsRow").hidden = section !== "2" || $("day1Scope").value !== "2a";
  $("genModeRow").hidden = section !== "2" || $("day1Scope").value === "2b";

  const adoExportRow = $("adoExportTagRow");
  if (adoExportRow) {
    const hideAdoExport = section !== "2";
    adoExportRow.hidden = hideAdoExport;
    if (hideAdoExport) {
      setAdoExportProgressState("idle");
    }
  }

  const showRun = section === "2" || section === "4";
  $("runRow").hidden = !showRun;
  $("runOutputWrap").hidden = !showRun;
  const titleEl = $("runOutputTitle");
  if (titleEl) {
    titleEl.textContent =
      section === "4"
        ? "Run log — Step 2 (live, same order as terminal)"
        : "Run log — Step 1 (live, same order as terminal)";
  }
  const pre1 = $("runOutputStep1");
  const pre2 = $("runOutputStep2");
  if (pre1 && pre2) {
    pre1.hidden = section !== "2";
    pre2.hidden = section !== "4";
  }
  const hint = $("runOutputHint");
  if (hint) {
    const logForHint = section === "4" ? pre2 : pre1;
    const hasLog = logForHint && (logForHint.textContent || "").trim().length > 0;
    hint.hidden = !showRun || hasLog;
    if (!hint.hidden) {
      hint.textContent =
        section === "4"
          ? 'Click "Run" to execute Step 2 on this PC. Logs stream here (stdout / stderr), same order as in the terminal.'
          : 'Click "Run" to execute on this PC. Logs appear here in real time (stdout / stderr), same order as in the terminal.';
    }
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  $("runStepBtn").disabled = !pathOk;
  $("runHint").style.opacity = pathOk ? "0.65" : "1";

  const adoExportBtn = $("adoExportTagBtn");
  if (adoExportBtn) {
    adoExportBtn.disabled = !pathOk || section !== "2";
  }
}

function setAdoExportProgressState(state) {
  const wrap = $("adoExportTagProgress");
  const okMsg = $("adoExportTagOk");
  if (okMsg) {
    okMsg.hidden = state !== "success";
  }
  if (!wrap) return;
  wrap.classList.remove("is-running", "is-success", "is-error");
  if (state === "running") {
    wrap.hidden = false;
    wrap.classList.add("is-running");
  } else if (state === "success") {
    wrap.hidden = false;
    wrap.classList.add("is-success");
  } else if (state === "error") {
    wrap.hidden = false;
    wrap.classList.add("is-error");
  } else {
    wrap.hidden = true;
  }
}

async function exportAdoTagCsv() {
  const v = vals();
  const tag = ($("adoExportTag").value || "").trim();
  const errEl = $("adoExportTagErr");
  const exportBtn = $("adoExportTagBtn");

  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }

  if (!tag) {
    if (errEl) {
      errEl.textContent = "Azure DevOps tag required";
      errEl.hidden = false;
    }
    return;
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    if (errEl) {
      errEl.textContent = "Set a valid AI Test Agent project path first";
      errEl.hidden = false;
    }
    return;
  }

  setAdoExportProgressState("running");
  if (exportBtn) exportBtn.disabled = true;

  try {
    const res = await fetch(apiUrl("/__da/run-ado-export-tag-csv"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: v.projectPath,
        tag,
        stream: true,
      }),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      const { ok, code, stderrLog } = await readNdjsonStream(res, null);
      if (ok && code === 0) {
        setAdoExportProgressState("success");
        $("toast").textContent = "Test cases added in Test cases folder";
        $("toast").hidden = false;
        setTimeout(() => {
          $("toast").hidden = true;
        }, 2200);
      } else if (code === 2) {
        setAdoExportProgressState("error");
        if (errEl) {
          errEl.textContent = "No test cases found for this tag in Azure DevOps.";
          errEl.hidden = false;
        }
      } else {
        setAdoExportProgressState("error");
        if (errEl) {
          const fromLog = compactToolOutputForUi(stderrLog);
          errEl.textContent =
            fromLog ||
            "Export failed. Check .env in the AI Test Agent folder (ADO_ORG, ADO_PROJECT, ADO_PAT, optional ADO_SERVER_URL) and PAT permissions.";
          errEl.hidden = false;
        }
      }
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      setAdoExportProgressState("error");
      if (errEl) {
        errEl.textContent = data.error || data.detail || res.statusText || "Request failed";
        errEl.hidden = false;
      }
    }
  } catch (e) {
    setAdoExportProgressState("error");
    if (errEl) {
      errEl.textContent = e.message || "Network error";
      errEl.hidden = false;
    }
  }

  render();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    $("toast").textContent = "Copied";
    $("toast").hidden = false;
    setTimeout(() => {
      $("toast").hidden = true;
    }, 1600);
  } catch {
    $("toast").textContent = "Copy failed";
    $("toast").hidden = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Two-phase pick + .json aliases — Cursor often 404s arbitrary paths; OS dialog runs async so /status can poll. */
const PICK_FOLDER_ROUTES = [
  {
    start: "/__da/folder-pick/start",
    status: (jobId) => `/__da/folder-pick/status?jobId=${encodeURIComponent(jobId)}`,
  },
  {
    start: "/web/folder-pick-start.json",
    status: (jobId) => `/web/folder-pick-status.json?jobId=${encodeURIComponent(jobId)}`,
  },
];

async function pickFolder() {
  $("toast").hidden = true;
  let routes = null;
  let startRes = null;
  try {
    for (const r of PICK_FOLDER_ROUTES) {
      try {
        const res = await fetch(apiUrl(r.start), { method: "GET" });
        if (res.ok) {
          routes = r;
          startRes = res;
          break;
        }
      } catch {
        /* try next alias */
      }
    }

    if (!routes || !startRes) {
      const b = $("cursorBrowserBanner");
      if (b) b.hidden = false;
      return;
    }

    const data = await startRes.json();
    const jobId = data.jobId;
    if (!jobId) {
      return;
    }

    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(280);
      let stRes;
      try {
        stRes = await fetch(apiUrl(routes.status(jobId)), { method: "GET" });
      } catch {
        continue;
      }
      let st = {};
      try {
        st = await stRes.json();
      } catch {
        continue;
      }
      if (st.pending) continue;
      if (st.path) {
        $("projectPath").value = st.path;
        render();
        return;
      }
      if (st.cancelled) {
        return;
      }
      if (st.error) {
        return;
      }
      break;
    }
  } catch {
    /* no toast — Browse folder stays quiet */
  }
}

function clearRunOutput(pre) {
  if (!pre) return;
  pre.textContent = "";
  pre.innerHTML = "";
}

function scrollRunOutputToBottom(pre) {
  if (!pre) return;
  pre.scrollTop = pre.scrollHeight;
}

/** Safe append: stderr gets a distinct style (terminal-like). */
function appendRunChunk(pre, stream, text) {
  if (!pre) return;
  if (stream === "stderr") {
    const span = document.createElement("span");
    span.className = "run-chunk-stderr";
    span.textContent = text;
    pre.appendChild(span);
  } else {
    pre.appendChild(document.createTextNode(text));
  }
  scrollRunOutputToBottom(pre);
}

function appendRunStage(pre, label, detail) {
  if (!pre) return;
  const s = document.createElement("span");
  s.className = "run-stage";
  s.textContent = detail ? `${label} — ${detail}` : label;
  pre.appendChild(s);
  pre.appendChild(document.createTextNode("\n"));
  scrollRunOutputToBottom(pre);
}

function compactToolOutputForUi(s) {
  if (!s || typeof s !== "string") return "";
  const t = s
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 480 ? `${t.slice(0, 477)}…` : t;
}

async function readNdjsonStream(res, pre) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastOk = false;
  let lastCode = null;
  let stderrLog = "";
  const STDERR_CAP = 12000;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === "stage") {
        appendRunStage(pre, msg.label || "Stage", msg.detail || "");
      } else if (msg.event === "stdout") {
        appendRunChunk(pre, "stdout", msg.text || "");
      } else if (msg.event === "stderr") {
        const chunk = msg.text || "";
        appendRunChunk(pre, "stderr", chunk);
        stderrLog += chunk;
        if (stderrLog.length > STDERR_CAP) stderrLog = stderrLog.slice(-STDERR_CAP);
      } else if (msg.event === "end") {
        lastOk = !!msg.ok;
        lastCode = typeof msg.code === "number" ? msg.code : lastOk ? 0 : 1;
        if (pre) {
          appendRunChunk(
            pre,
            "stdout",
            `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`
          );
        }
      }
    }
  }
  const code = lastCode !== null ? lastCode : lastOk ? 0 : -1;
  return { ok: lastOk, code, stderrLog: stderrLog.trim() };
}

async function runStep() {
  const v = vals();
  const section = $("mainSection").value;
  const isDay1 = section === "2";
  const isDay2 = section === "4";
  if (!isDay1 && !isDay2) return;

  $("runStepBtn").disabled = true;
  $("runOutputWrap").hidden = false;
  const hint = $("runOutputHint");
  if (hint) hint.hidden = true;
  const logPre = isDay1 ? $("runOutputStep1") : $("runOutputStep2");
  clearRunOutput(logPre);
  appendRunChunk(logPre, "stdout", "Connecting to local API…\n");

  const url = isDay1 ? "/__da/run-day1" : "/__da/run-day2";
  const body = isDay1
    ? {
        projectPath: v.projectPath,
        jiraKey: jiraKeyForApi(),
        relatedKeywords: v.relatedKeywords,
        generateMode: v.generateMode,
        day1Scope: v.day1Scope,
        stream: true,
      }
    : {
        projectPath: v.projectPath,
        jiraKey: jiraKeyForApi(),
        day2Scope: v.day2Scope,
        stream: true,
      };

  try {
    const res = await fetch(apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput(logPre);
      const { ok } = await readNdjsonStream(res, logPre);
      $("toast").textContent = ok ? "Done" : "Finished with errors";
      $("toast").hidden = false;
      setTimeout(() => {
        $("toast").hidden = true;
      }, 2000);
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      clearRunOutput(logPre);
      if (!res.ok) {
        appendRunChunk(logPre, "stdout", `Error: ${data.error || data.detail || res.statusText}\n`);
      } else {
        const parts = [];
        parts.push(`Exit code: ${data.code}`);
        if (data.stdout) parts.push("--- stdout ---\n" + data.stdout);
        if (data.stderr) parts.push("--- stderr ---\n" + data.stderr);
        appendRunChunk(logPre, "stdout", parts.join("\n\n") || "(no output)\n");
        $("toast").textContent = data.ok ? "Done" : "Finished with errors";
        $("toast").hidden = false;
        setTimeout(() => {
          $("toast").hidden = true;
        }, 2000);
      }
    }
  } catch (e) {
    clearRunOutput(logPre);
    appendRunChunk(logPre, "stdout", `Network / server: ${e.message}\n`);
  }

  render();
}

function wire() {
  [
    "mainSection",
    "day1Scope",
    "generateMode",
    "day2Scope",
    "projectPath",
    "jiraKey",
    "relatedKeywords",
  ].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", render);
      el.addEventListener("change", render);
    }
  });

  $("pickProjectBtn").addEventListener("click", pickFolder);
  $("runStepBtn").addEventListener("click", runStep);

  const adoTagInput = $("adoExportTag");
  if (adoTagInput) {
    adoTagInput.addEventListener("input", () => {
      const errEl = $("adoExportTagErr");
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
      setAdoExportProgressState("idle");
    });
  }
  const adoExportBtn = $("adoExportTagBtn");
  if (adoExportBtn) {
    adoExportBtn.addEventListener("click", () => {
      exportAdoTagCsv();
    });
  }

  $("copyBash").addEventListener("click", () => copyText($("bashOut").textContent));
  $("copyPs").addEventListener("click", () => copyText($("psOut").textContent));

  const extBtn = $("openExternalBrowserBtn");
  if (extBtn) {
    extBtn.addEventListener("click", () => {
      window.open(location.href, "_blank", "noopener,noreferrer");
    });
  }

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok && $("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      if ($("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    });

  render();
}

document.addEventListener("DOMContentLoaded", wire);
