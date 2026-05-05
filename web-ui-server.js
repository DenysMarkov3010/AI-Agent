#!/usr/bin/env node
/**
 * Serves ./web + API: native folder picker (same class of UI as system "Open Folder"),
 * Day 1 run (spawn agent). Binds 0.0.0.0 for localhost/Cursor compatibility.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync, execFile } = require("child_process");
const { wantsRawMarkdown, buildGuideHtml } = require("./markdown-preview.js");

const WEB_ROOT = path.join(__dirname, "web");
/** PNG: ai-agent.ico is multi‑MB; browsers often ignore huge favicons and show the default globe. */
const FAVICON_PNG_PATH = path.join(__dirname, "assets", "ai-agent.png");
const PORT = Number(process.env.WEB_UI_PORT || 3847);
const INDEX_PLACEHOLDER = "__DEMOAGENT_API_ORIGIN__";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * Normalizes request path. Cursor / some embedded browsers send absolute-form targets:
 *   GET http://127.0.0.1:3847/api/pick-folder HTTP/1.1
 * so req.url is the full URL, not "/api/pick-folder". Plain path.posix.normalize() breaks that.
 */
function getPathname(req) {
  let raw = String(req.url || "/").split("?")[0].split("#")[0].trim();

  if (!raw.startsWith("/")) {
    try {
      if (/^https?:\/\//i.test(raw)) {
        raw = new URL(raw).pathname || "/";
      } else {
        const host = req.headers.host || `127.0.0.1:${PORT}`;
        raw = new URL(raw, `http://${host}`).pathname || "/";
      }
    } catch {
      raw = "/";
    }
  }

  let n = path.posix.normalize(raw).replace(/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n || "/";
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(root, normalized);
  if (!full.startsWith(root)) return null;
  return full;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

/** Windows: create Desktop «AI Test Agent» shortcut if missing (same as npm run shortcut). */
function maybeEnsureWindowsDesktopShortcut() {
  if (process.platform !== "win32") return;
  const ensureScript = path.join(__dirname, "scripts", "ensure-desktop-shortcut.ps1");
  if (!fs.existsSync(ensureScript)) return;
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const ps = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFile(
    ps,
    ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", ensureScript],
    { cwd: __dirname, windowsHide: true, timeout: 120000 },
    (err, stdout, stderr) => {
      if (err) {
        console.warn("DemoAgent: optional desktop shortcut step failed:", err.message || String(err));
        if (stderr) process.stderr.write(String(stderr));
        return;
      }
      const out = String(stdout || "").trim();
      if (out) console.log(out);
    }
  );
}

/** macOS: system folder sheet (same family of UI as Finder / Open Folder). */
function pickFolderDarwin() {
  const script = [
    "try",
    "\tset theFolder to choose folder with prompt \"Select the DemoAgent project folder:\"",
    "\treturn POSIX path of theFolder",
    "on error number -128",
    "\treturn \"\"",
    "end try",
    "",
  ].join("\n");

  const r = spawnSync("osascript", ["-"], {
    input: script,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
  });

  const p = (r.stdout || "").trim();
  if (!p) return null;
  const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
  return fs.existsSync(normalized) && fs.statSync(normalized).isDirectory() ? normalized : null;
}

function pickFolderWindows() {
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Select the DemoAgent project folder'",
    "$d.ShowNewFolderButton = $false",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
  ].join("; ");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-STA", "-Command", psScript], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    });
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    const p = lines[lines.length - 1];
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function pickFolderLinux() {
  try {
    const out = execFileSync(
      "zenity",
      ["--file-selection", "--directory", "--title=Select DemoAgent folder", "--modal"],
      { encoding: "utf8", timeout: 120000 }
    );
    const p = out.trim();
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    /* try KDE */
  }
  try {
    const out = execFileSync("kdialog", ["--getexistingdirectory", "."], {
      encoding: "utf8",
      timeout: 120000,
    });
    const p = out.trim();
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function pickFolderDialog() {
  if (process.platform === "win32") return pickFolderWindows();
  if (process.platform === "darwin") return pickFolderDarwin();
  if (process.platform === "linux") return pickFolderLinux();
  return pickFolderLinux();
}

/** Non-blocking folder dialog so the HTTP server can answer /status polls while the OS sheet is open. */
function pickFolderDarwinAsync() {
  return new Promise((resolve) => {
    const script = [
      "try",
      "\tset theFolder to choose folder with prompt \"Select the DemoAgent project folder:\"",
      "\treturn POSIX path of theFolder",
      "on error number -128",
      "\treturn \"\"",
      "end try",
      "",
    ].join("\n");
    const child = spawn("osascript", ["-"], { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(t);
      const p = out.trim();
      if (!p) return resolve(null);
      const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
      resolve(fs.existsSync(normalized) && fs.statSync(normalized).isDirectory() ? normalized : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function pickFolderWindowsAsync() {
  return new Promise((resolve) => {
    const psScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = 'Select the DemoAgent project folder'",
      "$d.ShowNewFolderButton = $false",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", psScript], { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(t);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const p = lines[lines.length - 1];
      resolve(p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

function pickFolderLinuxAsync() {
  return new Promise((resolve) => {
    execFile(
      "zenity",
      ["--file-selection", "--directory", "--title=Select DemoAgent folder", "--modal"],
      { encoding: "utf8", timeout: 120000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          const p = stdout.trim();
          if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return resolve(p);
        }
        execFile("kdialog", ["--getexistingdirectory", "."], { encoding: "utf8", timeout: 120000 }, (e2, out2) => {
          if (e2 || !out2) return resolve(null);
          const p2 = out2.trim();
          resolve(p2 && fs.existsSync(p2) && fs.statSync(p2).isDirectory() ? p2 : null);
        });
      }
    );
  });
}

function pickFolderDialogAsync() {
  if (process.platform === "win32") return pickFolderWindowsAsync();
  if (process.platform === "darwin") return pickFolderDarwinAsync();
  return pickFolderLinuxAsync();
}

/** Merge DemoAgent root `.env` into env for spawned tools (ADO/Jira keys may only exist there). */
function envWithProjectDotenv(abs) {
  const env = { ...process.env };
  const envFile = path.join(abs, ".env");
  if (fs.existsSync(envFile)) {
    try {
      require("dotenv").config({ path: envFile, processEnv: env });
    } catch {
      /* ignore parse errors; child script may still load */
    }
  }
  return env;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 2_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function runSpawn(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cap = 600_000;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > cap) stderr = stderr.slice(-cap);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
  });
}

/**
 * Stream child output as it arrives (terminal-like). `onEvent` receives NDJSON-serializable objects.
 */
function runSpawnStreaming(command, args, options, onEvent) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cap = 600_000;
    const push = (ev) => {
      try {
        onEvent(ev);
      } catch (_) {
        /* client disconnected */
      }
    };
    child.stdout?.on("data", (d) => {
      const t = d.toString();
      stdout += t;
      if (stdout.length > cap) stdout = stdout.slice(-cap);
      push({ event: "stdout", text: t });
    });
    child.stderr?.on("data", (d) => {
      const t = d.toString();
      stderr += t;
      if (stderr.length > cap) stderr = stderr.slice(-cap);
      push({ event: "stderr", text: t });
    });
    child.on("close", (code) => {
      const c = code ?? 0;
      push({ event: "end", code: c, ok: c === 0 });
      resolve({ code: c, stdout, stderr });
    });
    child.on("error", (err) => {
      const msg = `${err && err.message ? err.message : err}\n`;
      stderr += msg;
      push({ event: "stderr", text: msg });
      push({ event: "end", code: -1, ok: false });
      resolve({ code: -1, stdout, stderr });
    });
  });
}

function validateProjectDir(abs) {
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: "Project path is not a directory" };
  }
  const agentJs = path.join(abs, "agent-docs.js");
  if (!fs.existsSync(agentJs)) {
    return { ok: false, error: "Folder must contain agent-docs.js (DemoAgent root)" };
  }
  return { ok: true };
}

function validateUpdateProjectDir(abs) {
  const base = validateProjectDir(abs);
  if (!base.ok) return base;
  const updateJs = path.join(abs, "agent-update-csv.js");
  if (!fs.existsSync(updateJs)) {
    return { ok: false, error: "Folder must contain agent-update-csv.js (updated CSV flow)" };
  }
  return { ok: true };
}

function validateAdoExportTagProject(abs) {
  const base = validateProjectDir(abs);
  if (!base.ok) return base;
  const script = path.join(abs, "ado-export-tag-csv.js");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "Folder must contain ado-export-tag-csv.js" };
  }
  return { ok: true };
}

function sanitizeAdoExportTag(raw) {
  const tag = String(raw || "").trim();
  if (!tag) return { ok: false, error: "Tag is required" };
  if (tag.length > 500) return { ok: false, error: "Tag is too long" };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(tag)) return { ok: false, error: "Invalid characters in tag" };
  return { ok: true, tag };
}

/** Single file name only (no path traversal) for Downloads lookup. */
function safeDownloadsFileName(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "File name is required" };
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.includes("/") || normalized.includes("..")) {
    return { ok: false, error: "Use a file name only, not a path" };
  }
  const base = path.basename(normalized);
  if (!base || base === "." || base === ".." || /[\x00-\x1f]/.test(base)) {
    return { ok: false, error: "Invalid file name" };
  }
  return { ok: true, base };
}

/** Same idea as copy-csv-from-downloads.js — env override + default + OneDrive Downloads on Windows. */
function getDownloadsLookupDirs() {
  const out = [];
  const seen = new Set();
  const push = (d) => {
    if (!d) return;
    const r = path.resolve(d);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  if (process.env.DOWNLOADS_DIR) push(process.env.DOWNLOADS_DIR);
  push(path.join(os.homedir(), "Downloads"));
  if (process.platform === "win32") {
    push(path.join(os.homedir(), "OneDrive", "Downloads"));
  }
  return out;
}

/**
 * Exact basename match in Downloads (any candidate dir). If missing .csv, tries name + ".csv".
 * @returns {{ found: boolean, fileName: string, sourcePath: string | null }}
 */
function locateCsvInDownloads(base) {
  const candidates = [base];
  if (!/\.csv$/i.test(base)) candidates.push(`${base}.csv`);
  for (const dir of getDownloadsLookupDirs()) {
    if (!fs.existsSync(dir)) continue;
    const resolvedDir = path.resolve(dir);
    for (const name of candidates) {
      const fullPath = path.resolve(path.join(dir, name));
      const rel = path.relative(resolvedDir, fullPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return { found: true, fileName: name, sourcePath: fullPath };
        }
      } catch {
        /* next */
      }
    }
  }
  return { found: false, fileName: base, sourcePath: null };
}

/** Two-phase folder pick: fast HTTP response (embedded browsers time out if the OS dialog blocks the request). */
const folderPickJobs = new Map();
const FOLDER_JOB_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of folderPickJobs) {
    if (now - j.at > FOLDER_JOB_TTL_MS) folderPickJobs.delete(id);
  }
}, 60_000);

