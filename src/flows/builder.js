import { logger } from '../utils/logger.js';
import { FlowRetriever } from './retriever.js';

export class FlowBuilder {
  constructor(sn) {
    this.sn             = sn;
    this.manualList     = [];
    this.results        = {};
    this.subflowRegistry = {}; // name → sys_id, for cross-referencing within a session
  }

  // Determine if the flowStructure represents a subflow
  _isSubflow(flowStructure) {
    const t = (flowStructure.type ?? '').toLowerCase();
    return t === 'subflow' || t === 'autolaunchedflow' || flowStructure.isSubflow === true;
  }

  async build({ flowStructure, snTableName, fieldMappings, flowScope, appScopeId = null }) {
    const isSubflow = this._isSubflow(flowStructure);
    logger.header(`Phase F5 — Building ${isSubflow ? 'Subflow' : 'Flow'}: ${flowStructure.apiName}`);
    const results = {};

    if (flowStructure.isScreen) {
      logger.warn('Screen Flow detected — this must be built manually.');
      this.manualList.push({
        flow:   flowStructure.apiName,
        reason: 'Screen Flow — no SN automation equivalent; build as Service Portal widget or Service Catalog item',
      });
      results.manual = true;
      results.manual_reason = 'Screen Flow';
      return results;
    }

    // F5.1 Create flow / subflow record
    logger.step(`F5.1 Creating ${isSubflow ? 'subflow' : 'flow'} record...`);
    const flowName = flowScope ? `${flowScope}_${flowStructure.apiName}` : flowStructure.apiName;

    let flowRecord;
    if (isSubflow) {
      flowRecord = await this.sn.createSubflow(flowName, flowStructure.label ?? flowStructure.apiName, appScopeId);
    } else {
      flowRecord = await this.sn.createFlow(flowName, flowStructure.label ?? flowStructure.apiName, appScopeId);
    }

    const flowSysId = flowRecord?.sys_id ?? flowRecord?.id;
    if (!flowSysId) throw new Error(`${isSubflow ? 'Subflow' : 'Flow'} record created but sys_id is missing. Raw: ${JSON.stringify(flowRecord)}`);
    results.flow = { name: flowName, sys_id: flowSysId, type: isSubflow ? 'subflow' : 'flow' };
    this.subflowRegistry[flowStructure.apiName] = flowSysId;
    this.subflowRegistry[flowName]              = flowSysId;
    logger.success(`${isSubflow ? 'Subflow' : 'Flow'} record: ${flowName} (${flowSysId})`);

    // F5.2 Create variables (inputs/outputs for subflows, internal vars for flows)
    logger.step('F5.2 Creating flow variables...');
    let varCount = 0;
    for (const v of flowStructure.variables ?? []) {
      const snType = this._mapVarType(v.dataType);
      const res = await this.sn.createFlowVariable(flowSysId, v.name, snType, v.isInput ?? false, v.isOutput ?? false);
      if (!res?.skipped) varCount++;
    }
    logger.success(`Variables: ${varCount} created`);
    results.variables = varCount;

    // F5.3 Create trigger — skipped for subflows (they have no trigger)
    if (isSubflow) {
      logger.info('F5.3 Skipping trigger (subflows have no trigger)');
      results.trigger = 'none (subflow)';
    } else {
      logger.step('F5.3 Creating flow trigger...');
      const triggerType = FlowRetriever.mapTriggerType(flowStructure.type);
      const condition   = flowStructure.trigger?.filterConditions
        ? this._buildConditionString(flowStructure.trigger.filterConditions, fieldMappings)
        : null;
      const trigger = await this.sn.createFlowTrigger(flowSysId, triggerType, snTableName, condition);
      results.trigger = trigger?.sys_id ?? trigger?.id ?? 'created';
      logger.success(`Trigger: ${triggerType} on ${snTableName ?? '—'}`);
    }

    // F5.4 Create steps
    logger.step('F5.4 Creating flow steps...');
    let stepCount = 0, manualCount = 0, order = 100;

    for (const el of flowStructure.elements ?? []) {
      const desc = FlowRetriever.describeElement(el);

      if (el.kind === 'screen') {
        await this._insertTodoStub(flowSysId, el, order, 'Screen element — build as Service Catalog / Now Experience form');
        this.manualList.push({ flow: flowStructure.apiName, element: el.name, reason: 'Screen element', desc });
        logger.warn(`  TODO stub inserted: ${desc}`);
        manualCount++;
        order += 100;
        continue;
      }

      // Element explicitly marked as requiring manual build (e.g. Jira email/comment actions)
      if (el.can_auto === false) {
        const reason = el.manual_reason ?? 'Requires manual configuration in Workflow Studio';
        await this._insertTodoStub(flowSysId, el, order, reason);
        this.manualList.push({ flow: flowStructure.apiName, element: el.name ?? el.label, reason, desc });
        logger.warn(`  TODO stub inserted (manual): ${desc}`);
        manualCount++;
        order += 100;
        continue;
      }

      try {
        const logicalType = this._mapElementToActionType(el.kind);
        const inputs      = this._buildStepInputs(el, logicalType, fieldMappings, snTableName);
        await this.sn.createActionInstance(flowSysId, el.label ?? el.name, logicalType, order, inputs);
        logger.info(`  ✓ ${desc}`);
        stepCount++;
        order += 100;
      } catch (e) {
        // On failure, insert a TODO script stub so the position is preserved in the flow
        await this._insertTodoStub(flowSysId, el, order, e.message).catch(() => {});
        this.manualList.push({ flow: flowStructure.apiName, element: el.name ?? el.label, reason: e.message, desc });
        logger.warn(`  TODO stub inserted (manual): ${desc} — ${e.message}`);
        manualCount++;
        order += 100;
      }
    }

    logger.success(`Steps: ${stepCount} automated, ${manualCount} manual stubs inserted`);
    results.steps = { automated: stepCount, manual: manualCount };

    // F5.5 Activate flow
    logger.step('F5.5 Activating flow...');
    try {
      await this.sn.activateFlow(flowSysId);
      logger.success('Flow activated');
      results.activated = true;
    } catch (e) {
      logger.warn(`Flow activation failed — activate manually: ${e.message}`);
      results.activated = false;
      results.activation_error = e.message;
      this.manualList.push({ flow: flowName, reason: `Activate the flow manually in Workflow Studio (${e.message})` });
    }

    this.results = results;
    return results;
  }

