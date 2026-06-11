import { logger } from '../utils/logger.js';

// Jira issue type tiers — parents must migrate before children
const JIRA_TYPE_TIER = {
  Epic: 1, Story: 1,
  Task: 2, Bug: 2, Feature: 2, Improvement: 2,
  Subtask: 3, 'Sub-task': 3,
};

// Salesforce objects that have parent/child relationships
// Key = child object, value = parent object field on that child
const SF_PARENT_FIELDS = {
  Contact:     { parentObject: 'Account',  parentField: 'AccountId',  tier: 2 },
  Case:        { parentObject: 'Account',  parentField: 'AccountId',  tier: 2 },
  Opportunity: { parentObject: 'Account',  parentField: 'AccountId',  tier: 2 },
  Task:        { parentObject: null,        parentField: 'WhatId',     tier: 2 },
  Event:       { parentObject: null,        parentField: 'WhatId',     tier: 2 },
  CaseComment: { parentObject: 'Case',      parentField: 'ParentId',   tier: 3 },
  Attachment:  { parentObject: null,        parentField: 'ParentId',   tier: 3 },
  Note:        { parentObject: null,        parentField: 'ParentId',   tier: 3 },
};

export class DependencyAnalyzer {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  async analyze(platform, source, projectKeys) {
    logger.step('Dependency analysis...');
    const result = {
      users:             { found: [], missing: [] },
      hierarchy:         {},
      migrationSequence: [],
      warnings:          [],
    };

    if (platform === 'jira') {
      const allIssues = await this._fetchAllJiraIssues(source, projectKeys);
      await this._analyzeUsers_Jira(allIssues, result);
      this._analyzeHierarchy_Jira(allIssues, result);
    } else if (platform === 'salesforce') {
      await this._analyzeSalesforce(source, projectKeys, result);
    }

    // Keep backwards-compat alias
    result.issueHierarchy = result.hierarchy;

    this._printSummary(platform, result);
    return result;
  }

  // ════════════════════════════════════════════════════════════════════════
  // JIRA
  // ════════════════════════════════════════════════════════════════════════

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

  async _analyzeUsers_Jira(issues, result) {
    const userMap = new Map();
    issues.forEach(issue => {
      const f = issue.fields ?? {};
      if (f.assignee?.emailAddress) userMap.set(f.assignee.emailAddress, { email: f.assignee.emailAddress, name: f.assignee.displayName });
      if (f.reporter?.emailAddress) userMap.set(f.reporter.emailAddress, { email: f.reporter.emailAddress, name: f.reporter.displayName });
    });
    await this._checkUsersInSN([...userMap.values()], result);
  }

