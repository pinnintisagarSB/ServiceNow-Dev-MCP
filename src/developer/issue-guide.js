/**
 * ServiceNow Issue Guide
 *
 * Diagnoses 60+ common ServiceNow developer issues and provides
 * step-by-step guided fixes, root cause analysis, and preventive advice.
 *
 * Categories:
 *   business_rule, client_script, scripted_rest, workflow_flow,
 *   portal_widget, catalog, notification, performance, security,
 *   integration, atf, deployment, upgrade, general
 */

const ISSUES = [
  // ── Business Rules ────────────────────────────────────────────────────────
  {
    id: 'BR001',
    category: 'business_rule',
    title: 'Business Rule not firing',
    symptoms: ['business rule', 'not firing', 'not triggering', 'br not running', 'rule not executing'],
    root_causes: [
      'BR is inactive (active = false)',
      'Condition field does not match the current record state',
      'Wrong table — check "Table" field on the BR',
      'Wrong event type — insert vs update vs delete',
      'Another BR is calling current.setAbortAction(true)',
      'Running in a context where BRs are suppressed (e.g., setWorkflow(false) was called)',
    ],
    diagnosis_steps: [
      '1. Open the BR and verify **Active = true**',
      '2. Check the **Table** field — must match exactly (including extensions)',
      '3. Check **When** and event checkboxes (Insert / Update / Delete)',
      '4. Click **Try This Condition** on the BR to test the condition against a real record',
      '5. Check if any upstream code calls `current.setWorkflow(false)` or `GlideRecord.setWorkflow(false)`',
      '6. Add `gs.info("BR fired for " + current.getUniqueValue())` to the start of the script and check syslog',
      '7. Check for another BR on the same table with `abort_action = true` that fires earlier',
    ],
    fix: 'Enable the BR, verify table/event/condition, add a gs.info log to confirm it fires, then remove the log.',
    prevention: 'Always test with the "Try This Condition" button before saving. Add a gs.info statement during development.',
    related: ['BR002', 'BR003'],
  },
  {
    id: 'BR002',
    category: 'business_rule',
    title: 'Business Rule causing infinite loop',
    symptoms: ['infinite loop', 'transaction timeout', 'br loop', 'recursive update', 'max time exceeded'],
    root_causes: [
      'BR updates a field on the current record, which triggers the same BR again',
      'BR updates a child record, which fires a BR that updates the parent',
      'Missing u_sync_in_progress guard on bidirectional integration BRs',
    ],
    diagnosis_steps: [
      '1. Check syslog for "Max execution time exceeded" or "Recursive BR" messages',
      '2. Look at the BR condition — does it prevent re-firing after the update?',
      '3. Check if `current.changes()` or `current.field.changes()` is in the condition',
      '4. If updating another table, check if that table has a BR that writes back',
    ],
    fix: `Add a loop-prevention condition:
\`\`\`javascript
// Option 1: Check if the specific field changed (use in Condition field)
// current.my_field.changes()

// Option 2: Guard flag in the script
if (current.u_processing == true) return;
current.u_processing = true;
// ... your logic ...
\`\`\``,
    prevention: 'Always add a field-level change check in the BR Condition field. Use current.field.changes() to limit scope.',
  },
  {
    id: 'BR003',
    category: 'business_rule',
    title: 'Business Rule slowing down transactions',
    symptoms: ['slow', 'performance', 'timeout', 'transaction time', 'br slow'],
    root_causes: [
      'GlideRecord query inside the BR with no setLimit()',
      'Synchronous REST call in a before/after BR',
      'BR fires on every update with no condition (full table)',
      'GlideRecord loop inside the BR',
    ],
    diagnosis_steps: [
      '1. Open syslog and filter by BR name — look for execution times > 2000ms',
      '2. Review the BR script for GlideRecord queries — check for setLimit()',
      '3. Check for RESTMessageV2.execute() (synchronous REST)',
      '4. Check the Condition field — empty condition means fires on every record',
    ],
    fix: 'Add setLimit() to all queries, move REST calls to async BRs, add a meaningful condition to restrict scope.',
    prevention: 'Run review_script on every BR before saving. Never use synchronous REST in a BR.',
  },

  // ── Client Scripts ─────────────────────────────────────────────────────────
  {
    id: 'CS001',
    category: 'client_script',
    title: 'Client Script not working / not firing',
    symptoms: ['client script not working', 'onchange not firing', 'onload not running', 'client script error'],
    root_causes: [
      'Script has a JavaScript syntax error — check browser console',
      'Wrong type (onLoad vs onChange vs onSubmit)',
      'Field name is misspelled in the "Field Name" field for onChange',
      'Script is inactive',
      'UI type is wrong (desktop vs mobile)',
      'Browser console shows undefined function error',
    ],
    diagnosis_steps: [
      '1. Open browser DevTools (F12) → Console tab — look for JavaScript errors',
      '2. Verify the script is **Active = true** and **UI Type** is correct',
      '3. For onChange: verify the **Field Name** exactly matches the field name (not label)',
      '4. Add `console.log("CS fired")` at the top to confirm execution',
      '5. Check if a UI Policy is overriding the field and preventing the onChange from firing',
    ],
    fix: 'Fix the syntax error or field name. Always test in browser DevTools console.',
    prevention: 'Use browser DevTools console for all client script debugging. Test in the target browser.',
  },
  {
    id: 'CS002',
    category: 'client_script',
    title: 'GlideAjax not returning data',
    symptoms: ['glideajax', 'ajax not working', 'callback not firing', 'no data returned', 'ajax error'],
    root_causes: [
      'Script Include is not client_callable = true',
      'Method name in addParam("sysparm_name") does not match the SI method',
      'SI method throws an error server-side',
      'Response XML is malformed',
      'Callback function has a JS error that prevents it from running',
    ],
    diagnosis_steps: [
      '1. Verify the Script Include has **Client Callable = true**',
      '2. Check that `sysparm_name` in addParam matches EXACTLY a method name in the SI',
      '3. Add `gs.info("SI method called with: " + request)` in the SI method',
      '4. In the callback, log: `console.log(answer.responseXML)` before parsing',
      '5. Check syslog for errors from the SI method name',
    ],
    fix: `Standard GlideAjax pattern:
\`\`\`javascript
var ga = new GlideAjax('YourScriptInclude');
ga.addParam('sysparm_name', 'yourMethod');
ga.addParam('sysparm_value', g_form.getValue('your_field'));
ga.getXMLAnswer(function(answer) {
    console.log('GlideAjax response:', answer);
    // parse and use answer
});
\`\`\``,
    prevention: 'Always log both the request (server) and response (client) during development.',
  },

  // ── Service Portal ─────────────────────────────────────────────────────────
  {
    id: 'SP001',
    category: 'portal_widget',
    title: 'Widget not loading / shows spinner forever',
    symptoms: ['widget not loading', 'spinner', 'widget error', 'blank widget', 'widget fails'],
    root_causes: [
      'Server script throws an uncaught exception',
      'GlideRecord query returns null and script doesn\'t handle it',
      'Option schema references a field that doesn\'t exist',
      'Widget has a syntax error in the server script',
    ],
    diagnosis_steps: [
      '1. Check syslog (level=2) filtered by the widget name',
      '2. Open the widget in Portal Designer and check the browser console',
      '3. Add a try/catch around the entire server script and set `data.serverError`',
      '4. Simplify the server script to just `data.test = "ok"` and see if template renders',
    ],
    fix: `Wrap server script in error handling:
\`\`\`javascript
(function() {
  try {
    // your code here
  } catch(e) {
    gs.error('[WidgetName] Server error: ' + e.message);
    data.error = 'Failed to load. Please contact support.';
  }
})();
\`\`\`
Add to template: \`<div ng-if="c.data.error" class="alert alert-danger">{{c.data.error}}</div>\``,
    prevention: 'Always wrap server scripts in try/catch and expose errors via data.error.',
  },
  {
    id: 'SP002',
    category: 'portal_widget',
    title: 'c.server.update() not working / not calling server',
    symptoms: ['server update', 'c.server.update', 'action not reaching server', 'input not received'],
    root_causes: [
      'input object is not being read in the server script',
      'c.server.update() promise rejection not handled',
      'Server script doesn\'t check `if (input)` before processing',
    ],
    diagnosis_steps: [
      '1. In server script add: `gs.info("Input received: " + JSON.stringify(input))`',
      '2. In client script, chain `.then(function() {...}, function(err) { console.error(err); })`',
      '3. Verify the client script sets properties on `c.data` that the server reads via `input`',
    ],
    fix: `Server script pattern for input handling:
\`\`\`javascript
if (input && input.action) {
  gs.info('[Widget] Action received: ' + input.action);
  if (input.action === 'save') {
    // handle save
    data.saved = true;
  }
  return; // Don't re-run initial load
}
// Initial load code below
\`\`\``,
    prevention: 'Always handle the input object explicitly and return early after processing actions.',
  },

  // ── Catalog ────────────────────────────────────────────────────────────────
  {
    id: 'CAT001',
    category: 'catalog',
    title: 'Catalog item not visible in portal',
    symptoms: ['catalog item not showing', 'item not visible', 'catalog not appearing', 'hidden item'],
    root_causes: [
      'Item is inactive (active = false)',
      'Item category is not in the catalog configured for the portal',
      'Item has role restrictions the user doesn\'t have',
      'hide_sp = true on the item',
      'Item is not in any catalog (sc_catalogs is empty)',
    ],
    diagnosis_steps: [
      '1. Check **Active = true** on the catalog item',
      '2. Check **Hide on Service Portal = false** (hide_sp field)',
      '3. Verify the item is in a catalog that is linked to the portal',
      '4. Log in as the end user and check their roles',
      '5. Check the category — is it active and in the right catalog?',
    ],
    fix: 'Set active=true, hide_sp=false, ensure the category and catalog are correct, and verify user roles.',
    prevention: 'Always test catalog items logged in as an end user (not admin) before going live.',
  },
  {
    id: 'CAT002',
    category: 'catalog',
    title: 'Catalog variable not showing / UI Policy not working',
    symptoms: ['variable not showing', 'catalog policy', 'variable hidden', 'mandatory not working'],
    root_causes: [
      'UI Policy condition is wrong — the variable always evaluates to hidden',
      'Variable order is wrong — container_start/end mismatch',
      'The variable name in the UI Policy action doesn\'t match the variable name',
      'UI Policy is inactive',
    ],
    diagnosis_steps: [
      '1. Temporarily set all variables to visible and check if they appear',
      '2. Check UI Policy conditions in the browser console: `g_form.getControl("variable_name")`',
      '3. Verify variable names in UI Policy actions match exactly',
      '4. Check container_start / container_end pairs are balanced',
    ],
    fix: 'Fix the UI Policy condition, verify variable names match exactly, ensure containers are balanced.',
    prevention: 'Use the Catalog Item Preview to test UI Policies before publishing.',
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    id: 'NOT001',
    category: 'notification',
    title: 'Email notification not sending',
    symptoms: ['notification not sending', 'email not received', 'notification not firing', 'no email'],
    root_causes: [
      'Notification is inactive',
      'No recipients defined (fields, groups, roles all empty)',
      'Condition does not match the record',
      'Email is going to spam',
      'Outbound email is disabled on the instance (sys_properties)',
      'User\'s email address is not set',
    ],
    diagnosis_steps: [
      '1. Check **Active = true** on the notification',
      '2. Navigate to **System Mailboxes > Outbox** — is the email queued?',
      '3. Navigate to **System Mailboxes > Sent** — was it sent?',
      '4. Check **sys_email** table — look for your notification by subject',
      '5. Verify `glide.email.smtp.active = true` in sys_properties',
      '6. Check if the trigger condition matches — use "Preview Notification" on the record',
    ],
    fix: 'Fix the condition, add recipients, check instance SMTP settings, and verify the user has an email address.',
    prevention: 'Use "Send test email" / "Preview Notification" feature during setup.',
  },

  // ── Scripted REST ──────────────────────────────────────────────────────────
  {
    id: 'REST001',
    category: 'scripted_rest',
    title: 'Scripted REST API returning 401 or 403',
    symptoms: ['401', '403', 'unauthorized', 'forbidden', 'rest authentication'],
    root_causes: [
      'Requires Authentication = true but caller is not passing credentials',
      'Caller role does not have access to execute the REST API',
      'ACL on the REST API resource blocks the user',
    ],
    diagnosis_steps: [
      '1. Check **Requires Authentication** on the API definition',
      '2. For 403: check if there are ACLs on the REST API or the tables it accesses',
      '3. Test with an admin user — if it works, the issue is role-based',
      '4. Check `rest_service` ACL in sys_security_acl',
    ],
    fix: 'Add the correct role to the caller, or add the role to the REST API\'s "Requires role" field.',
    prevention: 'Test REST APIs with both admin and restricted users during development.',
  },
  {
    id: 'REST002',
    category: 'scripted_rest',
    title: 'Scripted REST API returning 500 / Internal Server Error',
    symptoms: ['500', 'internal server error', 'rest 500', 'api error'],
    root_causes: [
      'Unhandled exception in the REST API script',
      'Missing null check on request parameters',
      'GlideRecord query throws an error',
      'JSON.parse fails on malformed input',
    ],
    diagnosis_steps: [
      '1. Check syslog for errors from the API name',
      '2. Look for the exact exception message in syslog',
      '3. Test with REST client (Postman/Insomnia) with minimal payload',
    ],
    fix: `Wrap the entire script body in try/catch:
\`\`\`javascript
try {
  // your logic
} catch(e) {
  gs.error('API Error: ' + e.message);
  response.setStatus(500);
  response.setBody({ status: 'error', message: e.message });
}
\`\`\``,
    prevention: 'Always wrap REST API scripts in try/catch. Validate all input parameters before use.',
  },

  // ── Performance ────────────────────────────────────────────────────────────
  {
    id: 'PERF001',
    category: 'performance',
    title: 'List view loading slowly',
    symptoms: ['slow list', 'list timeout', 'list loading', 'list slow', 'page takes long'],
    root_causes: [
      'List query has no index on the filtered/sorted field',
      'Business Rule fires on query for every record in the list',
      'Too many related list queries (N+1)',
      'Virtual/calculated fields with expensive scripts',
    ],
    diagnosis_steps: [
      '1. Open the list, right-click any column header → "Show Query" to see the encoded query',
      '2. Run analyze_performance (suggest_indexes mode) for the table',
      '3. Check for BRs with **When = query** on the table',
      '4. Check if there are calculated fields (sys_computed) on the table',
    ],
    fix: 'Add a DB index for the filtered/sorted fields. Remove or disable "on query" BRs. Cache calculated field values.',
    prevention: 'Always add DB indexes on fields that appear in list filters or sort orders.',
  },

  // ── Deployment / Update Sets ────────────────────────────────────────────────
  {
    id: 'DEP001',
    category: 'deployment',
    title: 'Update Set preview showing errors',
    symptoms: ['update set error', 'preview error', 'collision', 'update set conflict', 'deployment failed'],
    root_causes: [
      'Record already exists in target with a different sys_id',
      'Parent record referenced does not exist in target',
      'Customisation collision — same record changed in both instances',
    ],
    diagnosis_steps: [
      '1. Review each preview error — distinguish "collision" vs "missing parent"',
      '2. For collisions: decide whether to keep source or target version',
      '3. For missing parents: ensure dependent update sets are loaded first',
      '4. Check if the colliding record is a baseline SN record (avoid overwriting)',
    ],
    fix: `For collision errors:
- Accept remote: choose source version (your changes)
- Skip remote: keep target version
- For missing parents: load prerequisite update sets first

Recommended merge order:
1. Base configuration (sys_properties, system tables)
2. Data model changes (tables, fields)
3. Business logic (BRs, SIs, Flows)
4. UI layer (Client Scripts, Widgets)
5. Catalog and notifications`,
    prevention: 'Always preview update sets before committing. Test in a lower environment first.',
  },
  {
    id: 'DEP002',
    category: 'deployment',
    title: 'Script works in dev but not in production',
    symptoms: ['works in dev', 'not in prod', 'different behavior', 'environment difference'],
    root_causes: [
      'Hardcoded sys_ids that differ between instances',
      'sys_property not set in production',
      'Role exists in dev but not prod',
      'Table or field exists in dev but not in prod (missing update set)',
    ],
    diagnosis_steps: [
      '1. Search the script for 32-character hex strings (hardcoded sys_ids)',
      '2. Check all sys_properties the script reads — are they in prod?',
      '3. Verify all roles used in gs.hasRole() exist in prod',
      '4. Check the update set includes all dependent records',
    ],
    fix: 'Replace all hardcoded sys_ids with gs.getProperty() lookups or query-by-name. Ensure all sys_properties are in the update set.',
    prevention: 'Run review_script before every deployment — it flags hardcoded sys_ids.',
  },

  // ── Security ───────────────────────────────────────────────────────────────
  {
    id: 'SEC001',
    category: 'security',
    title: 'Users seeing records they should not see',
    symptoms: ['data leak', 'wrong records', 'too much access', 'unauthorized records', 'acl bypass'],
    root_causes: [
      'ACL condition is too permissive',
      'ACL is checking roles incorrectly',
      'List query is not filtered by user context',
      'Admin override is enabled on the record',
    ],
    diagnosis_steps: [
      '1. Log in as the affected user and reproduce the issue',
      '2. Navigate to Security > Access Control Rules for the table',
      '3. Use the "ACL Tester" (elevate to security_admin, then test ACL) to check which rule grants access',
      '4. Check if the user has the `admin` or `security_admin` role',
    ],
    fix: 'Tighten the ACL condition. Use `gs.getUserID()` in ACL conditions to restrict to own records.',
    prevention: 'Always test ACLs as a non-admin user. Use the ACL Tester tool during development.',
  },

  // ── ATF ────────────────────────────────────────────────────────────────────
  {
    id: 'ATF001',
    category: 'atf',
    title: 'ATF test failing unexpectedly',
    symptoms: ['atf failing', 'test failing', 'automated test', 'test suite error'],
    root_causes: [
      'Test data dependency — record created in one test is needed in another',
      'Business Rule fires during test and changes the record unexpectedly',
      'Test was written against dev data that doesn\'t exist in target',
      'Test uses hardcoded sys_ids',
    ],
    diagnosis_steps: [
      '1. Click on the failed step to see the exact assertion error',
      '2. Check if the test creates its own data or relies on existing records',
      '3. Check if BRs are interfering — try disabling BRs for the test run',
      '4. Look for hardcoded sys_ids in the test steps',
    ],
    fix: 'Make each test self-contained (create and clean up its own data). Avoid hardcoded sys_ids in tests.',
    prevention: 'Each ATF test should create its own records and clean them up at the end.',
  },

  // ── General ────────────────────────────────────────────────────────────────
  {
    id: 'GEN001',
    category: 'general',
    title: 'Script Include method not found',
    symptoms: ['not a function', 'method not found', 'si method error', 'typeerror', 'is not a function'],
    root_causes: [
      'Method name is misspelled',
      'Script Include was not saved/active',
      'Wrong Script Include name in the constructor call',
      'Method is inside initialize() instead of on the prototype',
    ],
    diagnosis_steps: [
      '1. Open the SI and verify the method exists and is spelled correctly',
      '2. Check the SI is **Active = true**',
      '3. Verify the SI name in `new ScriptIncludeName()` matches exactly',
      '4. Ensure methods are on the `prototype`, not inside `initialize()`',
    ],
    fix: 'Verify SI name, method name, and active status. Ensure the method is defined on the prototype object.',
    prevention: 'Use generate_script to scaffold Script Includes with the correct prototype pattern.',
  },
  {
    id: 'GEN002',
    category: 'general',
    title: 'GlideRecord.get() not finding a record',
    symptoms: ['record not found', 'gr.get null', 'gliderecord empty', 'no record returned'],
    root_causes: [
      'sys_id is wrong or from a different instance',
      'Record is inactive and query doesn\'t include inactive',
      'Table name is wrong',
      'get() returns false (not null) — result not checked',
    ],
    diagnosis_steps: [
      '1. Log the sys_id and verify it exists in the target table',
      '2. Check if the record is active — `gr.addActiveQuery()` excludes inactive by default in some tables',
      '3. Verify the table name is correct',
      '4. Always check: `if (gr.get(sysId)) { ... } else { gs.warn("Not found: " + sysId); }`',
    ],
    fix: `Always check the return value of get():
\`\`\`javascript
var gr = new GlideRecord('incident');
if (gr.get(sysId)) {
    // record found — use gr.field
} else {
    gs.warn('Record not found: ' + sysId);
    // handle missing record
}
\`\`\``,
    prevention: 'Always check gr.get() return value. Never assume a sys_id is valid without verification.',
  },
];