  // Insert a visible TODO script stub so the developer knows exactly where to fill in
  async _insertTodoStub(flowSysId, el, order, reason) {
    const todoScript = [
      `// ⚠️ TODO: Implement logic for "${el.label ?? el.name}"`,
      `// Reason this step was not automated: ${reason}`,
      `// Original element kind: ${el.kind ?? 'unknown'}`,
      `// See the Manual Build Guide returned with this migration for instructions.`,
      `gs.info('Placeholder step — not yet implemented: ${(el.label ?? el.name ?? '').replace(/'/g, "\\'")}');`,
    ].join('\n');

    return this.sn.createActionInstance(
      flowSysId,
      `⚠️ TODO: ${el.label ?? el.name ?? 'Manual Step'}`,
      'script',
      order,
      { script: todoScript },
    ).catch(err => logger.warn(`Could not insert TODO stub for "${el.label ?? el.name}": ${err.message}`));
  }

  _mapElementToActionType(kind) {
    const map = {
      decision:     'condition',
      assignment:   'script',
      loop:         'script',
      recordCreate: 'create_record',
      recordUpdate: 'update_record',
      recordDelete: 'delete_record',
      recordLookup: 'lookup_record',
      subflow:      'subflow',
      // 'action' and any other kind → script stub with the action details
    };
    return map[kind] ?? 'script';
  }

  _mapVarType(sfDataType) {
    const map = {
      String:   'string',  Number:   'integer',   Boolean: 'boolean',
      Date:     'glide_date', DateTime: 'glide_date_time',
      Record:   'reference',  SObject:  'reference', Currency: 'currency',
    };
    return map[sfDataType] ?? 'string';
  }

