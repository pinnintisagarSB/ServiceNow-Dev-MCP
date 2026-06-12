/**
 * ServiceNow Script Builder
 *
 * Generates every common SN artifact type with industry best practices,
 * correct patterns, and appropriate boilerplate — ready to paste or deploy.
 *
 * Covered types:
 *   Business Rule, Script Include, Client Script, UI Action, UI Policy,
 *   Scheduled Job, Scripted REST API, Fix Script, Transform Script,
 *   Mail Script, Service Portal Widget, Flow (Action / Subflow stub)
 */

// ── Best-practice rule catalogue (used by code-reviewer too) ─────────────
export const BEST_PRACTICES = {
  business_rule: [
    'Run "after" unless you must modify current before save — use "before" sparingly',
    'Always check conditions in the Condition field, not just in script',
    'Use gs.nil() to check for empty values — not == null or == ""',
    'Never do a GlideRecord query inside a BR that fires on every update — use conditions to limit scope',
    'Use current.setWorkflow(false) when updating child records to prevent cascading BRs',
    'Always wrap REST calls in try/catch and log failures with gs.error()',
    'Use async BRs for long-running operations — never block the transaction',
    'Avoid hardcoded sys_ids — look up by name/number or use sys_properties',
  ],
  script_include: [
    'Use prototype-based class pattern — not function-per-function',
    'Always set type = "Class"',
    'Add JSDoc comments on every public method',
    'Return meaningful values — not just true/false',
    'Keep SI focussed on one domain — single responsibility',
    'Never reference gs.getCurrentSession() at class definition time — only inside methods',
  ],
  client_script: [
    'Use g_form.getValue() / g_form.setValue() — never DOM manipulation',
    'Use g_form.addInfoMessage() / g_form.addErrorMessage() for user feedback',
    'Avoid synchronous GlideAjax — always use callbacks',
    'Use g_form.setMandatory() instead of checking fields in onSubmit',
    'Test for null before calling methods: if (g_form.getValue("field")) { ... }',
    'Do not put business logic in client scripts — keep it server-side',
  ],
  scripted_rest: [
    'Always set response.setContentType("application/json")',
    'Return consistent error envelope: { status, message, data }',
    'Validate all request parameters before processing',
    'Use requires_authentication: true unless public API',
    'Log every request with gs.info() including path and caller',
    'Rate-limit expensive operations — check caller role/IP',
  ],
};

export class ScriptBuilder {

