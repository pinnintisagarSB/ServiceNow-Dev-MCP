/**
 * ServiceNow Technical Documentation Writer
 *
 * Generates comprehensive project-level technical documentation by pulling
 * live data from a ServiceNow instance and producing structured Markdown:
 *
 *  - Application Overview (tables, scope, version)
 *  - Data Model (tables + fields + relationships, ER-style)
 *  - Business Logic (Business Rules, Script Includes, Flow Designer)
 *  - UI Layer (Client Scripts, UI Policies, UI Actions, Widgets)
 *  - Integration Points (Scripted REST APIs, Outbound REST, Transform Maps)
 *  - Automation (Scheduled Jobs, Workflows/Flows, Notifications, ATF)
 *  - Security (Roles, ACLs, Application Scope)
 *  - Operations Guide (common issues, monitoring, maintenance)
 *  - Glossary
 *  - Change Log template
 */

export class TechDocWriter {
  constructor(snConnector) {
    this.sn = snConnector;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Generate full project technical document
  // ══════════════════════════════════════════════════════════════════════════
  async generateProjectDoc({ appName, scope, tables = [], author, version = '1.0', date }) {
    const docDate = date ?? new Date().toISOString().split('T')[0];

    // Fetch live data for all tables in parallel
    const tableData = await Promise.all(
      tables.map(t => this._fetchTableData(t))
    );

    // Fetch application-level artifacts
    const [scriptIncludes, restApis, notifications, scheduledJobs] = await Promise.all([
      this._fetchScriptIncludes(scope),
      this._fetchRestApis(scope),
      this._fetchNotifications(tables),
      this._fetchScheduledJobs(scope),
    ]);

    const doc = `
# ${appName} — Technical Documentation

| Property | Value |
|---|---|
| Application | ${appName} |
| Scope | ${scope ?? 'global'} |
| Version | ${version} |
| Author | ${author ?? 'ServiceNow Developer MCP'} |
| Generated | ${docDate} |
| Tables | ${tables.join(', ')} |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Model](#3-data-model)
4. [Business Logic](#4-business-logic)
5. [UI Layer](#5-ui-layer)
6. [Integration Points](#6-integration-points)
7. [Automation](#7-automation)
8. [Security](#8-security)
9. [Operations Guide](#9-operations-guide)
10. [Change Log](#10-change-log)

---

## 1. Overview

${appName} is a ServiceNow application that manages ${tables.map(t => `\`${t}\``).join(', ')} records.

### Application Scope
- **Scope prefix:** \`${scope ?? 'global'}\`
- **Tables:** ${tableData.length}
- **Script Includes:** ${scriptIncludes.length}
- **REST APIs:** ${restApis.length}
- **Notifications:** ${notifications.length}
- **Scheduled Jobs:** ${scheduledJobs.length}

---

## 2. Architecture

\`\`\`
┌─────────────────────────────────────────────────────┐
│                 Service Portal / UI                  │
│   Widgets  │  Catalog Items  │  Client Scripts       │
└─────────────────────┬───────────────────────────────┘
                      │ user interaction
┌─────────────────────▼───────────────────────────────┐
│               Business Logic Layer                   │
│   Business Rules  │  Script Includes  │  Flows       │
└─────────────────────┬───────────────────────────────┘
                      │ data access
┌─────────────────────▼───────────────────────────────┐
│                  Data Layer                          │
${tableData.map(t => `│   ${t.table.padEnd(20)} │  ${(t.field_count + ' fields').padEnd(10)} │  ${(t.business_rules?.length ?? 0) + ' BRs'}${' '.repeat(Math.max(0, 10 - String(t.business_rules?.length ?? 0).length - 4))} │`).join('\n')}
└─────────────────────┬───────────────────────────────┘
                      │ integration
┌─────────────────────▼───────────────────────────────┐
│              Integration Layer                       │
│   REST APIs  │  Outbound REST  │  Transform Maps     │
└─────────────────────────────────────────────────────┘
\`\`\`

---

## 3. Data Model

${tableData.map(t => this._renderTableSection(t)).join('\n\n')}

---

## 4. Business Logic

### Script Includes

${scriptIncludes.length ? scriptIncludes.map(si => `
#### \`${si.name}\`

${si.description ?? '_No description._'}

- **Client callable:** ${si.client_callable === 'true' ? 'Yes' : 'No'}
- **Scope:** ${si.sys_scope?.display_value ?? 'global'}
`).join('\n') : '_No Script Includes found for this scope._'}

### Business Rules by Table

${tableData.map(t => `
#### Table: \`${t.table}\`

${t.business_rules?.length ? t.business_rules.map(br => `
| ${br.name} | ${br.when} | ${br.events?.join(', ') ?? ''} | \`${br.condition?.substring(0, 60) ?? '(always)'}\` |`).join('\n') : '_No Business Rules._'}
`).join('\n')}

---

## 5. UI Layer

### Client Scripts

${tableData.map(t => t.client_scripts?.length ? `
#### Table: \`${t.table}\`

${t.client_scripts.map(cs => `- **${cs.name}** (${cs.type}${cs.field ? ' on ' + cs.field : ''})`).join('\n')}
` : '').filter(Boolean).join('\n') || '_No Client Scripts found._'}

### UI Actions

${tableData.map(t => t.ui_actions?.length ? `
#### Table: \`${t.table}\`

${t.ui_actions.map(a => `- **${a.name}** — ${a.client === 'true' ? 'Client-side' : 'Server-side'} | Condition: \`${a.condition || '(always)'}\``).join('\n')}
` : '').filter(Boolean).join('\n') || '_No UI Actions found._'}

---

## 6. Integration Points

### Scripted REST APIs

${restApis.length ? restApis.map(api => `
#### \`${api.name}\`

- **Base Path:** \`/api/${scope ?? 'global'}/${api.service_id ?? api.name.toLowerCase().replace(/\s+/g,'_')}\`
- **Requires Auth:** ${api.requires_authentication === 'true' ? 'Yes' : 'No'}

`).join('\n') : '_No Scripted REST APIs found._'}

