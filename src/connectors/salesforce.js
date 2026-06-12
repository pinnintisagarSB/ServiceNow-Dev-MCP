import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { httpFetch, sleep } from '../utils/http.js';

export class SalesforceConnector {
  constructor() {
    this.accessToken  = null;
    this.instanceUrl  = null;
    this.apiVersion   = config.salesforce.apiVersion;
    this.apiLimits    = { used: 0, total: 0 };
  }

  async connect() {
    const { loginUrl: rawLoginUrl, clientId, clientSecret, username, password, securityToken, jwtKey, jwtSubject } = config.salesforce;
    const loginUrl = this._resolveOAuthUrl(rawLoginUrl);

    if (jwtKey && jwtSubject) return this._connectJwt({ loginUrl, clientId, jwtKey, jwtSubject });

    // Try client_credentials first (External Client Apps), fall back to password grant
    const ccBody = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const ccRes  = await httpFetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ccBody,
    });
    const ccJson = await ccRes.json();
    if (ccRes.ok) {
      this.accessToken = ccJson.access_token;
      this.instanceUrl = ccJson.instance_url;
      logger.success(`Salesforce connected (client_credentials) → ${this.instanceUrl}`);
      return this;
    }

    // Fall back to password grant
    const body = new URLSearchParams({
      grant_type:    'password',
      client_id:     clientId,
      client_secret: clientSecret,
      username,
      password:      `${password}${securityToken}`,
    });
    const res  = await httpFetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Salesforce auth failed: ${json.error_description ?? JSON.stringify(json)}`);

    this.accessToken = json.access_token;
    this.instanceUrl = json.instance_url;
    logger.success(`Salesforce connected (password grant) → ${this.instanceUrl}`);
    return this;
  }

  _resolveOAuthUrl(raw) {
    // lightning.force.com URLs redirect OAuth POSTs — swap to the my.salesforce.com equivalent
    return raw.replace(/\/+$/, '').replace('.lightning.force.com', '.my.salesforce.com');
  }

  async _connectJwt({ loginUrl: rawLoginUrl, clientId, jwtKey, jwtSubject }) {
    const loginUrl = this._resolveOAuthUrl(rawLoginUrl);
    let jwt;
    try { jwt = await import('jsonwebtoken'); }
    catch { throw new Error('JWT auth needs the "jsonwebtoken" package — install it or use password flow.'); }

    const claim = {
      iss: clientId, sub: jwtSubject, aud: loginUrl,
      exp: Math.floor(Date.now() / 1000) + 180,
    };
    const assertion = jwt.default.sign(claim, jwtKey, { algorithm: 'RS256' });
    const res = await httpFetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`SF JWT auth failed: ${json.error_description ?? JSON.stringify(json)}`);
    this.accessToken = json.access_token;
    this.instanceUrl = json.instance_url;
    logger.success(`Salesforce connected via JWT → ${this.instanceUrl}`);
    return this;
  }

  headers() {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' };
  }

  _readLimits(res) {
    const h = res.headers.get('sforce-limit-info');
    if (!h) return;
    const m = h.match(/api-usage=(\d+)\/(\d+)/);
    if (m) {
      this.apiLimits.used  = parseInt(m[1], 10);
      this.apiLimits.total = parseInt(m[2], 10);
      const pct = (this.apiLimits.used / this.apiLimits.total) * 100;
      if (pct > 90) logger.warn(`SF API usage at ${pct.toFixed(1)}% (${this.apiLimits.used}/${this.apiLimits.total}) — throttling advised`);
    }
  }

  async get(path, params = {}) {
    const url = new URL(`${this.instanceUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await httpFetch(url.toString(), { headers: this.headers() });
    this._readLimits(res);
    const json = await res.json();
    if (!res.ok) throw new Error(`SF GET ${path} → ${res.status}: ${JSON.stringify(json[0] ?? json)}`);
    return json;
  }

  async post(path, body, contentType = 'application/json') {
    const res = await httpFetch(`${this.instanceUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': contentType },
      body: contentType === 'application/json' ? JSON.stringify(body) : body,
    });
    this._readLimits(res);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`SF POST ${path} → ${res.status}: ${JSON.stringify(json[0] ?? json)}`);
    return json;
  }

  async patch(path, body) {
    const res = await httpFetch(`${this.instanceUrl}${path}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this._readLimits(res);
    if (res.status === 204) return { updated: true };
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`SF PATCH ${path} → ${res.status}: ${JSON.stringify(json[0] ?? json)}`);
    return json;
  }

  async delete(path) {
    const res = await httpFetch(`${this.instanceUrl}${path}`, {
      method: 'DELETE', headers: this.headers(),
    });
    this._readLimits(res);
    if (res.status === 204) return { deleted: true };
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`SF DELETE ${path} → ${res.status}: ${JSON.stringify(json[0] ?? json)}`);
    return json;
  }

  // ── Schema Discovery ───────────────────────────────────────────────────────
  async describeObject(objectName) {
    return this.get(`/services/data/${this.apiVersion}/sobjects/${objectName}/describe`);
  }
  async listObjects() {
    return this.get(`/services/data/${this.apiVersion}/sobjects`);
  }
  async getSampleRecord(objectName) {
    const result = await this.query(`SELECT Id FROM ${objectName} LIMIT 1`);
    if (!result.records.length) return null;
    return this.get(`/services/data/${this.apiVersion}/sobjects/${objectName}/${result.records[0].Id}`);
  }

  async checkFieldAccess(objectName) {
    const d = await this.describeObject(objectName);
    return d.fields
      .filter(f => !f.calculated && !f.autoNumber)
      .map(f => ({ name: f.name, createable: f.createable, updateable: f.updateable, accessible: !!f.permissionable }));
  }

  async getRecordTypes(objectName) {
    const d = await this.describeObject(objectName);
    return d.recordTypeInfos?.filter(r => r.available && !r.master) ?? [];
  }

  // ── Data Fetching (REST) ──────────────────────────────────────────────────
  async query(soql) {
    return this.get(`/services/data/${this.apiVersion}/query`, { q: soql });
  }
  async queryAll(soql) {
    return this.get(`/services/data/${this.apiVersion}/queryAll`, { q: soql });
  }

  async *fetchAllRecords(soql, { includeDeleted = false } = {}) {
    const endpoint = includeDeleted ? 'queryAll' : 'query';
    let result = await this.get(`/services/data/${this.apiVersion}/${endpoint}`, { q: soql });
    yield result.records;
    while (!result.done && result.nextRecordsUrl) {
      result = await this.get(result.nextRecordsUrl);
      yield result.records;
    }
  }

  // ── Bulk API 2.0 — use for very large datasets ────────────────────────────
  async bulkQuery(soql, { includeDeleted = false } = {}) {
    const job = await this.post(`/services/data/${this.apiVersion}/jobs/query`, {
      operation: includeDeleted ? 'queryAll' : 'query',
      query: soql,
    });
    const jobId = job.id;
    while (true) {
      await sleep(3000);
      const status = await this.get(`/services/data/${this.apiVersion}/jobs/query/${jobId}`);
      if (status.state === 'JobComplete') break;
      if (status.state === 'Failed' || status.state === 'Aborted') {
        throw new Error(`SF Bulk job ${jobId} ${status.state}: ${status.errorMessage}`);
      }
    }
    return jobId;
  }

  async *fetchBulkResults(jobId) {
    let locator = null;
    while (true) {
      const url = new URL(`${this.instanceUrl}/services/data/${this.apiVersion}/jobs/query/${jobId}/results`);
      url.searchParams.set('maxRecords', '10000');
      if (locator) url.searchParams.set('locator', locator);
      const res = await httpFetch(url.toString(), { headers: { ...this.headers(), Accept: 'text/csv' } });
      if (!res.ok) throw new Error(`SF Bulk results → ${res.status}`);
      const csv = await res.text();
      yield this._parseCsv(csv);
      locator = res.headers.get('sforce-locator');
      if (!locator || locator === 'null') break;
    }
  }

  _parseCsv(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = this._parseCsvLine(lines[0]);
    return lines.slice(1).map(l => {
      const vals = this._parseCsvLine(l);
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
    });
  }
  _parseCsvLine(line) {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === ',') { out.push(cur); cur = ''; }
        else if (c === '"') inQ = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  // ── Attachments (ContentVersion) ──────────────────────────────────────────
  async getContentVersionsFor(recordId) {
    const links = await this.query(
      `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId='${recordId}'`
    );
    if (!links.records.length) return [];
    const ids = links.records.map(r => `'${r.ContentDocumentId}'`).join(',');
    const versions = await this.query(
      `SELECT Id,Title,FileExtension,ContentSize,ContentDocumentId
       FROM ContentVersion WHERE ContentDocumentId IN (${ids}) AND IsLatest=true`
    );
    return versions.records;
  }
  async downloadContentVersion(versionId) {
    const res = await httpFetch(
      `${this.instanceUrl}/services/data/${this.apiVersion}/sobjects/ContentVersion/${versionId}/VersionData`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`SF attachment download → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async getCaseComments(caseId) {
    const json = await this.query(
      `SELECT Id,CommentBody,CreatedDate,CreatedById,IsPublished FROM CaseComment WHERE ParentId='${caseId}'`
    );
    return json.records;
  }

  // ── Tooling / Flow ────────────────────────────────────────────────────────
  async toolingQuery(soql) { return this.get(`/services/data/${this.apiVersion}/tooling/query`, { q: soql }); }
  async listFlows() { return this.toolingQuery("SELECT Id,MasterLabel,ProcessType,Description,LastModifiedDate,LastModifiedBy.Name,Definition.DeveloperName FROM Flow WHERE Status='Active'"); }
  async getFlowMetadata(apiName) {
    const defResult = await this.toolingQuery(`SELECT Id FROM FlowDefinition WHERE DeveloperName='${apiName}'`);
    const def = defResult.records[0];
    if (!def) return null;
    const result = await this.toolingQuery(`SELECT Id,MasterLabel,ProcessType,Metadata FROM Flow WHERE DefinitionId='${def.Id}' AND Status='Active' ORDER BY VersionNumber DESC LIMIT 1`);
    const record = result.records[0] ?? null;
    if (record) record._apiName = apiName;
    return record;
  }

  // ── Type Mapping → ServiceNow ──────────────────────────────────────────────
  static mapFieldType(sfType, length = 255) {
    const map = {
      id:       { internal_type: 'string',         max_length: 40 },
      string:   { internal_type: 'string',         max_length: length || 255 },
      textarea: { internal_type: 'string',         max_length: 4000 },
      int:      { internal_type: 'integer' },
      double:   { internal_type: 'decimal' },
      currency: { internal_type: 'decimal' },
      boolean:  { internal_type: 'boolean' },
      date:     { internal_type: 'glide_date' },
      datetime: { internal_type: 'glide_date_time' },
      reference:{ internal_type: 'string',         max_length: 40 },
      picklist: { internal_type: 'string',         max_length: 255 },
      email:    { internal_type: 'string',         max_length: 100 },
      phone:    { internal_type: 'string',         max_length: 40 },
      url:      { internal_type: 'string',         max_length: 255 },
    };
    return map[sfType] ?? { internal_type: 'string', max_length: 255 };
  }
}