  _buildStepInputs(el, logicalType, fieldMappings, snTableName) {
    // Subflow call: pass the subflow sys_id + any input assignments
    if (logicalType === 'subflow') {
      // Resolve subflow sys_id: check registry first, then el.subflowSysId, then el.flowName
      const subflowSysId = el.subflowSysId
        ?? this.subflowRegistry?.[el.flowName]
        ?? this.subflowRegistry?.[el.subflowName]
        ?? null;
      if (!subflowSysId) {
        // Generate a script stub that calls the subflow by name when sys_id isn't known
        const subflowRef = el.flowName ?? el.subflowName ?? 'unknown_subflow';
        el._overrideScript = [
          `// TODO: Call subflow "${subflowRef}"`,
          `// Replace 'subflow_internal_name' with the actual internal name after migration`,
          `// var outputs = sn_fd.FlowAPI.executeSubflow('${subflowRef.toLowerCase().replace(/[^a-z0-9]/g, '_')}', {});`,
          `gs.info('Subflow call placeholder: ${subflowRef}');`,
        ].join('\n');
        return { script: el._overrideScript };
      }
      const inputs = { subflow: subflowSysId };
      // Map any input parameters from the calling element
      (el.inputAssignments ?? el.inputParameters ?? []).forEach(p => {
        const snField = fieldMappings?.[p.field ?? p.name] ?? p.field ?? p.name;
        inputs[snField] = p.value ?? '';
      });
      return inputs;
    }

    if (logicalType === 'create_record' || logicalType === 'update_record') {
      const assignments = el.inputAssignments ?? el.inputParameters ?? [];
      if (assignments.length === 0) {
        // No field data — fall back to a script stub instead of an empty action
        // so the developer sees GlideRecord code with the right table pre-filled
        const op     = logicalType === 'create_record' ? 'insert' : 'update';
        const script = [
          `// TODO: set field values on ${snTableName ?? 'the target table'} before calling ${op}()`,
          `var gr = new GlideRecord('${snTableName ?? 'table_name'}');`,
          op === 'create_record' ? `gr.initialize();` : `gr.get(/* sys_id */);`,
          `// gr.field_name = 'value';`,
          `gr.${op}();`,
        ].join('\n');
        // Override logicalType to script so createActionInstance uses Run Script
        el._overrideScript = script;
        return { script };
      }
      const fields = {};
      assignments.forEach(p => {
        const snField = fieldMappings?.[p.field ?? p.name] ?? p.field ?? p.name;
        fields[snField] = p.value ?? '';
      });
      return { table: snTableName, fields };
    }

    if (logicalType === 'delete_record') {
      const script = [
        `// TODO: query and delete the record from ${snTableName ?? 'the target table'}`,
        `var gr = new GlideRecord('${snTableName ?? 'table_name'}');`,
        `gr.get(/* sys_id or query condition */);`,
        `gr.deleteRecord();`,
      ].join('\n');
      el._overrideScript = script;
      return { script };
    }

    if (logicalType === 'lookup_record') {
      const conditions = (el.filterConditions ?? el.filters ?? []).map(c => ({
        field:    fieldMappings?.[c.field ?? c.leftValueReference] ?? c.field ?? c.leftValueReference ?? '',
        operator: c.operator ?? 'EqualTo',
        value:    c.value ?? c.rightValue?.stringValue ?? '',
      }));
      if (conditions.length === 0) {
        // Generate a script stub for lookup with no conditions
        const script = [
          `// TODO: configure lookup conditions for ${snTableName ?? 'the target table'}`,
          `var gr = new GlideRecord('${snTableName ?? 'table_name'}');`,
          `// gr.addQuery('field', 'value');`,
          `gr.query();`,
          `if (gr.next()) {`,
          `  // use gr.sys_id, gr.field_name, etc.`,
          `}`,
        ].join('\n');
        el._overrideScript = script;
        return { script };
      }
      return { table: snTableName, conditions };
    }

    if (logicalType === 'condition') {
      const conditions = (el.rules ?? el.conditions ?? []).map(r => ({
        field:    fieldMappings?.[r.leftValueReference] ?? r.leftValueReference ?? '',
        operator: r.operator ?? 'EqualTo',
        value:    r.rightValue?.stringValue ?? r.rightValue?.elementReference ?? '',
      }));
      return { conditions };
    }

    // script / assignment / loop / action / unknown
    const script = this._generateScript(el, fieldMappings);
    if (script) return { script };
    return {};
  }