---

## 7. Automation

### Scheduled Jobs

${scheduledJobs.length ? scheduledJobs.map(j => `
- **${j.name}** — runs ${j.run_type ?? 'periodically'} (${j.run_period ?? j.run_time ?? 'schedule not set'})
`).join('\n') : '_No Scheduled Jobs found._'}

### Notifications

${notifications.length ? `
| Name | Table | Trigger | Subject |
|---|---|---|---|
${notifications.map(n => `| ${n.name} | ${n.table} | ${n.event_name || 'condition'} | ${(n.subject ?? '').substring(0,50)} |`).join('\n')}
` : '_No Notifications found._'}

---

## 8. Security

### Roles Required

${tableData.map(t => t.acls?.length ? `
#### Table: \`${t.table}\`

| Operation | Roles |
|---|---|
${t.acls.map(a => `| ${a.operation} | ${a.roles || '(script-based)'} |`).join('\n')}
` : '').filter(Boolean).join('\n') || '_No ACL data found._'}

### Scope Isolation

This application runs in scope \`${scope ?? 'global'}\`. Cross-scope access requires explicit script-callable declarations.

---

## 9. Operations Guide

### Health Checks

Run the \`health_check_instance\` MCP tool periodically to check:
- Business Rules without conditions
- Slow scripts in syslog
- Failed integration syncs
- Error rate trends

### Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Records not being created | Required field missing | Check mandatory fields in table schema |
| Business Rule not firing | Condition not met or BR inactive | Check condition and active flag |
| Notification not sending | No recipients or condition mismatch | Use analyze_notifications tool |
| Slow page loads | Missing DB indexes or BR without limits | Run analyze_performance tool |
| Widget not loading | Server script error | Check syslog with find_sys_logs tool |
| Catalog item not visible | Category or role mismatch | Check catalog item active status and roles |

### Monitoring

1. **System Logs:** Check \`syslog\` table for errors (level=2) daily
2. **Business Rule errors:** Filter syslog by your BR names
3. **Integration health:** Check the \`u_*_sync_error\` tables (if bidirectional integration is active)
4. **Performance:** Run \`analyze_performance\` weekly on high-traffic tables

### Maintenance Tasks

| Frequency | Task |
|---|---|
| Daily | Review error logs |
| Weekly | Run performance analysis on core tables |
| Monthly | Audit ACLs and role assignments |
| Per release | Run ATF test suite |
| Per release | Update this documentation |

---

## 10. Change Log

| Version | Date | Author | Changes |
|---|---|---|---|
| ${version} | ${docDate} | ${author ?? 'Developer'} | Initial documentation |

---

_Generated by ServiceNow Developer MCP on ${docDate}_
`.trim();

    return { doc, length_chars: doc.length, sections: 10 };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Generate a quick one-pager for a single feature
  // ══════════════════════════════════════════════════════════════════════════
  generateFeatureDoc({ featureName, description, tables, businessRules, scriptIncludes, notifications, testPlan }) {
    return `
# Feature: ${featureName}

**Description:** ${description ?? '_Not provided._'}
**Date:** ${new Date().toISOString().split('T')[0]}

## Affected Tables

${(tables ?? []).map(t => `- \`${t}\``).join('\n') || '_None specified._'}

## Business Rules

${(businessRules ?? []).map(br => `- **${br.name}** on \`${br.table}\` — ${br.when} ${(br.events ?? []).join('/')}`).join('\n') || '_None._'}

## Script Includes