  // ══════════════════════════════════════════════════════════════════════════
  // Business Rule
  // ══════════════════════════════════════════════════════════════════════════
  buildBusinessRule({ name, table, when = 'after', events = ['insert','update'], condition, description, logic, async: isAsync = false }) {
    const eventsComment = events.join(', ');
    const asyncNote     = isAsync ? '\n// NOTE: This BR runs async — "current" is a snapshot, updates here do NOT affect the original transaction.' : '';
    const conditionBlock = condition
      ? `\n// Condition (also set in the Condition field on the BR record):\n// ${condition}\n`
      : '';

    const script = `
/**
 * Business Rule: ${name}
 * Table:  ${table}
 * When:   ${when}  |  Events: ${eventsComment}${isAsync ? '  |  Async: true' : ''}
 * ${description ?? ''}
 */
(function executeRule(current, previous /*null when async*/) {${asyncNote}
${conditionBlock}
    // ── Guard: skip if triggered by another script to prevent loops ─────────
    if (current.u_processing == true) return;

    try {
        // ── Your logic here ────────────────────────────────────────────────
        ${logic ?? '// TODO: implement'}

    } catch (e) {
        gs.error('${name} BR failed for ' + current.getTableName() + ' ' + current.getUniqueValue() + ': ' + e.message);
        // Do NOT re-throw — let the transaction complete
    }

})(current, previous);
`.trim();

    return {
      type:          'business_rule',
      name,
      table,
      when,
      action_insert: events.includes('insert'),
      action_update: events.includes('update'),
      action_delete: events.includes('delete'),
      run_async:     isAsync,
      condition:     condition ?? '',
      script,
      best_practices: BEST_PRACTICES.business_rule,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Script Include
  // ══════════════════════════════════════════════════════════════════════════
  buildScriptInclude({ name, description, methods = [], client_callable = false, scope = 'global' }) {
    const methodBodies = methods.map(m => `
    /**
     * ${m.description ?? m.name}
     * @param {${m.paramType ?? 'object'}} params
     * @returns {${m.returnType ?? 'object'}}
     */
    ${m.name}: function(${m.params ?? 'params'}) {
        var result = { success: false, data: null, error: null };
        try {
            // TODO: implement ${m.name}
            ${m.body ?? ''}
            result.success = true;
        } catch(e) {
            gs.error('${name}.${m.name} failed: ' + e.message);
            result.error = e.message;
        }
        return result;
    }`).join(',\n');

    const script = `
/**
 * Script Include: ${name}
 * ${description ?? ''}
 * Client callable: ${client_callable}
 * Scope: ${scope}
 *
 * Best practices applied:
 *  - Prototype class pattern
 *  - Every method wrapped in try/catch with gs.error logging
 *  - Returns consistent { success, data, error } envelope
 */
var ${name} = Class.create();

${name}.prototype = {
    type: '${name}',

    /**
     * Constructor — initialise any shared state here.
     */
    initialize: function() {
        // this.someService = new AnotherScriptInclude();
    },
${methodBodies}

};
`.trim();

    return {
      type:             'script_include',
      name,
      description,
      script,
      client_callable,
      access:           client_callable ? 'public' : 'package_private',
      best_practices:   BEST_PRACTICES.script_include,
      deploy_fields: {
        name,
        script,
        client_callable,
        active: true,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Client Script
  // ══════════════════════════════════════════════════════════════════════════
  buildClientScript({ name, table, type = 'onChange', field, description, logic }) {
    const typeSignatures = {
      onLoad:    'function onLoad() {',
      onChange:  `function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n    if (isLoading || newValue === '') return;`,
      onSubmit:  'function onSubmit() {',
      onCellEdit:'function onCellEdit(sysForm, tableName, oldValue, newValue, sysId, sysColumn) {',
    };

    const sig = typeSignatures[type] ?? `function ${type}() {`;

    const script = `
/**
 * Client Script: ${name}
 * Table: ${table}  |  Type: ${type}${field ? '  |  Field: ' + field : ''}
 * ${description ?? ''}
 */
${sig}
    try {
        // ── Your logic here ────────────────────────────────────────────────
        ${logic ?? '// TODO: implement'}

    } catch(e) {
        // Client scripts cannot use gs.error — log to console for debugging
        console.error('${name}: ' + e.message);
        // Optionally show user message:
        // g_form.addErrorMessage('An error occurred. Please contact your administrator.');
    }
}
`.trim();

    return {
      type:    'client_script',
      name,
      table,
      script_type: type,
      field:   field ?? '',
      script,
      ui_type: '0',   // Desktop
      best_practices: BEST_PRACTICES.client_script,
      deploy_fields: {
        name,
        table,
        type,
        field: field ?? '',
        script,
        active: true,
        ui_type: '0',
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI Action
  // ══════════════════════════════════════════════════════════════════════════
  buildUiAction({ name, table, client = false, condition, hint, description, logic }) {
    let script;
    if (client) {
      script = `
/**
 * UI Action: ${name} (CLIENT-SIDE)
 * Table: ${table}
 * ${description ?? ''}
 * NOTE: Client UI Actions run in the browser. Use GlideAjax for server calls.
 */
function ${name.replace(/\s+/g, '_').toLowerCase()}() {
    // Confirm with user before irreversible actions
    if (!confirm('Are you sure?')) return;

    try {
        ${logic ?? '// TODO: implement'}

        // To submit the form after client action:
        // gsftSubmit(null, g_form.getFormElement(), 'sysverb_update');
    } catch(e) {
        console.error('${name}: ' + e.message);
        g_form.addErrorMessage('Action failed: ' + e.message);
    }
}
`.trim();
    } else {
      script = `
/**
 * UI Action: ${name} (SERVER-SIDE)
 * Table: ${table}
 * ${description ?? ''}
 */
(function() {
    try {
        // 'current' is the record being viewed
        ${logic ?? '// TODO: implement'}

        // Redirect back to the record after processing:
        action.setRedirectURL(current);

        gs.addInfoMessage('${name} completed successfully.');
    } catch(e) {
        gs.error('${name} UI Action failed: ' + e.message);
        gs.addErrorMessage('Action failed: ' + e.message);
        action.setRedirectURL(current);
    }
})();
`.trim();
    }

    return {
      type:      'ui_action',
      name,
      table,
      client,
      condition: condition ?? '',
      hint,
      script,
      best_practices: [
        'Set a meaningful Hint — shown as tooltip on the button',
        'Add a Condition to show the button only when relevant',
        'Server UI Actions have access to current and action objects',
        'Client UI Actions run in the browser — use GlideAjax for server calls',
        'Always call action.setRedirectURL() in server actions',
      ],
      deploy_fields: {
        name, table, client, condition: condition ?? '',
        hint: hint ?? name, script, active: true,
        form_button: true, list_action: false,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scripted REST API
  // ══════════════════════════════════════════════════════════════════════════
  buildScriptedRestApi({ name, apiPath, verb = 'GET', description, requiresAuth = true, logic, requestParams = [] }) {
    const paramDocs  = requestParams.map(p => ` *   ${p.name} (${p.type ?? 'string'}): ${p.description ?? ''}`).join('\n');
    const paramParse = requestParams.map(p =>
      `    var ${p.name} = request.queryParams.${p.name} ? request.queryParams.${p.name}[0] : ${p.default !== undefined ? JSON.stringify(p.default) : "null"};`
    ).join('\n');
    const paramValidate = requestParams.filter(p => p.required).map(p =>
      `    if (!${p.name}) { response.setStatus(400); response.setBody({ status: 'error', message: '${p.name} is required' }); return; }`
    ).join('\n');

    const script = `
/**
 * Scripted REST API: ${name}
 * Path:   /api/${apiPath}
 * Verb:   ${verb}
 * Auth:   ${requiresAuth}
 * ${description ?? ''}
 *
 * Request parameters:
${paramDocs || ' *   (none)'}
 */
(function process(request, response) {

    // ── Always set content type ────────────────────────────────────────────
    response.setContentType('application/json');

    // ── Log incoming request ───────────────────────────────────────────────
    gs.info('${name} API called by ' + gs.getUserName() + ' from ' + request.getHeader('X-Forwarded-For'));

    // ── Parse and validate parameters ─────────────────────────────────────
${paramParse}
${paramValidate}

    try {
        // ── Your logic here ───────────────────────────────────────────────
        var data = {};
        ${logic ?? '// TODO: implement'}

        // ── Success response ──────────────────────────────────────────────
        response.setStatus(200);
        response.setBody({
            status:  'success',
            message: 'OK',
            data:    data,
        });

    } catch (e) {
        gs.error('${name} API error: ' + e.message);
        response.setStatus(500);
        response.setBody({
            status:  'error',
            message: 'Internal server error',
            detail:  gs.getProperty('glide.ui.show_stack_trace') === 'true' ? e.message : 'Contact your administrator',
        });
    }

})(request, response);
`.trim();

    return {
      type:    'scripted_rest_api',
      name,
      api_path:  apiPath,
      verb,
      description,
      requires_authentication: requiresAuth,
      script,
      best_practices: BEST_PRACTICES.scripted_rest,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scheduled Job
  // ══════════════════════════════════════════════════════════════════════════
  buildScheduledJob({ name, description, schedule = 'daily', logic }) {
    const scheduleMap = {
      hourly:   '0 0 * * * ?',
      daily:    '0 0 2 * * ?',    // 2am daily
      weekly:   '0 0 2 ? * MON',  // Monday 2am
      monthly:  '0 0 2 1 * ?',    // 1st of month 2am
    };

    const script = `
/**
 * Scheduled Job: ${name}
 * Schedule: ${schedule}
 * ${description ?? ''}
 *
 * Best practices:
 *  - Log start/end with gs.info for audit trail
 *  - Use setLimit() on all GlideRecord queries
 *  - Handle errors per-record so one failure doesn't stop the job
 */

gs.info('[${name}] Job started at ' + new GlideDateTime());
var jobStartMs = new GlideDateTime().getNumericValue();
var processed  = 0;
var errors     = 0;

try {
    // ── Your logic here ───────────────────────────────────────────────────
    ${logic ?? '// TODO: implement'}

} catch (e) {
    gs.error('[${name}] Fatal error: ' + e.message);
    errors++;
}

var durationMs = new GlideDateTime().getNumericValue() - jobStartMs;
gs.info('[${name}] Job complete — processed: ' + processed + ', errors: ' + errors + ', duration: ' + (durationMs/1000).toFixed(1) + 's');
`.trim();

    return {
      type:        'scheduled_job',
      name,
      script,
      run_type:    'periodically',
      run_period:  scheduleMap[schedule] ?? schedule,
      description,
      deploy_fields: {
        name, script, active: true,
        run_type: 'periodically',
        run_period: scheduleMap[schedule] ?? schedule,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Fix Script (one-time data fix)
  // ══════════════════════════════════════════════════════════════════════════
  buildFixScript({ name, description, table, query, updateLogic, dryRun = true }) {
    const script = `
/**
 * Fix Script: ${name}
 * ${description ?? ''}
 * Table: ${table}
 * SAFE TO RUN: ${dryRun ? 'DRY RUN — no changes will be made' : 'LIVE — changes WILL be saved'}
 *
 * ALWAYS test with dryRun = true first!
 */

var DRY_RUN   = ${dryRun};
var processed = 0;
var changed   = 0;
var errors    = 0;

var gr = new GlideRecord('${table}');
gr.addEncodedQuery('${query ?? 'active=true'}');
gr.setLimit(${dryRun ? '10' : '10000'});
gr.query();

gs.info('[${name}] Found ' + gr.getRowCount() + ' records to process. DRY_RUN=' + DRY_RUN);

while (gr.next()) {
    processed++;
    try {
        // ── Apply fix logic ────────────────────────────────────────────────
        ${updateLogic ?? '// TODO: gr.field = newValue;'}

        if (DRY_RUN) {
            gs.info('[${name}] DRY RUN: would update ' + gr.getUniqueValue());
        } else {
            gr.setWorkflow(false);   // Suppress BRs during bulk fix
            gr.autoSysFields(false); // Preserve sys_updated_on
            gr.update();
            changed++;
            gs.info('[${name}] Updated ' + gr.getUniqueValue());
        }
    } catch(e) {
        errors++;
        gs.error('[${name}] Error on ' + gr.getUniqueValue() + ': ' + e.message);
    }
}

gs.info('[${name}] Done — processed: ' + processed + ', changed: ' + changed + ', errors: ' + errors + (DRY_RUN ? ' [DRY RUN]' : ''));
`.trim();

    return { type: 'fix_script', name, script, description, dry_run: dryRun };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Service Portal Widget stub
  // ══════════════════════════════════════════════════════════════════════════
  buildWidget({ name, description, dataFields = [] }) {
    const fieldInits = dataFields.map(f => `        data.${f.name} = ''; // ${f.description ?? f.name}`).join('\n');

    return {
      type:        'sp_widget',
      name,
      description,
      template:    `<div class="${name.toLowerCase().replace(/\s+/g,'-')}-widget">\n  <p>{{data.message}}</p>\n</div>`,
      css:         `.${name.toLowerCase().replace(/\s+/g,'-')}-widget { padding: 16px; }`,
      client_script: `function($scope) {\n  var c = this;\n  // c.data.fieldName is available here\n}`,
      server_script: `(function() {\n    data.message = 'Hello from ${name}';\n${fieldInits}\n})();`,
      demo_data:    JSON.stringify(Object.fromEntries(dataFields.map(f => [f.name, f.sample ?? '']))),
      best_practices: [
        'Use c.data.fieldName — not $scope — for two-way binding',
        'Load data server-side in the server script, not via GlideAjax from client',
        'Use spUtil.addErrorMessage() / spUtil.addInfoMessage() for feedback',
        'Cache expensive server queries with GlideCacheManager',
      ],
    };
  }
}