  _generateScript(el, fieldMappings) {
    if (el._overrideScript) return el._overrideScript;

    if (el.kind === 'assignment') {
      const lines = (el.assignmentItems ?? []).map(item => {
        const snField = fieldMappings?.[item.assignToReference] ?? item.assignToReference;
        const value   = item.value?.stringValue ?? item.value?.elementReference ?? item.value ?? '';
        return `current.${snField} = ${JSON.stringify(String(value))};`;
      });
      if (lines.length) return lines.join('\n') + '\ncurrent.update();';
      return `// TODO: assignment step "${el.label ?? el.name}" — add field assignments here\n// current.field_name = 'value';\n// current.update();`;
    }

    if (el.kind === 'loop') {
      return [
        `// TODO: Loop — "${el.label ?? el.name}"`,
        `// Collection: ${el.collectionReference ?? 'unknown'}`,
        `// Add loop body logic below:`,
        `// var item = /* current loop item */;`,
      ].join('\n');
    }

    if (el.kind === 'action') {
      const cfgLines = el.config
        ? Object.entries(el.config).map(([k, v]) => `//   ${k}: ${JSON.stringify(v)}`).join('\n')
        : '//   (no config available)';
      return [
        `// TODO: Action — "${el.label ?? el.name}"`,
        `// Original action type: ${el.raw_type ?? el.actionType ?? el.actionName ?? 'unknown'}`,
        `// Original configuration:`,
        cfgLines,
        `gs.info('Action placeholder: ${(el.label ?? el.name ?? '').replace(/'/g, "\\'")}');`,
      ].join('\n');
    }

    return null;
  }

  _buildConditionString(filterConditions, fieldMappings) {
    return (filterConditions ?? []).map(c => {
      const snField = fieldMappings?.[c.leftValueReference ?? c.field] ?? c.leftValueReference ?? c.field ?? '';
      const op      = this._mapOperator(c.operator ?? 'EqualTo');
      const val     = c.rightValue?.stringValue ?? c.rightValue?.elementReference ?? '';
      return `${snField}${op}${val}`;
    }).filter(Boolean).join('^');
  }

  _mapOperator(sfOp) {
    const map = {
      EqualTo: '=', NotEqualTo: '!=', GreaterThan: '>', GreaterThanOrEqualTo: '>=',
      LessThan: '<', LessThanOrEqualTo: '<=', Contains: 'CONTAINS',
      NotContain: 'DOES NOT CONTAIN', StartsWith: 'STARTSWITH',
      IsNull: 'ISEMPTY', IsNotNull: 'ISNOTEMPTY',
    };
    return map[sfOp] ?? '=';
  }

  printManualBuildGuide() {
    if (!this.manualList.length) return;
    logger.header('Phase F6 — Manual Build Guide');
    this.manualList.forEach((item, i) => {
      console.log(`\n${'━'.repeat(60)}`);
      console.log(`MANUAL BUILD ${i + 1}: ${item.element ?? item.flow}`);
      console.log(`${'━'.repeat(60)}`);
      console.log(`Flow:   ${item.flow}`);
      console.log(`Reason: ${item.reason}`);
      if (item.desc) console.log(`What:   ${item.desc}`);
      console.log('\nHow to build in ServiceNow Workflow Studio:');
      console.log('  1. Open Workflow Studio → find your flow → Edit');
      console.log('  2. Find the "⚠️ TODO" script step at the correct position');
      console.log('  3. Replace it with the appropriate action/step');
      console.log('  4. Configure inputs using the field mappings from Phase 3');
    });
  }

  printSummary() {
    logger.header('Flow Migration Summary');
    const r = this.results;
    if (r.manual) { logger.warn(`Full manual build required: ${r.manual_reason}`); return; }
    logger.success(`Flow created:  ${r.flow?.name} (${r.flow?.sys_id})`);
    logger.info(`Variables:     ${r.variables}`);
    logger.info(`Steps built:   ${r.steps?.automated} automated, ${r.steps?.manual} TODO stubs`);
    logger.info(`Activated:     ${r.activated ? 'yes' : 'no — activate manually in Workflow Studio'}`);
    if (this.manualList.length) logger.warn(`Manual items:  ${this.manualList.length} — see guide above`);
  }
}
