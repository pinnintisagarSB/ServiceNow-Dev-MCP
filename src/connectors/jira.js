import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { httpFetch } from '../utils/http.js';

export class JiraConnector {
  constructor() {
    const { email, apiToken } = config.jira;
    this.token   = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.baseUrl = config.jira.baseUrl?.replace(/\/$/, '');
    this.pageSize = config.jira.pageSize;
  }

  async connect() {
    const res = await httpFetch(`${this.baseUrl}/rest/api/3/myself`, { headers: this.headers() });
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
    const res  = await httpFetch(url.toString(), { headers: this.headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`Jira GET ${path} → ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  // ── Schema Discovery ───────────────────────────────────────────────────────
  async getAllFields()                  { return this.get('/rest/api/3/field'); }
  async getProject(projectKey)          { return this.get(`/rest/api/3/project/${projectKey}`); }
  async getIssueTypes()                 { return this.get('/rest/api/3/issuetype'); }
  async getPriorities()                 { return this.get('/rest/api/3/priority'); }
  async getStatuses(projectKey)         { return this.get(`/rest/api/3/project/${projectKey}/statuses`); }

  async getSampleIssue(projectKey) {
    const result = await this.search({ jql: `project=${projectKey} ORDER BY created DESC`, maxResults: 1 });
    if (!result.issues?.length) return null;
    const id = result.issues[0].key ?? result.issues[0].id;
    return this.get(`/rest/api/3/issue/${id}`);
  }

  // ── Data Fetching — new /search endpoint with nextPageToken (with fallback) ─
  async search({ jql, nextPageToken = null, maxResults = this.pageSize, fields = ['*all'], expand = [], startAt = null }) {
    // Legacy callers pass startAt — route to legacy path
    if (startAt !== null) return this._legacySearch({ jql, startAt, maxResults, fields });

    const body = { jql, maxResults, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    if (expand.length) body.expand = expand;

    const res  = await httpFetch(`${this.baseUrl}/rest/api/3/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return this._legacySearch({ jql, startAt: 0, maxResults, fields });
      throw new Error(`Jira search → ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  async _legacySearch({ jql, startAt = 0, maxResults, fields }) {
    const params = { jql, startAt, maxResults };
    if (fields?.length) params.fields = Array.isArray(fields) ? fields.join(',') : fields;
    return this.get('/rest/api/3/search/jql', params);
  }

  async *fetchAllIssues(jql, fields = ['*all']) {
    let token = null;
    let startAt = 0;
    let useLegacy = false;
    while (true) {
      const result = useLegacy
        ? await this._legacySearch({ jql, startAt, maxResults: this.pageSize, fields })
        : await this.search({ jql, nextPageToken: token, maxResults: this.pageSize, fields });

      if (!result.issues?.length) break;
      yield result.issues;

      if (result.nextPageToken !== undefined) {
        if (!result.nextPageToken) break;
        token = result.nextPageToken;
      } else {
        // legacy pagination
        useLegacy = true;
        startAt += result.issues.length;
        if (startAt >= (result.total ?? 0)) break;
      }
    }
  }

  // ── Attachments / Comments / Links / Worklog ──────────────────────────────
  async getAttachments(issueKey) {
    const issue = await this.get(`/rest/api/3/issue/${issueKey}`, { fields: 'attachment' });
    return issue.fields?.attachment ?? [];
  }
  async downloadAttachment(contentUrl) {
    const res = await httpFetch(contentUrl, { headers: { Authorization: `Basic ${this.token}` } });
    if (!res.ok) throw new Error(`Jira attachment download → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async getComments(issueKey) {
    const json = await this.get(`/rest/api/3/issue/${issueKey}/comment`);
    return (json.comments ?? []).map(c => ({
      id:       c.id,
      author:   c.author?.emailAddress ?? c.author?.displayName ?? '',
      created:  c.created,
      updated:  c.updated,
      body:     JiraConnector.adfToText(c.body),
      internal: !!c.jsdPublic === false,
    }));
  }
  async getIssueLinks(issueKey) {
    const issue = await this.get(`/rest/api/3/issue/${issueKey}`, { fields: 'issuelinks' });
    return issue.fields?.issuelinks ?? [];
  }
  async getWorklogs(issueKey) {
    const json = await this.get(`/rest/api/3/issue/${issueKey}/worklog`);
    return json.worklogs ?? [];
  }

  // ── ADF → Markdown (preserves links, code blocks, lists, mentions) ────────
  static adfToText(node, depth = 0) {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(n => JiraConnector.adfToText(n, depth)).join('');

    const t = node.type;
    const inner = () => (node.content ?? []).map(c => JiraConnector.adfToText(c, depth + 1)).join('');

    switch (t) {
      case 'text': {
        let s = node.text ?? '';
        for (const m of node.marks ?? []) {
          if (m.type === 'link')   s = `[${s}](${m.attrs?.href ?? ''})`;
          if (m.type === 'code')   s = '`' + s + '`';
          if (m.type === 'strong') s = '**' + s + '**';
          if (m.type === 'em')     s = '*' + s + '*';
        }
        return s;
      }
      case 'paragraph':    return inner() + '\n\n';
      case 'heading':      return '#'.repeat(node.attrs?.level ?? 1) + ' ' + inner() + '\n\n';
      case 'bulletList':
      case 'orderedList':  return inner();
      case 'listItem':     return '- ' + inner().trim() + '\n';
      case 'codeBlock':    return '```' + (node.attrs?.language ?? '') + '\n' + inner() + '```\n';
      case 'blockquote':   return '> ' + inner().trim() + '\n\n';
      case 'mention':      return '@' + (node.attrs?.text ?? node.attrs?.displayName ?? '');
      case 'hardBreak':    return '\n';
      case 'rule':         return '\n---\n';
      case 'inlineCard':   return node.attrs?.url ?? '';
      case 'mediaSingle':
      case 'media':        return `[attachment:${node.attrs?.id ?? ''}]`;
      default:             return inner();
    }
  }

  // ── Jira Automation API ───────────────────────────────────────────────────
  // Lists all automations visible to the authenticated user.
  // projectKey is optional — omit to fetch global + all project automations.
  async listAutomations({ projectKey = null, limit = 100 } = {}) {
    const params = { limit };
    if (projectKey) params.projectKey = projectKey;
    try {
      const res = await httpFetch(`${this.baseUrl}/rest/automation/1.0/rules/search`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ limit, ...(projectKey ? { projectKey } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`Jira Automation API → ${res.status}: ${JSON.stringify(json)}`);
      return json.values ?? json.rules ?? [];
    } catch (e) {
      // Cloud Automation is at a different path on some instances
      const res2 = await httpFetch(`${this.baseUrl}/rest/automation/1.0/rules/search?limit=${limit}${projectKey ? `&projectKey=${projectKey}` : ''}`, {
        headers: this.headers(),
      });
      const json2 = await res2.json();
      if (!res2.ok) throw new Error(`Jira Automation list failed: ${e.message}`);
      return json2.values ?? json2.rules ?? [];
    }
  }

  async getAutomation(ruleId) {
    const res  = await httpFetch(`${this.baseUrl}/rest/automation/1.0/rules/${ruleId}`, { headers: this.headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`Jira Automation get → ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  // Returns count of issues matching a JQL query (without fetching all records)
  async countIssues(jql) {
    const result = await this.search({ jql, maxResults: 0 });
    return result.total ?? 0;
  }

  // ── Flatten Issue for Staging (legacy — kept for back-compat) ─────────────
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
