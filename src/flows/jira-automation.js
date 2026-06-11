import { logger } from '../utils/logger.js';

/**
 * Jira Automation → ServiceNow Flow Designer migration.
 *
 * Jira Automation rules have: trigger, conditions (IF), and actions (THEN).
 * This maps them to SN Flow Designer blocks as closely as possible.
 * Screen-equivalent elements (forms, UI actions) are flagged as manual.
 */
export class JiraAutomationRetriever {
  constructor(jira) {
    this.jira = jira;
  }

  async listAutomations(projectKey = null) {
    logger.step(`Listing Jira automations${projectKey ? ` for project ${projectKey}` : ' (all)'}...`);
    return this.jira.listAutomations({ projectKey });
  }

  async getAutomation(ruleId) {
    logger.step(`Fetching Jira automation rule ${ruleId}...`);
    return this.jira.getAutomation(ruleId);
  }

  // Parse a raw Jira automation rule into a structured format
  parseRule(rule) {
    const trigger    = rule.trigger ?? rule.ruleScope?.trigger ?? null;
    const conditions = this._collectComponents(rule, 'CONDITION');
    const branches   = this._collectComponents(rule, 'BRANCH');
    const actions    = this._collectComponents(rule, 'ACTION');

    return {
      id:           rule.id,
      name:         rule.name,
      enabled:      rule.state === 'ENABLED',
      projects:     (rule.projects ?? []).map(p => p.key ?? p.name ?? p.id),
      trigger:      trigger ? this._parseTrigger(trigger) : null,
      conditions:   conditions.map(c => this._parseCondition(c)),
      branches:     branches.map(b => this._parseBranch(b)),
      actions:      actions.map(a => this._parseAction(a)),
      manual_steps: [],
    };
  }

  _collectComponents(rule, type) {
    const all = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === type || node.componentType === type) all.push(node);
      (node.children ?? []).forEach(walk);
      (node.components ?? []).forEach(walk);
    };
    (rule.components ?? rule.elements ?? []).forEach(walk);
    return all;
  }

  _parseTrigger(t) {
    const type = t.type ?? t.ruleScope?.trigger?.type ?? '';
    return {
      raw_type: type,
      sn_type:  JiraAutomationRetriever.mapTriggerType(type),
      label:    JiraAutomationRetriever.triggerLabel(type),
      config:   t.value ?? t.configuration ?? {},
    };
  }

  _parseCondition(c) {
    return {
      type:    c.type ?? '',
      label:   c.value?.name ?? c.type ?? 'Condition',
      config:  c.value ?? {},
      can_auto: this._canAutoCondition(c.type),
    };
  }

  _parseBranch(b) {
    return {
      type:   b.type ?? 'BRANCH',
      label:  b.value?.name ?? 'Branch',
      config: b.value ?? {},
    };
  }

  _parseAction(a) {
    const type = a.type ?? '';
    return {
      raw_type: type,
      label:    a.value?.name ?? type,
      config:   a.value ?? {},
      sn_action: JiraAutomationRetriever.mapActionType(type),
      can_auto:  this._canAutoAction(type),
      manual_reason: !this._canAutoAction(type)
        ? JiraAutomationRetriever.manualReason(type)
        : null,
    };
  }

  _canAutoCondition(type) {
    const auto = ['jira.issue.condition.status.changed','jira.issue.condition.field.changed',
                  'jira.issue.condition.created','jira.issue.condition.assigned',
                  'jira.issue.condition.user.condition','jira.condition.if'];
    return auto.some(t => (type ?? '').includes(t.split('.').pop()));
  }

  _canAutoAction(type) {
    const manual = ['jira.issue.action.comment.add','jira.issue.action.send.email',
                    'jira.issue.action.webhook','jira.issue.action.create.subtask',
                    'jira.issue.action.create.confluence'];
    return !manual.some(m => (type ?? '').includes(m.split('.').pop()));
  }

  // ── Static mapping tables ──────────────────────────────────────────────────

  static mapTriggerType(jiraType) {
    const t = (jiraType ?? '').toLowerCase();
    if (t.includes('created'))   return 'record';
    if (t.includes('updated') || t.includes('changed') || t.includes('transition')) return 'record';
    if (t.includes('scheduled') || t.includes('cron')) return 'scheduled';
    if (t.includes('webhook'))   return 'inbound_api';
    if (t.includes('manual'))    return 'manual';
    return 'manual';
  }

  static triggerLabel(jiraType) {
    const t = (jiraType ?? '').toLowerCase();
    if (t.includes('issue_created'))   return 'Issue created';
    if (t.includes('issue_updated'))   return 'Issue updated';
    if (t.includes('field.changed'))   return 'Field value changed';
    if (t.includes('transition'))      return 'Status/transition changed';
    if (t.includes('scheduled'))       return 'Scheduled';
    if (t.includes('manual'))          return 'Manually triggered';
    if (t.includes('webhook'))         return 'Incoming webhook';
    return jiraType ?? 'Unknown trigger';
  }

  static mapActionType(jiraType) {
    const t = (jiraType ?? '').toLowerCase();
    if (t.includes('field') || t.includes('edit'))  return 'update_record';
    if (t.includes('transition'))                    return 'update_record';
    if (t.includes('assign'))                        return 'update_record';
    if (t.includes('comment'))                       return 'create_record';  // journal entry
    if (t.includes('create') && !t.includes('sub')) return 'create_record';
    if (t.includes('delete'))                        return 'delete_record';
    if (t.includes('email'))                         return 'notification';
    if (t.includes('webhook'))                       return 'outbound_rest';
    return 'script';
  }

  static manualReason(jiraType) {
    const t = (jiraType ?? '').toLowerCase();
    if (t.includes('comment')) return 'Comment action → add Journal Entry in SN manually';
    if (t.includes('email'))   return 'Email action → configure SN Notification manually';
    if (t.includes('webhook')) return 'Webhook action → configure REST Step in SN manually';
    if (t.includes('subtask')) return 'Create subtask → configure child record creation in SN manually';
    if (t.includes('confluence')) return 'Confluence action — no SN equivalent';
    return 'Complex action — configure manually in SN Flow Designer';
  }

  // Build a human-readable migration plan for a parsed rule
  buildMigrationPlan(parsed) {
    const steps = [];
    const manual = [];

    steps.push({
      order: 1,
      action: 'Create Flow',
      detail: `Name: "${parsed.name}", Trigger: ${parsed.trigger?.sn_type ?? 'manual'}`,
      auto: true,
    });

    if (parsed.trigger) {
      steps.push({
        order: 2,
        action: `Set trigger: ${parsed.trigger.label}`,
        detail: `SN trigger type: ${parsed.trigger.sn_type}`,
        auto: true,
      });
    }

    let order = 3;
    for (const c of parsed.conditions) {
      steps.push({ order: order++, action: `IF: ${c.label}`, detail: c.can_auto ? 'Condition block' : 'Manual', auto: c.can_auto });
      if (!c.can_auto) manual.push({ type: 'condition', label: c.label });
    }
    for (const a of parsed.actions) {
      steps.push({ order: order++, action: `THEN: ${a.label}`, detail: a.sn_action, auto: a.can_auto, manual_reason: a.manual_reason });
      if (!a.can_auto) manual.push({ type: 'action', label: a.label, reason: a.manual_reason });
    }

    return { steps, manual };
  }
}
