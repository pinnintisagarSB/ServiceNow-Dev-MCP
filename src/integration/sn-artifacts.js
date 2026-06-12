/**
 * ServiceNow Artifact Builder for Bidirectional Integrations
 *
 * Creates all SN-side artifacts via Table API:
 *   1. Correlation & retry tables (custom tables)
 *   2. Sync-flag field on the target table (sys_dictionary)
 *   3. sys_properties for field mapping config
 *   4. Outbound REST Message + HTTP Methods
 *   5. Business Rule (outbound trigger)
 *   6. Scripted REST API + operation (inbound endpoint)
 *   7. UI Action ("Sync Now" button)
 *   8. Client Script (sync status display)
 */

import { logger } from '../utils/logger.js';

export class SNArtifactBuilder {
  constructor(sn) {
    this.sn = sn;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Correlation table
  // ══════════════════════════════════════════════════════════════════════════
  async createCorrelationTable(plan) {
    const { name, label, description } = plan.correlation_table;
    logger.step(`Creating correlation table: ${name}`);

    // Check if exists
    const existing = await this.sn.get('sys_db_object', { sysparm_query: `name=${name}`, sysparm_limit: '1' });
    if (existing.length) {
      logger.info(`  Table ${name} already exists — skipping`);
      return existing[0].sys_id;
    }

    const tableRec = await this.sn.post('sys_db_object', {
      name,
      label,
      is_extendable: false,
      super_class:   { table: 'sys_db_object', value: '' },  // extends nothing (base table)
      sys_scope:     { value: 'global' },
    });
    const tableSysId = tableRec.sys_id;
    logger.ok(`  Table ${name} created (${tableSysId})`);

    // Add fields
    for (const f of plan.correlation_table.fields) {
      await this._addDictEntry(name, f);
    }

    return tableSysId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Retry / error table
  // ══════════════════════════════════════════════════════════════════════════
  async createRetryTable(plan) {
    const { name, label, description } = plan.retry_table;
    logger.step(`Creating retry/error table: ${name}`);

    const existing = await this.sn.get('sys_db_object', { sysparm_query: `name=${name}`, sysparm_limit: '1' });
    if (existing.length) { logger.info(`  Already exists`); return existing[0].sys_id; }

    const rec = await this.sn.post('sys_db_object', { name, label });
    for (const f of plan.retry_table.fields) await this._addDictEntry(name, f);
    logger.ok(`  Retry table ${name} created`);
    return rec.sys_id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Sync-in-progress flag on target SN table
  // ══════════════════════════════════════════════════════════════════════════
  async addSyncFlag(plan) {
    const { table, name, type, label, description } = plan.sync_flag_field;
    if (!table) return null;
    logger.step(`Adding sync flag field ${name} to ${table}`);

    const existing = await this.sn.get('sys_dictionary', {
      sysparm_query: `name=${table}^element=${name}`,
      sysparm_limit: '1',
    });
    if (existing.length) { logger.info(`  Field already exists`); return existing[0].sys_id; }

    const rec = await this.sn.post('sys_dictionary', {
      name: table,
      element: name,
      column_label: label,
      internal_type: 'boolean',
      comments: description,
      default_value: 'false',
      active: true,
    });
    logger.ok(`  Sync flag field added`);
    return rec.sys_id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. sys_properties for field mapping
  // ══════════════════════════════════════════════════════════════════════════
  async createSysProperty(plan) {
    const { name, value, description } = plan.sys_property;
    logger.step(`Setting sys_property: ${name}`);

    const existing = await this.sn.get('sys_properties', { sysparm_query: `name=${name}`, sysparm_limit: '1' });
    if (existing.length) {
      await this.sn.patch('sys_properties', existing[0].sys_id, { value });
      logger.ok(`  Property updated`);
      return existing[0].sys_id;
    }
    const rec = await this.sn.post('sys_properties', { name, value, description, type: 'string', suffix: 'string' });
    logger.ok(`  Property created`);
    return rec.sys_id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Outbound REST Message + HTTP Method
  // ══════════════════════════════════════════════════════════════════════════
  async createOutboundRest(plan, targetPlatformUrl, targetApiKey) {
    if (!plan.outbound_a_to_b) return null;
    const prefix   = plan.meta.prefix;
    const msgName  = plan.outbound_a_to_b.artifacts?.outbound_rest_message ?? `u_${prefix}_outbound`;
    const target   = plan.meta.platformB;
    const baseUrl  = targetPlatformUrl ?? `https://${target}.example.com`;

    logger.step(`Creating Outbound REST Message: ${msgName}`);

    const existing = await this.sn.get('sys_rest_message', { sysparm_query: `name=${msgName}`, sysparm_limit: '1' });
    let msgSysId;
    if (existing.length) {
      msgSysId = existing[0].sys_id;
      logger.info(`  REST message already exists`);
    } else {
      const msg = await this.sn.post('sys_rest_message', {
        name:                   msgName,
        rest_endpoint:          baseUrl,
        authentication_type:    'basic',
        description:            `Outbound REST integration to ${target} for ${prefix}`,
        use_mutual_auth:        false,
      });
      msgSysId = msg.sys_id;
      logger.ok(`  REST message created (${msgSysId})`);
    }

    // Create the POST HTTP method for create/update
    await this._createRestMethod(msgSysId, msgName, target, prefix, plan.meta.tableB);

    return msgSysId;
  }

  async _createRestMethod(msgSysId, msgName, target, prefix, targetTable) {
    const methodName = 'create_or_update';
    const existing   = await this.sn.get('sys_rest_message_fn', {
      sysparm_query: `rest_message=${msgSysId}^function_name=${methodName}`,
      sysparm_limit: '1',
    });
    if (existing.length) return existing[0].sys_id;

    // Generate the endpoint path based on platform
    const endpoint = this._endpointTemplate(target, targetTable, prefix);

    const rec = await this.sn.post('sys_rest_message_fn', {
      rest_message:    msgSysId,
      function_name:   methodName,
      http_method:     'POST',
      rest_endpoint:   endpoint,
      content:         '${payload}',             // substitution variable
      description:     `Create or update record in ${target}`,
    });

    // Add substitution variables
    for (const varName of ['payload', 'correlation_id', 'source_sys_id']) {
      await this.sn.post('sys_rest_message_fn_var', {
        message_function: rec.sys_id,
        name:             varName,
        param_name:       varName,
        test_value:       '',
      }).catch(() => null);
    }

    logger.ok(`    HTTP method "${methodName}" created`);
    return rec.sys_id;
  }

  _endpointTemplate(target, table, prefix) {
    if (target === 'jira')       return `https://your-domain.atlassian.net/rest/api/3/issue`;
    if (target === 'salesforce') return `https://your-domain.my.salesforce.com/services/data/v59.0/sobjects/${table ?? 'Case'}`;
    if (target === 'servicenow') return `https://your-instance.service-now.com/api/x_snmig/${prefix}_rev/sync`;
    return `https://api.${target}.example.com/sync`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Business Rule (outbound trigger SN→external)
  // ══════════════════════════════════════════════════════════════════════════
  async createBusinessRule(plan) {
    if (plan.meta.platformA !== 'servicenow' && plan.outbound_a_to_b) {
      // SN is platform B — so outbound from SN is b_to_a direction
    }
    const snIsSource = plan.meta.platformA === 'servicenow';
    if (!snIsSource && plan.meta.platformB !== 'servicenow') return null;

    const prefix   = plan.meta.prefix;
    const table    = snIsSource ? plan.meta.tableA : plan.meta.tableB;
    const target   = snIsSource ? plan.meta.platformB : plan.meta.platformA;
    const brName   = `${prefix}_sync_outbound`;
    const msgName  = plan.outbound_a_to_b?.artifacts?.outbound_rest_message ?? `u_${prefix}_outbound`;
    const correlTable = plan.correlation_table.name;
    const propKey     = plan.sys_property.name;
    const retryTable  = plan.retry_table.name;
    const triggerPlan = snIsSource ? plan.outbound_a_to_b?.trigger : plan.outbound_b_to_a?.trigger;
    const condition   = this._buildBrCondition(triggerPlan?.conditions ?? []);
    const events      = triggerPlan?.events ?? ['insert', 'update'];

    logger.step(`Creating Business Rule: ${brName} on ${table}`);

    const existing = await this.sn.get('sys_script', {
      sysparm_query: `name=${brName}^collection=${table}`,
      sysparm_limit: '1',
    });
    if (existing.length) { logger.info('  BR already exists'); return existing[0].sys_id; }

    const script = this._businessRuleScript({ prefix, table, target, msgName, correlTable, propKey, retryTable });

    const rec = await this.sn.post('sys_script', {
      name:           brName,
      collection:     table,
      description:    `Sync ${table} records to ${target} when conditions are met`,
      action_insert:  events.includes('insert'),
      action_update:  events.includes('update'),
      action_delete:  false,
      when:           'after',
      order:          '100',
      active:         true,
      condition:      condition,
      script:         script,
    });

    logger.ok(`  Business Rule created (${rec.sys_id})`);
    return rec.sys_id;
  }

  _buildBrCondition(conditions) {
    if (!conditions.length) return 'current.u_sync_in_progress != true';
    return ['current.u_sync_in_progress != true', ...conditions].join(' && ');
  }

  _businessRuleScript({ prefix, table, target, msgName, correlTable, propKey, retryTable }) {
    return `
(function executeRule(current, previous /*null when async*/) {

    // ── Loop prevention ────────────────────────────────────────────────────
    if (current.u_sync_in_progress == true) return;

    // ── Build payload from field map ───────────────────────────────────────
    var fieldMapJson = gs.getProperty('${propKey}', '{}');
    var fieldMap = JSON.parse(fieldMapJson);
    var payload = { _sn_sys_id: current.sys_id.toString(), _sn_table: '${table}' };
    for (var snField in fieldMap) {
        if (fieldMap.hasOwnProperty(snField)) {
            payload[fieldMap[snField]] = current.getValue(snField) || '';
        }
    }

    // ── Find or create correlation record ──────────────────────────────────
    var corr = new GlideRecord('${correlTable}');
    corr.addQuery('u_record_sys_id_a', current.sys_id);
    corr.addQuery('u_platform_b', '${target}');
    corr.query();

    var externalId = corr.next() ? corr.getValue('u_record_id_b') : null;
    if (externalId) payload._external_id = externalId;

    // ── Call Outbound REST ─────────────────────────────────────────────────
    try {
        var msg = new sn_ws.RESTMessageV2('${msgName}', 'create_or_update');
        msg.setStringParameterNoEscape('payload', JSON.stringify(payload));
        msg.setStringParameterNoEscape('correlation_id', externalId || '');
        msg.setStringParameterNoEscape('source_sys_id', current.sys_id.toString());
        msg.setHttpTimeout(30000);

        var response   = msg.execute();
        var status     = response.getStatusCode();
        var body       = response.getBody();

        if (status >= 200 && status < 300) {
            var respObj = JSON.parse(body || '{}');
            var extId   = respObj.id || respObj.key || respObj.sys_id || externalId;

            // ── Update correlation table ───────────────────────────────────
            if (!corr.isValidRecord()) {
                corr.initialize();
                corr.u_platform_a      = 'servicenow';
                corr.u_table_a         = '${table}';
                corr.u_record_sys_id_a = current.sys_id;
                corr.u_platform_b      = '${target}';
                corr.u_record_id_b     = extId;
                corr.u_sync_enabled    = true;
            } else {
                corr.u_record_id_b = extId;
                corr.u_sync_error  = '';
            }
            corr.u_last_sync       = new GlideDateTime();
            corr.u_sync_direction  = 'a_to_b';
            corr.update();

            gs.info('${prefix} sync OK: SN ' + current.sys_id + ' → ${target} ' + extId);
        } else {
            throw new Error('HTTP ' + status + ': ' + body);
        }
    } catch (e) {
        gs.error('${prefix} sync FAILED for ' + current.sys_id + ': ' + e.message);

        // ── Write to retry table ───────────────────────────────────────────
        var retry = new GlideRecord('${retryTable}');
        retry.initialize();
        retry.u_source_platform = 'servicenow';
        retry.u_source_id       = current.sys_id;
        retry.u_target_platform = '${target}';
        retry.u_payload         = JSON.stringify(payload);
        retry.u_error           = e.message;
        retry.u_retry_count     = 0;
        retry.u_next_retry      = new GlideDateTime();
        retry.u_resolved        = false;
        retry.insert();

        if (corr.isValidRecord()) {
            corr.u_sync_error = e.message.substring(0, 4000);
            corr.update();
        }
    }

})(current, previous);
`.trim();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. Scripted REST API (inbound endpoint — external → SN)
  // ══════════════════════════════════════════════════════════════════════════
  async createInboundRestApi(plan) {
    if (!plan.inbound_sn_api) return null;
    const { api_name, api_path, sn_table, corr_table, field_map_prop } = plan.inbound_sn_api;

    logger.step(`Creating Scripted REST API: ${api_name}`);

    // sys_ws_definition
    const existing = await this.sn.get('sys_ws_definition', {
      sysparm_query: `name=${api_name}`,
      sysparm_limit: '1',
    });
    let apiSysId;
    if (existing.length) {
      apiSysId = existing[0].sys_id;
      logger.info('  API already exists');
    } else {
      const api = await this.sn.post('sys_ws_definition', {
        name:               api_name,
        service_id:         api_name.replace(/_/g, '-'),
        short_description:  `Inbound sync endpoint for ${plan.meta.prefix}`,
        active:             true,
        enforce_acl:        false,
      });
      apiSysId = api.sys_id;
      logger.ok(`  Scripted REST API created (${apiSysId})`);
    }

    // sys_ws_operation (POST handler)
    const opExisting = await this.sn.get('sys_ws_operation', {
      sysparm_query: `web_service_definition=${apiSysId}^http_method=POST`,
      sysparm_limit: '1',
    });
    if (!opExisting.length) {
      await this.sn.post('sys_ws_operation', {
        web_service_definition: apiSysId,
        name:                   'sync',
        http_method:            'POST',
        operation_uri:          '/sync',
        short_description:      'Receive sync payload from partner platform',
        active:                 true,
        script:                 this._inboundApiScript({ sn_table, corr_table, field_map_prop, plan }),
        requires_authentication: true,
        requires_acl_authorization: false,
        produces: 'application/json',
        consumes: 'application/json',
      });
      logger.ok('  POST operation created');
    }

    return apiSysId;
  }

  _inboundApiScript({ sn_table, corr_table, field_map_prop, plan }) {
    const prefix = plan.meta.prefix;
    const src    = plan.meta.platformA === 'servicenow' ? plan.meta.platformB : plan.meta.platformA;

    return `
(function process(request, response) {

    var body = request.body.data || {};
    var externalId = body._external_id || body.id || body.key || body.Id || '';
    var snSysId    = body._sn_sys_id || '';

    // ── Load field map from sys_properties ────────────────────────────────
    var fieldMapJson = gs.getProperty('${field_map_prop}', '{}');
    var fieldMap     = JSON.parse(fieldMapJson);   // { snField: extField }
    var inverted     = {};
    for (var snF in fieldMap) {
        if (fieldMap.hasOwnProperty(snF)) inverted[fieldMap[snF]] = snF;
    }

    // ── Find the SN record ─────────────────────────────────────────────────
    var gr = new GlideRecord('${sn_table}');
    var found = false;

    if (snSysId) {
        found = gr.get(snSysId);
    }

    if (!found && externalId) {
        var corr = new GlideRecord('${corr_table}');
        corr.addQuery('u_record_id_b', externalId);
        corr.addQuery('u_platform_b', '${src}');
        corr.query();
        if (corr.next()) {
            found = gr.get(corr.getValue('u_record_sys_id_a'));
        }
    }

    if (!found) {
        response.setStatus(404);
        response.setBody({ status: 'error', message: 'Record not found', external_id: externalId });
        return;
    }

    // ── Loop prevention ────────────────────────────────────────────────────
    if (gr.getValue('u_sync_in_progress') === 'true') {
        response.setStatus(200);
        response.setBody({ status: 'skipped', reason: 'sync_in_progress' });
        return;
    }

    // ── Apply field mappings ───────────────────────────────────────────────
    try {
        gr.u_sync_in_progress = true;

        for (var extField in inverted) {
            if (inverted.hasOwnProperty(extField) && body.hasOwnProperty(extField)) {
                var snField = inverted[extField];
                gr.setValue(snField, body[extField] || '');
            }
        }

        gr.update();
        gr.u_sync_in_progress = false;
        gr.update();

        // ── Update correlation ─────────────────────────────────────────────
        var corr2 = new GlideRecord('${corr_table}');
        corr2.addQuery('u_record_sys_id_a', gr.sys_id);
        corr2.query();
        if (corr2.next()) {
            corr2.u_last_sync      = new GlideDateTime();
            corr2.u_sync_direction = 'b_to_a';
            corr2.u_sync_error     = '';
            corr2.update();
        }

        gs.info('${prefix} inbound sync OK: ${src} ' + externalId + ' → SN ' + gr.sys_id);
        response.setStatus(200);
        response.setBody({ status: 'updated', sys_id: gr.getUniqueValue() });

    } catch (e) {
        gs.error('${prefix} inbound sync FAILED: ' + e.message);
        response.setStatus(400);
        response.setBody({ status: 'error', message: e.message });
    }

})(request, response);
`.trim();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. UI Action ("Sync Now" button)
  // ══════════════════════════════════════════════════════════════════════════
  async createUiAction(plan) {
    const snIsSource = plan.meta.platformA === 'servicenow';
    if (!snIsSource && plan.meta.platformB !== 'servicenow') return null;

    const table  = snIsSource ? plan.meta.tableA : plan.meta.tableB;
    const target = snIsSource ? plan.meta.platformB : plan.meta.platformA;
    const prefix = plan.meta.prefix;
    const name   = `Sync to ${target.charAt(0).toUpperCase() + target.slice(1)}`;
    const msgName = plan.outbound_a_to_b?.artifacts?.outbound_rest_message ?? `u_${prefix}_outbound`;

    logger.step(`Creating UI Action: ${name} on ${table}`);

    const existing = await this.sn.get('sys_ui_action', {
      sysparm_query: `name=${name}^table=${table}`,
      sysparm_limit: '1',
    });
    if (existing.length) { logger.info('  UI Action already exists'); return existing[0].sys_id; }

    const rec = await this.sn.post('sys_ui_action', {
      name,
      table,
      action_name:  `${prefix}_sync_now`,
      form_button:  true,
      list_action:  false,
      client:       false,
      active:       true,
      hint:         `Manually trigger sync to ${target}`,
      condition:    'current.u_sync_in_progress != true',
      script: `
(function() {
    if (current.u_sync_in_progress == true) {
        gs.addErrorMessage('Sync is already in progress for this record.');
        action.setRedirectURL(current);
        return;
    }

    var fieldMapJson = gs.getProperty('${plan.sys_property.name}', '{}');
    var fieldMap     = JSON.parse(fieldMapJson);
    var payload      = { _sn_sys_id: current.sys_id.toString(), _sn_table: '${table}' };
    for (var snField in fieldMap) {
        if (fieldMap.hasOwnProperty(snField)) payload[fieldMap[snField]] = current.getValue(snField) || '';
    }

    try {
        var msg = new sn_ws.RESTMessageV2('${msgName}', 'create_or_update');
        msg.setStringParameterNoEscape('payload', JSON.stringify(payload));
        msg.setStringParameterNoEscape('correlation_id', '');
        msg.setStringParameterNoEscape('source_sys_id', current.sys_id.toString());
        msg.setHttpTimeout(30000);
        var response = msg.execute();
        var status   = response.getStatusCode();

        if (status >= 200 && status < 300) {
            gs.addInfoMessage('Record synced to ${target} successfully.');
        } else {
            gs.addErrorMessage('Sync failed (HTTP ' + status + '). Check the error log table.');
        }
    } catch (e) {
        gs.addErrorMessage('Sync error: ' + e.message);
    }

    action.setRedirectURL(current);
})();
`.trim(),
    });

    logger.ok(`  UI Action created (${rec.sys_id})`);
    return rec.sys_id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. Client Script (sync status indicator)
  // ══════════════════════════════════════════════════════════════════════════
  async createClientScript(plan) {
    const snIsSource = plan.meta.platformA === 'servicenow';
    if (!snIsSource && plan.meta.platformB !== 'servicenow') return null;

    const table  = snIsSource ? plan.meta.tableA : plan.meta.tableB;
    const target = snIsSource ? plan.meta.platformB : plan.meta.platformA;
    const prefix = plan.meta.prefix;
    const name   = `${prefix}_sync_status_display`;

    logger.step(`Creating Client Script: ${name}`);

    const existing = await this.sn.get('sys_script_client', {
      sysparm_query: `name=${name}^table=${table}`,
      sysparm_limit: '1',
    });
    if (existing.length) { logger.info('  Client Script already exists'); return existing[0].sys_id; }

    const rec = await this.sn.post('sys_script_client', {
      name,
      table,
      type:        'onLoad',
      ui_type:     '0',     // Desktop
      active:      true,
      description: `Show sync status banner for ${target} integration`,
      script: `
function onLoad() {
    var syncInProgress = g_form.getValue('u_sync_in_progress');
    if (syncInProgress === 'true' || syncInProgress === true) {
        g_form.addInfoMessage('Sync with ${target} is currently in progress. The form will refresh when complete.');
    }

    // Show a notice if there is a sync error recorded in the correlation table
    // (This relies on a display business rule populating a scratch variable — optional enhancement)
}
`.trim(),
    });

    logger.ok(`  Client Script created (${rec.sys_id})`);
    return rec.sys_id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Run all SN artifacts in correct dependency order
  // ══════════════════════════════════════════════════════════════════════════
  async buildAll(plan, opts = {}) {
    const results = {};
    logger.header(`Building ServiceNow artifacts for ${plan.meta.prefix}`);

    results.correlation_table = await this.createCorrelationTable(plan);
    results.retry_table       = await this.createRetryTable(plan);
    results.sync_flag         = await this.addSyncFlag(plan);
    results.sys_property      = await this.createSysProperty(plan);

    if (plan.meta.platformA === 'servicenow' || plan.meta.platformB === 'servicenow') {
      results.outbound_rest = await this.createOutboundRest(plan, opts.targetUrl, opts.targetApiKey);
      results.business_rule = await this.createBusinessRule(plan);
      results.inbound_api   = await this.createInboundRestApi(plan);
      results.ui_action     = await this.createUiAction(plan);
      results.client_script = await this.createClientScript(plan);
    }

    logger.success(`All SN artifacts created for ${plan.meta.prefix}`);
    return results;
  }

  // ── Helper: add a field to a custom table ─────────────────────────────────
  async _addDictEntry(tableName, field) {
    const existing = await this.sn.get('sys_dictionary', {
      sysparm_query: `name=${tableName}^element=${field.name}`,
      sysparm_limit: '1',
    });
    if (existing.length) return;

    await this.sn.post('sys_dictionary', {
      name:          tableName,
      element:       field.name,
      column_label:  field.label ?? field.name,
      internal_type: this._snType(field.type),
      default_value: field.default !== undefined ? String(field.default) : undefined,
      max_length:    field.max_length ?? (field.type === 'string' ? 255 : undefined),
      mandatory:     false,
      active:        true,
    }).catch(e => logger.warn(`  Could not add field ${field.name}: ${e.message}`));
  }

  _snType(type) {
    const map = {
      string:          'string',
      boolean:         'boolean',
      integer:         'integer',
      url:             'url',
      glide_date_time: 'glide_date_time',
    };
    return map[type] ?? 'string';
  }
}
