/**
 * Integration Designer
 *
 * Analyses a user's bidirectional integration requirement and produces a
 * complete, structured integration plan that tells every other builder
 * exactly what artifacts to create and how to wire them together.
 *
 * Supported platform pairs (in either direction):
 *   servicenow ↔ jira
 *   servicenow ↔ salesforce
 *   jira       ↔ salesforce
 */

export const PLATFORMS = {
  servicenow: 'servicenow',
  jira:       'jira',
  salesforce: 'salesforce',
};

export const DIRECTIONS = {
  a_to_b: 'a_to_b',        // one-way
  b_to_a: 'b_to_a',        // one-way reverse
  bidirectional: 'bidirectional',
};

// Standard trigger event types recognized on both platforms
const TRIGGER_EVENTS = {
  servicenow: ['insert', 'update', 'delete', 'state_change', 'ui_action'],
  jira:       ['issue_created', 'issue_updated', 'issue_deleted', 'comment_added', 'status_changed', 'transition'],
  salesforce: ['record_created', 'record_updated', 'record_deleted', 'field_changed', 'flow_triggered'],
};

export class IntegrationDesigner {
  /**
   * Produce a full integration plan from user-supplied requirements.
   *
   * @param {object} req
   * @param {string} req.platformA        – 'servicenow' | 'jira' | 'salesforce'
   * @param {string} req.platformB
   * @param {string} req.direction        – 'a_to_b' | 'b_to_a' | 'bidirectional'
   * @param {string} req.tableA           – source object/table in platform A
   * @param {string} req.tableB           – target object/table in platform B
   * @param {object} req.triggerA         – { events, conditions }  (A→B direction)
   * @param {object} req.triggerB         – { events, conditions }  (B→A direction)
   * @param {object} req.fieldMappings    – { aField: bField, ... }
   * @param {object} req.options          – { prefix, retryOnError, syncComments, syncAttachments }
   */
  design(req) {
    const {
      platformA,
      platformB,
      direction = DIRECTIONS.bidirectional,
      tableA,
      tableB,
      triggerA = {},
      triggerB = {},
      fieldMappings = {},
      options = {},
    } = req;

    this._validate(platformA, platformB, direction);

    const prefix       = options.prefix ?? this._autoPrefix(platformA, platformB, tableA);
    const correlTable  = `u_${prefix}_correlation`;
    const propKey      = `x_snmig.${prefix}.field_map`;
    const retryTable   = `u_${prefix}_sync_error`;

    const aToB = direction !== DIRECTIONS.b_to_a;
    const bToA = direction !== DIRECTIONS.a_to_b;

    const plan = {
      meta: {
        prefix,
        direction,
        platformA,
        platformB,
        tableA,
        tableB,
        fieldMappings,
        options,
      },
      correlation_table: {
        name:        correlTable,
        label:       `${this._label(platformA)}-${this._label(platformB)} Correlation`,
        description: 'Stores cross-platform record ID mappings for the sync integration',
        fields: [
          { name: 'u_platform_a',       type: 'string',   label: 'Platform A' },
          { name: 'u_table_a',          type: 'string',   label: 'Table A' },
          { name: 'u_record_sys_id_a',  type: 'string',   label: 'Record ID A' },
          { name: 'u_platform_b',       type: 'string',   label: 'Platform B' },
          { name: 'u_table_b',          type: 'string',   label: 'Table B' },
          { name: 'u_record_id_b',      type: 'string',   label: 'Record ID B' },
          { name: 'u_record_url_b',     type: 'url',      label: 'Record URL B' },
          { name: 'u_last_sync',        type: 'glide_date_time', label: 'Last Sync' },
          { name: 'u_sync_direction',   type: 'string',   label: 'Direction' },
          { name: 'u_sync_enabled',     type: 'boolean',  label: 'Sync Enabled', default: true },
          { name: 'u_sync_error',       type: 'string',   label: 'Last Error' },
        ],
      },
      retry_table: {
        name:   retryTable,
        label:  `${this._label(platformA)}-${this._label(platformB)} Sync Errors`,
        description: 'Dead-letter queue for failed sync attempts',
        fields: [
          { name: 'u_source_platform', type: 'string' },
          { name: 'u_source_id',       type: 'string' },
          { name: 'u_target_platform', type: 'string' },
          { name: 'u_payload',         type: 'string', max_length: 65536 },
          { name: 'u_error',           type: 'string', max_length: 4000 },
          { name: 'u_retry_count',     type: 'integer', default: 0 },
          { name: 'u_next_retry',      type: 'glide_date_time' },
          { name: 'u_resolved',        type: 'boolean', default: false },
        ],
      },
      sys_property: {
        name:  propKey,
        value: JSON.stringify(fieldMappings, null, 2),
        description: `Field mapping JSON for ${this._label(platformA)}↔${this._label(platformB)} sync. Format: {"${platformA}_field":"${platformB}_field"}`,
      },
      sync_flag_field: {
        table: this._snTable(platformA, tableA, platformB, tableB),
        name:  'u_sync_in_progress',
        type:  'boolean',
        label: 'Sync In Progress',
        description: 'Set to true during inbound sync to prevent outbound loop',
        default: false,
      },

      // Outbound (A→B) artifacts
      outbound_a_to_b: aToB ? this._outboundPlan(platformA, platformB, tableA, tableB, prefix, triggerA, fieldMappings, options) : null,

      // Outbound (B→A) artifacts
      outbound_b_to_a: bToA ? this._outboundPlan(platformB, platformA, tableB, tableA, prefix + '_rev', triggerB, this._invertMap(fieldMappings), options) : null,

      // Inbound REST endpoint on SN side (if SN is involved)
      inbound_sn_api:  this._snInboundApiPlan(platformA, platformB, tableA, tableB, prefix, correlTable, fieldMappings, options),

      // Best-practice checklist
      checklist: this._checklist(platformA, platformB, direction),
    };

    return plan;
  }