function requestUrl(req) {
  const raw = req.url || "/";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return new URL(raw);
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return new URL(raw, `http://${host}`);
  } catch {
    return new URL(`http://127.0.0.1:${PORT}/`);
  }
}

const FOLDER_PICK_START_PATHS = new Set([
  "/__da/folder-pick/start",
  "/web/folder-pick-start.json",
]);
const FOLDER_PICK_STATUS_PATHS = new Set([
  "/__da/folder-pick/status",
  "/web/folder-pick-status.json",
]);

const PICK_FOLDER_SYNC_PATHS = new Set(["/__da/pick-folder", "/api/pick-folder"]);
const RUN_DAY1_PATHS = new Set(["/__da/run-day1", "/api/run-day1"]);
const RUN_DAY2_PATHS = new Set(["/__da/run-day2", "/api/run-day2"]);
const RUN_UPDATE_CSV_PATHS = new Set(["/__da/run-update-csv", "/api/run-update-csv"]);
const RUN_ADO_EXPORT_TAG_PATHS = new Set(["/__da/run-ado-export-tag-csv", "/api/run-ado-export-tag-csv"]);
const DOWNLOADS_LOOKUP_PATHS = new Set(["/__da/downloads-lookup", "/api/downloads-lookup"]);
const ADD_CSV_TO_UPDATED_PATHS = new Set(["/__da/add-csv-to-updated", "/api/add-csv-to-updated"]);

