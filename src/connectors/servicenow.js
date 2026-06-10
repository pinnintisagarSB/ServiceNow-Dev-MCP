import { getSnToken, buildSnHeaders } from '../utils/sn-auth.js';
import { logger } from '../utils/logger.js';

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

    const res  = await fetch(url.toString(), {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`SN ${method} ${table} → HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    return json.result;
  }

  get(table, params = {})              { return this.request('GET', table, null, null, params); }
  getById(table, sysId, params = {})   { return this.request('GET', table, null, sysId, params); }
  post(table, body)                    { return this.request('POST', table, body); }
  patch(table, sysId, body)            { return this.request('PATCH', table, body, sysId); }
  delete(table, sysId)                 { return this.request('DELETE', table, null, sysId); }

  // ── Import Set (push records + trigger transform) ──────────────────────────
  async pushToImportSet(stagingTable, record) {
    const url = `${this.baseUrl}/api/now/import/${stagingTable}`;
    const res  = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(record),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Import Set push failed: ${JSON.stringify(json.error ?? json)}`);
    return json.result;
  }

  // ── Schema discovery ───────────────────────────────────────────────────────
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

  async createTransformMap(name, sourceTable, targetTable) {
    return this.post('sys_transform_map', {
      name,
      source_table: sourceTable,
      target_table: targetTable,
      enforce_mandatory_fields: 'true',
      run_business_rules: 'true',
      copy_empty_fields: 'false',
    });
  }

  async createFieldMap(transformMapSysId, sourceField, targetField, coalesce = false, referenceValue = null) {
    const body = {
      map: transformMapSysId,
      source_field: sourceField,
      target_field: targetField,
      coalesce: String(coalesce),
      use_source_script: 'false',
    };
    if (referenceValue) body.reference_value = referenceValue;
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

  // ── Flow artifacts (Phase F5) ──────────────────────────────────────────────
  async createFlow(name, description, appScopeId = null) {
    const body = { name, description, active: false, run_as: 'system' };
    if (appScopeId) body.sys_scope = appScopeId;
    return this.post('sys_hub_flow', body);
  }

  async createFlowVariable(flowSysId, varName, varType, isInput = false, isOutput = false) {
    return this.post('sys_hub_flow_var', {
      flow: flowSysId,
      name: varName,
      type: varType,
      input: String(isInput),
      output: String(isOutput),
    });
  }

  async createFlowTrigger(flowSysId, triggerType, triggerTable = null) {
    const body = { flow: flowSysId, trigger_type: triggerType };
    if (triggerTable) body.trigger_table = triggerTable;
    return this.post('sys_hub_trigger_instance', body);
  }

  async createFlowBlock(flowSysId, stepName, actionType, script = null, order = 100) {
    const body = { flow: flowSysId, name: stepName, action_type: actionType, order: String(order) };
    if (script) body.script = script;
    return this.post('sys_hub_flow_block', body);
  }

  async createFlowConditionBranch(flowSysId, blockSysId, label, condition) {
    return this.post('sys_hub_condition_branch', {
      flow: flowSysId,
      block: blockSysId,
      label,
      condition,
    });
  }

  async activateFlow(flowSysId) {
    return this.patch('sys_hub_flow', flowSysId, { active: true });
  }
}