  // ── Sub-plan builders ──────────────────────────────────────────────────────
  _outboundPlan(src, dst, srcTable, dstTable, prefix, trigger, fieldMappings, options) {
    return {
      trigger: {
        platform: src,
        table:    srcTable,
        events:   trigger.events ?? this._defaultEvents(src),
        conditions: trigger.conditions ?? [],
        notes: this._triggerNotes(src, trigger),
      },
      artifacts: this._artifactsFor(src, dst, srcTable, dstTable, prefix, fieldMappings, options),
    };
  }

  _artifactsFor(src, dst, srcTable, dstTable, prefix, fieldMappings, options) {
    if (src === 'servicenow') {
      return {
        outbound_rest_message: `u_${prefix}_outbound_rest`,
        business_rule:         `u_${prefix}_sync_outbound`,
        ui_action:             `u_${prefix}_sync_now`,
        client_script:         `u_${prefix}_sync_status`,
      };
    }
    if (src === 'jira') {
      return {
        webhook:        `${prefix}_jira_webhook`,
        automation_rule: `${prefix}_jira_automation`,
      };
    }
    if (src === 'salesforce') {
      return {
        platform_event_or_flow: `${prefix}_SF_OutboundFlow`,
        named_credential: `${prefix}_Named_Credential`,
        apex_callout_class: `${prefix}SyncCallout`,
      };
    }
  }

  _snInboundApiPlan(platformA, platformB, tableA, tableB, prefix, correlTable, fieldMappings, options) {
    // If neither platform is SN, no SN inbound API needed
    const snTable  = platformA === 'servicenow' ? tableA : platformB === 'servicenow' ? tableB : null;
    if (!snTable) return null;

    return {
      api_name:     `${prefix}_inbound_api`,
      api_path:     `/api/x_snmig/${prefix}/sync`,
      verb:         'POST',
      sn_table:     snTable,
      corr_table:   correlTable,
      field_map_prop: `x_snmig.${prefix}.field_map`,
      notes: [
        'The inbound Scripted REST API receives webhook calls from the partner platform.',
        'It looks up the correlation table to find the SN record sys_id.',
        'Loop prevention: sets u_sync_in_progress=true before update, clears after.',
        'Returns 200 {status, sys_id} on success; 404 if record not found; 400 on error.',
      ],
    };
  }

  // ── Defaults ───────────────────────────────────────────────────────────────
  _defaultEvents(platform) {
    switch (platform) {
      case 'servicenow': return ['insert', 'update'];
      case 'jira':       return ['issue_updated', 'status_changed'];
      case 'salesforce': return ['record_created', 'record_updated'];
      default:           return ['update'];
    }
  }

  _triggerNotes(platform, trigger) {
    if (platform === 'servicenow') {
      return [
        'Business Rule fires "After" on the specified table.',
        'Condition filters prevent running on unrelated updates (e.g. only state changes).',
        'Uses Outbound REST Message for the HTTP call — no hardcoded credentials.',
      ];
    }
    if (platform === 'jira') {
      return [
        'Jira Automation Rule with "Issue updated" trigger fires the webhook.',
        'Add a condition to scope it (e.g. only when status changes).',
        'The action calls the SN Scripted REST API endpoint via HTTP request.',
      ];
    }
    if (platform === 'salesforce') {
      return [
        'Salesforce Flow (or Apex Trigger) fires after record save.',
        'HTTP Callout action uses Named Credential for authentication.',
        'Must be asynchronous — use a Queueable Apex class for the callout.',
      ];
    }
    return [];
  }

  _checklist(platformA, platformB, direction) {
    return [
      'Loop prevention: both platforms must detect and ignore updates they themselves triggered',
      'Idempotency: use correlation table to detect existing links before creating new records',
      'Authentication: use Named Credentials (SF), Connection Aliases (SN), or Stored Tokens (Jira) — never hardcode',
      'Field mapping: store in sys_properties (SN) or Custom Metadata (SF) so it is configurable without code',
      'Error handling: failed syncs go to retry table — implement scheduled retry job',
      'Audit trail: log every sync event with before/after values',
      direction === DIRECTIONS.bidirectional ? 'Conflict resolution: define "last-write-wins" or "platform A wins" policy for simultaneous updates' : null,
      platformA === 'salesforce' || platformB === 'salesforce' ? 'Salesforce callouts must be async (cannot callout in same transaction as trigger)' : null,
      'Test with a single record first; verify round-trip before enabling for all records',
      'Set up monitoring/alerting on the retry/error table',
    ].filter(Boolean);
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
  _validate(a, b, direction) {
    if (!Object.values(PLATFORMS).includes(a)) throw new Error(`Unknown platform: ${a}`);
    if (!Object.values(PLATFORMS).includes(b)) throw new Error(`Unknown platform: ${b}`);
    if (a === b) throw new Error('Platform A and B must be different');
    if (!Object.values(DIRECTIONS).includes(direction)) throw new Error(`Unknown direction: ${direction}`);
  }

  _autoPrefix(a, b, tableA) {
    const short = { servicenow: 'sn', jira: 'jira', salesforce: 'sf' };
    const tbl   = (tableA ?? 'rec').replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 12);
    return `${short[a]}_${short[b]}_${tbl}`;
  }

  _label(platform) {
    return { servicenow: 'ServiceNow', jira: 'Jira', salesforce: 'Salesforce' }[platform] ?? platform;
  }

  _snTable(a, tableA, b, tableB) {
    if (a === 'servicenow') return tableA;
    if (b === 'servicenow') return tableB;
    return null;
  }

  _invertMap(map) {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
  }
}
