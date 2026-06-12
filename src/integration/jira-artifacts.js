/**
 * Jira Artifact Builder for Bidirectional Integrations
 *
 * Creates Jira-side artifacts:
 *   1. Webhook registration (Jira → external platform)
 *   2. Automation rule plan (JSON + human instructions)
 *
 * Note: Jira Automation rules cannot be created via REST API —
 * we generate the exact JSON to import + step-by-step UI instructions.
 */

import { logger } from '../utils/logger.js';

export class JiraArtifactBuilder {
  constructor(jira) {
    this.jira = jira;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Register a Jira webhook (calls external URL when issues change)
  // ══════════════════════════════════════════════════════════════════════════
  async createWebhook(plan, inboundUrl, secret) {
    const prefix   = plan.meta.prefix;
    const jiraIsA  = plan.meta.platformA === 'jira';
    const outbound = jiraIsA ? plan.outbound_a_to_b : plan.outbound_b_to_a;
    if (!outbound) return null;

    const events   = outbound.trigger.events ?? ['jira:issue_updated'];
    const webhookEvents = events.map(e => this._jiraEvent(e));

    logger.step('Registering Jira webhook');

    // Check for existing webhook with the same URL
    const existing = await this._listWebhooks();
    const found    = existing.find(w => w.url === inboundUrl);
    if (found) {
      logger.info(`  Webhook already registered (id: ${found.id})`);
      return found;
    }

    const body = {
      name:   `${prefix}-sync-webhook`,
      url:    inboundUrl,
      events: webhookEvents,
      filters: {
        'issue-related-events-section': outbound.trigger.conditions?.join(' AND ') ?? '',
      },
      excludeBody: false,
    };

    const result = await this.jira.request('POST', '/rest/webhooks/1.0/webhook', body);
    logger.ok(`  Webhook registered (id: ${result.self ?? result.id})`);
    return result;
  }

  async _listWebhooks() {
    try {
      const res = await this.jira.request('GET', '/rest/webhooks/1.0/webhook');
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  _jiraEvent(event) {
    const map = {
      issue_created:  'jira:issue_created',
      issue_updated:  'jira:issue_updated',
      issue_deleted:  'jira:issue_deleted',
      comment_added:  'comment_created',
      status_changed: 'jira:issue_updated',
      transition:     'jira:issue_updated',
    };
    return map[event] ?? event;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Automation rule — generate JSON + UI instructions
  //    (Jira Automation REST is not publicly available; user must import)
  // ══════════════════════════════════════════════════════════════════════════
  generateAutomationRule(plan, inboundUrl) {
    const prefix   = plan.meta.prefix;
    const jiraIsA  = plan.meta.platformA === 'jira';
    const jiraTable = jiraIsA ? plan.meta.tableA : plan.meta.tableB;
    const outbound  = jiraIsA ? plan.outbound_a_to_b : plan.outbound_b_to_a;
    const trigger   = outbound?.trigger ?? {};
    const target    = jiraIsA ? plan.meta.platformB : plan.meta.platformA;
    const fieldMappings = plan.meta.fieldMappings;

    // Build the body template (maps Jira fields → external fields)
    const bodyTemplate = this._buildBodyTemplate(fieldMappings, jiraIsA);

    const automationJson = {
      ruleType: 'manual',
      name:     `[${prefix}] Sync to ${target}`,
      description: `Automatically syncs Jira ${jiraTable} to ${target} when conditions are met`,
      trigger: this._automationTrigger(trigger),
      components: [
        this._conditionComponent(trigger.conditions ?? []),
        this._httpRequestComponent(inboundUrl, bodyTemplate, prefix),
        this._loopPreventionLabel(prefix),
      ].filter(Boolean),
    };

    const instructions = this._automationInstructions(plan, automationJson, target);
    return { automation_json: automationJson, instructions };
  }

  _automationTrigger(trigger) {
    const events = trigger.events ?? ['issue_updated'];
    if (events.includes('issue_created') && events.includes('issue_updated')) {
      return { type: 'ISSUE_CREATED_OR_UPDATED' };
    }
    if (events.includes('issue_created')) return { type: 'ISSUE_CREATED' };
    if (events.includes('status_changed') || events.includes('transition')) {
      return { type: 'FIELD_VALUE_CHANGED', configuration: { fields: ['status'] } };
    }
    return { type: 'ISSUE_UPDATED' };
  }

  _conditionComponent(conditions) {
    if (!conditions.length) return null;
    return {
      type: 'CONDITION',
      component: {
        type: 'JQL_CONDITION',
        configuration: { query: conditions.join(' AND ') },
      },
    };
  }

  _httpRequestComponent(url, body, prefix) {
    return {
      type: 'ACTION',
      component: {
        type: 'SEND_WEB_REQUEST',
        configuration: {
          url,
          method:  'POST',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'X-Integration-Source', value: 'jira' },
            { name: 'X-Prefix', value: prefix },
          ],
          body:         JSON.stringify(body, null, 2),
          delayInSeconds: 0,
          parseHtml: false,
        },
      },
    };
  }

  _loopPreventionLabel(prefix) {
    // Add a label to synced issues so we can filter them out
    return {
      type: 'ACTION',
      component: {
        type: 'EDIT_ISSUE',
        configuration: {
          operations: [{
            fieldId: 'labels',
            operation: 'SET',
            value: [`${prefix}-synced`],
          }],
        },
      },
    };
  }

  _buildBodyTemplate(fieldMappings, jiraIsA) {
    // If Jira is platform A, keys are Jira fields; values are external fields
    const template = {
      _external_id:  '{{issue.key}}',
      _jira_key:     '{{issue.key}}',
      _jira_id:      '{{issue.id}}',
      _event_type:   '{{webhookEvent}}',
    };
    for (const [aField, bField] of Object.entries(fieldMappings)) {
      const jiraField = jiraIsA ? aField : bField;
      const extField  = jiraIsA ? bField : aField;
      template[extField] = `{{issue.fields.${jiraField}}}`;
    }
    return template;
  }

  _automationInstructions(plan, automationJson, target) {
    return [
      '── How to import this Jira Automation Rule ──',
      '',
      '1. Go to your Jira project → Project Settings → Automation',
      '   (Or go to Jira Settings → Automation for global rules)',
      '2. Click "Create rule" in the top-right corner',
      '3. In the rule editor, click the "⋮" (three-dot menu) → "Import rule"',
      '4. Paste the automation_json from this response and click "Import"',
      '5. Review the imported rule:',
      `   - Trigger: set to "${this._automationTrigger(plan.outbound_a_to_b?.trigger ?? {}).type}"`,
      `   - Condition: scope to relevant projects / issue types`,
      `   - HTTP Action URL: your ${target} inbound endpoint`,
      '6. Add a condition to check that the issue does NOT have the "synced" label',
      '   to prevent infinite loops (the label is added after each sync)',
      '7. Click "Enable rule" and test with a single issue first',
      '',
      '── Loop prevention strategy ──',
      `When ${target} updates an issue back in Jira, the automation label "${plan.meta.prefix}-synced"`,
      'will be present. Add a condition: "Issue label does not contain synced" to skip those updates.',
      '',
      '── Security ──',
      'Generate a shared secret and set it as a custom header (X-Webhook-Secret) on both sides.',
      `In ServiceNow, validate this header in the Scripted REST API operation script.`,
    ];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Convenience: run all Jira artifact steps
  // ══════════════════════════════════════════════════════════════════════════
  async buildAll(plan, opts = {}) {
    const results = {};
    const jiraInvolved = plan.meta.platformA === 'jira' || plan.meta.platformB === 'jira';
    if (!jiraInvolved) return results;

    logger.header(`Building Jira artifacts for ${plan.meta.prefix}`);

    if (opts.inboundUrl) {
      results.webhook = await this.createWebhook(plan, opts.inboundUrl, opts.webhookSecret).catch(e => {
        logger.warn(`  Webhook creation failed (${e.message}) — register manually`);
        return null;
      });
    }

    results.automation_rule = this.generateAutomationRule(plan, opts.inboundUrl ?? '<your-inbound-endpoint>');
    logger.ok('Jira automation rule JSON generated');
    return results;
  }
}
