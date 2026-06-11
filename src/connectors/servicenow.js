import { getSnToken, buildSnHeaders } from '../utils/sn-auth.js';
import { logger } from '../utils/logger.js';
import { httpFetch, sleep } from '../utils/http.js';

export class ServiceNowConnector {
  constructor() {
    this._auth = null;
  }

  async init() {
    this._auth = await getSnToken();
    logger.success(`ServiceNow connected → ${this._auth.instanceUrl}`);
    return this;
  }

  get baseUrl() { return this._auth.instanceUrl; }

  headers() {
    return buildSnHeaders(this._auth.token, this._auth.authType);
  }

  async request(method, table, body = null, sysId = null, params = {}) {
    const url = new URL(
      sysId
        ? `${this.baseUrl}/api/now/table/${table}/${sysId}`
        : `${this.baseUrl}/api/now/table/${table}`
    );
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res  = await httpFetch(url.toString(), {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`SN ${method} ${table} → HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    return json.result;
  }

  async getCount(table, query = '') {
    const url = new URL(`${this.baseUrl}/api/now/stats/${table}`);
    url.searchParams.set('sysparm_count', 'true');
    if (query) url.searchParams.set('sysparm_query', query);
    const res  = await httpFetch(url.toString(), { method: 'GET', headers: this.headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`SN stats ${table} → HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    return parseInt(json.result?.stats?.count ?? '0', 10);
  }

  get(table, params = {})              { return this.request('GET', table, null, null, params); }
  getById(table, sysId, params = {})   { return this.request('GET', table, null, sysId, params); }
  post(table, body)                    { return this.request('POST', table, body); }
  patch(table, sysId, body)            { return this.request('PATCH', table, body, sysId); }
  delete(table, sysId)                 { return this.request('DELETE', table, null, sysId); }

  // ── Import Set (push records + trigger transform) ──────────────────────────
  async pushToImportSet(stagingTable, record) {
    const url = `${this.baseUrl}/api/now/import/${stagingTable}`;
    const res  = await httpFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(record),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Import Set push failed: ${JSON.stringify(json.error ?? json)}`);
    return json.result;
  }

  // ── Bulk load — insert directly into staging WITHOUT triggering transform.
  // Massively faster than pushToImportSet when migrating thousands of records;
  // call executeTransform() once afterwards to run the transform map on the batch.
  async bulkLoad(stagingTable, records) {
    const inserted = [];
    for (const rec of records) {
      try {
        const row = await this.post(stagingTable, rec);
        inserted.push(row.sys_id);
      } catch (e) {
        inserted.push({ error: e.message, record: rec });
      }
    }
    return inserted;
  }

  // Trigger a transform map run over all unprocessed staging rows for a given import set
  async executeTransform(transformMapSysId, importSetSysId = null) {
    const body = importSetSysId
      ? { sys_transform_map: transformMapSysId, sys_import_set: importSetSysId }
      : { sys_transform_map: transformMapSysId };
    const res = await httpFetch(`${this.baseUrl}/api/now/transform/run`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Transform run failed: ${JSON.stringify(json)}`);
    return json.result ?? json;
  }

  // Preview a transform on a single staging row without persisting
  async previewTransform(stagingTable, stagingSysId, transformMapSysId) {
    // No first-party preview endpoint; simulate by fetching the staging row +
    // transform map fields and returning what would be written.
    const row = await this.getById(stagingTable, stagingSysId, { sysparm_display_value: 'true' });
    const fieldMaps = await this.findFieldMaps(transformMapSysId);
    const projected = {};
    for (const fm of fieldMaps) {
      projected[fm.target_field] = row[fm.source_field] ?? null;
    }
    return { source: row, projected };
  }

  // ── Schema discovery ───────────────────────────────────────────────────────

  // Returns a list of candidate SN tables ranked by label/name similarity to the hint.
  // Searches across all non-system, non-staging tables — fully live, nothing hardcoded.
  async suggestTargetTable(hint) {
    const norm = s => (s ?? '').toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const hintNorm  = norm(hint);
    const hintWords = new Set(hintNorm.split(' ').filter(w => w.length > 2));

    // Pull tables that are visible (non sys_ internal, non staging) — limit 500
    const tables = await this.get('sys_db_object', {
      sysparm_query: 'super_class.name!=sys_import_set_row^nameNOT LIKEsys_^nameNOT LIKEx_snc^is_extendable=true^ORis_extendable=false',
      sysparm_fields: 'name,label',
      sysparm_limit: '500',
    });

    const scored = tables.map(t => {
      const nameNorm  = norm(t.name);
      const labelNorm = norm(t.label ?? t.name);
      let score = 0;

      if (nameNorm  === hintNorm || labelNorm === hintNorm) score = 100;
      else if (nameNorm.includes(hintNorm) || labelNorm.includes(hintNorm)) score = 80;
      else if (hintNorm.includes(nameNorm) && nameNorm.length > 3) score = 75;
      else {
        const labelWords = new Set(labelNorm.split(' ').filter(w => w.length > 2));
        const nameWords  = new Set(nameNorm.split('_').filter(w => w.length > 2));
        const overlap = [...hintWords].filter(w => labelWords.has(w) || nameWords.has(w)).length;
        score = overlap > 0
          ? Math.round((overlap / Math.max(hintWords.size, Math.max(labelWords.size, 1))) * 60)
          : 0;
      }

      return { table: t.name, label: t.label, score };
    });

    return scored
      .filter(t => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  async getTableSchema(tableName) {
    return this.get('sys_dictionary', {
      sysparm_query: `name=${tableName}^active=true^internal_type!=collection`,
      sysparm_fields: 'element,column_label,internal_type,reference,mandatory,max_length',
      sysparm_limit: '300',
    });
  }

  async getImportSetRowSysId() {
    const rows = await this.get('sys_db_object', {
      sysparm_query: 'name=sys_import_set_row',
      sysparm_fields: 'sys_id,name',
      sysparm_limit: '1',
    });
    if (!rows.length) throw new Error('Could not find sys_import_set_row in this instance');
    return rows[0].sys_id;
  }

  // ── Artifact builders (Phase 4) ────────────────────────────────────────────
  async createStagingTable(name, label, superClassSysId) {
    return this.post('sys_db_object', { name, label, super_class: superClassSysId });
  }

  async createStagingColumn(tableName, element, columnLabel, internalType, maxLength) {
    const body = { name: tableName, element, column_label: columnLabel, internal_type: internalType, mandatory: 'false' };
    if (maxLength) body.max_length = String(maxLength);
    return this.post('sys_dictionary', body);
  }

  async createTransformMap(name, sourceTable, targetTable, opts = {}) {
    return this.post('sys_transform_map', {
      name,
      source_table: sourceTable,
      target_table: targetTable,
      enforce_mandatory_fields: String(opts.enforceMandatory ?? true),
      run_business_rules:       String(opts.runBusinessRules ?? true),
      copy_empty_fields:        String(opts.copyEmptyFields ?? false),
    });
  }

  async createFieldMap(transformMapSysId, sourceField, targetField, coalesce = false, referenceValue = null, script = null) {
    const body = {
      map: transformMapSysId,
      source_field: sourceField,
      target_field: targetField,
      coalesce: String(coalesce),
      use_source_script: script ? 'true' : 'false',
    };
    if (script)          body.script = script;
    if (referenceValue)  body.reference_value = referenceValue;
    return this.post('sys_transform_entry', body);
  }

  async createTransformScript(transformMapSysId, fieldName, script, order = 100) {
    return this.post('sys_transform_script', {
      map: transformMapSysId,
      field_name: fieldName,
      when: 'onBefore',
      script,
      order: String(order),
    });
  }

  async createDataSource(name, stagingTableName) {
    return this.post('sys_data_source', {
      name,
      import_set_table_name: stagingTableName,
      type: 'Custom (Load by Script)',
      format: 'JSON',
      file_retrieval_method: 'REST',
    });
  }

  async createRestMessage(name, endpoint) {
    return this.post('sys_rest_message', {
      name,
      rest_endpoint: endpoint,
      authentication_type: 'no_authentication',
    });
  }

  async createRestMessageFn(restMessageSysId, fnName, endpoint, method = 'get') {
    return this.post('sys_rest_message_fn', {
      rest_message: restMessageSysId,
      function_name: fnName,
      http_method: method,
      rest_endpoint: endpoint,
    });
  }

  async addRestMessageHeader(fnSysId, name, value) {
    return this.post('sys_rest_message_fn_headers', {
      rest_message_function: fnSysId,
      name,
      value,
    });
  }

  async createScriptInclude(name, script, description = '') {
    return this.post('sys_script_include', {
      name,
      description,
      active: true,
      access: 'public',
      api_name: name,
      script,
    });
  }

  // ── Update Sets ───────────────────────────────────────────────────────────
  async createUpdateSet(name, description = '') {
    return this.post('sys_update_set', {
      name,
      description,
      state:       'in progress',
      is_default:  'false',
    });
  }

  async setCurrentUpdateSet(sysId) {
    // Set via user preference so all subsequent changes land in this update set
    const existing = await this.get('sys_user_preference', {
      sysparm_query:  'name=sys_update_set',
      sysparm_fields: 'sys_id',
      sysparm_limit:  '1',
    });
    if (existing.length) {
      return this.patch('sys_user_preference', existing[0].sys_id, { value: sysId });
    }
    return this.post('sys_user_preference', { name: 'sys_update_set', value: sysId });
  }

  async getUpdateSet(sysId) {
    return this.getById('sys_update_set', sysId, { sysparm_display_value: 'true' });
  }

  async listUpdateSets() {
    return this.get('sys_update_set', {
      sysparm_query:  'state=in progress^ORstate=build',
      sysparm_fields: 'sys_id,name,state,description,sys_created_on,sys_created_by',
      sysparm_limit:  '20',
      sysparm_display_value: 'true',
    });
  }

  async completeUpdateSet(sysId) {
    return this.patch('sys_update_set', sysId, { state: 'complete' });
  }

  // ── Existence checks (idempotency) ────────────────────────────────────────
  async findStagingTable(name) {
    const rows = await this.get('sys_db_object', {
      sysparm_query:  `name=${name}`,
      sysparm_fields: 'sys_id,name,label',
      sysparm_limit:  '1',
    });
    return rows[0] ?? null;
  }

  async findStagingColumns(tableName) {
    const rows = await this.get('sys_dictionary', {
      sysparm_query:  `name=${tableName}^active=true`,
      sysparm_fields: 'sys_id,element,column_label,internal_type',
      sysparm_limit:  '300',
    });
    return rows;
  }

  async findTransformMap(name) {
    const rows = await this.get('sys_transform_map', {
      sysparm_query:  `name=${name}`,
      sysparm_fields: 'sys_id,name,source_table,target_table',
      sysparm_limit:  '1',
    });
    return rows[0] ?? null;
  }

  async findFieldMaps(transformMapSysId) {
    return this.get('sys_transform_entry', {
      sysparm_query:  `map=${transformMapSysId}`,
      sysparm_fields: 'sys_id,source_field,target_field,coalesce,use_source_script',
      sysparm_limit:  '300',
    });
  }

  async findTransformScripts(transformMapSysId) {
    return this.get('sys_transform_script', {
      sysparm_query:  `map=${transformMapSysId}`,
      sysparm_fields: 'sys_id,field_name,when,order',
      sysparm_limit:  '100',
    });
  }

  async findDataSource(name) {
    const rows = await this.get('sys_data_source', {
      sysparm_query:  `name=${name}`,
      sysparm_fields: 'sys_id,name',
      sysparm_limit:  '1',
    });
    return rows[0] ?? null;
  }

  async findRestMessage(name) {
    const rows = await this.get('sys_rest_message', {
      sysparm_query:  `name=${name}`,
      sysparm_fields: 'sys_id,name',
      sysparm_limit:  '1',
    });
    return rows[0] ?? null;
  }

  // ── Flow Designer (Phase F5) ──────────────────────────────────────────────
  // Uses Table API with the correct field names confirmed from live schema inspection.
  // Key findings from schema discovery on zetechnodemo4:
  //   sys_hub_action_instance: action_type (ref), action_inputs (glide_var JSON), order
  //   sys_hub_trigger_instance: flow, trigger_type, table, trigger_definition (ref)
  //   sys_hub_trigger_definition: DefaultTriggerDef = 3d442150435d311057c35a5088b8f205
  //   action_type lookup: nameCONTAINS works; exact name= query returns empty due to SN encoding

  // DefaultTriggerDef sys_id (universal OOB record — same across all instances)
  static TRIGGER_DEF_DEFAULT = '3d442150435d311057c35a5088b8f205';

  async createFlow(name, description, appScopeId = null) {
    const internal = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const body = { name, description, run_as: 'user', active: 'false', internal_name: internal };
    if (appScopeId) body.sys_scope = appScopeId;
    return this.post('sys_hub_flow', body);
  }

  async createFlowVariable(flowSysId, varName, varType, isInput = false, isOutput = false) {
    const table = isInput ? 'sys_hub_flow_input' : 'sys_hub_flow_output';
    try {
      return await this.post(table, { flow: flowSysId, name: varName, label: varName, type: varType, mandatory: 'false' });
    } catch (e) {
      logger.warn(`Flow variable skipped (${varName}): ${e.message}`);
      return { skipped: true, name: varName };
    }
  }

  async createFlowTrigger(flowSysId, triggerType, triggerTable = null, condition = null) {
    const typeMap = {
      record: 'record', scheduled: 'scheduled', manual: 'on_demand',
      inbound_api: 'on_demand', on_demand: 'on_demand',
      RecordTriggeredFlow: 'record', ScheduledFlow: 'scheduled', AutoLaunchedFlow: 'on_demand',
    };
    const snType = typeMap[triggerType] ?? 'on_demand';

    // Look up the trigger definition for this type — DefaultTriggerDef covers record triggers
    let triggerDefSysId = ServiceNowConnector.TRIGGER_DEF_DEFAULT;
    if (snType === 'scheduled') {
      // Try to find a "Daily" or "Scheduled" trigger definition
      const defs = await this.get('sys_hub_trigger_definition', {
        sysparm_query:  'nameLIKEScheduled^ORnameLIKEDaily',
        sysparm_fields: 'sys_id,name',
        sysparm_limit:  '1',
      }).catch(() => []);
      if (defs[0]) triggerDefSysId = defs[0].sys_id;
    }

    const body = { flow: flowSysId, trigger_type: snType, trigger_definition: triggerDefSysId };
    if (triggerTable) body.table     = triggerTable;
    if (condition)    body.condition = condition;
    return this.post('sys_hub_trigger_instance', body);
  }

  // Look up action type sys_id by name (using CONTAINS query which works in SN)
  async lookupActionType(name) {
    // Use STARTSWITH to avoid false positives from CONTAINS
    const results = await this.get('sys_hub_action_type_base', {
      sysparm_query:  `nameSTARTSWITH${name}`,
      sysparm_fields: 'sys_id,name',
      sysparm_limit:  '5',
    });
    // Prefer an exact match if multiple results
    const exact = results.find(r => r.name === name);
    return (exact ?? results[0])?.sys_id ?? null;
  }

  static flowActionTypeName(logicalType) {
    // These names match the OOB sys_hub_action_type_base records
    const map = {
      create_record:  'Create Record',
      update_record:  'Update Record',
      delete_record:  'Delete Record',
      lookup_record:  'Look Up Record',
      condition:      'Run Script',   // IF blocks → script in Flow Designer Table API path
      script:         'Run Script',
      notification:   'Send Notification',
      outbound_rest:  'REST Step',
      subflow:        'Flow Logic - Subflow',
    };
    return map[logicalType] ?? 'Run Script';
  }

  async createActionInstance(flowSysId, stepName, logicalActionType, order = 100, inputs = {}) {
    const actionTypeName  = ServiceNowConnector.flowActionTypeName(logicalActionType);
    const actionTypeSysId = await this.lookupActionType(actionTypeName);

    if (!actionTypeSysId) {
      throw new Error(`Action type "${actionTypeName}" not found in sys_hub_action_type_base — add step manually`);
    }

    // action_inputs is a glide_var field — must be a JSON string, not an object
    const body = {
      flow:         flowSysId,
      action_type:  actionTypeSysId,
      order:        String(order),
      action_inputs: Object.keys(inputs).length ? JSON.stringify(inputs) : '',
    };
    return this.post('sys_hub_action_instance', body);
  }

  async createFlowBlock(flowSysId, stepName, logicalActionType, script = null, order = 100) {
    const inputs = script ? { script } : {};
    return this.createActionInstance(flowSysId, stepName, logicalActionType, order, inputs);
  }

  async activateFlow(flowSysId) {
    // Activation via Table API patch
    return this.patch('sys_hub_flow', flowSysId, { active: 'true' });
  }

  // ── Choice synchronization ───────────────────────────────────────────────
  // Ensures target picklist values exist in sys_choice; creates missing ones.
  async syncChoices(table, element, values) {
    const existing = await this.get('sys_choice', {
      sysparm_query:  `name=${table}^element=${element}`,
      sysparm_fields: 'sys_id,value,label',
      sysparm_limit:  '500',
    });
    const have = new Set(existing.map(c => c.value));
    const created = [];
    for (const v of values) {
      if (!v || have.has(v)) continue;
      try {
        const c = await this.post('sys_choice', {
          name: table, element, value: v, label: v, inactive: 'false',
        });
        created.push(c.value);
      } catch (e) {
        logger.warn(`sys_choice create ${table}.${element}=${v} failed: ${e.message}`);
      }
    }
    return { existing: existing.length, created };
  }

  // ── Target table ACL pre-flight ──────────────────────────────────────────
  async checkTableAccess(table) {
    // The /api/now/security/acl endpoint isn't universal; use heuristic GET+POST probe.
    const out = { read: false, create: false, update: false, delete: false };
    try { await this.get(table, { sysparm_limit: '1', sysparm_fields: 'sys_id' }); out.read = true; } catch (_) {}
    try {
      const r = await this.post(table, { sys_id: '00000000000000000000000000000000' });
      out.create = true;
      if (r.sys_id) await this.delete(table, r.sys_id);
    } catch (e) {
      if (/403/.test(e.message)) out.create = false;
      else out.create = true; // payload-related error means we *could* write
    }
    return out;
  }

  // ── Super-class walk (extension chain) ───────────────────────────────────
  async getTableExtensionChain(table) {
    const chain = [];
    let current = table;
    for (let i = 0; i < 10 && current; i++) {
      const rows = await this.get('sys_db_object', {
        sysparm_query: `name=${current}`,
        sysparm_fields: 'name,label,super_class.name',
        sysparm_limit: '1',
        sysparm_display_value: 'true',
      });
      if (!rows.length) break;
      chain.push({ name: current, label: rows[0].label });
      current = rows[0]['super_class.name'] || null;
    }
    return chain;
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  async uploadAttachment(tableName, sysId, fileName, buffer, mime = 'application/octet-stream') {
    const url = `${this.baseUrl}/api/now/attachment/file?table_name=${encodeURIComponent(tableName)}&table_sys_id=${sysId}&file_name=${encodeURIComponent(fileName)}`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': mime },
      body: buffer,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`SN attachment upload failed: ${JSON.stringify(json)}`);
    return json.result;
  }

  // ── Journal entry (comments / work_notes) ────────────────────────────────
  async addJournalEntry(table, sysId, fieldName, value) {
    return this.patch(table, sysId, { [fieldName]: value });
  }

  // ── Error log table ──────────────────────────────────────────────────────
  async ensureErrorLogTable(stagingTable) {
    const name = `${stagingTable}_errors`;
    const existing = await this.findStagingTable(name);
    if (existing) return existing;
    try {
      const parent = await this.get('sys_db_object', {
        sysparm_query: 'name=sys_metadata', sysparm_fields: 'sys_id', sysparm_limit: '1',
      });
      const tbl = await this.createStagingTable(name, `Errors – ${stagingTable}`, parent[0]?.sys_id);
      for (const col of [
        { e: 'u_source_id',  l: 'Source ID',   t: 'string',     ml: 255  },
        { e: 'u_payload',    l: 'Payload',     t: 'string',     ml: 8000 },
        { e: 'u_error',      l: 'Error',       t: 'string',     ml: 4000 },
        { e: 'u_phase',      l: 'Phase',       t: 'string',     ml: 40   },
      ]) await this.createStagingColumn(name, col.e, col.l, col.t, col.ml);
      return tbl;
    } catch (e) {
      logger.warn(`Could not create error log table ${name}: ${e.message}`);
      return null;
    }
  }
  async logError(stagingTable, { source_id, payload, error, phase }) {
    const name = `${stagingTable}_errors`;
    try {
      await this.post(name, {
        u_source_id: String(source_id ?? '').substring(0, 255),
        u_payload:   JSON.stringify(payload ?? {}).substring(0, 8000),
        u_error:     String(error ?? '').substring(0, 4000),
        u_phase:     phase ?? 'transform',
      });
    } catch (_) { /* swallow — error logging must never throw */ }
  }

  // ── Cleanup old import set runs ──────────────────────────────────────────
  async cleanupOldImportSetRuns(daysOld = 30) {
    const cutoff = new Date(Date.now() - daysOld * 86400_000).toISOString().substring(0, 10);
    const runs = await this.get('sys_import_set_run', {
      sysparm_query: `sys_created_on<${cutoff}^state=complete`,
      sysparm_fields: 'sys_id',
      sysparm_limit: '500',
    });
    let deleted = 0, failed = 0;
    for (const r of runs) {
      try { await this.delete('sys_import_set_run', r.sys_id); deleted++; }
      catch (_) { failed++; }
    }
    return { deleted, failed, scanned: runs.length };
  }

  // ── Cross-session locking (sys_user_preference) ──────────────────────────
  async acquireMigrationLock(key, holderId) {
    const name = `sn_migration_lock:${key}`;
    const existing = await this.get('sys_user_preference', {
      sysparm_query: `name=${name}`, sysparm_fields: 'sys_id,value,sys_updated_on', sysparm_limit: '1',
    });
    if (existing.length) {
      // Treat lock as stale after 30 minutes
      const age = Date.now() - new Date(existing[0].sys_updated_on).getTime();
      if (age < 30 * 60 * 1000) return { acquired: false, heldBy: existing[0].value };
      await this.delete('sys_user_preference', existing[0].sys_id);
    }
    await this.post('sys_user_preference', { name, value: holderId });
    return { acquired: true };
  }
  async releaseMigrationLock(key) {
    const name = `sn_migration_lock:${key}`;
    const existing = await this.get('sys_user_preference', {
      sysparm_query: `name=${name}`, sysparm_fields: 'sys_id', sysparm_limit: '1',
    });
    if (existing.length) await this.delete('sys_user_preference', existing[0].sys_id);
  }

  // ── Watermark store (sys_user_preference) ────────────────────────────────
  async getWatermark(key) {
    const rows = await this.get('sys_user_preference', {
      sysparm_query: `name=sn_migration_watermark:${key}`, sysparm_fields: 'value', sysparm_limit: '1',
    });
    return rows[0]?.value ?? null;
  }
  async setWatermark(key, value) {
    const name = `sn_migration_watermark:${key}`;
    const rows = await this.get('sys_user_preference', {
      sysparm_query: `name=${name}`, sysparm_fields: 'sys_id', sysparm_limit: '1',
    });
    if (rows.length) return this.patch('sys_user_preference', rows[0].sys_id, { value });
    return this.post('sys_user_preference', { name, value });
  }

  // ── Reconciliation (target records by correlation_id) ────────────────────
  async findByCorrelationId(table, correlationId) {
    const rows = await this.get(table, {
      sysparm_query:  `correlation_id=${correlationId}`,
      sysparm_fields: 'sys_id,correlation_id',
      sysparm_limit:  '1',
    });
    return rows[0] ?? null;
  }
}
