import { logger } from '../utils/logger.js';

/**
 * Phase F2: Retrieves Salesforce Flow metadata via Tooling API.
 */
export class FlowRetriever {
  constructor(sf) {
    this.sf = sf;
  }

  async listFlows() {
    logger.step('Listing Salesforce flows...');
    const result = await this.sf.listFlows();
    return result.records ?? [];
  }

  async getFlowMetadata(apiName) {
    logger.step(`Fetching metadata for flow: ${apiName}`);
    const flow = await this.sf.getFlowMetadata(apiName);
    if (!flow) throw new Error(`Flow "${apiName}" not found or not active.`);
    return flow;
  }

  printFlowList(flows) {
    logger.header('Available Salesforce Flows');
    flows.forEach((f, i) => {
      const isScreen = f.ProcessType === 'Flow';
      const tag      = isScreen ? '⚠️  Screen Flow (manual only)' : f.ProcessType;
      console.log(`  ${String(i + 1).padStart(2)}. ${f.ApiName.padEnd(50)} [${tag}]`);
    });
  }

  parseFlowStructure(flowMetadata) {
    const meta = flowMetadata.Metadata ?? {};
    return {
      apiName:    flowMetadata.ApiName,
      type:       flowMetadata.ProcessType,
      label:      meta.label ?? flowMetadata.ApiName,
      trigger:    meta.start ?? null,
      variables:  meta.variables ?? [],
      elements:   [
        ...(meta.decisions ?? []).map(e => ({ ...e, kind: 'decision' })),
        ...(meta.assignments ?? []).map(e => ({ ...e, kind: 'assignment' })),
        ...(meta.loops ?? []).map(e => ({ ...e, kind: 'loop' })),
        ...(meta.recordCreates ?? []).map(e => ({ ...e, kind: 'recordCreate' })),
        ...(meta.recordUpdates ?? []).map(e => ({ ...e, kind: 'recordUpdate' })),
        ...(meta.recordDeletes ?? []).map(e => ({ ...e, kind: 'recordDelete' })),
        ...(meta.recordLookups ?? []).map(e => ({ ...e, kind: 'recordLookup' })),
        ...(meta.actionCalls ?? []).map(e => ({ ...e, kind: 'action' })),
        ...(meta.screens ?? []).map(e => ({ ...e, kind: 'screen' })),
        ...(meta.subflows ?? []).map(e => ({ ...e, kind: 'subflow' })),
      ],
      screens: meta.screens ?? [],
      isScreen: flowMetadata.ProcessType === 'Flow',
    };
  }

  // Map SF flow type → SN trigger type
  static mapTriggerType(sfProcessType) {
    const map = {
      AutoLaunchedFlow: 'manual',
      RecordTriggeredFlow: 'record',
      ScheduledFlow: 'scheduled',
      Flow: 'manual', // Screen Flow
    };
    return map[sfProcessType] ?? 'manual';
  }

  // Map SF element kind → human summary for plan
  static describeElement(el) {
    const descriptions = {
      decision:     `IF/ELSE — "${el.label ?? el.name}"`,
      assignment:   `Assign — "${el.label ?? el.name}"`,
      loop:         `Loop — "${el.label ?? el.name}"`,
      recordCreate: `Create record — "${el.label ?? el.name}"`,
      recordUpdate: `Update record — "${el.label ?? el.name}"`,
      recordDelete: `Delete record — "${el.label ?? el.name}"`,
      recordLookup: `Get record — "${el.label ?? el.name}"`,
      action:       `Action call — "${el.actionName ?? el.name}" (${el.actionType ?? ''})`,
      screen:       `Screen — "${el.label ?? el.name}" ⚠️ MANUAL`,
      subflow:      `Subflow — "${el.flowName ?? el.name}"`,
    };
    return descriptions[el.kind] ?? `Unknown (${el.kind})`;
  }
}
