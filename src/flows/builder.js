import { logger } from '../utils/logger.js';
import { FlowRetriever } from './retriever.js';

/**
 * Phase F5: Builds ServiceNow flow artifacts from parsed SF flow structure.
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
      this.manualList.push({ flow: flowStructure.apiName, reason: 'Screen Flow — no SN automation' });
      results.manual = true;
      return results;
    }

    // F5.1 Create flow record
    logger.step('F5.1 Creating flow record...');
    const flowName  = flowScope ? `${flowScope}_${flowStructure.apiName}` : flowStructure.apiName;
    const flowRecord = await this.sn.createFlow(
      flowName,
      flowStructure.label ?? flowStructure.apiName,
      appScopeId
    );
    results.flow = { name: flowName, sys_id: flowRecord.sys_id };
    logger.success(`Flow record: ${flowName} (${flowRecord.sys_id})`);

    // F5.2 Create variables
    logger.step('F5.2 Creating flow variables...');
    let varCount = 0;
    for (const v of flowStructure.variables) {
      const snType = this._mapVarType(v.dataType);
      await this.sn.createFlowVariable(
        flowRecord.sys_id, v.name, snType,
        v.isInput ?? false, v.isOutput ?? false
      );
      varCount++;
    }
    logger.success(`Variables: ${varCount} created`);
    results.variables = varCount;

    // F5.3 Create trigger
    logger.step('F5.3 Creating flow trigger...');
    const triggerType = FlowRetriever.mapTriggerType(flowStructure.type);
    const trigger = await this.sn.createFlowTrigger(flowRecord.sys_id, triggerType, snTableName);
    results.trigger = trigger.sys_id;
    logger.success(`Trigger: ${triggerType} on ${snTableName ?? '—'}`);

    // F5.4 Create steps
    logger.step('F5.4 Creating flow steps...');
    let stepCount = 0, manualCount = 0, order = 100;

    for (const el of flowStructure.elements) {
      const desc = FlowRetriever.describeElement(el);

      if (el.kind === 'screen') {
        this.manualList.push({ flow: flowStructure.apiName, element: el.name, reason: 'Screen element — manual in Now Experience/Service Catalog', desc });
        logger.warn(`  Skipped (manual): ${desc}`);
        manualCount++;
        continue;
      }

      try {
        const snActionType = this._mapElementToActionType(el.kind);
        const script       = this._generateScript(el, fieldMappings);
        await this.sn.createFlowBlock(flowRecord.sys_id, el.label ?? el.name, snActionType, script, order);
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
    await this.sn.activateFlow(flowRecord.sys_id);
    logger.success('Flow activated');

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
      action:       'script',
      subflow:      'subflow',
    };
    return map[kind] ?? 'script';
  }

  _mapVarType(sfDataType) {
    const map = {
      String:   'string',
      Number:   'integer',
      Boolean:  'boolean',
      Date:     'glide_date',
      DateTime: 'glide_date_time',
      Record:   'reference',
      SObject:  'reference',
    };
    return map[sfDataType] ?? 'string';
  }

  _generateScript(el, fieldMappings) {
    if (el.kind === 'assignment') {
      return el.assignmentItems?.map(item => {
        const snField = fieldMappings?.[item.assignToReference] ?? item.assignToReference;
        return `current.${snField} = ${JSON.stringify(item.value ?? '')};`;
      }).join('\n') ?? null;
    }
    if (el.kind === 'loop') {
      return `// Loop: ${el.label ?? el.name}\n// TODO: implement loop logic`;
    }
    return null;
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
      console.log('  1. Open Flow Designer → your flow');
      console.log('  2. Add the appropriate action/step at the correct position');
      console.log('  3. Configure using the field mapping from Phase 3');
    });
  }

  printSummary() {
    logger.header('Flow Migration Summary');
    const r = this.results;
    if (r.manual) {
      logger.warn('Full manual build required (Screen Flow)');
      return;
    }
    logger.success(`Flow created:  ${r.flow?.name} (${r.flow?.sys_id})`);
    logger.info(`Variables:     ${r.variables}`);
    logger.info(`Steps built:   ${r.steps?.automated} automated, ${r.steps?.manual} manual`);
    if (this.manualList.length) logger.warn(`Manual items:  ${this.manualList.length} — see guide above`);
  }
}