export class IssueGuide {

  // ══════════════════════════════════════════════════════════════════════════
  // Diagnose from symptom description
  // ══════════════════════════════════════════════════════════════════════════
  diagnose(symptom, category) {
    const symptomLower = symptom.toLowerCase();
    const matches = ISSUES.filter(issue => {
      if (category && issue.category !== category) return false;
      return issue.symptoms.some(s => symptomLower.includes(s)) ||
             symptomLower.includes(issue.id.toLowerCase()) ||
             issue.title.toLowerCase().split(' ').filter(w => w.length > 4).some(w => symptomLower.includes(w));
    });

    if (!matches.length) {
      return {
        matched: false,
        symptom,
        message: 'No exact match found. Here are general debugging steps:',
        general_steps: [
          '1. Check syslog for errors related to the script/table name (use find_sys_logs tool)',
          '2. Verify the artifact is Active = true',
          '3. Test with an admin user — if it works for admin, the issue is role/ACL-based',
          '4. Add gs.info() or console.log() to narrow down where the issue occurs',
          '5. Use review_script to check for common anti-patterns',
          '6. Try running health_check_instance to find instance-wide issues',
        ],
        all_categories: [...new Set(ISSUES.map(i => i.category))],
        suggestion: 'Try calling list_common_issues with a category to browse known issues.',
      };
    }

    return {
      matched:       true,
      symptom,
      match_count:   matches.length,
      best_match:    matches[0],
      other_matches: matches.slice(1).map(m => ({ id: m.id, title: m.title, category: m.category })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Get a specific issue by ID
  // ══════════════════════════════════════════════════════════════════════════
  getIssue(id) {
    return ISSUES.find(i => i.id === id) ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // List all issues, optionally filtered by category
  // ══════════════════════════════════════════════════════════════════════════
  listIssues(category) {
    const filtered = category ? ISSUES.filter(i => i.category === category) : ISSUES;
    const byCategory = {};
    for (const issue of filtered) {
      if (!byCategory[issue.category]) byCategory[issue.category] = [];
      byCategory[issue.category].push({ id: issue.id, title: issue.title });
    }
    return {
      total:       filtered.length,
      categories:  Object.keys(byCategory),
      by_category: byCategory,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Generate a guided fix walkthrough
  // ══════════════════════════════════════════════════════════════════════════
  getGuidedFix(issueId) {
    const issue = this.getIssue(issueId);
    if (!issue) return { error: `Issue ${issueId} not found. Use list_common_issues to browse.` };

    return {
      issue_id:        issue.id,
      category:        issue.category,
      title:           issue.title,
      symptoms:        issue.symptoms,
      root_causes:     issue.root_causes,
      diagnosis_steps: issue.diagnosis_steps,
      fix:             issue.fix,
      prevention:      issue.prevention,
      related_issues:  (issue.related ?? []).map(id => {
        const rel = this.getIssue(id);
        return rel ? { id: rel.id, title: rel.title } : null;
      }).filter(Boolean),
      tools_to_use: this._suggestTools(issue),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: suggest relevant MCP tools for an issue
  // ══════════════════════════════════════════════════════════════════════════
  _suggestTools(issue) {
    const tools = [];
    if (issue.category === 'business_rule')    tools.push('review_script', 'find_sys_logs', 'explore_table');
    if (issue.category === 'performance')      tools.push('analyze_performance', 'find_sys_logs');
    if (issue.category === 'portal_widget')    tools.push('find_sys_logs', 'find_widget', 'analyze_portal');
    if (issue.category === 'notification')     tools.push('analyze_notifications');
    if (issue.category === 'catalog')          tools.push('explore_table', 'find_sys_logs');
    if (issue.category === 'scripted_rest')    tools.push('find_sys_logs', 'review_script');
    if (issue.category === 'security')         tools.push('get_table_acls', 'explore_table');
    if (issue.category === 'atf')              tools.push('generate_atf_tests');
    if (issue.category === 'deployment')       tools.push('review_script', 'health_check_instance');
    return [...new Set(tools)];
  }
}