async function handleApi(req, res) {
  const pathname = getPathname(req);
  const method = String(req.method || "GET").toUpperCase().trim();

  if (
    method === "OPTIONS" &&
    (pathname.startsWith("/__da/") ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/web/folder-pick") ||
      pathname.startsWith("/web/folder-pick-"))
  ) {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (method === "GET" && pathname === "/__da/health") {
    return json(res, 200, { ok: true, demoagent: "web-ui", pid: process.pid });
  }

  if (method === "GET" && DOWNLOADS_LOOKUP_PATHS.has(pathname)) {
    const q = requestUrl(req).searchParams.get("name") || "";
    const parsed = safeDownloadsFileName(q);
    if (!parsed.ok) {
      return json(res, 400, { found: false, error: parsed.error });
    }
    const r = locateCsvInDownloads(parsed.base);
    return json(res, 200, { found: r.found, fileName: r.fileName });
  }

  if (method === "POST" && ADD_CSV_TO_UPDATED_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const projectPath = String(body.projectPath || "").trim();
    const rawName = String(body.name || "").trim();
    const parsed = safeDownloadsFileName(rawName);
    if (!parsed.ok) {
      return json(res, 400, { ok: false, error: parsed.error });
    }
    const abs = path.resolve(projectPath);
    const v = validateUpdateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }
    const located = locateCsvInDownloads(parsed.base);
    if (!located.found || !located.sourcePath) {
      return json(res, 404, { ok: false, error: "CSV not found in Downloads" });
    }
    const destDir = path.join(abs, "Updated test cases");
    const destPath = path.join(destDir, located.fileName);
    const resolvedDest = path.resolve(destPath);
    const resolvedDir = path.resolve(destDir);
    const relOut = path.relative(resolvedDir, resolvedDest);
    if (relOut.startsWith("..") || path.isAbsolute(relOut)) {
      return json(res, 400, { ok: false, error: "Invalid destination path" });
    }
    try {
      fs.mkdirSync(resolvedDir, { recursive: true });
      fs.copyFileSync(located.sourcePath, resolvedDest);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return json(res, 500, { ok: false, error: `Copy failed: ${msg}` });
    }
    return json(res, 200, { ok: true, fileName: located.fileName });
  }

  if (method === "GET" && FOLDER_PICK_START_PATHS.has(pathname)) {
    const jobId = crypto.randomUUID();
    folderPickJobs.set(jobId, { status: "pending", at: Date.now() });
    const sent = json(res, 200, { jobId, mode: "two-phase" });
    setImmediate(() => {
      pickFolderDialogAsync()
        .then((picked) => {
          const j = folderPickJobs.get(jobId);
          if (!j) return;
          if (picked) {
            j.status = "done";
            j.path = picked;
          } else {
            j.status = "cancelled";
          }
        })
        .catch((e) => {
          const j = folderPickJobs.get(jobId);
          if (j) {
            j.status = "error";
            j.error = String(e && e.message ? e.message : e);
          }
        });
    });
    return sent;
  }

  if (method === "GET" && FOLDER_PICK_STATUS_PATHS.has(pathname)) {
    const jobId = requestUrl(req).searchParams.get("jobId");
    if (!jobId) return json(res, 400, { error: "missing jobId" });
    const j = folderPickJobs.get(jobId);
    if (!j) return json(res, 404, { error: "unknown or expired jobId" });
    if (j.status === "pending") return json(res, 200, { pending: true });

    if (j.status === "done") {
      const pathVal = j.path;
      folderPickJobs.delete(jobId);
      return json(res, 200, { pending: false, path: pathVal });
    }
    if (j.status === "cancelled") {
      folderPickJobs.delete(jobId);
      return json(res, 200, { pending: false, cancelled: true });
    }
    const err = j.error || "error";
    folderPickJobs.delete(jobId);
    return json(res, 200, { pending: false, error: err });
  }

  if ((method === "GET" || method === "POST") && PICK_FOLDER_SYNC_PATHS.has(pathname)) {
    try {
      const picked = pickFolderDialog();
      if (picked) return json(res, 200, { path: picked });
      return json(res, 200, { cancelled: true });
    } catch (err) {
      return json(res, 500, { error: "pick-folder failed", detail: String(err && err.message ? err.message : err) });
    }
  }

  if (method === "POST" && RUN_DAY1_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const jiraKey = String(body.jiraKey || "").trim();
    const relatedKeywords = String(body.relatedKeywords || "").trim();
    const generateMode = String(body.generateMode || "checklist");
    const day1Scope = String(body.day1Scope || "2a");
    const relatedJiraSearch = String(body.relatedJiraSearch || "yes");
    const testCasesLimitRaw = String(body.testCasesLimit || "").trim().toLowerCase();
    const wantStream = body.stream === true || body.stream === "true";

    if (day1Scope !== "2b" && !jiraKey) {
      return json(res, 400, { ok: false, error: "JIRA_ISSUE_KEY is required" });
    }

    const abs = path.resolve(projectPath);
    const v = validateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const env = { ...process.env, CHECK_APPROVAL: "false" };
    if (jiraKey) env.JIRA_ISSUE_KEY = jiraKey;
    if (generateMode === "testcases") env.GENERATE_MODE = "testcases";
    if (relatedKeywords) env.RELATED_ISSUES_KEYWORDS = relatedKeywords;
    if (relatedJiraSearch === "no") env.ENABLE_RELATED_ISSUES_SEARCH = "false";
    if (generateMode === "testcases" && testCasesLimitRaw) {
      const allowed = new Set(["10", "20", "30", "unlimited"]);
      if (allowed.has(testCasesLimitRaw)) {
        env.TEST_CASES_LIMIT = testCasesLimitRaw;
      }
    }

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        if (day1Scope === "2b") {
          const npm = process.platform === "win32" ? "npm.cmd" : "npm";
          line({ event: "stage", label: "Process", detail: "npm run batch (CHECK_APPROVAL=false)" });
          await runSpawnStreaming(npm, ["run", "batch"], opts, line);
        } else {
          line({
            event: "stage",
            label: "Process",
            detail: `node agent-docs.js (JIRA_ISSUE_KEY=${jiraKey}${generateMode === "testcases" ? ", GENERATE_MODE=testcases" : ""})`,
          });
          await runSpawnStreaming(process.execPath, ["agent-docs.js"], opts, line);
        }
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    if (day1Scope === "2b") {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = await runSpawn(npm, ["run", "batch"], opts);
      return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
    }

    const result = await runSpawn(process.execPath, ["agent-docs.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && RUN_DAY2_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const jiraKey = String(body.jiraKey || "").trim();
    const day2Scope = String(body.day2Scope || "4a");
    const wantStream = body.stream === true || body.stream === "true";

    if (day2Scope !== "4b" && !jiraKey) {
      return json(res, 400, { ok: false, error: "JIRA_ISSUE_KEY is required" });
    }

    const abs = path.resolve(projectPath);
    const v = validateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const env = { ...process.env, CHECK_APPROVAL: "true" };
    if (jiraKey) env.JIRA_ISSUE_KEY = jiraKey;

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        if (day2Scope === "4b") {
          const npm = process.platform === "win32" ? "npm.cmd" : "npm";
          line({ event: "stage", label: "Process", detail: "npm run batch (CHECK_APPROVAL=true)" });
          await runSpawnStreaming(npm, ["run", "batch"], opts, line);
        } else {
          line({
            event: "stage",
            label: "Process",
            detail: `node agent-docs.js (CHECK_APPROVAL=true, JIRA_ISSUE_KEY=${jiraKey})`,
          });
          await runSpawnStreaming(process.execPath, ["agent-docs.js"], opts, line);
        }
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    if (day2Scope === "4b") {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = await runSpawn(npm, ["run", "batch"], opts);
      return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
    }

    const result = await runSpawn(process.execPath, ["agent-docs.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && RUN_UPDATE_CSV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const jiraKey = String(body.jiraKey || "").trim();
    const mainSection = String(body.mainSection || "2");
    const wantStream = body.stream === true || body.stream === "true";
    let updatedFlowMode = String(body.updatedFlowMode || "auto").toLowerCase().trim();
    const updatedFlowInputFile = String(body.updatedFlowInputFile || "").trim();

    if (!jiraKey) {
      return json(res, 400, { ok: false, error: "JIRA_ISSUE_KEY is required" });
    }
    if (mainSection !== "2" && mainSection !== "4") {
      return json(res, 400, { ok: false, error: "mainSection must be 2 or 4" });
    }

    const checkApproval = mainSection === "4";
    if (!["auto", "checklist", "testcases"].includes(updatedFlowMode)) {
      updatedFlowMode = "auto";
    }

    if (!checkApproval && !updatedFlowInputFile) {
      return json(res, 400, { ok: false, error: "CSV file name is required for this step" });
    }

    const abs = path.resolve(projectPath);
    const v = validateUpdateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const env = {
      ...process.env,
      JIRA_ISSUE_KEY: jiraKey,
      CHECK_APPROVAL: checkApproval ? "true" : "false",
    };
    if (!checkApproval) {
      env.UPDATED_FLOW_MODE = updatedFlowMode;
      env.UPDATED_FLOW_INPUT_FILE = updatedFlowInputFile;
    }

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        const detail = checkApproval
          ? "node agent-update-csv.js (CHECK_APPROVAL=true)"
          : `node agent-update-csv.js (CHECK_APPROVAL=false, UPDATED_FLOW_MODE=${updatedFlowMode})`;
        line({ event: "stage", label: "Process", detail });
        await runSpawnStreaming(process.execPath, ["agent-update-csv.js"], opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    const result = await runSpawn(process.execPath, ["agent-update-csv.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && RUN_ADO_EXPORT_TAG_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const wantStream = body.stream === true || body.stream === "true";
    const tagParsed = sanitizeAdoExportTag(body.tag);
    if (!tagParsed.ok) {
      return json(res, 400, { ok: false, error: tagParsed.error });
    }

    const abs = path.resolve(projectPath);
    const v = validateAdoExportTagProject(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const opts = { cwd: abs, env: envWithProjectDotenv(abs) };
    const args = ["ado-export-tag-csv.js", "--tag", tagParsed.tag, "--fail-on-empty"];

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        line({
          event: "stage",
          label: "Export",
          detail: `ado-export-tag-csv.js --tag ${JSON.stringify(tagParsed.tag)} --fail-on-empty`,
        });
        await runSpawnStreaming(process.execPath, args, opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    const result = await runSpawn(process.execPath, args, opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  return false;
}

const FULL_FLOW_GUIDE_PATH = path.join(__dirname, "FULL_FLOW_GUIDE.md");
const UPDATED_CSV_FLOW_PATH = path.join(__dirname, "UPDATED_CSV_FLOW.md");
const ADO_TEST_PLANS_PATH = path.join(__dirname, "ADO_TEST_PLANS.md");

/** Guide lives in repo root; web UI is under ./web — serve so footer link works. Default: HTML preview (like editor Markdown preview); `?raw=1` or Accept: text/markdown → source. */
function sendMarkdownGuide(req, res, absPath, pageTitle) {
  fs.readFile(absPath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    const md = data.toString("utf8");
    if (wantsRawMarkdown(req)) {
      const body = req.method === "HEAD" ? undefined : md;
      res.writeHead(200, { "Content-Type": MIME[".md"], "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    const html = buildGuideHtml(pageTitle, md);
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": buf.length,
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

function sendFaviconPng(req, res) {
  if (req.method === "HEAD") {
    fs.stat(FAVICON_PNG_PATH, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=86400",
      });
      res.end();
    });
    return;
  }
  fs.readFile(FAVICON_PNG_PATH, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(data);
  });
}

function sendIndexHtml(req, res) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const origin = `http://${host}`;
  const indexPath = path.join(WEB_ROOT, "index.html");
  fs.readFile(indexPath, "utf8", (err, html) => {
    if (err) {
      res.writeHead(500);
      res.end("Server error");
      return;
    }
    if (html.includes(INDEX_PLACEHOLDER)) {
      html = html.split(INDEX_PLACEHOLDER).join(origin);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : html);
  });
}

function serveStatic(req, res) {
  const pathname = getPathname(req);
  let rel = pathname === "/" ? "/index.html" : pathname;
  let filePath = safeJoin(WEB_ROOT, rel);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const ext = path.extname(filePath);
  if (ext === ".html") {
    fs.readFile(filePath, "utf8", (err, html) => {
      if (err) {
        if (err.code === "ENOENT") {
          res.writeHead(404);
          res.end("Not found");
        } else {
          res.writeHead(500);
          res.end("Server error");
        }
        return;
      }
      if (html.includes(INDEX_PLACEHOLDER)) {
        const host = req.headers.host || `127.0.0.1:${PORT}`;
        html = html.split(INDEX_PLACEHOLDER).join(`http://${host}`);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : html);
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = getPathname(req);

  const handled = await handleApi(req, res);
  if (handled) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    sendIndexHtml(req, res);
    return;
  }

  if (pathname === "/favicon.png") {
    sendFaviconPng(req, res);
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(302, { Location: "/favicon.png", "Cache-Control": "no-cache" });
    res.end();
    return;
  }

  if (pathname === "/FULL_FLOW_GUIDE.md") {
    sendMarkdownGuide(req, res, FULL_FLOW_GUIDE_PATH, "FULL_FLOW_GUIDE.md");
    return;
  }

  if (pathname === "/UPDATED_CSV_FLOW.md") {
    sendMarkdownGuide(req, res, UPDATED_CSV_FLOW_PATH, "UPDATED_CSV_FLOW.md");
    return;
  }

  if (pathname === "/ADO_TEST_PLANS.md") {
    sendMarkdownGuide(req, res, ADO_TEST_PLANS_PATH, "ADO_TEST_PLANS.md");
    return;
  }

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/__da/") ||
    pathname.startsWith("/web/folder-pick")
  ) {
    return json(res, 404, { error: "Unknown API route", path: pathname });
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DemoAgent web UI → http://127.0.0.1:${PORT}/`);
  console.log(`Listening on 0.0.0.0:${PORT} (local network). Press Ctrl+C to stop.`);
  maybeEnsureWindowsDesktopShortcut();
});
