import { JiraConnector } from '../connectors/jira.js';
import { logger } from '../utils/logger.js';

// Issue type tiers — parents must migrate before children
const JIRA_TYPE_TIER = {
  Epic: 1, Story: 1,
  Task: 2, Bug: 2,
  Subtask: 3, 'Sub-task': 3,
};

export class DependencyAnalyzer {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  async analyze(platform, source, projectKeys) {
    logger.step('Dependency analysis...');
    const result = {
      users:            { found: [], missing: [] },
      issueHierarchy:   {},
      migrationSequence: [],
      warnings:         [],
    };

    if (platform === 'jira') {
      const allIssues = await this._fetchAllJiraIssues(source, projectKeys);
      await this._analyzeUsers(allIssues, result);
      this._analyzeHierarchy(allIssues, result);
    }

    this._printSummary(result);
    return result;
  }

  // ── Fetch all issues across projects ──────────────────────────────────────
  async _fetchAllJiraIssues(jira, projectKeys) {
    const jql = projectKeys.map(k => `project=${k}`).join(' OR ');
    const issues = [];
    let startAt = 0;

    while (true) {
      const res = await jira.search({ jql: `(${jql}) ORDER BY created ASC`, maxResults: 50, startAt });
      if (!res.issues?.length) break;
      const full = await Promise.all(res.issues.map(i => jira.get(`/rest/api/3/issue/${i.id}`)));
      issues.push(...full);
      startAt += res.issues.length;
      if (!res.total || startAt >= res.total) break;
    }

    return issues;
  }

  // ── User dependency check ─────────────────────────────────────────────────
  async _analyzeUsers(issues, result) {
    const userMap = new Map();
    issues.forEach(issue => {
      const f = issue.fields ?? {};
      if (f.assignee?.emailAddress) userMap.set(f.assignee.emailAddress, { email: f.assignee.emailAddress, name: f.assignee.displayName });
      if (f.reporter?.emailAddress) userMap.set(f.reporter.emailAddress, { email: f.reporter.emailAddress, name: f.reporter.displayName });
    });

    for (const u of userMap.values()) {
      const existing = await this.sn.get('sys_user', {
        sysparm_query: `email=${u.email}`,
        sysparm_fields: 'sys_id,name,email',
        sysparm_limit: '1',
      });
      if (existing.length) result.users.found.push({ ...u, sys_id: existing[0].sys_id });
      else result.users.missing.push(u);
    }
  }

  // ── Issue hierarchy analysis ───────────────────────────────────────────────
  _analyzeHierarchy(issues, result) {
    const byType = {};
    issues.forEach(issue => {
      const type = issue.fields?.issuetype?.name ?? 'Unknown';
      if (!byType[type]) byType[type] = [];
      byType[type].push(issue);
    });
    result.issueHierarchy = Object.fromEntries(
      Object.entries(byType).map(([t, arr]) => [t, arr.length])
    );

    // Build migration sequence sorted by tier
    const tiers = new Map();
    issues.forEach(issue => {
      const type = issue.fields?.issuetype?.name ?? 'Unknown';
      const tier = JIRA_TYPE_TIER[type] ?? 2;
      if (!tiers.has(tier)) tiers.set(tier, []);
      tiers.get(tier).push(issue);
    });

    result.migrationSequence = [...tiers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tier, tierIssues]) => ({
        tier,
        types: [...new Set(tierIssues.map(i => i.fields?.issuetype?.name))],
        issues: tierIssues,
        count: tierIssues.length,
      }));
  }

  // ── Create missing users in SN ────────────────────────────────────────────
  async createMissingUsers(missingUsers) {
    if (!missingUsers.length) return [];
    logger.step(`Creating ${missingUsers.length} missing user(s) in ServiceNow...`);
    const created = [];

    for (const u of missingUsers) {
      try {
        const parts = u.name?.split(' ') ?? [];
        const result = await this.sn.post('sys_user', {
          email:      u.email,
          user_name:  u.email,
          name:       u.name,
          first_name: parts[0] ?? '',
          last_name:  parts.slice(1).join(' ') ?? '',
          active:     'true',
        });
        logger.success(`Created user: ${u.name} <${u.email}>`);
        created.push({ ...u, sys_id: result.sys_id });
      } catch (e) {
        logger.warn(`Could not create user ${u.email}: ${e.message}`);
      }
    }

    return created;
  }

  // ── Analyse an existing transform map ────────────────────────────────────
  async analyzeTransformMap(transformMapSysId) {
    logger.step('Analysing transform map...');

    const [fieldMaps, transformScripts] = await Promise.all([
      this.sn.get('sys_transform_entry', {
        sysparm_query: `map=${transformMapSysId}`,
        sysparm_fields: 'sys_id,source_field,target_field,coalesce,use_source_script,script',
        sysparm_limit: '100',
      }),
      this.sn.get('sys_transform_script', {
        sysparm_query: `map=${transformMapSysId}`,
        sysparm_fields: 'sys_id,field_name,when,script',
        sysparm_limit: '50',
      }),
    ]);

    const issues = [];
    const suggestions = [];

    // Flag transform scripts that should be field map scripts instead
    transformScripts.forEach(ts => {
      if (!ts.field_name) {
        issues.push({ type: 'orphan_transform_script', sys_id: ts.sys_id, detail: 'Transform script has no field_name — answer value is never applied' });
        suggestions.push('Delete orphan transform scripts and use field map scripts (use_source_script=true) for field-level value transforms');
      }
      if (ts.when === 'onBefore' && ts.field_name) {
        suggestions.push(`Move transform script for "${ts.field_name}" to a field map script — simpler and field-scoped`);
      }
    });

    // Flag field maps that could use a script
    fieldMaps.forEach(fm => {
      if (!fm.use_source_script && !fm.script) {
        // Fine — direct mapping
      }
    });

    const directMaps    = fieldMaps.filter(f => !f.use_source_script);
    const scriptedMaps  = fieldMaps.filter(f => f.use_source_script);

    return {
      fieldMaps:        { total: fieldMaps.length, direct: directMaps.length, scripted: scriptedMaps.length, entries: fieldMaps },
      transformScripts: { total: transformScripts.length, entries: transformScripts },
      issues,
      suggestions: [...new Set(suggestions)],
    };
  }

  _printSummary(result) {
    logger.header('Dependency Analysis Results');

    logger.info(`Users found in SN:   ${result.users.found.length}`);
    if (result.users.missing.length) {
      logger.warn(`Users missing in SN: ${result.users.missing.length}`);
      result.users.missing.forEach(u => logger.warn(`  ✗ ${u.email} (${u.name})`));
    } else {
      logger.success('All referenced users exist in ServiceNow');
    }

    logger.info('\nIssue hierarchy:');
    Object.entries(result.issueHierarchy).forEach(([type, count]) => {
      const tier = JIRA_TYPE_TIER[type] ?? 2;
      logger.info(`  Tier ${tier}  ${type.padEnd(12)} → ${count} issues`);
    });

    logger.info('\nMigration sequence:');
    result.migrationSequence.forEach(s => {
      logger.info(`  Tier ${s.tier}: ${s.types.join(', ')} (${s.count} records)`);
    });
  }
}
