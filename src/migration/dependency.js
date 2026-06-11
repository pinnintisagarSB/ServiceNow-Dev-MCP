import { logger } from '../utils/logger.js';

// Jira issue type tiers — parents before children
const JIRA_TYPE_TIER = {
  Epic: 1, Story: 1,
  Task: 2, Bug: 2, Feature: 2, Improvement: 2,
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
      platform,
      references:        [],   // all cross-object/cross-record references found
      missingInTarget:   [],   // referenced records that don't exist in SN yet
      migrationSequence: [],   // ordered list of tiers
      hierarchy:         {},   // object → record count
      warnings:          [],
      // backwards-compat
      users: { found: [], missing: [] },
      issueHierarchy: {},
    };

    if (platform === 'jira') {
      const allIssues = await this._fetchAllJiraIssues(source, projectKeys);
      this._analyzeJira(allIssues, result);
      await this._checkJiraRefsInSN(allIssues, result);
    } else if (platform === 'salesforce') {
      await this._analyzeSalesforce(source, projectKeys, result);
    }

    result.issueHierarchy = result.hierarchy;
    this._printSummary(result);
    return result;
  }

  // ════════════════════════════════════════════════════════════════════════
  // JIRA
  // ════════════════════════════════════════════════════════════════════════

  async _fetchAllJiraIssues(jira, projectKeys) {
    const jql    = projectKeys.map(k => `project=${k}`).join(' OR ');
    const issues = [];
    let startAt  = 0;
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

  _analyzeJira(issues, result) {
    const byType = {};
    const tiers  = new Map();
    const issueIndex = new Map(issues.map(i => [i.key, i]));

    for (const issue of issues) {
      const type = issue.fields?.issuetype?.name ?? 'Unknown';
      const tier = JIRA_TYPE_TIER[type] ?? 2;
      byType[type] = (byType[type] ?? 0) + 1;
      if (!tiers.has(tier)) tiers.set(tier, []);
      tiers.get(tier).push(issue);

      // Parent link (Epic / parent issue)
      const parentKey = issue.fields?.parent?.key ?? issue.fields?.customfield_10014;
      if (parentKey) {
        result.references.push({
          type:        'parent_issue',
          from:        issue.key,
          from_type:   type,
          to:          parentKey,
          to_type:     issue.fields?.parent?.fields?.issuetype?.name ?? 'Epic',
          resolved:    issueIndex.has(parentKey),
          description: `${issue.key} (${type}) depends on parent ${parentKey}`,
        });
        if (!issueIndex.has(parentKey)) {
          result.warnings.push(`Parent issue ${parentKey} of ${issue.key} is not in the migration scope — the parent link will be unresolved in ServiceNow`);
        }
      }

      // Issue links (blocks / is blocked by)
      for (const link of issue.fields?.issuelinks ?? []) {
        const linkedKey  = link.outwardIssue?.key ?? link.inwardIssue?.key;
        const linkType   = link.type?.name ?? 'links to';
        if (linkedKey) {
          result.references.push({
            type:        'issue_link',
            from:        issue.key,
            to:          linkedKey,
            link_type:   linkType,
            resolved:    issueIndex.has(linkedKey),
            description: `${issue.key} ${linkType} ${linkedKey}`,
          });
        }
      }
    }

    result.hierarchy = byType;
    result.migrationSequence = [...tiers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tier, tierIssues]) => ({
        tier,
        types:  [...new Set(tierIssues.map(i => i.fields?.issuetype?.name))],
        issues: tierIssues,
        count:  tierIssues.length,
        note:   tier === 1 ? 'Migrate first — other issues depend on these' : `Depends on Tier ${tier - 1} issues`,
      }));
  }

  async _checkJiraRefsInSN(issues, result) {
    // Check users
    const userMap = new Map();
    for (const issue of issues) {
      const f = issue.fields ?? {};
      if (f.assignee?.emailAddress)  userMap.set(f.assignee.emailAddress,  { email: f.assignee.emailAddress,  name: f.assignee.displayName,  role: 'assignee' });
      if (f.reporter?.emailAddress)  userMap.set(f.reporter.emailAddress,  { email: f.reporter.emailAddress,  name: f.reporter.displayName,  role: 'reporter' });
    }

    for (const u of userMap.values()) {
      const existing = await this.sn.get('sys_user', {
        sysparm_query:  `email=${u.email}`,
        sysparm_fields: 'sys_id,name,email',
        sysparm_limit:  '1',
      });
      const ref = { type: 'user', email: u.email, name: u.name, role: u.role };
      if (existing.length) {
        result.references.push({ ...ref, resolved: true,  sn_sys_id: existing[0].sys_id });
        result.users.found.push({ email: u.email, name: u.name, sys_id: existing[0].sys_id });
      } else {
        result.references.push({ ...ref, resolved: false });
        result.users.missing.push({ email: u.email, name: u.name });
        result.missingInTarget.push({ kind: 'user', email: u.email, name: u.name, impact: `Issues assigned to or reported by ${u.name} will have blank assignee/reporter in ServiceNow` });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SALESFORCE
  // ════════════════════════════════════════════════════════════════════════

  async _analyzeSalesforce(sf, objectNames, result) {
    // Step 1 — discover relationship fields for each object
    const objectMeta = {};
    for (const objectName of objectNames) {
      try {
        const meta = await sf.describeObject(objectName);
        objectMeta[objectName] = meta;
        result.hierarchy[objectName] = 0;
      } catch (e) {
        result.warnings.push(`Could not describe Salesforce object "${objectName}": ${e.message}`);
      }
    }

    const objectNamesSet = new Set(objectNames);

    // Step 2 — build dependency graph from relationship fields
    const deps     = new Map(); // objectName → Set of objects it depends on
    const refFields = {};       // objectName → [{ field, referenceTo }]

    for (const [objectName, meta] of Object.entries(objectMeta)) {
      deps.set(objectName, new Set());
      refFields[objectName] = [];

      for (const field of meta.fields ?? []) {
        if (field.type !== 'reference' || !field.referenceTo?.length) continue;
        for (const refTo of field.referenceTo) {
          if (refTo === objectName) continue; // self-reference, ignore
          result.references.push({
            type:        'lookup_field',
            from:        objectName,
            field:       field.name,
            label:       field.label,
            to:          refTo,
            in_scope:    objectNamesSet.has(refTo),
            description: `${objectName}.${field.name} → ${refTo}`,
          });
          refFields[objectName].push({ field: field.name, referenceTo: refTo });

          if (objectNamesSet.has(refTo)) {
            // This object depends on another object in scope
            deps.get(objectName).add(refTo);
          } else {
            result.warnings.push(
              `${objectName}.${field.name} references "${refTo}" which is NOT in the migration scope. ` +
              `Records referencing ${refTo} records that don't exist in ServiceNow will have blank/broken lookup fields.`
            );
          }
        }
      }
    }

    // Step 3 — topological sort to build migration tiers
    const tiers    = this._topoSort(objectNames, deps);
    let   tierNum  = 1;
    const tierMap  = new Map();

    for (const group of tiers) {
      for (const obj of group) tierMap.set(obj, tierNum);
      tierNum++;
    }

    // Step 4 — count records per object
    for (const objectName of objectNames) {
      try {
        const countRes = await sf.query(`SELECT COUNT() FROM ${objectName}`);
        result.hierarchy[objectName] = countRes?.totalSize ?? 0;
      } catch (e) {
        result.warnings.push(`Could not count records for ${objectName}: ${e.message}`);
      }
    }

    // Step 5 — check referenced records in SN (users, etc.)
    await this._checkSalesforceRefsInSN(sf, objectNames, objectMeta, result);

    // Step 6 — build migration sequence
    result.migrationSequence = tiers.map((group, idx) => ({
      tier:    idx + 1,
      types:   group,
      issues:  group.map(obj => ({ objectName: obj, count: result.hierarchy[obj] ?? 0 })),
      count:   group.reduce((s, obj) => s + (result.hierarchy[obj] ?? 0), 0),
      note:    idx === 0
        ? 'Migrate first — no dependencies on other objects'
        : `Depends on Tier ${idx} objects: ${[...new Set(group.flatMap(obj => [...(deps.get(obj) ?? [])]))].join(', ')}`,
      ref_fields: group.flatMap(obj => (refFields[obj] ?? []).filter(r => objectNamesSet.has(r.referenceTo))),
    }));
  }

  async _checkSalesforceRefsInSN(sf, objectNames, objectMeta, result) {
    // Check users referenced via OwnerId, CreatedById, etc.
    const userFieldTypes = new Set(['owner', 'createdby', 'lastmodifiedby']);
    const userIds        = new Set();

    for (const objectName of objectNames) {
      const userFields = (objectMeta[objectName]?.fields ?? [])
        .filter(f => f.type === 'reference' && f.referenceTo?.includes('User'))
        .map(f => f.name)
        .slice(0, 3); // limit to first 3 user fields to avoid huge queries

      if (!userFields.length) continue;
      try {
        const sample = await sf.query(`SELECT ${userFields.join(',')} FROM ${objectName} LIMIT 200`);
        for (const rec of sample.records ?? []) {
          for (const f of userFields) { if (rec[f]) userIds.add(rec[f]); }
        }
      } catch (_) {}
    }

    if (userIds.size) {
      try {
        const ids   = [...userIds].slice(0, 50);
        const users = await sf.query(
          `SELECT Id, Email, FirstName, LastName FROM User WHERE Id IN (${ids.map(id => `'${id}'`).join(',')})`
        );
        for (const u of users.records ?? []) {
          if (!u.Email) continue;
          const name     = `${u.FirstName ?? ''} ${u.LastName ?? ''}`.trim();
          const existing = await this.sn.get('sys_user', {
            sysparm_query: `email=${u.Email}`, sysparm_fields: 'sys_id', sysparm_limit: '1',
          });
          const ref = { type: 'user', email: u.Email, name, sf_id: u.Id };
          if (existing.length) {
            result.references.push({ ...ref, resolved: true, sn_sys_id: existing[0].sys_id });
            result.users.found.push({ email: u.Email, name, sys_id: existing[0].sys_id });
          } else {
            result.references.push({ ...ref, resolved: false });
            result.users.missing.push({ email: u.Email, name });
            result.missingInTarget.push({ kind: 'user', email: u.Email, name, impact: `Owner/user fields referencing ${name} will be blank in ServiceNow` });
          }
        }
      } catch (_) {}
    }
  }

  // ── Topological sort — returns array of groups (each group can run in parallel) ─
  _topoSort(nodes, deps) {
    const remaining = new Set(nodes);
    const tiers     = [];

    while (remaining.size) {
      // Pick nodes whose dependencies are all already placed
      const placed = new Set(tiers.flat());
      const ready  = [...remaining].filter(n => {
        const nodeDeps = deps.get(n) ?? new Set();
        return [...nodeDeps].every(d => placed.has(d) || !remaining.has(d));
      });

      if (!ready.length) {
        // Circular dependency — put everything remaining in one tier with a warning
        tiers.push([...remaining]);
        break;
      }

      tiers.push(ready);
      ready.forEach(n => remaining.delete(n));
    }

    return tiers;
  }

  // ── Create missing users in SN ────────────────────────────────────────────
  async createMissingUsers(missingUsers) {
    if (!missingUsers.length) return [];
    logger.step(`Creating ${missingUsers.length} missing user(s) in ServiceNow...`);
    const created = [];
    for (const u of missingUsers) {
      try {
        const parts = u.name?.split(' ') ?? [];
        const res   = await this.sn.post('sys_user', {
          email: u.email, user_name: u.email, name: u.name,
          first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') ?? '', active: 'true',
        });
        logger.success(`Created user: ${u.name} <${u.email}>`);
        created.push({ ...u, sys_id: res.sys_id });
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
        sysparm_query: `map=${transformMapSysId}`, sysparm_fields: 'sys_id,source_field,target_field,coalesce,use_source_script,script', sysparm_limit: '100',
      }),
      this.sn.get('sys_transform_script', {
        sysparm_query: `map=${transformMapSysId}`, sysparm_fields: 'sys_id,field_name,when,script', sysparm_limit: '50',
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

  _printSummary(result) {
    logger.header('Dependency Analysis Results');

    // Record counts
    logger.info('Record counts:');
    Object.entries(result.hierarchy).forEach(([key, count]) => logger.info(`  ${key.padEnd(20)} → ${count}`));

    // References summary
    const byType = {};
    result.references.forEach(r => { byType[r.type] = (byType[r.type] ?? 0) + 1; });
    if (Object.keys(byType).length) {
      logger.info('\nReferences found:');
      Object.entries(byType).forEach(([t, n]) => logger.info(`  ${t.padEnd(20)} ${n}`));
    }

    // Missing in target
    if (result.missingInTarget.length) {
      logger.warn(`\n${result.missingInTarget.length} reference(s) not yet in ServiceNow:`);
      result.missingInTarget.forEach(m => logger.warn(`  ✗ ${m.kind}: ${m.email ?? m.name ?? m.id} — ${m.impact}`));
    } else {
      logger.success('All referenced records exist in ServiceNow');
    }

    // Migration sequence
    logger.info('\nMigration sequence:');
    result.migrationSequence.forEach(s => logger.info(`  Tier ${s.tier}: ${s.types.join(', ')} (${s.count} records) — ${s.note ?? ''}`));

    if (result.warnings.length) {
      logger.info('\nWarnings:');
      result.warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  }
}
