import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export class SalesforceConnector {
  constructor() {
    this.accessToken  = null;
    this.instanceUrl  = null;
    this.apiVersion   = config.salesforce.apiVersion;
  }

  async connect() {
    const { loginUrl, clientId, clientSecret, username, password, securityToken } = config.salesforce;
    const body = new URLSearchParams({
      grant_type:    'password',
      client_id:     clientId,
      client_secret: clientSecret,
      username,
      password:      `${password}${securityToken}`,
    });

    const res  = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Salesforce auth failed: ${json.error_description ?? JSON.stringify(json)}`);

    this.accessToken = json.access_token;
    this.instanceUrl = json.instance_url;
    logger.success(`Salesforce connected → ${this.instanceUrl}`);
    return this;
  }

  headers() {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' };
  }

  async get(path, params = {}) {
    const url = new URL(`${this.instanceUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await fetch(url.toString(), { headers: this.headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`SF GET ${path} → ${res.status}: ${JSON.stringify(json[0] ?? json)}`);
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

  // ── Data Fetching ──────────────────────────────────────────────────────────
  async query(soql) {
    return this.get(`/services/data/${this.apiVersion}/query`, { q: soql });
  }

  async *fetchAllRecords(soql, pageSize = config.migration.pageSize) {
    const paginatedSoql = soql.includes('LIMIT') ? soql : `${soql} LIMIT ${pageSize} OFFSET 0`;
    let result = await this.get(`/services/data/${this.apiVersion}/query`, { q: paginatedSoql });
    yield result.records;

    while (!result.done && result.nextRecordsUrl) {
      result = await this.get(result.nextRecordsUrl);
      yield result.records;
    }
  }

  // ── Flow / Tooling API ─────────────────────────────────────────────────────
  async toolingQuery(soql) {
    return this.get(`/services/data/${this.apiVersion}/tooling/query`, { q: soql });
  }

  async listFlows() {
    return this.toolingQuery(
      'SELECT Id,ApiName,ProcessType,TriggerType,Label,Description FROM FlowDefinition'
    );
  }

  async getFlowMetadata(apiName) {
    const result = await this.toolingQuery(
      `SELECT Id,ApiName,ProcessType,Metadata FROM Flow WHERE ApiName='${apiName}' AND Status='Active'`
    );
    return result.records[0] ?? null;
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
