import { logger } from '../utils/logger.js';
import { FlowRetriever } from './retriever.js';
import { ServiceNowConnector } from '../connectors/servicenow.js';

/**
 * Phase F5: Builds ServiceNow Flow Designer artifacts from a parsed flow structure.
 *
 * Uses /api/sn_fd (Flow Designer REST API) where available, falls back to Table API.
 * Step-level action types are resolved by label from sys_hub_action_type_base so the
 * build works across instances regardless of sys_id differences.
 */
export class FlowBuilder {
  constructor(sn) {
    this.sn         = sn;
    this.manualList = [];
    this.results    = {};
  }

  async build({ flowStructure, snTableName, fieldMappings, flowScope, appScopeId = null }) {
    logger.header(`Phase F5 — Building Flow: ${flowStructure.apiName}`);
    const results = {};

    if (flowStructure.isScreen) {
      logger.warn('Screen Flow detected — this must be built manually.');
      this.manualList.push({ flow: flowStructure.apiName, reason: 'Screen Flow — no SN automation equivalent; build as Service Portal widget or Service Catalog item' });
      results.manual = true;
      results.manual_reason = 'Screen Flow';
      return results;
    }

    // F5.1 Create flow record
    logger.step('F5.1 Creating flow record...');
    const flowName   = flowScope ? `${flowScope}_${flowStructure.apiName}` : flowStructure.apiName;
    const flowRecord = await this.sn.createFlow(flowName, flowStructure.label ?? flowStructure.apiName, appScopeId);
    const flowSysId  = flowRecord?.sys_id ?? flowRecord?.id;
    if (!flowSysId) throw new Error(`Flow record created but sys_id is missing. Raw response: ${JSON.stringify(flowRecord)}`);
    results.flow = { name: flowName, sys_id: flowSysId };
    logger.success(`Flow record: ${flowName} (${flowSysId})`);

    // F5.2 Create variables (best-effort — some instances block these tables)
    logger.step('F5.2 Creating flow variables...');
    let varCount = 0;
    for (const v of flowStructure.variables ?? []) {
      const snType = this._mapVarType(v.dataType);
      const res = await this.sn.createFlowVariable(flowSysId, v.name, snType, v.isInput ?? false, v.isOutput ?? false);
      if (!res?.skipped) varCount++;
    }
    logger.success(`Variables: ${varCount} created`);
    results.variables = varCount;

    // F5.3 Create trigger
    logger.step('F5.3 Creating flow trigger...');
    const triggerType = FlowRetriever.mapTriggerType(flowStructure.type);
    const condition   = flowStructure.trigger?.filterConditions
      ? this._buildConditionString(flowStructure.trigger.filterConditions, fieldMappings)
      : null;
    const trigger = await this.sn.createFlowTrigger(flowSysId, triggerType, snTableName, condition);
    results.trigger = trigger?.sys_id ?? trigger?.id ?? 'created';
    logger.success(`Trigger: ${triggerType} on ${snTableName ?? '—'}`);

    // F5.4 Create steps
    logger.step('F5.4 Creating flow steps...');
    let stepCount = 0, manualCount = 0, order = 100;

    for (const el of flowStructure.elements ?? []) {
      const desc = FlowRetriever.describeElement(el);

      if (el.kind === 'screen') {
        this.manualList.push({ flow: flowStructure.apiName, element: el.name, reason: 'Screen element — build as Service Catalog / Now Experience form', desc });
        logger.warn(`  Skipped (manual): ${desc}`);
        manualCount++;
        continue;
      }

      try {
        const logicalType = this._mapElementToActionType(el.kind);
        const script      = this._generateScript(el, fieldMappings);
        const inputs      = this._buildStepInputs(el, logicalType, fieldMappings, snTableName, script);
        await this.sn.createActionInstance(flowSysId, el.label ?? el.name, logicalType, order, inputs);
        logger.info(`  ✓ ${desc}`);
        stepCount++;
        order += 100;
      } catch (e) {
        this.manualList.push({ flow: flowStructure.apiName, element: el.name, reason: e.message, desc });
        logger.warn(`  Manual: ${desc} — ${e.message}`);
        manualCount++;
      }
    }

    logger.success(`Steps: ${stepCount} automated, ${manualCount} manual`);
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
      this.manualList.push({ flow: flowName, reason: `Activate the flow manually in Flow Designer (${e.message})` });
    }

    this.results = results;
    return results;
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
      action:       'notification',
      subflow:      'subflow',
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

  _buildStepInputs(el, logicalType, fieldMappings, snTableName, script) {
    if (logicalType === 'create_record' || logicalType === 'update_record') {
      const fields = {};
      (el.inputAssignments ?? el.inputParameters ?? []).forEach(p => {
        const snField = fieldMappings?.[p.field ?? p.name] ?? p.field ?? p.name;
        fields[snField] = p.value ?? '';
      });
      return { table: snTableName, fields };
    }
    if (logicalType === 'lookup_record') return { table: snTableName, conditions: [] };
    if (logicalType === 'condition') {
      const conditions = (el.rules ?? el.conditions ?? []).map(r => ({
        field:    fieldMappings?.[r.leftValueReference] ?? r.leftValueReference ?? '',
        operator: r.operator ?? 'EqualTo',
        value:    r.rightValue?.stringValue ?? r.rightValue?.elementReference ?? '',
      }));
      return { conditions };
    }
    if (script) return { script };
    return {};
  }

  _generateScript(el, fieldMappings) {
    if (el.kind === 'assignment') {
      const lines = (el.assignmentItems ?? []).map(item => {
        const snField = fieldMappings?.[item.assignToReference] ?? item.assignToReference;
        const value   = item.value?.stringValue ?? item.value?.elementReference ?? item.value ?? '';
        return `current.${snField} = ${JSON.stringify(String(value))};`;
      });
      return lines.length ? lines.join('\n') + '\ncurrent.update();' : null;
    }
    if (el.kind === 'loop') return `// Loop over: ${el.collectionReference ?? el.label}\n// TODO: implement loop body`;
    if (el.kind === 'action') return `// Action: ${el.actionName ?? el.label}\n// Type: ${el.actionType ?? 'unknown'}\n// TODO: implement`;
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
      console.log('\nHow to build in ServiceNow Flow Designer:');
      console.log('  1. Open Flow Designer → find your flow → Edit');
      console.log('  2. Add the appropriate action/step at the correct position');
      console.log('  3. Configure inputs using the field mappings from Phase 3');
    });
  }

  printSummary() {
    logger.header('Flow Migration Summary');
    const r = this.results;
    if (r.manual) { logger.warn(`Full manual build required: ${r.manual_reason}`); return; }
    logger.success(`Flow created:  ${r.flow?.name} (${r.flow?.sys_id})`);
    logger.info(`Variables:     ${r.variables}`);
    logger.info(`Steps built:   ${r.steps?.automated} automated, ${r.steps?.manual} manual`);
    logger.info(`Activated:     ${r.activated ? 'yes' : 'no — activate manually in Flow Designer'}`);
    if (this.manualList.length) logger.warn(`Manual items:  ${this.manualList.length} — see guide above`);
  }
}