  _analyzeHierarchy_Jira(issues, result) {
    const byType = {};
    issues.forEach(issue => {
      const type = issue.fields?.issuetype?.name ?? 'Unknown';
      if (!byType[type]) byType[type] = [];
      byType[type].push(issue);
    });
    result.hierarchy = Object.fromEntries(
      Object.entries(byType).map(([t, arr]) => [t, arr.length])
    );

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
        types:  [...new Set(tierIssues.map(i => i.fields?.issuetype?.name))],
        issues: tierIssues,
        count:  tierIssues.length,
      }));
  }

  // ════════════════════════════════════════════════════════════════════════
  // SALESFORCE
  // ════════════════════════════════════════════════════════════════════════

  async _analyzeSalesforce(sf, objectNames, result) {
    const tiers = new Map();

    for (const objectName of objectNames) {
      const meta  = SF_PARENT_FIELDS[objectName];
      const tier  = meta?.tier ?? 1;

      // Count records
      const countRes = await sf.query(`SELECT COUNT() FROM ${objectName}`).catch(() => null);
      const count    = countRes?.totalSize ?? 0;

      if (!tiers.has(tier)) tiers.set(tier, []);
      tiers.get(tier).push({ objectName, count, parentObject: meta?.parentObject ?? null, parentField: meta?.parentField ?? null });
      result.hierarchy[objectName] = count;

      // Check for parent objects that also need migrating
      if (meta?.parentObject && !objectNames.includes(meta.parentObject)) {
        result.warnings.push(
          `"${objectName}" has a parent relationship to "${meta.parentObject}" via field "${meta.parentField}". ` +
          `If "${meta.parentObject}" is not also being migrated, reference fields may not resolve correctly in ServiceNow.`
        );
      }

      // Extract owner/user references
      try {
        const sample = await sf.query(`SELECT OwnerId FROM ${objectName} LIMIT 100`);
        const ownerIds = [...new Set((sample.records ?? []).map(r => r.OwnerId).filter(Boolean))];
        if (ownerIds.length) {
          const users = await sf.query(
            `SELECT Id, Email, FirstName, LastName FROM User WHERE Id IN (${ownerIds.map(id => `'${id}'`).join(',')})`
          ).catch(() => null);
          if (users?.records?.length) {
            const userList = users.records.map(u => ({
              email: u.Email,
              name:  `${u.FirstName ?? ''} ${u.LastName ?? ''}`.trim(),
              sf_id: u.Id,
            }));
            await this._checkUsersInSN(userList, result);
          }
        }
      } catch (_) {
        result.warnings.push(`Could not check owner users for ${objectName} — user dependency check skipped`);
      }
    }

    // Build migration sequence sorted by tier (Tier 1 = parent objects, Tier 2+ = children)
    result.migrationSequence = [...tiers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tier, objects]) => ({
        tier,
        types:  objects.map(o => o.objectName),
        issues: objects,   // generic name kept for compatibility with BatchMigrationRunner
        count:  objects.reduce((s, o) => s + o.count, 0),
        note:   tier === 1 ? 'Migrate these first — other objects depend on them' : `Depends on Tier ${tier - 1} objects`,
      }));
  }

  // ════════════════════════════════════════════════════════════════════════
  // SHARED
  // ════════════════════════════════════════════════════════════════════════

  async _checkUsersInSN(users, result) {
    // Deduplicate by email
    const seen = new Set([...result.users.found.map(u => u.email), ...result.users.missing.map(u => u.email)]);
    for (const u of users) {
      if (!u.email || seen.has(u.email)) continue;
      seen.add(u.email);
      const existing = await this.sn.get('sys_user', {
        sysparm_query:  `email=${u.email}`,
        sysparm_fields: 'sys_id,name,email',
        sysparm_limit:  '1',
      });
      if (existing.length) result.users.found.push({ ...u, sys_id: existing[0].sys_id });
      else result.users.missing.push(u);
    }
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
        sysparm_query:  `map=${transformMapSysId}`,
        sysparm_fields: 'sys_id,source_field,target_field,coalesce,use_source_script,script',
        sysparm_limit:  '100',
      }),
      this.sn.get('sys_transform_script', {
        sysparm_query:  `map=${transformMapSysId}`,
        sysparm_fields: 'sys_id,field_name,when,script',
        sysparm_limit:  '50',
      }),
    ]);

    const issues = [], suggestions = [];
    transformScripts.forEach(ts => {
      if (!ts.field_name) {
        issues.push({ type: 'orphan_transform_script', sys_id: ts.sys_id, detail: 'Transform script has no field_name — answer value is never applied' });
        suggestions.push('Delete orphan transform scripts and use field map scripts (use_source_script=true) for field-level value transforms');
      }
      if (ts.when === 'onBefore' && ts.field_name) {
        suggestions.push(`Move transform script for "${ts.field_name}" to a field map script — simpler and field-scoped`);
      }
    });

    return {
      fieldMaps:        { total: fieldMaps.length, direct: fieldMaps.filter(f => !f.use_source_script).length, scripted: fieldMaps.filter(f => f.use_source_script).length, entries: fieldMaps },
      transformScripts: { total: transformScripts.length, entries: transformScripts },
      issues,
      suggestions: [...new Set(suggestions)],
    };
  }

  _printSummary(platform, result) {
    logger.header('Dependency Analysis Results');
    logger.info(`Users found in SN:   ${result.users.found.length}`);
    if (result.users.missing.length) {
      logger.warn(`Users missing in SN: ${result.users.missing.length}`);
      result.users.missing.forEach(u => logger.warn(`  ✗ ${u.email} (${u.name})`));
    } else {
      logger.success('All referenced users exist in ServiceNow');
    }

    if (platform === 'jira') {
      logger.info('\nIssue hierarchy:');
      Object.entries(result.hierarchy).forEach(([type, count]) => {
        const tier = JIRA_TYPE_TIER[type] ?? 2;
        logger.info(`  Tier ${tier}  ${type.padEnd(12)} → ${count} issues`);
      });
    } else {
      logger.info('\nObject record counts:');
      Object.entries(result.hierarchy).forEach(([obj, count]) => {
        logger.info(`  ${obj.padEnd(20)} → ${count} records`);
      });
    }

    logger.info('\nMigration sequence:');
    result.migrationSequence.forEach(s => {
      logger.info(`  Tier ${s.tier}: ${s.types.join(', ')} (${s.count} records)`);
    });

    if (result.warnings.length) {
      logger.info('\nWarnings:');
      result.warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  }
}
