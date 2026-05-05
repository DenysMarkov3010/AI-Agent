/**
 * Azure DevOps REST client — Test Plans scope (plans, suites, suite test cases).
 * Test Case step text is read via the Work Items API (see ADO_TEST_PLANS.md).
 */
const fetch = globalThis.fetch || require("node-fetch");

const DEFAULT_API_VERSION = process.env.ADO_API_VERSION || "7.1-preview.1";
/** Suite Test Case GET/POST — documented path uses Plans/Suites/TestCase; api-version=7.1 (see Microsoft testplan suite-test-case REST docs). */
const TESTPLAN_SUITE_API_VERSION = process.env.ADO_TESTPLAN_API_VERSION || "7.1";
/**
 * Bulk suite list uses `GET .../test/Plans/{id}/suites` (legacy **Test** API).
 * Microsoft documents **api-version=5.0**; **7.1** often returns 404 — see `_listFlatSuitesInPlanBulk` fallbacks.
 */
const WIT_API_VERSION = process.env.ADO_WIT_API_VERSION || "7.1";

class AdoClient {
  /**
   * @param {string} organization - org name (segment after dev.azure.com)
   * @param {string} project - Azure DevOps project name
   * @param {string} pat - Personal Access Token
   * @param {{ baseUrl?: string, apiVersion?: string }} [options]
   */
  constructor(organization, project, pat, options = {}) {
    if (!organization || !project || !pat) {
      throw new Error("AdoClient: organization, project, and PAT are required");
    }
    this.organization = organization;
    this.project = project;
    this.pat = pat;
    this.apiVersion = options.apiVersion || DEFAULT_API_VERSION;
    this.witApiVersion = options.witApiVersion || WIT_API_VERSION;
    const host =
      (options.baseUrl || process.env.ADO_SERVER_URL || "https://dev.azure.com").replace(/\/$/, "");
    const encProject = encodeURIComponent(project);
    this.apisBase = `${host}/${encodeURIComponent(organization)}/${encProject}/_apis`;
    this.auth = Buffer.from(`:${pat}`).toString("base64");
  }