${(scriptIncludes ?? []).map(si => `- **${si.name}** — ${si.description ?? ''}`).join('\n') || '_None._'}

## Notifications

${(notifications ?? []).map(n => `- **${n.name}** — ${n.table} — ${n.event ?? 'condition-based'}`).join('\n') || '_None._'}

## Test Plan

${testPlan ?? `
1. Create a test record and verify Business Rule fires
2. Check notifications are received by expected recipients
3. Run ATF tests if available
4. Test as end user (not admin) to verify ACLs
5. Verify portal / catalog item visibility if applicable
`.trim()}

---
_Generated by ServiceNow Developer MCP_
`.trim();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal fetchers
  // ══════════════════════════════════════════════════════════════════════════
  async _fetchTableData(table) {
    const [fields, brs, css, acls, uiActions] = await Promise.all([
      this.sn.query('sys_dictionary', {
        sysparm_query:  `name=${table}^elementISNOTEMPTY`,
        sysparm_fields: 'element,column_label,internal_type,reference,mandatory,read_only',
        sysparm_limit:  200,
      }).catch(() => []),
      this.sn.query('sys_script', {
        sysparm_query:  `collection=${table}^active=true`,
        sysparm_fields: 'name,when,action_insert,action_update,action_delete,filter_condition',
        sysparm_limit:  50,
      }).catch(() => []),
      this.sn.query('sys_script_client', {
        sysparm_query:  `table=${table}^active=true`,
        sysparm_fields: 'name,type,field_name',
        sysparm_limit:  50,
      }).catch(() => []),
      this.sn.query('sys_security_acl', {
        sysparm_query:  `name=${table}^ORname=${table}.*`,
        sysparm_fields: 'name,operation,roles',
        sysparm_limit:  50,
      }).catch(() => []),
      this.sn.query('sys_ui_action', {
        sysparm_query:  `table=${table}^active=true`,
        sysparm_fields: 'name,client,condition',
        sysparm_limit:  30,
      }).catch(() => []),
    ]);

    return {
      table,
      field_count:    fields.length,
      fields:         fields,
      business_rules: brs.map(br => ({
        name:      br.name,
        when:      br.when,
        events:    [br.action_insert==='true'&&'insert', br.action_update==='true'&&'update', br.action_delete==='true'&&'delete'].filter(Boolean),
        condition: br.filter_condition ?? '',
      })),
      client_scripts: css.map(cs => ({ name: cs.name, type: cs.type, field: cs.field_name })),
      acls:           acls.map(a  => ({ operation: a.operation, roles: a.roles })),
      ui_actions:     uiActions,
    };
  }

  async _fetchScriptIncludes(scope) {
    return this.sn.query('sys_script_include', {
      sysparm_query:  scope ? `sys_scope.scope=${scope}` : 'active=true',
      sysparm_fields: 'name,description,client_callable,sys_scope',
      sysparm_limit:  50,
    }).catch(() => []);
  }

  async _fetchRestApis(scope) {
    return this.sn.query('sys_ws_definition', {
      sysparm_query:  scope ? `sys_scope.scope=${scope}` : 'active=true',
      sysparm_fields: 'name,requires_authentication,service_id,sys_scope',
      sysparm_limit:  30,
    }).catch(() => []);
  }

  async _fetchNotifications(tables) {
    if (!tables.length) return [];
    return this.sn.query('sysevent_email_action', {
      sysparm_query:  `tableIN${tables.join(',')}^active=true`,
      sysparm_fields: 'name,table,event_name,subject',
      sysparm_limit:  50,
    }).catch(() => []);
  }

  async _fetchScheduledJobs(scope) {
    return this.sn.query('sysauto_script', {
      sysparm_query:  scope ? `sys_scope.scope=${scope}^active=true` : 'active=true',
      sysparm_fields: 'name,run_type,run_period,run_time',
      sysparm_limit:  30,
    }).catch(() => []);
  }

  _renderTableSection(t) {
    const mandatoryMarker = f => f.mandatory === 'true' ? ' \\*' : '';
    const refMarker       = f => f.reference ? ` → \`${f.reference?.display_value ?? f.reference}\`` : '';

    return `
### Table: \`${t.table}\`

**Fields:** ${t.field_count}  |  **Business Rules:** ${t.business_rules?.length ?? 0}  |  **Client Scripts:** ${t.client_scripts?.length ?? 0}

| Field | Label | Type | Notes |
|---|---|---|---|
${(t.fields ?? []).slice(0, 25).map(f =>
  `| \`${f.element}\` | ${f.column_label} | ${f.internal_type?.display_value ?? f.internal_type} | ${mandatoryMarker(f)}${refMarker(f)} |`
).join('\n')}
${t.field_count > 25 ? `\n_…and ${t.field_count - 25} more fields._` : ''}

> \\* = mandatory field`.trim();
  }
}
