/**
 * Update test design flow — UPDATED_CSV_FLOW.md (agent-update-csv.js)
 */

const $ = (id) => document.getElementById(id);

const PATH_PLACEHOLDER = "PATH_TO_DEMO_AGENT";

function apiOrigin() {
  const m = document.querySelector('meta[name="demoagent-api-origin"]');
  const raw = (m && m.getAttribute("content")) || "";
  if (raw && !raw.includes("__DEMOAGENT_API_ORIGIN__")) {
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

/** null = not checked yet; 'found' | 'notfound' after Add */
let csvLookupResult = null;
let csvLookupErrorText = "";

function vals() {
  const rawJira = ($("jiraKey").value || "").trim();
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraKey: rawJira || "PROJ-123",
    generateMode: $("generateMode").value,
    updatedFlowInputFile: ($("updatedFlowInputFile").value || "").trim(),
  };
}

function escPs(s) {
  return String(s).replace(/`/g, "``").replace(/"/g, '`"');
}

function bashSq(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function cdBash(v) {
  return v.projectPath === PATH_PLACEHOLDER ? "cd /path/to/DemoAgent" : `cd ${bashSq(v.projectPath)}`;
}

function cdPs(v) {
  if (v.projectPath === PATH_PLACEHOLDER) return `cd ${PATH_PLACEHOLDER}`;
  const p = String(v.projectPath).replace(/'/g, "''");
  return `cd '${p}'`;
}

function buildUpdateStep1(v) {
  const mode = v.generateMode;
  const file = v.updatedFlowInputFile;
  const fileBash = `UPDATED_FLOW_INPUT_FILE=${bashSq(file || "your-file.csv")} `;
  const filePs = `$env:UPDATED_FLOW_INPUT_FILE="${escPs(file || "your-file.csv")}"\n`;
  return {
    title: "Updated flow — Step 1 (post to Test design)",
    bash: `${cdBash(v)}\nJIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=false ${fileBash}UPDATED_FLOW_MODE=${bashSq(mode)} node agent-update-csv.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="false"\n${filePs}$env:UPDATED_FLOW_MODE="${escPs(mode)}"\nnode agent-update-csv.js`,
    note: "CSV file name is required. Use Add to copy the file from Downloads into the project folder Updated test cases, then Run.",
  };
}

function buildUpdateStep2(v) {
  return {
    title: "Updated flow — Step 2 (approval CSV + optional ADO)",
    bash: `${cdBash(v)}\nJIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=true node agent-update-csv.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="true"\nnode agent-update-csv.js`,
    note: "Same approval rules as Create flow; extra copy may be named with parent summary. See UPDATED_CSV_FLOW.md.",
  };
}

function render() {
  const v = vals();
  const section = $("mainSection").value;

  const block = section === "4" ? buildUpdateStep2(v) : buildUpdateStep1(v);
  $("outTitle").textContent = block.title;
  $("bashOut").textContent = block.bash;
  $("psOut").textContent = block.ps;
  $("extraNote").textContent = block.note || "";
  $("extraNote").hidden = !block.note;

  $("genModeRow").hidden = section === "4";
  $("csvFileRow").hidden = section === "4";

  const okEl = $("csvDownloadsOk");
  const errEl = $("csvDownloadsErr");
  if (okEl && errEl) {
    if (section === "4") {
      okEl.hidden = true;
      errEl.hidden = true;
    } else {
      okEl.hidden = csvLookupResult !== "found";
      errEl.hidden = csvLookupResult !== "notfound";
      if (!errEl.hidden) {
        errEl.textContent = csvLookupErrorText || "Not found";
      }
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
          : 'Click "Run" to execute Step 1 on this PC. Logs stream here (stdout / stderr), same order as in the terminal.';
    }
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  const jiraOk = ($("jiraKey").value || "").trim().length > 0;
  const csvName = ($("updatedFlowInputFile").value || "").trim();
  const csvOk =
    section === "4" || (csvName.length > 0 && csvLookupResult === "found");
  $("runStepBtn").disabled = !pathOk || !jiraOk || !csvOk;
  $("runHint").style.opacity = pathOk ? "0.65" : "1";

}

function resetCsvLookup() {
  csvLookupResult = null;
  csvLookupErrorText = "";
}

async function lookupCsvInDownloads() {
  const name = ($("updatedFlowInputFile").value || "").trim();
  if (!name) {
    csvLookupResult = "notfound";
    csvLookupErrorText = "CSV file name required";
    render();
    return;
  }
  const v = vals();
  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    csvLookupResult = "notfound";
    csvLookupErrorText = "Set a valid DemoAgent project path first";
    render();
    return;
  }
  const btn = $("csvAddBtn");
  if (btn) btn.disabled = true;
  csvLookupResult = null;
  csvLookupErrorText = "";
  render();
  try {
    const res = await fetch(apiUrl("/__da/add-csv-to-updated"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: v.projectPath, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      csvLookupResult = "found";
      csvLookupErrorText = "";
    } else {
      csvLookupResult = "notfound";
      if (res.status === 404) {
        csvLookupErrorText =
          "Not in Downloads — use the same base name as the file (.csv optional). If you use OneDrive, check OneDrive\\Downloads.";
      } else {
        csvLookupErrorText = data.error || "Add failed";
      }
    }
  } catch {
    csvLookupResult = "notfound";
    csvLookupErrorText = "Network or server error";
  }
  if (btn) btn.disabled = false;
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
    /* quiet */
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

async function readNdjsonStream(res, pre) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastOk = false;
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
        appendRunChunk(pre, "stderr", msg.text || "");
      } else if (msg.event === "end") {
        lastOk = !!msg.ok;
        appendRunChunk(pre, "stdout", `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`);
      }
    }
  }
  return lastOk;
}

async function runStep() {
  const v = vals();
  const section = $("mainSection").value;
  const isStep1 = section === "2";
  const isStep2 = section === "4";
  if (!isStep1 && !isStep2) return;

  $("runStepBtn").disabled = true;
  $("runOutputWrap").hidden = false;
  const hint = $("runOutputHint");
  if (hint) hint.hidden = true;
  const logPre = isStep1 ? $("runOutputStep1") : $("runOutputStep2");
  clearRunOutput(logPre);
  appendRunChunk(logPre, "stdout", "Connecting to local API…\n");

  const body = {
    projectPath: v.projectPath,
    jiraKey: ($("jiraKey").value || "").trim(),
    mainSection: section,
    updatedFlowMode: v.generateMode,
    updatedFlowInputFile: v.updatedFlowInputFile,
    stream: true,
  };

  try {
    const res = await fetch(apiUrl("/__da/run-update-csv"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput(logPre);
      const ok = await readNdjsonStream(res, logPre);
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
  ["mainSection", "generateMode", "projectPath", "jiraKey"].forEach((id) => {
    const el = $(id);
    if (el) {
      const onParamChange = () => {
        if (id === "projectPath") resetCsvLookup();
        render();
      };
      el.addEventListener("input", onParamChange);
      el.addEventListener("change", onParamChange);
    }
  });

  const csvInput = $("updatedFlowInputFile");
  if (csvInput) {
    csvInput.addEventListener("input", () => {
      resetCsvLookup();
      render();
    });
    csvInput.addEventListener("change", () => {
      resetCsvLookup();
      render();
    });
  }

  $("pickProjectBtn").addEventListener("click", pickFolder);
  const csvAddBtn = $("csvAddBtn");
  if (csvAddBtn) {
    csvAddBtn.addEventListener("click", () => {
      lookupCsvInDownloads();
    });
  }
  $("runStepBtn").addEventListener("click", runStep);

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