  async request(absolutePath, options = {}) {
    const url = `${this.apisBase}${absolutePath}`;
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (e) {
      const cause = e && e.cause != null ? ` (${String(e.cause.message || e.cause)})` : "";
      throw new Error(`Azure DevOps fetch failed: ${e.message || e}${cause}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  /**
   * GET with api-version query parameter.
   * @param {string} path - e.g. /testplan/plans
   * @param {Record<string, string|number|undefined>} [query]
   */
  async get(path, query = {}, getOptions = {}) {
    const params = new URLSearchParams();
    params.set("api-version", getOptions.apiVersion ?? this.apiVersion);
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    });
    const q = params.toString();
    const sep = path.includes("?") ? "&" : "?";
    return this.request(`${path}${sep}${q}`, { method: "GET" });
  }

  /** List Test Plans in the project (for planId selection). */
  async listTestPlans() {
    const res = await this.get("/testplan/plans");
    return res.value || res || [];
  }

  /** One Test Plan metadata (includes rootSuite). */
  async getTestPlan(planId) {
    return this.get(`/testplan/plans/${planId}`);
  }

  /**
   * Build "Root / Folder / Suite" from bulk API rows (each row may include `parent` id).
   * @param {object} suite
   * @param {Map<number, object>} idMap
   */
  _suitePathFromBulkRow(suite, idMap) {
    const parts = [];
    let cur = suite;
    const guard = new Set();
    while (cur && cur.id != null) {
      if (guard.has(cur.id)) break;
      guard.add(cur.id);
      parts.unshift(cur.name || `Suite-${cur.id}`);
      const pid = cur.parent != null && cur.parent.id != null ? cur.parent.id : null;
      cur = pid != null ? idMap.get(pid) : null;
    }
    return parts.join(" / ");
  }

  /**
   * All suites in one plan via **Test** REST API (`GET .../test/Plans/{id}/suites`).
   * Default **api-version=5.0** (documented for this route; 7.x often 404 on dev.azure.com).
   * Override with `ADO_TEST_PLAN_BULK_API_VERSION` — only that version is used (no automatic retries).
   * @param {number} planId
   * @param {string} apiVersion
   */
  async _listFlatSuitesInPlanBulkWithApiVersion(planId, apiVersion) {
    const merged = [];
    let skip = 0;
    const pageSize = 500;
    for (;;) {
      const res = await this.get(
        `/test/Plans/${planId}/suites`,
        { $skip: skip, $top: pageSize },
        { apiVersion }
      );
      const batch = res.value || [];
      merged.push(...batch);
      if (batch.length < pageSize) break;
      skip += pageSize;
    }
    const idMap = new Map(merged.map((s) => [s.id, s]));
    return merged.map((s) => ({
      suiteId: s.id,
      suiteName: s.name || `Suite-${s.id}`,
      path: this._suitePathFromBulkRow(s, idMap),
    }));
  }

  async _listFlatSuitesInPlanBulk(planId) {
    const envVer = (process.env.ADO_TEST_PLAN_BULK_API_VERSION || "").trim();
    const apiVersion = envVer || "5.0";
    return this._listFlatSuitesInPlanBulkWithApiVersion(planId, apiVersion);
  }

  /**
   * Fallback: walk the suite tree via Test Plan API (`parentSuiteId` per level).
   * @param {number} planId
   */
  async _listFlatSuitesInPlanTreeWalk(planId) {
    const plan = await this.getTestPlan(planId);
    const rootSuite = plan.rootSuite;
    if (!rootSuite || rootSuite.id == null) {
      throw new Error("Test plan response has no rootSuite.id");
    }
    /** @type {Array<{ suiteId: number, suiteName: string, path: string }>} */
    const flat = [];

    let frontier = [{ suiteObj: rootSuite, parentPathSegments: /** @type {string[]} */ ([]) }];
    const treeConcurrency = Math.max(
      1,
      Math.min(32, parseInt(process.env.ADO_SYNC_SUITE_TREE_CONCURRENCY || "4", 10) || 4)
    );

    while (frontier.length) {
      const nextFrontier = [];
      for (let i = 0; i < frontier.length; i += treeConcurrency) {
        const chunk = frontier.slice(i, i + treeConcurrency);
        const wave = await Promise.all(
          chunk.map(async ({ suiteObj, parentPathSegments }) => {
            const suiteId = suiteObj.id;
            const name = suiteObj.name || `Suite-${suiteId}`;
            const pathStr = [...parentPathSegments, name].join(" / ");
            const entry = { suiteId, suiteName: name, path: pathStr };
            const children = await this.listChildSuites(planId, suiteId);
            const nextSegments = [...parentPathSegments, name];
            return { entry, children, nextSegments };
          })
        );
        for (const w of wave) {
          flat.push(w.entry);
          for (const child of w.children) {
            nextFrontier.push({ suiteObj: child, parentPathSegments: w.nextSegments });
          }
        }
      }
      frontier = nextFrontier;
    }

    return flat;
  }

  /**
   * All suites in a Test Plan (flat), with hierarchical path — same shape as `ado-plan-tools` export, without test case counts.
   * Prefers **one bulk** `GET .../test/Plans/{id}/suites?api-version=5.0` (filter by Jira key client-side); falls back to tree walk if bulk fails.
   * Set `ADO_SYNC_SUITE_USE_TREE_WALK=true` to force the slow tree API.
   * @param {number} planId
   * @returns {Promise<Array<{ suiteId: number, suiteName: string, path: string }>>}
   */
  async listFlatSuitesInPlan(planId) {
    if (process.env.ADO_SYNC_SUITE_USE_TREE_WALK === "true") {
      return this._listFlatSuitesInPlanTreeWalk(planId);
    }
    try {
      return await this._listFlatSuitesInPlanBulk(planId);
    } catch (e) {
      console.warn(
        `   ⚠️  Azure DevOps: bulk suite list (GET .../test/Plans/.../suites, api-version=${(process.env.ADO_TEST_PLAN_BULK_API_VERSION || "").trim() || "5.0"}) failed: ${e.message}. Falling back to tree walk.`
      );
      return this._listFlatSuitesInPlanTreeWalk(planId);
    }
  }

  /**
   * Child suites under a parent suite (start from the plan’s rootSuite).
   * @param {number} planId
   * @param {number} parentSuiteId
   */
  async listChildSuites(planId, parentSuiteId) {
    const res = await this.get(`/testplan/plans/${planId}/suites`, {
      parentSuiteId,
    });
    return res.value || [];
  }

  /**
   * Test case entries in a suite (references to work items).
   * @param {number} planId
   * @param {number} suiteId
   */
  async listTestCasesInSuite(planId, suiteId) {
    const path = `/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`;
    const res = await this.get(path, {}, { apiVersion: TESTPLAN_SUITE_API_VERSION });
    return res.value || [];
  }

  /**
   * Run a WIQL query (filter Test Cases by tags, area path, etc.). Results reference work items in Azure DevOps only — no export required.
   * Uses explicit $top and follows x-ms-continuationtoken until exhausted so large result sets are not truncated.
   * @param {string} wiql - e.g. SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'smoke'
   * @param {{ $top?: number }} [options]
   * @returns {Promise<object>} API response (merged workItems[] with id/url; other fields from last page)
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql
   */
  async runWiql(wiql, options = {}) {
    const $top = options.$top ?? 20000;
    const allWorkItems = [];
    let continuationToken = null;
    /** @type {object | null} */
    let lastJson = null;
    let pages = 0;
    const maxPages = 500;

    do {
      pages += 1;
      if (pages > maxPages) {
        throw new Error(`Azure DevOps WIQL: pagination exceeded ${maxPages} pages; refine your query`);
      }
      const params = new URLSearchParams();
      params.set("api-version", this.witApiVersion);
      params.set("$top", String($top));
      if (continuationToken) {
        params.set("continuationToken", continuationToken);
      }
      const url = `${this.apisBase}/wit/wiql?${params.toString()}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: wiql }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure DevOps WIQL error: ${response.status} ${response.statusText}. ${errorText}`);
      }
      const data = await response.json();
      lastJson = data;
      const batch = data.workItems || [];
      allWorkItems.push(...batch);
      continuationToken = response.headers.get("x-ms-continuationtoken");
    } while (continuationToken);

    const seen = new Set();
    const merged = [];
    for (const w of allWorkItems) {
      if (!w || w.id == null || seen.has(w.id)) continue;
      seen.add(w.id);
      merged.push(w);
    }
    return { ...lastJson, workItems: merged };
  }

  /**
   * Work item details via batch POST (avoids GET URL length limits with many ids/fields).
   * @param {number[]} ids
   * @param {string[]} [fields] - optional field list
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch
   */
  async getWorkItemsBatch(ids, fields) {
    if (!ids.length) return [];
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const url = `${this.apisBase}/wit/workitemsbatch?${params.toString()}`;
    const body = { ids };
    if (fields && fields.length) {
      body.fields = fields;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps WIT batch error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    const data = await response.json();
    return data.value || [];
  }

  /**
   * Work item details (Test Case — title, steps). Uses WIT batch API in chunks of 200.
   * @param {number[]} ids
   * @param {string[]} [fields] - optional field list
   */
  async getWorkItemsByIds(ids, fields) {
    if (!ids.length) return [];
    const chunkSize = 200;
    const out = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const part = ids.slice(i, i + chunkSize);
      const batch = await this.getWorkItemsBatch(part, fields);
      out.push(...batch);
    }
    return out;
  }

  /**
   * Create a work item (e.g. Test Case) via JSON Patch.
   * @param {string} workItemTypeName - e.g. "Test Case"
   * @param {Array<{ op: string, path: string, value?: unknown }>} patchDocument
   */
  async createWorkItem(workItemTypeName, patchDocument) {
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const typeSeg = encodeURIComponent(workItemTypeName);
    const url = `${this.apisBase}/wit/workitems/$${typeSeg}?${params.toString()}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(patchDocument),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps create work item error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    return response.json();
  }

  /**
   * Update fields of an existing work item (e.g. patch System.Description after creation).
   * @param {number} id
   * @param {Array<{ op: string, path: string, value?: unknown }>} patchDocument
   */
  async updateWorkItem(id, patchDocument) {
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const url = `${this.apisBase}/wit/workitems/${encodeURIComponent(id)}?${params.toString()}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(patchDocument),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps update work item error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    return response.json();
  }

  /**
   * Add existing Test Case work items to a suite in a Test Plan.
   * @param {number} planId
   * @param {number} suiteId
   * @param {number[]} workItemIds
   */
  async addTestCasesToSuite(planId, suiteId, workItemIds) {
    if (!workItemIds.length) return null;
    const params = new URLSearchParams();
    params.set("api-version", TESTPLAN_SUITE_API_VERSION);
    const path = `/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`;
    const url = `${this.apisBase}${path}?${params.toString()}`;
    const body = workItemIds.map((id) => ({ workItem: { id } }));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps add test cases to suite error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    if (response.status === 204) return null;
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) return response.json();
    return null;
  }
}

module.exports = { AdoClient };
