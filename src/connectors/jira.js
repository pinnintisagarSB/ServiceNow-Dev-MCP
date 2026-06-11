import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export class JiraConnector {
  constructor() {
    const { email, apiToken } = config.jira;
    this.token   = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.baseUrl = config.jira.baseUrl?.replace(/\/$/, '');
    this.pageSize = config.jira.pageSize;
  }

  async connect() {
    const res = await fetch(`${this.baseUrl}/rest/api/3/myself`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira auth failed (${res.status}): ${body}`);
    }
    const me = await res.json();
    logger.success(`Jira connected → ${this.baseUrl} as ${me.displayName}`);
    return this;
  }

  headers() {
    return { Authorization: `Basic ${this.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async get(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res  = await fetch(url.toString(), { headers: this.headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`Jira GET ${path} → ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  // ── Schema Discovery ───────────────────────────────────────────────────────
  async getAllFields() {
    return this.get('/rest/api/3/field');
  }

  async getProject(projectKey) {
    return this.get(`/rest/api/3/project/${projectKey}`);
  }

  async getSampleIssue(projectKey) {
    const result = await this.search({ jql: `project=${projectKey} ORDER BY created DESC`, maxResults: 1 });
    if (!result.issues?.length) return null;
    const issue = result.issues[0];
    const id = issue.key ?? issue.id;
    if (!id) return null;
    return this.get(`/rest/api/3/issue/${id}`);
  }

  async getIssueTypes() { return this.get('/rest/api/3/issuetype'); }
  async getPriorities()  { return this.get('/rest/api/3/priority'); }

  // ── Data Fetching ──────────────────────────────────────────────────────────
  async search({ jql, startAt = 0, maxResults = this.pageSize, fields = [] }) {
    const params = { jql, startAt, maxResults };
    if (fields.length) params.fields = fields.join(',');
    return this.get('/rest/api/3/search/jql', params);
  }

  async *fetchAllIssues(jql, fields = []) {
    let startAt = 0;
    let total   = Infinity;

    while (startAt < total) {
      const result = await this.search({ jql, startAt, maxResults: this.pageSize, fields });
      total = result.total;
      if (!result.issues.length) break;
      yield result.issues;
      startAt += result.issues.length;
    }
  }

  // ── ADF → Plain Text ───────────────────────────────────────────────────────
  static adfToText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    if (node.content) return node.content.map(JiraConnector.adfToText).join('');
    return '';
  }

  // ── Flatten Issue for Staging ──────────────────────────────────────────────
  static flattenIssue(issue) {
    const f = issue.fields;
    return {
      jira_id:          issue.id,
      jira_key:         issue.key,
      jira_summary:     f.summary ?? '',
      jira_description: JiraConnector.adfToText(f.description),
      jira_status:      f.status?.name ?? '',
      jira_priority:    f.priority?.name ?? '',
      jira_issue_type:  f.issuetype?.name ?? '',
      jira_assignee:    f.assignee?.emailAddress ?? '',
      jira_reporter:    f.reporter?.emailAddress ?? '',
      jira_created:     f.created ? f.created.replace('T', ' ').substring(0, 19) : '',
      jira_updated:     f.updated ? f.updated.replace('T', ' ').substring(0, 19) : '',
      jira_project:     f.project?.key ?? '',
    };
  }

  // ── Type Mapping → ServiceNow ──────────────────────────────────────────────
  static mapFieldType(jiraType) {
    const map = {
      string:    { internal_type: 'string',         max_length: 255 },
      number:    { internal_type: 'integer' },
      datetime:  { internal_type: 'glide_date_time' },
      date:      { internal_type: 'glide_date' },
      user:      { internal_type: 'string',         max_length: 255 },
      status:    { internal_type: 'string',         max_length: 100 },
      priority:  { internal_type: 'string',         max_length: 100 },
      issuetype: { internal_type: 'string',         max_length: 100 },
      option:    { internal_type: 'string',         max_length: 255 },
      array:     { internal_type: 'string',         max_length: 4000 },
      project:   { internal_type: 'string',         max_length: 100 },
    };
    return map[jiraType] ?? { internal_type: 'string', max_length: 255 };
  }
}
