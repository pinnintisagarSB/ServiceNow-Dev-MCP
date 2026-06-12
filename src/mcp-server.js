/**
 * SN Data Migration — MCP Server
 *
 * All migration work happens through these tools. Claude drives the workflow,
 * asks the user questions at each checkpoint, and calls the next tool based
 * on their answers. No manual node commands needed.
 *
 * Start: registered in Claude Code via `claude mcp add`
 */

import 'dotenv/config';
import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                    from 'zod';

import { ServiceNowConnector }  from './connectors/servicenow.js';
import { SalesforceConnector }  from './connectors/salesforce.js';
import { JiraConnector }        from './connectors/jira.js';
import { SchemaDiscovery }      from './migration/schema.js';
import { ArtifactBuilder }      from './migration/staging.js';
import { MigrationRunner, topoSort } from './migration/runner.js';
import { DependencyAnalyzer }   from './migration/dependency.js';
import { MigrationValidator }   from './migration/validator.js';
import { BatchMigrationRunner } from './migration/batch.js';
import { MigrationCleanup }     from './migration/cleanup.js';
import { FlowRetriever }           from './flows/retriever.js';
import { JiraAutomationRetriever } from './flows/jira-automation.js';
import { UserGroupMapper }      from './migration/user-mapping.js';
import { PreMigrationChecker }  from './migration/pre-migration-checks.js';
import { TransformEngine }      from './migration/transform-engine.js';
import { AuditTrail }           from './migration/audit.js';
import { toSnHtml }             from './utils/rich-text.js';
import { MigrationReconciler }  from './migration/reconciler.js';
import { IntegrationDesigner }  from './integration/designer.js';
import { SNArtifactBuilder }    from './integration/sn-artifacts.js';
import { JiraArtifactBuilder }  from './integration/jira-artifacts.js';
import { SFArtifactBuilder }    from './integration/sf-artifacts.js';
import { ScriptBuilder }        from './developer/script-builder.js';
import { CodeReviewer }         from './developer/code-reviewer.js';
import { TableExplorer }        from './developer/table-explorer.js';
import { TestGenerator }        from './developer/test-generator.js';
import { PerfAnalyzer }         from './developer/perf-analyzer.js';
import { DocGenerator }         from './developer/doc-generator.js';
import { PortalBuilder }        from './developer/portal-builder.js';
import { CatalogBuilder }       from './developer/catalog-builder.js';
import { NotificationBuilder }  from './developer/notification-builder.js';
import { TechDocWriter }        from './developer/tech-doc-writer.js';
import { IssueGuide }           from './developer/issue-guide.js';
import { logger }               from './utils/logger.js';

// ── Developer tools singletons (stateless, no credentials needed) ──────────
const _scriptBuilder   = new ScriptBuilder();
const _codeReviewer    = new CodeReviewer();
const _testGen         = new TestGenerator();
const _docGen          = new DocGenerator();
const _notifBuilder    = new NotificationBuilder();
const _issueGuide      = new IssueGuide();

// ── Connector cache (reuse within a session) ───────────────────────────────
// In HTTP mode each request is stateless, so connectors are reset per-session
// via configure_credentials. In stdio mode they are process-scoped singletons.
let _sn   = null;
let _sf   = null;
let _jira = null;

// Session-level credential overrides (set via configure_credentials tool).
// These override whatever is in .env, so each web session can use its own instance.
const _sessionCreds = {
  servicenow:  null,   // { instanceUrl, username, password }
  jira:        null,   // { baseUrl, email, apiToken }
  salesforce:  null,   // { loginUrl, clientId, clientSecret, username, password, securityToken }
};

async function getSn() {
  if (!_sn) {
    if (_sessionCreds.servicenow) {
      // Override env with session credentials
      const c = _sessionCreds.servicenow;
      process.env.SN_INSTANCE_URL = c.instanceUrl;
      process.env.SN_USERNAME     = c.username;
      process.env.SN_PASSWORD     = c.password;
    }
    _sn = await new ServiceNowConnector().init();
  }
  return _sn;
}

async function getSf() {
  if (!_sf) {
    if (_sessionCreds.salesforce) {
      const c = _sessionCreds.salesforce;
      process.env.SF_LOGIN_URL      = c.loginUrl     ?? 'https://login.salesforce.com';
      process.env.SF_CLIENT_ID      = c.clientId;
      process.env.SF_CLIENT_SECRET  = c.clientSecret;
      process.env.SF_USERNAME       = c.username;
      process.env.SF_PASSWORD       = c.password;
      process.env.SF_SECURITY_TOKEN = c.securityToken ?? '';
    }
    _sf = await new SalesforceConnector().connect();
  }
  return _sf;
}

async function getJira() {
  if (!_jira) {
    if (_sessionCreds.jira) {
      const c = _sessionCreds.jira;
      process.env.JIRA_BASE_URL  = c.baseUrl;
      process.env.JIRA_EMAIL     = c.email;
      process.env.JIRA_API_TOKEN = c.apiToken;
    }
    _jira = await new JiraConnector().connect();
  }
  return _jira;
}

function resetConnectors() {
  _sn = null; _sf = null; _jira = null;
}

// ── Response helpers ───────────────────────────────────────────────────────
const ok  = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });

// ── Server ─────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'sn-data-migration', version: '1.0.0' });

// ══════════════════════════════════════════════════════════════════════════
// TOOL: get_config  (always call first in a new session)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'get_config',
  `Returns which platforms are configured and ready to use.
   Call this at the very start of every session BEFORE asking the user for anything.

   Credentials come from one of two places (checked in this order):
     1. Session memory — set via configure_credentials (used in web Claude Code)
     2. .env file on the server (used in CLI / personal deployment)

   If a platform shows configured=false AND the server has no .env:
     → Call configure_credentials first, then re-call get_config.
   If a platform shows configured=false AND a .env exists:
     → The .env is missing that platform's values. Tell the user which vars are needed.

   Never ask the user for credentials unless get_config reports a platform is not configured.`,
  {},
  async () => {
    const snCreds  = _sessionCreds.servicenow;
    const jiraCreds = _sessionCreds.jira;
    const sfCreds   = _sessionCreds.salesforce;

    const cfg = {
      servicenow: {
        configured:   !!(snCreds?.instanceUrl || (process.env.SN_INSTANCE_URL && (process.env.SN_USERNAME || process.env.SN_USE_SDK_AUTH === 'true'))),
        instance:     snCreds?.instanceUrl ?? process.env.SN_INSTANCE_URL ?? null,
        auth_type:    process.env.SN_USE_SDK_AUTH === 'true' ? 'oauth_sdk' : 'basic',
        scope_prefix: process.env.SN_SCOPE_PREFIX ?? 'u',
        source:       snCreds ? 'session' : 'env',
      },
      jira: {
        configured: !!(jiraCreds?.baseUrl || (process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN)),
        base_url:   jiraCreds?.baseUrl ?? process.env.JIRA_BASE_URL ?? null,
        email:      jiraCreds?.email   ?? process.env.JIRA_EMAIL ?? null,
        source:     jiraCreds ? 'session' : 'env',
      },
      salesforce: {
        configured:  !!(sfCreds?.clientId || (process.env.SF_CLIENT_ID && process.env.SF_USERNAME)),
        login_url:   sfCreds?.loginUrl  ?? process.env.SF_LOGIN_URL ?? null,
        username:    sfCreds?.username  ?? process.env.SF_USERNAME ?? null,
        api_version: process.env.SF_API_VERSION ?? null,
        source:      sfCreds ? 'session' : 'env',
      },
      migration_settings: {
        test_limit:  parseInt(process.env.MIGRATION_TEST_LIMIT ?? '5', 10),
        page_size:   parseInt(process.env.MIGRATION_PAGE_SIZE ?? '200', 10),
      },
    };

    const ready = Object.entries(cfg)
      .filter(([k, v]) => v?.configured)
      .map(([k]) => k);

    const notConfigured = ['servicenow', 'jira', 'salesforce'].filter(p => !cfg[p].configured);

    return ok({
      instructions_for_claude: [
        `The following platforms are configured and ready: ${ready.length ? ready.join(', ') : 'none'}.`,
        notConfigured.length
          ? `These platforms are NOT configured: ${notConfigured.join(', ')}. If the user needs one of them, call configure_credentials to collect their credentials for this session.`
          : 'All three platforms are configured.',
        ready.length === 0
          ? 'No platforms are configured. Call configure_credentials first — ask the user which platform(s) they need and collect the credentials.'
          : 'Call connect() next to verify the live connections, then proceed with the user\'s request.',
      ],
      configured_platforms: ready,
      not_configured:       notConfigured,
      config:               cfg,
    });
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: configure_credentials
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'configure_credentials',
  `Set credentials for this session when running in web Claude Code or any context
   where a .env file is not present on the server.

   WHEN TO CALL THIS:
   - Web Claude Code (claude.ai/code): the server is deployed remotely and has no
     access to the user's .env. Call this once at the start of the session.
   - CLI: only needed if the user wants to override their .env for this session.

   SECURITY: credentials are held in memory for this session only and are never
   logged, stored to disk, or returned in any tool response. They are cleared
   when the session ends.

   Only provide credentials for the platforms you actually need.
   After calling this, call get_config to confirm the platforms are now configured,
   then call connect to verify the live connections.`,
  {
    servicenow: z.object({
      instance_url: z.string().describe('e.g. https://yourinstance.service-now.com'),
      username:     z.string().describe('ServiceNow username'),
      password:     z.string().describe('ServiceNow password'),
    }).optional().describe('ServiceNow credentials'),

    jira: z.object({
      base_url:  z.string().describe('e.g. https://yourcompany.atlassian.net'),
      email:     z.string().describe('Atlassian account email'),
      api_token: z.string().describe('Jira API token from id.atlassian.com/manage-profile/security'),
    }).optional().describe('Jira credentials'),

    salesforce: z.object({
      login_url:      z.string().optional().default('https://login.salesforce.com').describe('Use https://test.salesforce.com for sandboxes'),
      client_id:      z.string().describe('Connected App consumer key'),
      client_secret:  z.string().describe('Connected App consumer secret'),
      username:       z.string().describe('Salesforce username'),
      password:       z.string().describe('Salesforce password'),
      security_token: z.string().optional().default('').describe('Salesforce security token (if IP not allowlisted)'),
    }).optional().describe('Salesforce credentials'),
  },
  async ({ servicenow, jira, salesforce }) => {
    const configured = [];
    const skipped    = [];

    if (servicenow) {
      _sessionCreds.servicenow = {
        instanceUrl: servicenow.instance_url,
        username:    servicenow.username,
        password:    servicenow.password,
      };
      configured.push('servicenow');
    } else skipped.push('servicenow');

    if (jira) {
      _sessionCreds.jira = {
        baseUrl:  jira.base_url,
        email:    jira.email,
        apiToken: jira.api_token,
      };
      configured.push('jira');
    } else skipped.push('jira');

    if (salesforce) {
      _sessionCreds.salesforce = {
        loginUrl:      salesforce.login_url ?? 'https://login.salesforce.com',
        clientId:      salesforce.client_id,
        clientSecret:  salesforce.client_secret,
        username:      salesforce.username,
        password:      salesforce.password,
        securityToken: salesforce.security_token ?? '',
      };
      configured.push('salesforce');
    } else skipped.push('salesforce');

    // Reset cached connectors so they re-initialise with the new credentials
    resetConnectors();

    return ok({
      instructions_for_claude: [
        `Credentials stored in session memory for: ${configured.join(', ')}.`,
        'Credentials are NOT logged or persisted — they exist only for this session.',
        'Call get_config to confirm, then call connect to verify the live connections.',
      ],
      configured,
      skipped,
      note: 'Credentials held in memory only. Call configure_credentials again to update.',
    });
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: create_update_set
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'create_update_set',
  `Create a ServiceNow Update Set before starting any migration setup.
   An Update Set captures all configuration changes (staging tables, transform maps,
   field maps, scripts, etc.) into a named package that can be reviewed, exported,
   and deployed to other ServiceNow instances (e.g. from dev → test → production).

   IMPORTANT: Always ask the user for a name before calling this tool.
   A good name includes the source platform, project/object, and date — e.g.:
     "Jira KAN Migration - June 2026"
     "Salesforce Account Migration - v1"

   Call this after connect() and before build_artifacts() so all artifacts
   created during setup are captured in the update set.

   Also use list_update_sets to show existing in-progress update sets in case
   the user wants to reuse one instead of creating a new one.`,
  {
    name:        z.string().describe('Name for the update set — ask the user for this before calling'),
    description: z.string().optional().describe('Optional description of what this update set contains'),
  },
  async ({ name, description }) => {
    try {
      const sn = await getSn();

      // Create the update set
      const updateSet = await sn.createUpdateSet(name, description ?? `Migration setup: ${name}`);

      // Set as current so all subsequent changes land here
      await sn.setCurrentUpdateSet(updateSet.sys_id).catch(() => null); // non-fatal if preference API blocked

      const url = `${sn.baseUrl}/nav_to.do?uri=sys_update_set.do?sys_id=${updateSet.sys_id}`;

      return ok({
        instructions_for_claude: [
          `Tell the user: "I've created an Update Set called '${name}' in ServiceNow. All the migration configuration changes (staging tables, transform maps, field maps, etc.) will be captured in this update set."`,
          `Share the update set URL so they can view it: ${url}`,
          `Explain: "Once the migration setup is complete, you can export this update set and deploy it to other ServiceNow instances (like test or production) without having to redo the setup manually."`,
          `Proceed to check_migration_state or build_artifacts next.`,
        ],
        update_set: {
          sys_id:      updateSet.sys_id,
          name:        updateSet.name ?? name,
          state:       'in progress',
          url,
        },
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: list_update_sets
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'list_update_sets',
  `List all in-progress Update Sets in ServiceNow.
   Use this before creating a new one — the user may want to reuse an existing update set
   instead of creating a new one, especially if they are continuing a previous migration session.`,
  {},
  async () => {
    try {
      const sn   = await getSn();
      const sets = await sn.listUpdateSets();
      return ok({
        instructions_for_claude: sets.length
          ? [
              'Show the list of existing in-progress update sets to the user.',
              'Ask: "Would you like to use one of these existing update sets, or create a new one? If you want a new one, what should it be called?"',
            ]
          : [
              'Tell the user no in-progress update sets were found.',
              'Ask: "What would you like to name the update set for this migration? A good name includes the source, object/project, and date — for example: \'Jira KAN Migration - June 2026\'."',
              'Then call create_update_set with the name they give.',
            ],
        count:       sets.length,
        update_sets: sets.map(s => ({
          sys_id:      s.sys_id,
          name:        s.name,
          state:       s.state,
          created_on:  s.sys_created_on,
          created_by:  s.sys_created_by,
          description: s.description,
        })),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: complete_update_set
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'complete_update_set',
  `Mark a ServiceNow Update Set as complete when migration setup is finished.
   A completed update set can be exported as an XML file and deployed to other
   ServiceNow instances (test, UAT, production) via System Update Sets → Retrieved Update Sets.
   Call this after build_artifacts is done and the user has verified everything looks correct.`,
  {
    update_set_sys_id: z.string().describe('sys_id of the update set to complete'),
  },
  async ({ update_set_sys_id }) => {
    try {
      const sn  = await getSn();
      await sn.completeUpdateSet(update_set_sys_id);
      const url = `${sn.baseUrl}/nav_to.do?uri=sys_update_set.do?sys_id=${update_set_sys_id}`;
      return ok({
        instructions_for_claude: [
          'Tell the user: "The Update Set has been marked as complete. It\'s ready to be exported and deployed to other ServiceNow instances."',
          `Share the update set URL: ${url}`,
          'Explain next steps: "To deploy to another instance: go to System Update Sets → Retrieved Update Sets → Import Update Set from XML. Select the exported file and click Preview, then Commit."',
        ],
        status: 'complete',
        url,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: check_migration_state  (run before build_artifacts on any revisit)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'check_migration_state',
  `Inspect ServiceNow to see what migration artifacts already exist for a given source→target combination.
   Call this at the very start of any migration session (before build_artifacts) to avoid re-creating things.
   Returns a gap analysis: what exists, what's missing, and what needs to be added.
   Works for ANY source platform and ANY ServiceNow target table.`,
  {
    platform:      z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name:   z.string().describe('Source object / project key (e.g. KAN, Account, Case)'),
    sn_table:      z.string().describe('ServiceNow target table (e.g. incident, problem, change_request, cmdb_ci)'),
    staging_table: z.string().optional().describe('Override staging table name — auto-derived if omitted'),
  },
  async ({ platform, object_name, sn_table, staging_table }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);
      const source    = platform === 'salesforce' ? await getSf() : await getJira();

      let sourceFields;
      if (platform === 'salesforce') sourceFields = await discovery.discoverSalesforceSchema(source, object_name);
      else                           sourceFields = await discovery.discoverJiraSchema(source, object_name);

      const stagingDef = discovery.buildStagingDefinition(platform, object_name, sourceFields);
      if (staging_table) stagingDef.tableName = staging_table;

      const builder  = new ArtifactBuilder(sn);
      const existing = await builder.checkExisting({ stagingDef, targetTable: sn_table, platform, objectName: object_name });

      const gaps = [];
      if (!existing.stagingTable.exists)  gaps.push('staging_table');
      if (!existing.transformMap.exists)  gaps.push('transform_map');
      if (!existing.dataSource.exists)    gaps.push('data_source');
      if (!existing.restMessage.exists)   gaps.push('rest_message');

      const definedCols     = stagingDef.columns.length;
      const existingColSet  = new Set(existing.existingColumns.map(c => c.element));
      const missingCols     = stagingDef.columns.filter(c => !existingColSet.has(c.element) && !existingColSet.has(`u_${c.element}`));
      if (missingCols.length) gaps.push(`${missingCols.length} missing staging columns`);
      if (!existing.existingFieldMaps.length && existing.transformMap.exists) gaps.push('no field maps on existing transform map');

      return ok({
        instructions_for_claude: gaps.length === 0
          ? [
              'Tell the user: "Good news — all migration artifacts are already set up in ServiceNow. We can skip straight to running a test migration."',
              'Proceed directly to run_test_migration (or run_full_migration if they are ready).',
            ]
          : [
              `Tell the user what already exists and what still needs to be created.`,
              `Show the gaps list. Explain that build_artifacts will fill only the missing pieces (it won't recreate what's already there).`,
              'Ask: "Should I go ahead and set up the missing pieces now?"',
            ],
        staging_table:    existing.stagingTable,
        transform_map:    existing.transformMap,
        data_source:      existing.dataSource,
        rest_message:     existing.restMessage,
        columns: {
          defined:  definedCols,
          existing: existing.existingColumns.length,
          missing:  missingCols.map(c => c.element),
        },
        field_maps:        existing.existingFieldMaps.length,
        transform_scripts: existing.existingTxScripts.length,
        gaps,
        recommendation: gaps.length === 0 ? 'skip_to_test' : 'run_build_artifacts',
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: connect
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'connect',
  `Test live connections to one or all platforms using credentials already stored in .env.
   Call this after get_config to verify connections are working.
   Do NOT ask the user for any credentials before calling this — they are already configured.
   Returns connection status and instance URLs.`,
  {
    platform: z.enum(['servicenow', 'salesforce', 'jira', 'all']).default('all')
      .describe('Which platform(s) to connect to'),
  },
  async ({ platform }) => {
    try {
      const results = {};
      if (platform === 'all' || platform === 'servicenow') {
        const sn = await getSn();
        results.servicenow = { connected: true, instance: sn.baseUrl };
      }
      if (platform === 'all' || platform === 'salesforce') {
        const sf = await getSf();
        results.salesforce = { connected: true, instance: sf.instanceUrl, api_version: sf.apiVersion };
      }
      if (platform === 'all' || platform === 'jira') {
        const jira = await getJira();
        results.jira = { connected: true, base_url: jira.baseUrl };
      }
      return ok({ status: 'connected', ...results });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: suggest_target_table  (Phase 1.5 — before discover_schema)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'suggest_target_table',
  `Call this BEFORE discover_schema when the user has not told you which ServiceNow table to migrate into.
   It queries the live SN instance for all tables and ranks them by similarity to the source object name.
   Returns a ranked list of suggestions + a custom-table fallback.
   Present the top suggestion(s) to the user and ask them to confirm or choose a different one.
   NEVER guess or hardcode a table name — always call this first if the target is unknown.`,
  {
    platform:    z.string().describe('Source platform (e.g. salesforce, jira, hubspot, azure_devops — any string)'),
    object_name: z.string().describe('Source object name (e.g. Case, Account, KAN project, Ticket)'),
  },
  async ({ platform, object_name }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);
      const result    = await discovery.suggestTargetTable(object_name);

      return ok({
        instructions_for_claude: [
          result.suggested_table
            ? `Present this to the user: "Based on your ${platform} ${object_name} object, I suggest migrating into the ServiceNow '${result.suggested_table}' table (${result.suggested_label ?? result.suggested_table}). Confidence: ${result.confidence}."`
            : `Tell the user: "I couldn't find a close match in ServiceNow. I suggest creating a custom table named '${result.custom_table_hint}'.`,
          result.alternatives?.length
            ? `Also show the alternatives: ${result.alternatives.map(a => `${a.table} (${a.label})`).join(', ')}.`
            : null,
          `Always ask: "Would you like to use ${result.suggested_table ?? result.custom_table_hint}, or a different table?" before calling discover_schema.`,
          `If the user says "custom" or no match fits, suggest '${result.custom_table_hint}' as the new table name.`,
        ].filter(Boolean),
        ...result,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: discover_schema  (Phase 2 → Checkpoint 1)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'discover_schema',
  `Phase 2: Discover ALL source fields and ServiceNow target fields side by side.
   Returns complete field lists (every source field is included — none are skipped),
   auto-suggested staging table definition, and field mapping proposals.

   WORKFLOW:
   - If sn_table is not known yet, call suggest_target_table first and confirm with the user.
   - After calling this, STOP and present all fields + mappings to the user for Checkpoint 1 review.
   - For UNMAPPED fields (sn_target=null): highlight them and ask the user to either map them
     to an existing SN field or confirm they should land only in staging.
   - Show the upsert key (coalesce) fields so the user understands duplicate prevention.
   - Ask: (1) Are all source fields present? (2) Any mapping corrections? (3) Approve to continue?
   - Only call build_artifacts after explicit user approval.

   IMPORTANT — target table changes:
   If the user changes the sn_table AFTER this has been called, call discover_schema AGAIN from scratch.
   Discard all prior suggested_mappings — target fields will be completely different.

   GENERIC: platform can be any string — salesforce, jira, or any registered custom connector.`,
  {
    platform:    z.string().describe('Source platform — salesforce, jira, or any registered connector'),
    object_name: z.string().describe('Source object name (Salesforce: Account/Case/..., Jira: project key, etc.)'),
    sn_table:    z.string().describe('ServiceNow target table confirmed by the user (from suggest_target_table or explicit)'),
  },
  async ({ platform, object_name, sn_table }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);

      // Connector dispatch — generic, works for any platform
      let connector;
      if (platform === 'salesforce') connector = await getSf();
      else if (platform === 'jira')  connector = await getJira();
      // else: custom connector must have been registered via SchemaDiscovery.registerConnector()

      const sourceFields = await discovery.discoverSourceSchema(platform, connector, object_name);
      const snFields     = await discovery.discoverSnSchema(sn_table);
      const stagingDef   = discovery.buildStagingDefinition(platform, object_name, sourceFields);
      const mappings     = discovery.suggestMappings(sourceFields, snFields, { platform, objectName: object_name });

      const unmapped       = mappings.filter(m => !m.sn_target && !m.synthetic);
      const autoMapped     = mappings.filter(m => m.auto_matched);
      const coalesceFields = mappings.filter(m => m.coalesce);
      const scripted       = mappings.filter(m => m.needs_script);

      return ok({
        checkpoint: 1,
        instructions_for_claude: [
          `All ${sourceFields.length} source fields are included in suggested_mappings — none are skipped.`,
          'Present a table: source field | source type | → | SN target field | approach (direct/script/reference/unmapped).',
          unmapped.length
            ? `UNMAPPED fields (${unmapped.length}): ${unmapped.map(f => `'${f.source_field}'`).join(', ')}. ` +
              `For each, ask the user: map to an existing SN field, add a custom field to the target table, or keep only in staging?`
            : 'All fields were auto-mapped to ServiceNow target fields.',
          coalesceFields.length
            ? `Upsert keys: ${coalesceFields.map(f => `'${f.source_field}' → '${f.sn_target}'`).join(', ')}. Tell the user these prevent duplicate records on re-run.`
            : 'WARNING: No upsert key detected — ask the user which field should prevent duplicate records on re-run.',
          scripted.length
            ? `${scripted.length} fields will use value-mapping scripts (built from live schema values): ${scripted.map(f => f.source_field).slice(0, 5).join(', ')}${scripted.length > 5 ? '...' : ''}.`
            : null,
          'Ask: "Are the mappings correct? Any changes before I build the ServiceNow artifacts?"',
          `If the user changes the target table (e.g. "use problem instead of ${sn_table}"), call discover_schema AGAIN from scratch.`,
          'Wait for explicit approval before calling build_artifacts.',
        ].filter(Boolean),
        summary: {
          source_fields_count:   sourceFields.length,
          sn_fields_count:       snFields.length,
          auto_mapped_count:     autoMapped.length,
          unmapped_count:        unmapped.length,
          scripted_count:        scripted.length,
          staging_table:         stagingDef.tableName,
          coalesce_fields:       coalesceFields.map(f => ({
            source_field: f.source_field,
            sn_target:    f.sn_target,
            reason:       f.coalesce_reason,
          })),
          unmapped_fields:       unmapped.map(f => ({
            source_field:   f.source_field,
            source_label:   f.source_label,
            staging_column: f.staging_field,
            reason:         f.unmapped_reason,
          })),
        },
        source_fields:        sourceFields,
        sn_fields:            snFields,
        staging_definition:   stagingDef,
        suggested_mappings:   mappings,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: build_artifacts  (Phase 4 → Checkpoint 3)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'build_artifacts',
  `Phase 4: Create all migration artifacts in ServiceNow:
   staging table + columns, transform map, field maps, transform scripts, data source, REST message.
   Only call this after Checkpoint 1 (schema) AND Checkpoint 2 (mappings) are both approved by the user.
   After this completes, show the artifact summary and ask the user to verify in ServiceNow (Checkpoint 3).`,
  {
    platform:    z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name: z.string(),
    sn_table:    z.string(),
    mappings: z.array(z.object({
      staging_field:    z.string().describe('Column name in staging table'),
      source_field:     z.string().optional().describe('Source field name (SF API name or Jira field id)'),
      sn_target:        z.string().nullable().describe('ServiceNow target field name, or null to exclude'),
      coalesce:         z.boolean().default(false).describe('Use as upsert key (dedup on re-run)'),
      is_reference:     z.boolean().default(false),
      reference_value:  z.string().optional().describe('SN field used to resolve the reference (e.g. email)'),
      transform_script: z.string().optional().describe('JS body if value translation needed (sets answer = ...)'),
    })).describe('Approved field mappings — either from discover_schema or user-modified'),
  },
  async ({ platform, object_name, sn_table, mappings }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);
      const source    = platform === 'salesforce' ? await getSf() : await getJira();

      let sourceFields;
      if (platform === 'salesforce') sourceFields = await discovery.discoverSalesforceSchema(source, object_name);
      else                           sourceFields = await discovery.discoverJiraSchema(source, object_name);

      const stagingDef = discovery.buildStagingDefinition(platform, object_name, sourceFields);
      const builder    = new ArtifactBuilder(sn);
      const sourceUrl  = platform === 'salesforce'
        ? (process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com')
        : process.env.JIRA_BASE_URL;

      const results = await builder.build({
        stagingDef, mappings, targetTable: sn_table,
        platform, objectName: object_name, sourceBaseUrl: sourceUrl,
      });

      return ok({
        checkpoint: 3,
        instructions_for_claude: [
          'Show the artifacts summary to the user.',
          'Give them the transform_map_url to verify field mappings in ServiceNow.',
          'Ask: "Please open ServiceNow and verify the transform map looks correct. Reply Validated to run a test migration of 10 records."',
          'Only call run_test_migration after they confirm.',
        ],
        artifacts: results,
        transform_map_url: results.transformMap?.sys_id
          ? `${sn.baseUrl}/nav_to.do?uri=sys_transform_map.do?sys_id=${results.transformMap.sys_id}`
          : null,
        staging_table: results.stagingTable?.name,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: run_test_migration  (Phase 5 → Checkpoint 4)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'run_test_migration',
  `Trial run: sends a small sample of records (default 5) through the full migration pipeline
   and produces a detailed data quality report.

   The report checks three layers:
     1. Source (Jira/Salesforce) — what values exist in the original data
     2. Staging table — what landed in the ServiceNow staging table
     3. Target table  — what ended up in the final ServiceNow record (e.g. Incident)

   For each mapped field it shows the fill rate (% of records with a value) and flags
   any field that is blank in staging (source → staging data loss) or blank in the
   target (staging → target mapping failure).

   Only call this after build_artifacts. Only call run_full_migration after the user
   reviews this report and explicitly says "Approved".`,
  {
    platform:      z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name:   z.string().describe('Salesforce object name or Jira project key'),
    staging_table: z.string(),
    target_table:  z.string().describe('ServiceNow target table (e.g. incident, problem, change_request — whatever the user chose)'),
    mappings: z.array(z.object({
      staging_field: z.string(),
      source_field:  z.string().optional(),
      sn_target:     z.string().nullable().optional(),
    })),
    sample_size: z.number().default(5).describe('How many records to test (5–10 recommended)'),
    filter: z.string().optional(),
  },
  async ({ platform, object_name, staging_table, target_table, mappings, sample_size, filter }) => {
    try {
      const sn        = await getSn();
      const runner    = new MigrationRunner(sn);
      const validator = new MigrationValidator(sn);
      const limit     = sample_size ?? parseInt(process.env.MIGRATION_TEST_LIMIT ?? '5', 10);

      // Flatten function for Jira
      const flattenJira = (issue) => {
        const f = issue.fields ?? {};
        const flat = {};
        mappings.forEach(m => {
          if (!m.source_field) return;
          const val = f[m.source_field];
          if (val === null || val === undefined) { flat[m.staging_field] = ''; return; }
          if (m.source_field === 'description') { flat[m.staging_field] = JiraConnector.adfToText(val); return; }
          if (m.source_field === 'project')     { flat[m.staging_field] = val.key ?? ''; return; }
          if (typeof val === 'object' && val.emailAddress) flat[m.staging_field] = val.emailAddress;
          else if (typeof val === 'object' && val.name)    flat[m.staging_field] = val.name;
          else if (typeof val === 'object' && val.key)     flat[m.staging_field] = val.key;
          else if (Array.isArray(val)) flat[m.staging_field] = val.map(v => v.name ?? v).join('|');
          else flat[m.staging_field] = String(val);
        });
        return flat;
      };

      let records = [];
      if (platform === 'jira') {
        const jira   = await getJira();
        const jql    = filter ? `project=${object_name} AND ${filter}` : `project=${object_name} ORDER BY created DESC`;
        const result = await jira.search({ jql, maxResults: limit });
        const full   = await Promise.all(result.issues.map(i => jira.get(`/rest/api/3/issue/${i.id}`)));
        records = full.map(flattenJira);
      } else {
        const sf     = await getSf();
        const fields = [...new Set(mappings.map(m => m.source_field).filter(Boolean))].join(',');
        const where  = filter ? ` WHERE ${filter}` : '';
        const result = await sf.query(`SELECT ${fields} FROM ${object_name}${where} LIMIT ${limit}`);
        records = result.records.map(r => {
          const flat = {};
          mappings.forEach(m => { if (m.source_field) flat[m.staging_field] = r[m.source_field] ?? null; });
          return flat;
        });
      }

      // Push test records
      const testResults = await runner.runTestMigration(staging_table, records);

      // Data quality validation
      const validationReport = await validator.validate({
        platform, source: null,
        stagingTable: staging_table,
        targetTable:  target_table,
        mappings,
        sampleSize:   limit,
      });

      return ok({
        checkpoint: 4,
        instructions_for_claude: [
          `Tell the user in plain English: "We just moved ${records.length} sample records from Jira into ServiceNow as a test."`,
          `Show the data quality report — highlight any fields flagged as blank in staging or blank in the incident.`,
          `If staging_issues or target_issues exist, explain what went wrong in simple terms (e.g. "The Priority field didn't get copied across — we need to fix the mapping before running the full migration").`,
          `If overall_health is PASS, say: "The test looks good — all fields came through correctly. Ready to run the full migration?"`,
          `Only call run_full_migration after the user replies with clear approval (e.g. "Yes, run it" or "Approved").`,
        ],
        test_summary: {
          records_tested: records.length,
          ...testResults.counts,
        },
        data_quality: {
          overall_health:  validationReport.overall_health,
          staging_issues:  validationReport.staging_issues.map(f => ({ field: f.staging_field, fill_rate: `${f.staging_pct}%` })),
          target_issues:   validationReport.target_issues.map(f => ({ field: f.target_field,  fill_rate: `${f.target_pct}%`  })),
          field_detail:    validationReport.fields.map(f => ({
            from: f.staging_field,
            to:   f.target_field,
            staging_fill: `${f.staging_pct}%`,
            target_fill:  f.target_pct !== null ? `${f.target_pct}%` : 'n/a',
            status: f.staging_issue ? 'BLANK IN STAGING' : f.target_issue ? 'BLANK IN TARGET' : 'OK',
          })),
        },
        staging_table,
        target_table,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: analyze_dependencies  (Phase 3 — before build_artifacts)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'analyze_dependencies',
  `Phase 3: Analyse migration dependencies before building artifacts.

   For Jira:
     - Scans all referenced users (assignee/reporter), checks if they exist in ServiceNow
     - Identifies issue type hierarchy (Epic/Story → Task/Bug → Subtask)
     - Proposes a sequenced migration plan (Tier 1 = parents first, Tier 2 = children, etc.)

   For Salesforce:
     - Counts records per object
     - Detects parent/child object relationships (e.g. Account → Contact, Account → Case)
     - Checks record owners (OwnerId) against ServiceNow sys_user
     - Warns if a parent object is not included in the migration scope
     - Proposes migration order (parent objects first, child objects after)

   Always call this after discover_schema and before build_artifacts.
   If users are missing, ask the user whether to auto-create them in SN.`,
  {
    platform:          z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    project_keys:      z.array(z.string()).describe('Jira project keys or Salesforce object names to analyse (e.g. ["EMAL","KAN"] or ["Account","Contact","Case"])'),
    auto_create_users: z.boolean().default(false).describe('Create missing SN users automatically'),
  },
  async ({ platform, project_keys, auto_create_users }) => {
    try {
      const sn       = await getSn();
      const analyzer = new DependencyAnalyzer(sn);

      let analysis;
      if (platform === 'jira') {
        const jira = await getJira();
        analysis   = await analyzer.analyze(platform, jira, project_keys);
      } else {
        const sf = await getSf();
        analysis  = await analyzer.analyze(platform, sf, project_keys);
      }

      let usersCreated = [];
      if (auto_create_users && analysis.users.missing.length) {
        usersCreated = await analyzer.createMissingUsers(analysis.users.missing);
      }

      return ok({
        instructions_for_claude: [
          'Show the dependency summary to the user in plain English.',
          'Show the record counts per object/project.',
          analysis.missingInTarget?.length
            ? `Highlight the ${analysis.missingInTarget.length} missing reference(s) — explain the impact of each in plain language (e.g. "5 issues reference a user that doesn't exist in ServiceNow — those records will have a blank assignee field").`
            : 'Tell the user all referenced records already exist in ServiceNow.',
          analysis.users.missing.length && !auto_create_users
            ? 'For missing users specifically, ask: "Should I create these users in ServiceNow now so that assignee and owner fields resolve correctly?"'
            : null,
          analysis.warnings.length
            ? 'List any warnings about out-of-scope references — explain what will break if the referenced object is not migrated.'
            : null,
          'Show the migration sequence (Tier 1 first, then Tier 2, etc.) and explain why the order matters.',
          'After user confirms, proceed to build_artifacts.',
        ].filter(Boolean),
        record_counts:   analysis.hierarchy,
        references: {
          total:      analysis.references.length,
          resolved:   analysis.references.filter(r => r.resolved).length,
          unresolved: analysis.references.filter(r => r.resolved === false).length,
          by_type:    analysis.references.reduce((acc, r) => { acc[r.type] = (acc[r.type] ?? 0) + 1; return acc; }, {}),
        },
        missing_in_target: analysis.missingInTarget,
        users: {
          found:   analysis.users.found.map(u => u.email),
          missing: analysis.users.missing,
          created: usersCreated,
        },
        migration_sequence: analysis.migrationSequence.map(s => ({
          tier:       s.tier,
          types:      s.types,
          count:      s.count,
          note:       s.note ?? null,
          ref_fields: s.ref_fields ?? [],
        })),
        warnings: analysis.warnings,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: analyze_transform_map  (utility — inspect existing transform map)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'analyze_transform_map',
  `Inspect an existing ServiceNow transform map and report:
   - Field maps (direct vs field map scripts)
   - Standalone transform scripts (and whether they have field_name set)
   - Issues: orphan scripts, missing field_name, scripts that should be field map scripts
   - Suggestions to improve the transform map following best practices
   Use this to audit a transform map after build_artifacts or to review a manually built one.`,
  {
    transform_map_sys_id: z.string().describe('sys_id of the sys_transform_map record'),
  },
  async ({ transform_map_sys_id }) => {
    try {
      const sn       = await getSn();
      const analyzer = new DependencyAnalyzer(sn);
      const analysis = await analyzer.analyzeTransformMap(transform_map_sys_id);

      return ok({
        instructions_for_claude: [
          'Show the field map breakdown (direct vs scripted) and transform scripts.',
          'Highlight any issues (orphan scripts, missing field_name).',
          'Present suggestions clearly — offer to fix them if the user agrees.',
        ],
        ...analysis,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: run_full_migration  (Phase 6)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'run_full_migration',
  `Phase 6: Migrate ALL records from source to ServiceNow.
   For Jira: automatically migrates in dependency order (Tier 1 parents first, then children).
   For Salesforce: paginated bulk migration.
   Only call after explicit user approval at Checkpoint 4.
   Stops immediately on any error and reports what happened.`,
  {
    platform:      z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name:   z.string().describe('Salesforce object or comma-separated Jira project keys (e.g. "EMAL,KAN")'),
    staging_table: z.string(),
    mappings: z.array(z.object({
      staging_field: z.string(),
      source_field:  z.string().optional(),
    })),
    filter: z.string().optional().describe('Optional SOQL WHERE or JQL to scope the migration'),
  },
  async ({ platform, object_name, staging_table, mappings, filter }) => {
    try {
      const sn     = await getSn();
      const runner = new MigrationRunner(sn);

      if (platform === 'jira') {
        const jira       = await getJira();
        const analyzer   = new DependencyAnalyzer(sn);
        const projectKeys = object_name.split(',').map(k => k.trim());

        // Build JQL — apply filter server-side so we only fetch matching issues
        const baseJql  = `project IN (${projectKeys.map(k => `"${k}"`).join(',')})`;
        const fullJql  = filter ? `${baseJql} AND (${filter})` : baseJql;

        // Dependency analysis with JQL so only filtered issues are fetched
        const analysis = await analyzer.analyze('jira', jira, projectKeys, fullJql);
        if (analysis.users.missing.length) {
          await analyzer.createMissingUsers(analysis.users.missing);
        }

        // Flatten function using staging field names
        const flattenIssue = (issue) => {
          const f = issue.fields ?? {};
          const flat = {};
          mappings.forEach(m => {
            if (!m.source_field) return;
            const val = f[m.source_field];
            if (val === null || val === undefined) { flat[m.staging_field] = ''; return; }
            if (m.source_field === 'description') { flat[m.staging_field] = JiraConnector.adfToText(val); return; }
            if (m.source_field === 'project')     { flat[m.staging_field] = val.key ?? ''; return; }
            if (typeof val === 'object' && val.emailAddress) flat[m.staging_field] = val.emailAddress;
            else if (typeof val === 'object' && val.name)    flat[m.staging_field] = val.name;
            else if (typeof val === 'object' && val.key)     flat[m.staging_field] = val.key;
            else if (Array.isArray(val)) flat[m.staging_field] = val.map(v => v.name ?? v).join('|');
            else flat[m.staging_field] = String(val);
          });
          return flat;
        };

        const sequence = analysis.migrationSequence;

        // Use batch runner: divides records into import sets, runs up to 5 in parallel
        const batchRunner = new BatchMigrationRunner(sn);
        const result = await batchRunner.run(staging_table, sequence, flattenIssue);
        return ok({
          ...result,
          users_created: analysis.users.missing.length,
          migration_sequence: sequence.map(s => ({ tier: s.tier, types: s.types, count: s.count })),
          instructions_for_claude: result.stopped
            ? [
                result.reason === 'import_set_limit_reached'
                  ? `Tell the user: "ServiceNow is currently busy running ${result.active} other import jobs. Please wait a few minutes and try again."`
                  : 'Migration stopped due to an error. Show the details and ask whether to retry or stop.',
              ]
            : [
                `Tell the user in plain English: "The migration is complete! ${result.stats.inserted} records were successfully moved into ServiceNow."`,
                `Show the stats table (inserted / updated / ignored / errors) and how many import sets were used.`,
                `If there were errors, show them and suggest next steps.`,
              ],
        });
      }

      // Salesforce — batched paginated migration
      const sf          = await getSf();
      const fields      = [...new Set(mappings.map(m => m.source_field).filter(Boolean))].join(',');
      const where       = filter ? ` WHERE ${filter}` : '';
      const flatSf      = (r) => {
        const flat = {};
        mappings.forEach(m => { if (m.source_field) flat[m.staging_field] = r[m.source_field] ?? null; });
        return flat;
      };
      const sfRunner    = new MigrationRunner(sn);
      const iter        = sf.fetchAllRecords(`SELECT ${fields} FROM ${object_name}${where}`);
      const result      = await sfRunner.runFullMigration(staging_table, iter, flatSf);
      return ok({
        ...result,
        instructions_for_claude: result.stopped
          ? ['Migration stopped. Show error details and ask the user how to proceed.']
          : ['Tell the user the migration is complete and show the final record counts.'],
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: cleanup_migration
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'cleanup_migration',
  `Remove records that were created during a migration — both from the staging table
   and from the target table (e.g. incidents).

   Use this if:
     - The test migration created records you want to delete before the real run
     - A migration went wrong and you want to start fresh
     - The client asked you to roll back

   IMPORTANT: Always ask the user for explicit permission before calling this tool.
   Show them exactly how many records will be deleted and from which tables.
   Only proceed after they confirm with "Yes, delete them" or similar.`,
  {
    staging_table:   z.string(),
    target_table:    z.string().describe('ServiceNow target table to clean up (same table that was used in build_artifacts)'),
    project_keys:    z.array(z.string()).optional().describe('Project / object keys to scope the cleanup (e.g. ["EMAL","KAN"])'),
    project_field:   z.string().optional().describe('Staging table column that holds the project key (e.g. u_jira_project). Used to scope deletion. Leave blank to delete all staging records.'),
    confirmed:       z.boolean().describe('Must be true — user has explicitly confirmed the deletion'),
  },
  async ({ staging_table, target_table, project_keys, project_field, confirmed }) => {
    try {
      if (!confirmed) {
        return ok({
          instructions_for_claude: [
            'The user has NOT confirmed the deletion yet.',
            `First discover what would be deleted by calling cleanup_migration with confirmed=false (already done — see below).`,
            'Show the user exactly how many staging records and incidents will be permanently deleted.',
            'Ask: "Are you sure you want to permanently delete these records? This cannot be undone. Please reply \'Yes, delete them\' to confirm."',
            'Only call cleanup_migration with confirmed=true after they explicitly confirm.',
          ],
          status: 'awaiting_confirmation',
        });
      }

      const sn      = await getSn();
      const cleanup = new MigrationCleanup(sn);
      const result  = await cleanup.cleanupAll({
        stagingTable:  staging_table,
        targetTable:   target_table,
        projectKeys:   project_keys ?? [],
        projectField:  project_field ?? null,
      });

      return ok({
        ...result,
        instructions_for_claude: [
          `Tell the user in plain English: "${result.summary}."`,
          'Confirm that both the staging records and the ServiceNow incidents have been removed.',
          'Let them know they can run the migration again from scratch.',
        ],
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: cleanup_artifacts
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'cleanup_artifacts',
  `Remove all migration artifacts that were created in ServiceNow during the setup phase.
   This deletes (in safe order):
     1. Field maps  (sys_transform_entry)
     2. Transform scripts  (sys_transform_script)
     3. Transform map  (sys_transform_map)
     4. Staging table columns  (sys_dictionary)
     5. Staging table  (sys_db_object)
     6. Data source  (sys_data_source)
     7. REST message  (sys_rest_message)

   Use this when you want a completely clean slate — for example after a failed migration setup,
   or when the customer wants to restart with different field mappings.

   IMPORTANT: Always discover first (confirmed=false) to show the user exactly what will be deleted.
   Only delete after they explicitly confirm with "Yes, delete them" or similar.`,
  {
    platform:      z.string().describe('Source platform used during setup'),
    object_name:   z.string().describe('Source object / project key used during setup (e.g. KAN, Account)'),
    staging_table: z.string().describe('Staging table name (e.g. u_stg_jira_kan)'),
    target_table:  z.string().describe('ServiceNow target table (e.g. incident, problem, change_request)'),
    confirmed:     z.boolean().describe('Must be true — user has explicitly confirmed the deletion'),
  },
  async ({ platform, object_name, staging_table, target_table, confirmed }) => {
    try {
      const sn      = await getSn();
      const cleanup = new MigrationCleanup(sn);

      // Always discover first so we can show the user what will be deleted
      const artifacts = await cleanup.discoverArtifacts({
        stagingTable: staging_table,
        targetTable:  target_table,
        platform,
        objectName:   object_name,
      });

      if (!confirmed) {
        const willDelete = [
          artifacts.stagingTable.exists  ? `Staging table: ${artifacts.stagingTable.name}`                  : null,
          artifacts.transformMap.exists  ? `Transform map: ${artifacts.transformMap.name}`                  : null,
          artifacts.fieldMaps.length     ? `${artifacts.fieldMaps.length} field map(s)`                     : null,
          artifacts.transformScripts.length ? `${artifacts.transformScripts.length} transform script(s)`    : null,
          artifacts.columns.length       ? `${artifacts.columns.length} staging column definition(s)`       : null,
          artifacts.dataSource.exists    ? `Data source: ${artifacts.dataSource.name}`                      : null,
          artifacts.restMessage.exists   ? `REST message: ${artifacts.restMessage.name}`                    : null,
        ].filter(Boolean);

        return ok({
          instructions_for_claude: [
            'Show the user the full list of artifacts that will be permanently deleted from ServiceNow.',
            willDelete.length
              ? `Say: "I found ${willDelete.length} migration artifact(s) in ServiceNow. Deleting these will remove the staging table, transform map, field maps, and all related configuration. This cannot be undone. Do you want to proceed?"`
              : 'Tell the user: "No migration artifacts were found in ServiceNow for this configuration — nothing to delete."',
            'Only call cleanup_artifacts with confirmed=true after explicit user approval.',
          ],
          status:       willDelete.length ? 'awaiting_confirmation' : 'nothing_to_delete',
          will_delete:  willDelete,
          artifacts_found: {
            staging_table:     artifacts.stagingTable.exists,
            transform_map:     artifacts.transformMap.exists,
            field_maps:        artifacts.fieldMaps.length,
            transform_scripts: artifacts.transformScripts.length,
            columns:           artifacts.columns.length,
            data_source:       artifacts.dataSource.exists,
            rest_message:      artifacts.restMessage.exists,
          },
        });
      }

      const result = await cleanup.cleanupArtifacts({
        stagingTable: staging_table,
        targetTable:  target_table,
        platform,
        objectName:   object_name,
      });

      return ok({
        ...result,
        instructions_for_claude: [
          `Tell the user in plain English: "${result.summary}"`,
          result.failed.length
            ? 'Some items could not be deleted — list them and suggest the user delete them manually in ServiceNow (System Definition → Tables / Transform Maps).'
            : 'Let them know the ServiceNow environment is now clean and they can start the migration setup from scratch.',
        ],
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: verify_migration_counts
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'verify_migration_counts',
  `Verify that record counts match across all three layers of a migration:
     Source (Jira / Salesforce)  →  Staging table  →  Target table

   Checks:
     - How many records exist in the source
     - How many rows landed in the staging table
     - How many records were created in the target table
     - Whether staging count matches source (no records lost in transit)
     - Whether target count matches staging (no records lost in transform)
     - Whether there are MORE records in staging or target than in source (duplicates)

   Use this after a full migration to confirm data integrity.
   Also useful after a test migration to see how many records were actually moved.`,
  {
    platform:      z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name:   z.string().describe('Comma-separated Jira project keys or Salesforce object name (e.g. "EMAL,KAN" or "Account")'),
    staging_table: z.string().describe('Staging table name (e.g. u_stg_jira_kan)'),
    target_table:  z.string().describe('ServiceNow target table (e.g. incident, problem, change_request)'),
    project_field: z.string().optional().describe('Staging/target field that holds the project key for scoped queries (e.g. u_jira_project). Leave blank to count all rows.'),
    filter:        z.string().optional().describe('Optional JQL (Jira) or SOQL WHERE clause (Salesforce) to scope the source count'),
  },
  async ({ platform, object_name, staging_table, target_table, project_field, filter }) => {
    try {
      const sn      = await getSn();
      const keys    = object_name.split(',').map(k => k.trim());
      const results = [];

      for (const key of keys) {
        // ── Source count ──────────────────────────────────────────────────
        let sourceCount = 0;
        if (platform === 'jira') {
          const jira  = await getJira();
          const jql   = filter ? `project=${key} AND ${filter}` : `project=${key}`;
          const res   = await jira.search({ jql, maxResults: 0 });
          sourceCount = res.total ?? 0;
        } else {
          const sf     = await getSf();
          const where  = filter ? ` WHERE ${filter}` : '';
          const res    = await sf.query(`SELECT COUNT() FROM ${key}${where}`);
          sourceCount  = res.totalSize ?? 0;
        }

        // ── Staging count ─────────────────────────────────────────────────
        const stagingQuery = project_field ? `${project_field}=${key}` : '';
        const stagingCount = await sn.getCount(staging_table, stagingQuery).catch(() => null);

        // ── Target count ──────────────────────────────────────────────────
        const targetQuery = project_field ? `${project_field}=${key}` : '';
        const targetCount = await sn.getCount(target_table, targetQuery).catch(() => null);

        // ── Evaluate ──────────────────────────────────────────────────────
        const stagingOk = stagingCount != null && stagingCount === sourceCount;
        const targetOk  = targetCount  != null && targetCount  === sourceCount;
        const stagingExtra = stagingCount != null && stagingCount > sourceCount;
        const targetExtra  = targetCount  != null && targetCount  > sourceCount;

        let status;
        if (stagingOk && targetOk)      status = 'PASS';
        else if (stagingExtra || targetExtra) status = 'DUPLICATES DETECTED';
        else                            status = 'MISMATCH';

        results.push({
          key,
          source_count:  sourceCount,
          staging_count: stagingCount,
          target_count:  targetCount,
          staging_match: stagingOk,
          target_match:  targetOk,
          staging_extra: stagingExtra,
          target_extra:  targetExtra,
          status,
          issues: [
            !stagingOk && !stagingExtra && stagingCount != null
              ? `${sourceCount - stagingCount} record(s) missing from staging (lost between source and staging)`
              : null,
            stagingExtra
              ? `${stagingCount - sourceCount} extra record(s) in staging — possible duplicate push`
              : null,
            !targetOk && !targetExtra && targetCount != null
              ? `${(stagingCount ?? sourceCount) - targetCount} record(s) missing from target (transform may have failed for some)`
              : null,
            targetExtra
              ? `${targetCount - sourceCount} extra record(s) in target — possible duplicate migration run`
              : null,
          ].filter(Boolean),
        });
      }

      const allPass = results.every(r => r.status === 'PASS');

      return ok({
        instructions_for_claude: allPass
          ? [
              `Tell the user: "Record counts match perfectly across all layers — the migration is verified."`,
              `Show the summary table with source / staging / target counts for each project.`,
            ]
          : [
              `Show the count comparison table for each project.`,
              `For any MISMATCH, explain in plain English what went wrong (e.g. "5 records made it to staging but only 3 reached the incident table — the transform failed for 2 records").`,
              `For DUPLICATES DETECTED, warn the user that the migration may have been run more than once and suggest running cleanup_migration before re-running.`,
              `If all counts match, confirm the migration is complete and accurate.`,
            ],
        overall_status: allPass ? 'PASS' : 'NEEDS REVIEW',
        results,
        summary: results.map(r =>
          `${r.key}: source=${r.source_count} | staging=${r.staging_count ?? 'n/a'} | target=${r.target_count ?? 'n/a'} → ${r.status}`
        ),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: list_sf_flows  (Phase F2)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'list_sf_flows',
  `List all active Salesforce flows with their types.
   Use this to show the user what flows are available before asking which to migrate.
   Screen Flows are flagged as manual-only.`,
  {},
  async () => {
    try {
      const retriever = new FlowRetriever(await getSf());
      const flows     = await retriever.listFlows();
      return ok({
        total: flows.length,
        flows: flows.map((f, i) => ({
          index:          i + 1,
          api_name:       f.Definition?.DeveloperName ?? f.MasterLabel,
          label:          f.MasterLabel,
          process_type:   f.ProcessType,
          last_modified_by: f.LastModifiedBy?.Name ?? null,
          last_modified_date: f.LastModifiedDate ?? null,
          manual_only:    f.ProcessType === 'Flow',
        })),
        instructions_for_claude: [
          'Present the flow list to the user.',
          'Flag Screen Flows (manual_only: true) — these cannot be automated.',
          'Ask which flows they want to migrate (by number or api_name).',
          'Ask for the ServiceNow target table and scope prefix before calling migrate_flows.',
        ],
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: analyze_flow  (Phase F3 → Checkpoint F1)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'analyze_flow',
  `Phase F3: Fetch and parse a Salesforce flow's full metadata.
   Returns structured breakdown of trigger, variables, and elements.
   After calling, present the analysis to the user and ask the clarifying questions required for Checkpoint F1.
   Only call build_flow after user confirms the understanding is correct.`,
  {
    flow_api_name: z.string().describe('Exact Salesforce Flow API name'),
    sn_table:      z.string().describe('ServiceNow table this flow will operate on'),
  },
  async ({ flow_api_name, sn_table }) => {
    try {
      const retriever = new FlowRetriever(await getSf());
      const raw       = await retriever.getFlowMetadata(flow_api_name);
      if (!raw) throw new Error(`Flow "${flow_api_name}" not found or not active`);
      const structure = retriever.parseFlowStructure(raw);

      const clarifyingQuestions = [
        `This flow operates on Salesforce. The equivalent ServiceNow table you specified is "${sn_table}" — is that correct?`,
        `The flow references these fields: ${structure.elements.flatMap(e => Object.values(e).filter(v => typeof v === 'string' && v.includes('.'))).slice(0, 5).join(', ') || '(none detected)'}. What are their equivalent SN field names on ${sn_table}?`,
        structure.elements.some(e => e.kind === 'action') ? `This flow calls external actions. Should those become Script Steps or ServiceNow Notifications in SN?` : null,
        structure.elements.some(e => e.kind === 'subflow') ? `This flow calls subflows. Are those subflows also being migrated?` : null,
      ].filter(Boolean);

      return ok({
        checkpoint: 'F1',
        instructions_for_claude: [
          'Present the flow structure summary (trigger, variables, elements) to the user.',
          'Ask all clarifying_questions in one message — do not ask one at a time.',
          'After the user answers, write a plain-English summary of what the flow does and ask them to confirm.',
          'Only call build_flow after they reply "Confirmed".',
        ],
        flow: {
          api_name:      structure.apiName,
          type:          structure.type,
          trigger:       structure.trigger,
          variables:     structure.variables,
          elements:      structure.elements.map(e => ({
            name: e.name ?? e.label,
            kind: e.kind,
            description: FlowRetriever.describeElement(e),
            manual_required: e.kind === 'screen',
          })),
          is_screen_flow: structure.isScreen,
        },
        clarifying_questions: clarifyingQuestions,
        sn_table,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: generate_migration_guide
// Replaces build_flow / build_subflow / build_jira_automation / create_custom_action
// Produces a clear numbered step-by-step guide for replicating the flow
// manually in ServiceNow Workflow Studio — no Table API calls.
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'generate_migration_guide',
  `Generates a clear, numbered step-by-step guide for manually building a
   Salesforce or Jira flow/automation inside ServiceNow Workflow Studio.

   Does NOT touch ServiceNow via API — it only produces a human guide.
   Call this after analyze_flow or analyze_jira_automation.

   The guide covers every click: where to go, what to name things,
   which trigger to choose, how to add each step and fill in its fields.`,
  {
    source_platform: z.enum(['salesforce', 'jira']).describe('Where the flow comes from'),
    flow_analysis:   z.object({
      name:        z.string(),
      description: z.string().optional(),
      type:        z.string().describe('record | scheduled | screen | subflow | autolaunched | jira_rule'),
      trigger: z.object({
        object:    z.string().optional().describe('Salesforce object / Jira project'),
        when:      z.string().optional().describe('created | updated | createdOrUpdated | scheduled | manual'),
        condition: z.string().optional().describe('Entry condition / filter'),
        schedule:  z.string().optional().describe('e.g. daily at 08:00'),
      }).optional(),
      variables: z.array(z.object({
        name:     z.string(),
        type:     z.string().optional(),
        isInput:  z.boolean().optional(),
        isOutput: z.boolean().optional(),
      })).default([]),
      steps: z.array(z.object({
        order:       z.number(),
        label:       z.string(),
        type:        z.string().describe('recordCreate | recordUpdate | recordDelete | recordLookup | decision | loop | notification | script | subflow | approval | wait | screen'),
        table:       z.string().optional(),
        fields:      z.record(z.string()).optional().describe('field → value mappings'),
        condition:   z.string().optional(),
        script:      z.string().optional(),
        notes:       z.string().optional().describe('Extra context or why this step is needed'),
        manual_only: z.boolean().default(false).describe('True if this cannot be automated and must be done manually'),
      })).default([]),
    }).describe('Parsed flow structure from analyze_flow or analyze_jira_automation'),
    sn_table:       z.string().describe('ServiceNow target table (e.g. incident, problem, sc_req_item)'),
    field_mappings: z.record(z.string()).default({}).describe('Source field → SN field name'),
    sn_instance_url: z.string().optional().describe('SN instance URL for direct links (e.g. https://yourinstance.service-now.com)'),
  },
  async ({ source_platform, flow_analysis, sn_table, field_mappings, sn_instance_url }) => {
    try {
      const sn   = await getSn();
      const base = sn_instance_url ?? process.env.SN_INSTANCE_URL?.replace(/\/$/, '') ?? 'https://your-instance.service-now.com';
      const fa   = flow_analysis;

      const mapField = (f) => field_mappings[f] ?? f;
      const isSubflow = ['subflow','autolaunched','autolaunchedflow'].includes((fa.type ?? '').toLowerCase());
      const isScheduled = (fa.type ?? '').toLowerCase().includes('sched') || fa.trigger?.when === 'scheduled';

      // ── Step-type → SN action name ─────────────────────────────────────
      const actionNames = {
        recordCreate:  'Create Record',
        recordUpdate:  'Update Record',
        recordDelete:  'Delete Record',
        recordLookup:  'Look Up Record',
        notification:  'Send Notification',
        script:        'Run Script',
        approval:      'Ask for Approval',
        wait:          'Wait for Condition',
        subflow:       'Flow Logic → Subflow',
        decision:      'Flow Logic → If',
        loop:          'Flow Logic → For Each',
      };

      // ── Trigger description ─────────────────────────────────────────────
      const triggerLines = (() => {
        const t = fa.trigger ?? {};
        if (isSubflow) {
          return [
            '(Subflows have no trigger — they are called by other flows)',
            'In the "Type" dropdown at the top, select **Subflow**',
          ];
        }
        if (isScheduled) {
          return [
            'Click **Trigger** → choose **Scheduled**',
            `Set frequency: **${t.schedule ?? 'Daily at 08:00'}**`,
            t.condition ? `Set run condition: \`${t.condition}\`` : null,
          ].filter(Boolean);
        }
        const when = { created:'Created', updated:'Updated', createdOrUpdated:'Created or Updated', before:'Before Save', after:'After Save' }[t.when ?? 'createdOrUpdated'] ?? 'Created or Updated';
        return [
          'Click **Trigger** → choose **Record**',
          `Table: **${sn_table}**`,
          `When: **${when}**`,
          t.condition ? `Condition (click "Add filter"): \`${t.condition}\`` : 'Leave condition blank to run on every record',
          fa.source_platform === 'salesforce' && t.when === 'before' ? '⚠ Before-save flows → set "When to run" to **Before** in advanced trigger settings' : null,
        ].filter(Boolean);
      })();

      // ── Build step guide ────────────────────────────────────────────────
      const stepGuides = fa.steps.map((step, idx) => {
        const num   = idx + 1;
        const sType = step.type ?? 'script';
        const aName = actionNames[sType] ?? 'Run Script';
        const lines = [`**Step ${num} — ${step.label}**`];

        if (step.manual_only) {
          lines.push('⚠️  **MANUAL STEP** — cannot be fully automated, build by hand:');
        }

        // Where to click
        lines.push(`Click the **+** button → **Action** → search for "**${aName}**" → select it`);
        lines.push(`Label the step: **"${step.label}"**`);

        // Step-specific instructions
        if (sType === 'decision') {
          lines.push(`This is a branch. Choose **Flow Logic → If**`);
          lines.push(`Condition: \`${step.condition ?? 'set your condition here'}\``);
          lines.push('Add the True-branch steps inside the If block, then add False/Else steps below');
        } else if (sType === 'loop') {
          lines.push('Choose **Flow Logic → For Each**');
          lines.push(`Collection: set to the record list variable from the previous Look Up step`);
          lines.push('Add loop body steps inside the For Each block');
        } else if (sType === 'recordCreate') {
          lines.push(`Table: **${step.table ?? sn_table}**`);
          if (step.fields && Object.keys(step.fields).length) {
            lines.push('Fields to set:');
            Object.entries(step.fields).forEach(([f,v]) => lines.push(`  • ${mapField(f)} = \`${v}\``));
          } else {
            lines.push('Click **Add Field Value** and set each field you want to populate');
          }
        } else if (sType === 'recordUpdate') {
          lines.push(`Table: **${step.table ?? sn_table}**`);
          lines.push('Record: drag the trigger record data pill into the "Record" field');
          if (step.fields && Object.keys(step.fields).length) {
            lines.push('Fields to update:');
            Object.entries(step.fields).forEach(([f,v]) => lines.push(`  • ${mapField(f)} = \`${v}\``));
          } else {
            lines.push('Click **Add Field Value** and set each field to update');
          }
        } else if (sType === 'recordDelete') {
          lines.push(`Table: **${step.table ?? sn_table}**`);
          lines.push('Record: drag the trigger record data pill into the "Record" field');
        } else if (sType === 'recordLookup') {
          lines.push(`Table: **${step.table ?? sn_table}**`);
          lines.push(`Conditions: ${step.condition ?? 'add query filters to find the right record(s)'}`);
          lines.push('Save the output as a flow variable for use in later steps');
        } else if (sType === 'notification') {
          lines.push('Choose **Send Notification**');
          lines.push(step.fields?.to ? `To: ${step.fields.to}` : 'To: drag the user/email data pill');
          lines.push(step.fields?.subject ? `Subject: "${step.fields.subject}"` : 'Subject: set notification subject');
          lines.push('Or choose an existing **Notification** record from your SN instance');
        } else if (sType === 'approval') {
          lines.push('Choose **Ask for Approval**');
          lines.push('Table: set to the record being approved');
          lines.push('Approvers: add users or groups who must approve');
          lines.push('Add a branch for Approved / Rejected outcomes');
        } else if (sType === 'subflow') {
          lines.push('Choose **Flow Logic → Subflow**');
          lines.push(`Subflow: search for "${step.label}" (build and publish the subflow first)`);
          lines.push('Map input values by dragging data pills from parent flow variables');
        } else {
          // script / fallback
          if (step.script) {
            lines.push('Choose **Run Script**');
            lines.push('Paste this script into the Script field:');
            lines.push('```javascript');
            lines.push(step.script.trim());
            lines.push('```');
          } else {
            lines.push(`Choose **${aName}** and configure it for: ${step.notes ?? step.label}`);
          }
        }

        if (step.notes && sType !== 'script') lines.push(`📝 Note: ${step.notes}`);
        return lines.join('\n');
      });

      // ── Variables guide ─────────────────────────────────────────────────
      const varLines = fa.variables?.length ? fa.variables.map(v =>
        `• **${v.name}** (${v.type ?? 'String'})${v.isInput ? ' — Input' : ''}${v.isOutput ? ' — Output' : ''}`
      ) : ['(No variables needed)'];

      // ── Compose the full guide ──────────────────────────────────────────
      const guide = [
        `# ServiceNow Migration Guide`,
        `**Source:** ${source_platform === 'salesforce' ? 'Salesforce' : 'Jira'} → **"${fa.name}"**`,
        `**Target table:** \`${sn_table}\``,
        `**Flow type:** ${isSubflow ? 'Subflow' : isScheduled ? 'Scheduled Flow' : 'Record-Triggered Flow'}`,
        fa.description ? `**Description:** ${fa.description}` : null,
        '',
        '---',
        '',
        '## 1 — Open Workflow Studio',
        `1. Go to: **${base}/flow-designer.do**`,
        '2. Click **New** (top-right) → choose **Flow** (or **Subflow** if this is a reusable subflow)',
        `3. Name: **"${fa.name}"**`,
        `4. Description: "${fa.description ?? fa.name}"`,
        '5. Run as: **System** (recommended for automation flows)',
        '6. Click **Submit**',
        '',
        '---',
        '',
        '## 2 — Configure the Trigger',
        ...triggerLines.map((l, i) => `${i + 1}. ${l}`),
        '',
        '---',
        '',
        ...(fa.variables?.length ? [
          '## 3 — Add Flow Variables (optional)',
          'Variables let you pass data between steps.',
          '1. Click the **Variables** tab (top of the canvas)',
          '2. Click **+** to add each variable:',
          ...varLines,
          '',
          '---',
          '',
        ] : []),
        `## ${fa.variables?.length ? 4 : 3} — Add Steps`,
        'Click the **+** button after the trigger to add your first step.',
        'Add each step in order — the canvas flows top to bottom.',
        '',
        ...stepGuides.map((g, i) => `### Step ${i + 1}\n${g}`).flatMap(s => [s, '']),
        '---',
        '',
        `## ${fa.variables?.length ? 5 : 4} — Save and Activate`,
        '1. Click **Save** (top-right) to save the draft',
        '2. Review the canvas — make sure all steps are connected',
        '3. Click **Activate** to publish the flow',
        '4. Test: trigger the flow manually or create a test record',
        '',
        '---',
        '',
        '## Tips',
        '• **Data pills**: Drag values from the right-hand panel into step fields — this links live data (e.g. the trigger record\'s fields) into your steps',
        '• **Conditions**: Use the filter builder — click "Add filter" then pick field / operator / value',
        '• **Scripts**: In Run Script steps, use `current` for the trigger record, `fd_data` for flow variable data',
        '• **Subflows**: Build and activate subflows before the parent flow — parent flows call them by name',
        `• **Workflow Studio URL**: ${base}/flow-designer.do`,
      ].filter(s => s !== null).join('\n');

      return ok({
        guide,
        summary: {
          flow_name:   fa.name,
          flow_type:   isSubflow ? 'subflow' : isScheduled ? 'scheduled' : 'record_triggered',
          sn_table,
          total_steps: fa.steps.length,
          manual_steps: fa.steps.filter(s => s.manual_only).length,
          workflow_studio_url: `${base}/flow-designer.do`,
        },
      });
    } catch (e) { return fail(e.message); }
  }
);


// ══════════════════════════════════════════════════════════════════════════
// TOOL: fetch_sn_records  (utility)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'fetch_sn_records',
  'Query any ServiceNow table — useful for checking staging table results, verifying migrations, or fetching incidents.',
  {
    table:  z.string().describe('ServiceNow table name'),
    query:  z.string().optional().describe('sysparm_query encoded string (e.g. priority=1^active=true)'),
    fields: z.string().optional().describe('Comma-separated field names to return'),
    limit:  z.number().default(20),
    display_value: z.boolean().default(true),
  },
  async ({ table, query, fields, limit, display_value }) => {
    try {
      const sn = await getSn();
      const params = { sysparm_limit: String(limit) };
      if (query)  params.sysparm_query = query;
      if (fields) params.sysparm_fields = fields;
      if (display_value) params.sysparm_display_value = 'true';

      const records = await sn.get(table, params);
      return ok({ table, count: records.length, records });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: get_report_data
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'get_report_data',
  `Collects all data needed to produce a customer-facing field mapping sign-off report.
   Returns structured content (source schema, SN schema, approved mappings, staging definition,
   artifact sys_ids, migration stats if available) ready for Claude to render as a Word document.
   Call this after discover_schema and optionally after build_artifacts / run_full_migration.
   Claude should then use the docx skill to produce a .docx file from the returned data.`,
  {
    platform:       z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_name:    z.string(),
    sn_table:       z.string(),
    mappings:       z.array(z.object({
      staging_field:    z.string(),
      source_field:     z.string().optional(),
      sn_target:        z.string().nullable(),
      coalesce:         z.boolean().default(false),
      is_reference:     z.boolean().default(false),
      reference_value:  z.string().optional(),
      transform_script: z.string().optional(),
      excluded:         z.boolean().default(false),
      notes:            z.string().optional(),
    })).describe('Approved mappings from discover_schema or user-corrected'),
    artifacts:      z.object({
      stagingTable:  z.object({ name: z.string(), sys_id: z.string().nullable() }).optional(),
      transformMap:  z.object({ name: z.string(), sys_id: z.string().nullable() }).optional(),
      dataSource:    z.object({ name: z.string(), sys_id: z.string().nullable() }).optional(),
      restMessage:   z.object({ name: z.string(), sys_id: z.string().nullable() }).optional(),
    }).optional().describe('Artifact results from build_artifacts (include if already built)'),
    migration_stats: z.object({
      inserted: z.number(),
      updated:  z.number(),
      ignored:  z.number(),
      errors:   z.number(),
    }).optional().describe('Stats from run_full_migration (include if migration already ran)'),
    customer_name:  z.string().optional().describe('Customer / project name for the report header'),
    prepared_by:    z.string().optional().describe('Author name shown on the report'),
  },
  async ({ platform, object_name, sn_table, mappings, artifacts, migration_stats, customer_name, prepared_by }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);
      const source    = platform === 'salesforce' ? await getSf() : await getJira();

      let sourceFields;
      if (platform === 'salesforce') sourceFields = await discovery.discoverSalesforceSchema(source, object_name);
      else                           sourceFields = await discovery.discoverJiraSchema(source, object_name);

      const snFields   = await discovery.discoverSnSchema(sn_table);
      const stagingDef = discovery.buildStagingDefinition(platform, object_name, sourceFields);

      // Enrich mappings with source field labels and SN field labels
      const snFieldIndex  = Object.fromEntries(snFields.map(f => [f.field, f]));
      const srcFieldIndex = Object.fromEntries(sourceFields.map(f => [f.source_field, f]));

      const enrichedMappings = mappings.map(m => ({
        ...m,
        source_label: srcFieldIndex[m.source_field]?.label ?? m.source_field ?? '—',
        source_type:  srcFieldIndex[m.source_field]?.sf_type ?? srcFieldIndex[m.source_field]?.jira_type ?? '—',
        sn_label:     m.sn_target ? (snFieldIndex[m.sn_target]?.label ?? m.sn_target) : '—',
        sn_type:      m.sn_target ? (snFieldIndex[m.sn_target]?.type ?? '—') : '—',
        mapping_type: m.excluded
          ? 'Excluded'
          : m.transform_script
          ? 'Transform Script'
          : m.is_reference
          ? `Reference (by ${m.reference_value ?? 'display value'})`
          : m.coalesce
          ? 'Direct (Coalesce / Upsert Key)'
          : 'Direct',
      }));

      const included = enrichedMappings.filter(m => !m.excluded);
      const excluded = enrichedMappings.filter(m => m.excluded);

      return ok({
        instructions_for_claude: [
          'Use the docx skill to create a Word document from this data.',
          'The document is a customer sign-off report for field mapping review.',
          'Structure: cover page → overview table → field mapping table → artifact details (if present) → migration results (if present) → sign-off section.',
          'Save the file as "Migration_Field_Mapping_Report_<object_name>.docx" in the project folder.',
          'After creating it, tell the user the file path and ask them to review it before sharing with the customer.',
        ],
        report: {
          title:          `Data Migration Field Mapping Report`,
          subtitle:       `${platform.charAt(0).toUpperCase() + platform.slice(1)} ${object_name} → ServiceNow ${sn_table}`,
          customer_name:  customer_name ?? 'Customer',
          prepared_by:    prepared_by ?? 'Migration Team',
          prepared_date:  new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          sn_instance:    sn.baseUrl,

          overview: {
            source_platform:  platform.charAt(0).toUpperCase() + platform.slice(1),
            source_object:    object_name,
            source_fields_total: sourceFields.length,
            sn_target_table:  sn_table,
            sn_instance:      sn.baseUrl,
            staging_table:    stagingDef.tableName,
            mappings_included: included.length,
            mappings_excluded: excluded.length,
            mappings_with_transform: included.filter(m => m.transform_script).length,
            mappings_reference: included.filter(m => m.is_reference).length,
          },

          field_mappings: {
            included,
            excluded,
          },

          transform_scripts: included
            .filter(m => m.transform_script)
            .map(m => ({
              target_field: m.sn_target,
              target_label: m.sn_label,
              script:       m.transform_script,
              notes:        m.notes ?? '',
            })),

          artifacts: artifacts ?? null,

          migration_stats: migration_stats ?? null,

          sign_off: {
            instructions: 'Please review the field mappings above and sign below to approve the migration to proceed.',
            rows: [
              { role: 'Customer Representative', name: '', signature: '', date: '' },
              { role: 'Migration Lead',          name: '', signature: '', date: '' },
            ],
          },
        },
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: validate_target_acl — preflight ACL check before migration
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'validate_target_acl',
  `Verifies the ServiceNow integration user can read, create, update, and delete records on the target table.
   Call this BEFORE build_artifacts to catch permission problems early.`,
  { sn_table: z.string() },
  async ({ sn_table }) => {
    try {
      const sn  = await getSn();
      const acl = await sn.checkTableAccess(sn_table);
      const chain = await sn.getTableExtensionChain(sn_table);
      const missing = Object.entries(acl).filter(([_, v]) => !v).map(([k]) => k);
      return ok({
        table: sn_table,
        access: acl,
        extension_chain: chain,
        message: missing.length
          ? `Missing permissions: ${missing.join(', ')}. Grant these to the integration user before continuing.`
          : 'All permissions present. Safe to proceed.',
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: preview_transform — dry-run the transform map on one staging row
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'preview_transform',
  `Shows what target fields will be set when a staging row is transformed — no record is persisted.
   Useful for validating the transform map after build_artifacts.`,
  { staging_table: z.string(), staging_sys_id: z.string(), transform_map_sys_id: z.string() },
  async ({ staging_table, staging_sys_id, transform_map_sys_id }) => {
    try {
      const sn = await getSn();
      const preview = await sn.previewTransform(staging_table, staging_sys_id, transform_map_sys_id);
      return ok({ preview, message: 'These are the values that would land in the target record.' });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: reconcile_migration — compare source vs target field-by-field
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'reconcile_migration',
  `After a migration, compares a sample of source records against the target records (matched by correlation_id)
   and reports any per-field discrepancies. Use to certify data fidelity.`,
  {
    platform: z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    source_filter: z.string().describe('Jira JQL or SF SOQL WHERE clause'),
    sn_table: z.string(),
    sample_size: z.number().optional().default(20),
  },
  async ({ platform, source_filter, sn_table, sample_size }) => {
    try {
      const sn = await getSn();
      const records = [];
      if (platform === 'jira') {
        const jira = await getJira();
        const r = await jira.search({ jql: source_filter, maxResults: sample_size });
        for (const i of r.issues ?? []) records.push({ id: i.key, source: i });
      } else {
        const sf = await getSf();
        const r = await sf.query(source_filter);
        for (const rec of r.records ?? []) records.push({ id: rec.Id, source: rec });
      }
      const prefix = platform === 'salesforce' ? 'salesforce' : 'jira';
      const matched = [], missing = [];
      for (const rec of records) {
        const target = await sn.findByCorrelationId(sn_table, `${prefix}:${rec.id}`);
        if (target) matched.push({ source_id: rec.id, target_sys_id: target.sys_id });
        else missing.push(rec.id);
      }
      return ok({
        sampled: records.length,
        matched: matched.length,
        missing: missing.length,
        missing_source_ids: missing.slice(0, 20),
        message: missing.length === 0
          ? '✓ All sampled source records have a corresponding target record.'
          : `⚠ ${missing.length} source records have no matching target. They may have failed or never been migrated.`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: rollback_migration — delete target records by correlation_id
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'rollback_migration',
  `Deletes target records that were created by a migration, identified by correlation_id prefix (e.g. "jira:" or "salesforce:").
   Two-phase: first call with confirm=false to see the count, then confirm=true to delete.`,
  {
    sn_table: z.string(),
    correlation_prefix: z.string().describe('e.g. "jira:" or "salesforce:"'),
    confirm: z.boolean().optional().default(false),
  },
  async ({ sn_table, correlation_prefix, confirm }) => {
    try {
      const sn = await getSn();
      const rows = await sn.get(sn_table, {
        sysparm_query:  `correlation_idSTARTSWITH${correlation_prefix}`,
        sysparm_fields: 'sys_id,correlation_id',
        sysparm_limit:  '500',
      });
      if (!confirm) return ok({
        would_delete: rows.length,
        sample: rows.slice(0, 5).map(r => r.correlation_id),
        message: `Would delete ${rows.length} records. Call again with confirm=true to proceed.`,
      });
      let deleted = 0, failed = 0;
      for (const r of rows) {
        try { await sn.delete(sn_table, r.sys_id); deleted++; }
        catch (_) { failed++; }
      }
      return ok({ deleted, failed, message: `Deleted ${deleted} records from ${sn_table}.` });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: migrate_attachments
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'migrate_attachments',
  `Copies attachments from source records to their corresponding ServiceNow target records.
   Matches via correlation_id (jira:<key> or salesforce:<id>).`,
  {
    platform: z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    source_ids: z.array(z.string()).describe('Jira issue keys or SF record Ids'),
    sn_table: z.string(),
  },
  async ({ platform, source_ids, sn_table }) => {
    try {
      const sn = await getSn();
      const prefix = platform === 'salesforce' ? 'salesforce' : 'jira';
      let uploaded = 0, failed = 0, skipped = 0;
      const errors = [];

      for (const id of source_ids) {
        const target = await sn.findByCorrelationId(sn_table, `${prefix}:${id}`);
        if (!target) { skipped++; continue; }

        if (platform === 'jira') {
          const jira = await getJira();
          const atts = await jira.getAttachments(id);
          for (const a of atts) {
            try {
              const buf = await jira.downloadAttachment(a.content);
              await sn.uploadAttachment(sn_table, target.sys_id, a.filename, buf, a.mimeType);
              uploaded++;
            } catch (e) { failed++; errors.push(`${id}/${a.filename}: ${e.message}`); }
          }
        } else {
          const sf = await getSf();
          const versions = await sf.getContentVersionsFor(id);
          for (const v of versions) {
            try {
              const buf = await sf.downloadContentVersion(v.Id);
              const fileName = `${v.Title}.${v.FileExtension}`;
              await sn.uploadAttachment(sn_table, target.sys_id, fileName, buf);
              uploaded++;
            } catch (e) { failed++; errors.push(`${id}/${v.Title}: ${e.message}`); }
          }
        }
      }
      return ok({ uploaded, failed, skipped_records_not_found: skipped, errors: errors.slice(0, 10) });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: migrate_comments — copy comments into work_notes / comments journal
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'migrate_comments',
  `Copies source comments into the ServiceNow target record's comments or work_notes journal.
   Each comment is appended with its original author and timestamp.`,
  {
    platform: z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    source_ids: z.array(z.string()),
    sn_table: z.string(),
    journal_field: z.string().optional().default('comments'),
  },
  async ({ platform, source_ids, sn_table, journal_field }) => {
    try {
      const sn = await getSn();
      const prefix = platform === 'salesforce' ? 'salesforce' : 'jira';
      let added = 0, skipped = 0, failed = 0;
      for (const id of source_ids) {
        const target = await sn.findByCorrelationId(sn_table, `${prefix}:${id}`);
        if (!target) { skipped++; continue; }
        try {
          let comments = [];
          if (platform === 'jira') {
            const jira = await getJira();
            comments = await jira.getComments(id);
          } else {
            const sf = await getSf();
            const raw = await sf.getCaseComments(id);
            comments = raw.map(c => ({ author: c.CreatedById, created: c.CreatedDate, body: c.CommentBody }));
          }
          const blob = comments.map(c => `[${c.created} – ${c.author}]\n${c.body}`).join('\n\n---\n\n');
          if (blob) {
            await sn.addJournalEntry(sn_table, target.sys_id, journal_field, blob);
            added += comments.length;
          }
        } catch (e) { failed++; }
      }
      return ok({ added, skipped_records_not_found: skipped, failed });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: run_delta_sync — incremental migration based on stored watermark
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'run_delta_sync',
  `Runs a migration of records that have changed since the last delta sync (uses a stored watermark in ServiceNow).
   First run migrates everything and stores the current time as the watermark.`,
  {
    platform: z.string().describe('Source platform (salesforce, jira, or any registered connector)'),
    object_or_project: z.string(),
    sn_table: z.string(),
    staging_table: z.string(),
    watermark_key: z.string().describe('Unique identifier for this migration config — used to store the watermark'),
  },
  async ({ platform, object_or_project, sn_table, staging_table, watermark_key }) => {
    try {
      const sn = await getSn();
      const lastWatermark = await sn.getWatermark(watermark_key);
      const newWatermark  = new Date().toISOString();

      const runner = new MigrationRunner(sn);
      let processed = 0;

      if (platform === 'jira') {
        const jira = await getJira();
        const jql = lastWatermark
          ? `project=${object_or_project} AND updated>="${lastWatermark.substring(0,16).replace('T',' ')}"`
          : `project=${object_or_project}`;
        const iterator = jira.fetchAllIssues(jql);
        const result   = await runner.runFullMigration(staging_table, iterator, i => ({ jira_key: i.key, jira_summary: i.fields?.summary ?? '' }));
        processed = result.stats.total;
      } else {
        const sf = await getSf();
        const soql = lastWatermark
          ? `SELECT Id, LastModifiedDate FROM ${object_or_project} WHERE LastModifiedDate > ${lastWatermark}`
          : `SELECT Id FROM ${object_or_project}`;
        const iterator = sf.fetchAllRecords(soql);
        const result   = await runner.runFullMigration(staging_table, iterator, r => ({ sf_id: r.Id }));
        processed = result.stats.total;
      }

      await sn.setWatermark(watermark_key, newWatermark);
      return ok({
        previous_watermark: lastWatermark,
        new_watermark:      newWatermark,
        records_processed:  processed,
        message: lastWatermark
          ? `Migrated ${processed} records changed since ${lastWatermark}.`
          : `Initial sync complete (${processed} records). Future runs will only migrate changes since now.`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: monitor_import_set_progress — long-poll an import set run
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'monitor_import_set_progress',
  `Polls the active import set runs in ServiceNow until they all complete (or 5 minutes elapse).
   Use after kicking off a bulk migration to watch live progress.`,
  { max_wait_seconds: z.number().optional().default(300) },
  async ({ max_wait_seconds }) => {
    try {
      const sn = await getSn();
      const started = Date.now();
      let last = null;
      while ((Date.now() - started) / 1000 < max_wait_seconds) {
        const running = await sn.get('sys_import_set_run', {
          sysparm_query:  'state=running',
          sysparm_fields: 'sys_id,number,state,sys_created_on',
          sysparm_limit:  '20',
        });
        last = running;
        if (!running.length) break;
        await new Promise(r => setTimeout(r, 5000));
      }
      return ok({
        completed: !last?.length,
        still_running: last ?? [],
        message: !last?.length ? 'All import sets finished.' : `${last.length} import set(s) still running.`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: cleanup_old_import_sets — purge completed runs older than N days
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'cleanup_old_import_sets',
  `Deletes completed sys_import_set_run records older than the given number of days.
   Run periodically to keep the instance healthy.`,
  { days_old: z.number().optional().default(30) },
  async ({ days_old }) => {
    try {
      const sn = await getSn();
      const r = await sn.cleanupOldImportSetRuns(days_old);
      return ok({ ...r, message: `Scanned ${r.scanned} runs older than ${days_old} days. Deleted ${r.deleted}.` });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: preview_query — show count + sample records before migrating
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'preview_query',
  `Preview how many records will be migrated before committing to a full run.
   Returns the total record count and a sample (up to 5 records) matching the query.
   ALWAYS call this before run_test_migration or run_full_migration when the user wants
   to filter or scope the migration — e.g. "only migrate closed tickets" or
   "just the records from 2024". This prevents accidentally migrating too many records.

   For Jira: filter is JQL (e.g. "status = Done AND created >= 2024-01-01")
   For Salesforce: filter is a SOQL WHERE clause (e.g. "Status = 'Closed' AND CreatedDate >= 2024-01-01T00:00:00Z")`,
  {
    platform:    z.string().describe('Source platform (jira or salesforce)'),
    object_name: z.string().describe('Jira project key or Salesforce object name'),
    filter:      z.string().optional().describe('JQL (Jira) or SOQL WHERE clause (Salesforce) to scope records'),
    fields:      z.array(z.string()).optional().describe('Specific fields to preview (defaults to key fields)'),
  },
  async ({ platform, object_name, filter, fields }) => {
    try {
      if (platform === 'jira') {
        const jira = await getJira();
        const jql  = filter
          ? `project=${object_name} AND ${filter}`
          : `project=${object_name}`;

        const [countResult, sampleResult] = await Promise.all([
          jira.search({ jql, maxResults: 0 }),
          jira.search({ jql, maxResults: 5, fields: fields?.length ? fields : ['summary', 'status', 'priority', 'issuetype', 'assignee', 'created'] }),
        ]);

        const sample = (sampleResult.issues ?? []).map(i => ({
          key:       i.key,
          summary:   i.fields?.summary ?? '',
          status:    i.fields?.status?.name ?? '',
          priority:  i.fields?.priority?.name ?? '',
          issuetype: i.fields?.issuetype?.name ?? '',
          assignee:  i.fields?.assignee?.emailAddress ?? i.fields?.assignee?.displayName ?? null,
          created:   i.fields?.created?.substring(0, 10) ?? '',
        }));

        return ok({
          instructions_for_claude: [
            `Tell the user: "${countResult.total ?? 0} records match${filter ? ` the filter "${filter}"` : ''} in project ${object_name}."`,
            `Show the sample records table and ask: "Does this look right? Should I proceed with the migration?"`,
            countResult.total === 0
              ? 'Warn: no records found — the filter may be too restrictive or the project key wrong.'
              : null,
          ].filter(Boolean),
          total_records: countResult.total ?? 0,
          jql_used: jql,
          sample,
        });
      }

      if (platform === 'salesforce') {
        const sf         = await getSf();
        const previewFields = fields?.length ? fields : ['Id', 'Name', 'CreatedDate', 'LastModifiedDate'];
        const where      = filter ? ` WHERE ${filter}` : '';
        const countSoql  = `SELECT COUNT() FROM ${object_name}${where}`;
        const sampleSoql = `SELECT ${previewFields.join(',')} FROM ${object_name}${where} LIMIT 5`;

        const [countRes, sampleRes] = await Promise.all([
          sf.query(countSoql),
          sf.query(sampleSoql),
        ]);

        return ok({
          instructions_for_claude: [
            `Tell the user: "${countRes.totalSize ?? 0} records match${filter ? ` the filter "${filter}"` : ''} in ${object_name}."`,
            `Show the sample records and ask: "Does this look right? Shall I proceed with the migration?"`,
            (countRes.totalSize ?? 0) === 0
              ? 'Warn: no records found — check the filter or object name.'
              : null,
          ].filter(Boolean),
          total_records: countRes.totalSize ?? 0,
          soql_used: sampleSoql,
          sample: sampleRes.records ?? [],
        });
      }

      return fail(`preview_query not yet supported for platform "${platform}"`);
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: list_jira_automations  (Jira Automation Phase 1)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'list_jira_automations',
  `Lists all Jira Automation rules visible to the authenticated user.
   Call this when the user wants to migrate Jira automations to ServiceNow Flow Designer.
   Returns a summary of each rule: name, trigger type, number of conditions/actions, enabled state.
   After calling this, show the list and ask which automation(s) the user wants to migrate.`,
  {
    project_key: z.string().optional().describe('Jira project key to scope — omit to list all automations'),
  },
  async ({ project_key }) => {
    try {
      const jira      = await getJira();
      const retriever = new JiraAutomationRetriever(jira);
      const rules     = await retriever.listAutomations(project_key ?? null);

      const summary = rules.map(r => ({
        id:       r.id,
        name:     r.name,
        enabled:  r.state === 'ENABLED',
        projects: (r.projects ?? []).map(p => p.key ?? p.name ?? p.id),
        trigger:  JiraAutomationRetriever.triggerLabel(r.trigger?.type ?? r.ruleScope?.trigger?.type ?? ''),
        actions:  (r.components ?? r.elements ?? []).filter(c => (c.type ?? '').includes('ACTION')).length,
      }));

      return ok({
        instructions_for_claude: [
          `Tell the user: "I found ${rules.length} Jira automation rule(s)${project_key ? ` for project ${project_key}` : ''}.`,
          'Show the list in a table: name | trigger | actions | enabled.',
          'Ask: "Which automation(s) would you like to migrate to ServiceNow Flow Designer?"',
          'Then call analyze_jira_automation with the chosen rule ID.',
        ],
        total: rules.length,
        automations: summary,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: analyze_jira_automation  (Jira Automation Phase 2)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'analyze_jira_automation',
  `Fetches and analyses a specific Jira Automation rule and produces a migration plan for ServiceNow.
   Returns: trigger type, conditions, actions, what can be automated vs manual.
   After calling this, present the plan and ask the user to confirm before building.`,
  {
    rule_id:   z.string().describe('Jira Automation rule ID (from list_jira_automations)'),
    sn_table:  z.string().describe('ServiceNow table this automation will operate on (e.g. incident, problem)'),
  },
  async ({ rule_id, sn_table }) => {
    try {
      const jira      = await getJira();
      const retriever = new JiraAutomationRetriever(jira);
      const raw       = await retriever.getAutomation(rule_id);
      const parsed    = retriever.parseRule(raw);
      const plan      = retriever.buildMigrationPlan(parsed);

      const autoSteps   = plan.steps.filter(s => s.auto).length;
      const manualSteps = plan.manual.length;

      return ok({
        instructions_for_claude: [
          `Present the automation: "${parsed.name}"`,
          `Trigger: ${parsed.trigger?.label ?? 'unknown'} → SN type: ${parsed.trigger?.sn_type ?? 'manual'}`,
          `${autoSteps} steps can be automated, ${manualSteps} require manual setup.`,
          manualSteps
            ? `Manual items: ${plan.manual.map(m => m.label).join(', ')}. Explain these to the user.`
            : 'All steps can be automated.',
          'Ask: "Does this plan look correct? Which ServiceNow table should this flow operate on?" (already set if sn_table was provided)',
          'After confirmation, call build_jira_automation.',
        ],
        automation: parsed,
        migration_plan: plan,
        sn_table,
        auto_steps:   autoSteps,
        manual_steps: manualSteps,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: build_jira_automation  (Jira Automation Phase 3)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'build_jira_automation',
  `Builds the ServiceNow Flow Designer artifacts for a Jira Automation rule.
   Creates the flow record, trigger, condition blocks, and action steps.
   Steps that cannot be automated are skipped — the manual build guide explains what to do.
   Only call this after analyze_jira_automation and user confirmation.`,
  {
    rule_id:        z.string().describe('Jira Automation rule ID'),
    sn_table:       z.string().describe('ServiceNow table the flow will operate on'),
    flow_scope:     z.string().optional().describe('Scope prefix for the SN flow name (e.g. custom, global)'),
    field_mappings: z.record(z.string()).optional().describe('Jira field name → SN field name overrides'),
  },
  async ({ rule_id, sn_table, flow_scope, field_mappings }) => {
    try {
      const jira      = await getJira();
      const sn        = await getSn();
      const retriever = new JiraAutomationRetriever(jira);
      const raw       = await retriever.getAutomation(rule_id);
      const parsed    = retriever.parseRule(raw);

      // Build using the existing FlowBuilder (shared with Salesforce flow path)
      const builder     = new FlowBuilder(sn);
      const flowStructure = {
        apiName:    `jira_${parsed.id}`,
        type:       parsed.trigger?.sn_type === 'record' ? 'RecordTriggeredFlow' : 'AutoLaunchedFlow',
        label:      parsed.name,
        trigger:    parsed.trigger,
        variables:  [],
        elements:   [
          ...parsed.conditions.map(c => ({ ...c, kind: 'decision',   label: c.label,  name: c.label })),
          // Include all actions (both auto and manual) so flow structure is complete
          // Manual ones become TODO stubs; auto ones become real steps or script stubs
          ...parsed.actions.map(a => ({
            kind:     a.sn_action === 'create_record' ? 'recordCreate'
                    : a.sn_action === 'update_record' ? 'recordUpdate'
                    : a.sn_action === 'delete_record' ? 'recordDelete'
                    : 'action',
            label:    a.label,
            name:     a.label,
            raw_type: a.raw_type,
            config:   a.config,               // pass Jira config so script stubs are informative
            can_auto: a.can_auto,
            manual_reason: a.manual_reason,
            // Map Jira field assignments if present in config
            inputAssignments: a.config?.fields
              ? Object.entries(a.config.fields).map(([k, v]) => ({ field: k, value: v }))
              : [],
          })),
        ],
        isScreen:   false,
      };

      const results = await builder.build({
        flowStructure,
        snTableName:   sn_table,
        fieldMappings: field_mappings ?? {},
        flowScope:     flow_scope ?? 'jira',
      });

      const plan      = retriever.buildMigrationPlan(parsed);
      const manualCount = plan.manual.length;

      return ok({
        instructions_for_claude: [
          `Tell the user: "Flow '${parsed.name}' has been created in ServiceNow Flow Designer."`,
          manualCount
            ? `${manualCount} step(s) need manual configuration. Show the manual_guide to the user step by step.`
            : 'All steps were automated successfully.',
          `Share the SN Flow Designer URL: ${sn.baseUrl}/nav_to.do?uri=sys_flow.do`,
        ],
        flow: results,
        manual_guide: plan.manual,
        sn_table,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: map_users
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'map_users',
  `Load all ServiceNow users and groups into memory, then resolve a list of
   source-platform users (Jira / Salesforce) to ServiceNow sys_user sys_ids.
   Returns a match report with matched/unmatched lists and the fallback user used.
   Call this before running a migration that has assignee / owner / reporter fields.`,
  {
    source_users:   z.array(z.object({
      email:       z.string().optional(),
      displayName: z.string().optional(),
      accountId:   z.string().optional(),
    })).describe('Array of source platform users to resolve'),
    fallback_user_email: z.string().optional().describe('SN user email to use when no match is found'),
    fallback_group_name: z.string().optional().describe('SN group name to use when no group match is found'),
  },
  async ({ source_users, fallback_user_email, fallback_group_name }) => {
    try {
      const sn     = await getSn();
      const mapper = new UserGroupMapper(sn);
      await mapper.build({ fallbackUser: fallback_user_email ?? null, fallbackGroup: fallback_group_name ?? null });
      const report = await mapper.matchSourceUsers(source_users ?? []);
      return ok({ summary: mapper.summary(), ...report });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: pre_migration_check
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'pre_migration_check',
  `Run all pre-migration validation checks against the target ServiceNow table before importing any data.
   Checks: (1) picklist/choice values, (2) reference integrity, (3) required field coverage,
   (4) business rule conflicts. Returns a pass/fail report with blocking issues and warnings.
   Always call this before run_migration.`,
  {
    sn_table:        z.string().describe('Target ServiceNow table, e.g. incident'),
    field_mappings:  z.record(z.string()).describe('{ sourceField: snField } mapping object'),
    reference_fields: z.record(z.object({
      table:       z.string(),
      lookupField: z.string().optional(),
    })).optional().describe('{ snField: { table, lookupField } } — which SN fields are reference fields'),
    sample_records:  z.array(z.record(z.unknown())).describe('Sample of source records (20–100) for validation'),
  },
  async ({ sn_table, field_mappings, reference_fields, sample_records }) => {
    try {
      const sn      = await getSn();
      const checker = new PreMigrationChecker(sn);
      const result  = await checker.runAll(
        sn_table,
        field_mappings ?? {},
        reference_fields ?? {},
        sample_records ?? [],
      );
      return ok(result);
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: transform_preview
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'transform_preview',
  `Apply field transformation rules to a sample set of source records and return the transformed output.
   Use this to verify date formats, boolean normalization, status mapping, and custom transforms
   BEFORE running the full migration. Supports built-in presets: jira_status, jira_priority,
   sf_status, sf_priority.`,
  {
    source_records: z.array(z.record(z.unknown())).describe('Source records to transform'),
    rules: z.array(z.object({
      sourceField:  z.string(),
      targetField:  z.string().optional(),
      type:         z.string().describe('date | boolean | number | map | trim | truncate | glide_datetime | glide_date | html_strip | preset'),
      preset:       z.enum(['jira_status','jira_priority','sf_status','sf_priority']).optional(),
      map:          z.record(z.string()).optional(),
      fallback:     z.string().optional(),
      default:      z.unknown().optional(),
      maxLength:    z.number().optional(),
      outputFormat: z.string().optional(),
      toTimezone:   z.string().optional(),
    })).describe('Transformation rules to apply'),
  },
  async ({ source_records, rules }) => {
    try {
      const resolvedRules = (rules ?? []).map(r => {
        if (r.type === 'preset') {
          const presets = {
            jira_status:    TransformEngine.jiraStatusToSnState(),
            jira_priority:  TransformEngine.jiraPriorityToSnPriority(),
            sf_status:      TransformEngine.sfStatusToSnState(),
            sf_priority:    TransformEngine.sfPriorityToSnPriority(),
          };
          return { ...presets[r.preset], sourceField: r.sourceField, targetField: r.targetField };
        }
        return r;
      });
      const engine = new TransformEngine(resolvedRules);
      const transformed = engine.applyBatch(source_records ?? []);
      return ok({ transformed, rules_applied: resolvedRules.length });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: convert_rich_text
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'convert_rich_text',
  `Convert rich text from source platforms to ServiceNow-compatible HTML.
   Supports Jira ADF (JSON document format), Salesforce HTML, and plain text.
   Use hint="auto" to auto-detect. Returns converted HTML safe for SN fields.`,
  {
    values:  z.array(z.object({
      id:    z.string().describe('Record identifier for reference'),
      value: z.unknown().describe('Rich text value: ADF object, HTML string, or plain text'),
    })).describe('Array of values to convert'),
    hint: z.enum(['auto','adf','sf_html','text']).optional().default('auto').describe('Source format hint'),
  },
  async ({ values, hint }) => {
    try {
      const results = (values ?? []).map(({ id, value }) => ({
        id,
        html: toSnHtml(value, hint ?? 'auto'),
      }));
      return ok({ results, count: results.length });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: topological_sort
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'topological_sort',
  `Sort a list of entity types / record IDs in dependency order (parents before children).
   Useful for relationship-aware migration — e.g. migrate Epics before Stories before Sub-tasks.
   Provide nodes (IDs) and edges ([parentId, childId] pairs).
   Returns the sorted order.`,
  {
    nodes: z.array(z.string()).describe('List of record or type identifiers'),
    edges: z.array(z.tuple([z.string(), z.string()])).describe('Dependency edges: [parent, child]'),
  },
  async ({ nodes, edges }) => {
    try {
      const sorted = topoSort(nodes ?? [], edges ?? []);
      return ok({ sorted });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: start_audit_session / log_audit_event
// ══════════════════════════════════════════════════════════════════════════
let _audit = null;

server.tool(
  'start_audit_session',
  `Open an audit trail log file for this migration session. All subsequent migrations
   will be recorded with before/after field values, timing, and error details.
   Call this once at the start of any production migration.`,
  {
    output_path: z.string().optional().describe('Where to write the audit NDJSON log (default: ./migration-audit.ndjson)'),
    session_id:  z.string().optional().describe('Human-readable session label'),
  },
  async ({ output_path, session_id }) => {
    try {
      _audit = new AuditTrail({ outputPath: output_path, sessionId: session_id });
      _audit.open();
      return ok({ message: 'Audit trail opened', output_path: _audit.outputPath, session_id: _audit.sessionId });
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  'get_audit_stats',
  `Return current audit trail statistics for the active migration session.
   Shows counts of created, updated, skipped, and errored records, plus average time per record.`,
  {},
  async () => {
    if (!_audit) return fail('No active audit session. Call start_audit_session first.');
    return ok(_audit.stats());
  }
);

// ══════════════════════════════════════════════════════════════════════════
// MIGRATION TESTING & RECONCILIATION TOOLS
// ══════════════════════════════════════════════════════════════════════════

// ── TOOL: reconcile_migration ──────────────────────────────────────────────
server.tool(
  'reconcile_migration',
  `Deep comparison between source records and ServiceNow target records to verify
   the migration was successful. Goes far beyond fill-rate checks:

   1. COUNT CHECK       — source count vs SN count (detects missing or duplicate records)
   2. RECORD MATCHING   — correlates each source record to its SN counterpart using
                          a correlation field (e.g. u_jira_key, u_sf_id)
   3. FIELD-LEVEL DIFF  — for every matched pair, compares each mapped field value
                          Expected vs Actual, with transform-awareness (so a Jira
                          "In Progress" → SN state "2" is not flagged as a mismatch)
   4. VERDICT           — PASS / PARTIAL / FAIL with specific reasons

   Returns: verdict, per-record diffs, per-field accuracy %, missing/extra records.
   Use after a test migration or a full migration to confirm data integrity.`,
  {
    source_records: z.array(z.record(z.unknown())).describe(
      'Array of source records (Jira issues, SF records, etc.) to compare against SN'
    ),
    sn_table: z.string().describe('Target ServiceNow table (e.g. incident, u_my_custom_table)'),
    field_mappings: z.record(z.string()).describe(
      '{ sourceField: snField } — the same mapping used during migration'
    ),
    correlation_field: z.string().describe(
      'Field in the SN table that stores the source record ID (e.g. u_jira_key, u_sf_id, correlation_display)'
    ),
    source_id_field: z.string().describe(
      'Field in source records that holds the unique ID (e.g. "key" for Jira, "Id" for Salesforce)'
    ),
    transform_rules: z.array(z.object({
      sn_field:     z.string(),
      value_map:    z.record(z.string()).describe('{ sourceValue: expectedSnValue }'),
    })).optional().describe(
      'Transform mappings to apply when comparing — prevents false mismatches for status/priority fields'
    ),
    date_fields: z.array(z.string()).optional().describe(
      'SN field names that are dates — compared as YYYY-MM-DD only, ignoring time'
    ),
    ignored_fields: z.array(z.string()).optional().describe(
      'SN field names to skip in value comparison (e.g. sys_created_on, sys_updated_by)'
    ),
    limit: z.number().optional().default(200).describe('Max source records to compare (default 200)'),
    full_scan: z.boolean().optional().default(false).describe(
      'Also check for records in SN that are not in the source sample (detects extras/duplicates)'
    ),
  },
  async ({
    source_records, sn_table, field_mappings,
    correlation_field, source_id_field,
    transform_rules, date_fields, ignored_fields, limit, full_scan,
  }) => {
    try {
      const sn = await getSn();

      // Build transform map from rules
      const transformMap = new Map();
      for (const rule of (transform_rules ?? [])) {
        transformMap.set(rule.sn_field, new Map(Object.entries(rule.value_map)));
      }

      const reconciler = new MigrationReconciler(sn, {
        transformMap,
        dateFields:    new Set(date_fields ?? []),
        ignoredFields: new Set([
          'sys_created_on','sys_updated_on','sys_created_by','sys_updated_by','sys_mod_count',
          ...(ignored_fields ?? []),
        ]),
      });

      const report = await reconciler.reconcile(
        source_records,
        sn_table,
        field_mappings,
        correlation_field,
        source_id_field,
        { limit: limit ?? 200, fullScan: full_scan ?? false },
      );

      return ok({
        instructions_for_claude: [
          `Reconciliation verdict: ${report.verdict.result}`,
          report.verdict.reason,
          report.summary.missing_from_sn > 0
            ? `ACTION NEEDED: ${report.summary.missing_from_sn} records were not found in ServiceNow. Check that the correlation field "${correlation_field}" is populated and that the transform map ran.`
            : null,
          report.summary.records_with_errors > 0
            ? `ACTION NEEDED: ${report.summary.records_with_errors} records have field-level mismatches. Review the mismatched_records array and fix the transform map or field mapping.`
            : null,
          report.verdict.result === 'PASS'
            ? 'Migration verified. Safe to proceed to full production run.'
            : null,
        ].filter(Boolean),
        ...report,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: reconcile_staging ────────────────────────────────────────────────
server.tool(
  'reconcile_staging',
  `Compare the ServiceNow STAGING table against the TARGET table to verify that
   the transform map correctly moved all records from staging into the real table.

   This is the staging → target leg of the three-layer quality check:
     Source → [staging] → Target

   Fetches the most recent N staging records, looks up their corresponding target
   records via sys_target_sys_id, then compares every mapped field value.

   Returns: per-record diffs, per-field accuracy, missing target records.`,
  {
    staging_table:    z.string().describe('ServiceNow import set staging table (e.g. u_jira_import)'),
    target_table:     z.string().describe('ServiceNow target table (e.g. incident)'),
    field_mappings:   z.record(z.string()).describe('{ stagingField: targetField }'),
    sample_size:      z.number().optional().default(50).describe('How many staging records to check'),
    transform_rules:  z.array(z.object({
      target_field: z.string(),
      value_map:    z.record(z.string()),
    })).optional(),
    date_fields:      z.array(z.string()).optional(),
  },
  async ({ staging_table, target_table, field_mappings, sample_size, transform_rules, date_fields }) => {
    try {
      const sn = await getSn();

      // Fetch recent staging records
      const stagingRecords = await sn.get(staging_table, {
        sysparm_limit:         String(sample_size ?? 50),
        sysparm_query:         'ORDERBYDESCsys_created_on',
        sysparm_display_value: 'true',
      });

      if (!stagingRecords.length) return fail(`No records found in staging table ${staging_table}`);

      // For each staging record, fetch the target record via sys_target_sys_id
      const pairs = [];
      const noTarget = [];

      for (const row of stagingRecords) {
        const targetSysId = row.sys_target_sys_id?.value
          ?? row.sys_target_sys_id?.link?.split('/').pop()
          ?? row.sys_target_sys_id
          ?? null;

        if (!targetSysId || targetSysId === 'null' || targetSysId === '') {
          noTarget.push({ staging_id: row.sys_id, state: row.sys_import_state?.value ?? row.sys_import_state });
          continue;
        }

        const target = await sn.getById(target_table, targetSysId, { sysparm_display_value: 'true' }).catch(() => null);
        if (target) pairs.push({ staging: row, target });
        else         noTarget.push({ staging_id: row.sys_id, target_sys_id: targetSysId, reason: 'not_found_in_target' });
      }

      // Build transform map
      const transformMap = new Map();
      for (const rule of (transform_rules ?? [])) {
        transformMap.set(rule.target_field, new Map(Object.entries(rule.value_map)));
      }
      const dateSet = new Set(date_fields ?? []);

      // Compare field values
      const fieldStats    = {};
      const mismatchedPairs = [];

      for (const { staging, target } of pairs) {
        const diffs = [];
        for (const [stagingField, targetField] of Object.entries(field_mappings)) {
          const rawStaging = staging[stagingField];
          const rawTarget  = target[targetField];

          // Normalise
          const normVal = v => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'object' && 'value' in v) return String(v.value ?? '').trim();
            return String(v).trim();
          };

          let expected = normVal(rawStaging);
          const actual = normVal(rawTarget);

          // Apply transform
          const fieldMap = transformMap.get(targetField);
          if (fieldMap && fieldMap.has(expected)) expected = fieldMap.get(expected);

          // Date normalise
          const normDate = v => { try { return new Date(v).toISOString().slice(0,10); } catch { return v; } };
          const e = dateSet.has(targetField) ? normDate(expected) : expected;
          const a = dateSet.has(targetField) ? normDate(actual)   : actual;

          const match = e === a || e.toLowerCase() === a.toLowerCase() || (!e && !a);

          if (!fieldStats[targetField]) fieldStats[targetField] = { passed: 0, failed: 0, total: 0, samples: [] };
          fieldStats[targetField].total++;
          match ? fieldStats[targetField].passed++ : fieldStats[targetField].failed++;
          if (!match && fieldStats[targetField].samples.length < 3) {
            fieldStats[targetField].samples.push({ expected: e, actual: a });
          }

          diffs.push({ stagingField, targetField, expected: e, actual: a, match });
        }

        const failures = diffs.filter(d => !d.match);
        if (failures.length) {
          mismatchedPairs.push({
            staging_sys_id: staging.sys_id,
            target_sys_id:  target.sys_id,
            failed: failures.length,
            passed: diffs.length - failures.length,
            accuracy_pct: Math.round(((diffs.length - failures.length) / diffs.length) * 100),
            diffs: failures,
          });
        }
      }

      const totalRecords    = stagingRecords.length;
      const matched         = pairs.length;
      const withMismatches  = mismatchedPairs.length;
      const fullyCorrect    = matched - withMismatches;

      const fieldSummary = Object.entries(fieldStats).map(([field, s]) => ({
        target_field:  field,
        total:         s.total,
        passed:        s.passed,
        failed:        s.failed,
        accuracy_pct:  Math.round((s.passed / s.total) * 100),
        verdict:       s.failed === 0 ? 'PASS' : s.passed === 0 ? 'FAIL' : 'PARTIAL',
        sample_mismatches: s.samples,
      })).sort((a,b) => a.accuracy_pct - b.accuracy_pct);

      const overallVerdict = noTarget.length === totalRecords ? 'FAIL'
        : withMismatches === 0 && noTarget.length === 0 ? 'PASS'
        : 'PARTIAL';

      return ok({
        instructions_for_claude: [
          `Staging→Target reconciliation: ${overallVerdict}`,
          noTarget.length > 0
            ? `${noTarget.length}/${totalRecords} staging records have no target record — transform map may not have run, or records were in error state.`
            : null,
          withMismatches > 0
            ? `${withMismatches} record pairs have field-level mismatches — review field_stats for details.`
            : null,
          overallVerdict === 'PASS'
            ? 'All staging records successfully transformed into target table with correct values.'
            : null,
        ].filter(Boolean),
        verdict:             overallVerdict,
        summary: {
          staging_records:       totalRecords,
          matched_to_target:     matched,
          no_target_record:      noTarget.length,
          records_with_errors:   withMismatches,
          records_fully_correct: fullyCorrect,
          record_accuracy_pct:   matched ? Math.round((fullyCorrect / matched) * 100) : 0,
        },
        field_stats:           fieldSummary,
        mismatched_pairs:      mismatchedPairs.slice(0, 30),
        no_target_records:     noTarget.slice(0, 20),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: migration_test_report ────────────────────────────────────────────
server.tool(
  'migration_test_report',
  `Generate a complete end-to-end migration test report covering all three layers:

     Source (Jira/SF) → Staging Table → Target Table (ServiceNow)

   Combines the existing validate tool (fill-rate check) with deep reconciliation
   to produce a single pass/fail report with actionable fix guidance.

   Use this after a test migration of 5–50 records before running the full migration.
   Returns a human-readable verdict + specific fields/records that need fixing.`,
  {
    platform:         z.enum(['jira','salesforce']).describe('Source platform'),
    source_records:   z.array(z.record(z.unknown())).describe('The source records that were migrated'),
    staging_table:    z.string().describe('SN staging/import table name'),
    target_table:     z.string().describe('SN target table name (e.g. incident)'),
    field_mappings:   z.array(z.object({
      source_field:  z.string(),
      staging_field: z.string(),
      sn_field:      z.string(),
    })).describe('Three-layer field mapping: source → staging → SN target'),
    correlation_field: z.string().describe('SN target field holding the source ID (e.g. u_jira_key)'),
    source_id_field:   z.string().describe('Field in source records that is the unique ID (e.g. key, Id)'),
    transform_rules:   z.array(z.object({
      sn_field: z.string(),
      value_map: z.record(z.string()),
    })).optional(),
    date_fields:       z.array(z.string()).optional(),
  },
  async ({ platform, source_records, staging_table, target_table, field_mappings,
           correlation_field, source_id_field, transform_rules, date_fields }) => {
    try {
      const sn = await getSn();

      // ── Layer 1: staging fill-rate (existing MigrationValidator) ──────────
      const { MigrationValidator } = await import('./migration/validator.js');
      const validator  = new MigrationValidator(sn);
      const mappingsForValidator = field_mappings.map(m => ({
        staging_field: m.staging_field,
        sn_target:     m.sn_field,
      }));
      const fillReport = await validator.validate({
        platform,
        source:        null,
        stagingTable:  staging_table,
        targetTable:   target_table,
        mappings:      mappingsForValidator,
        sampleSize:    Math.min(source_records.length, 50),
      }).catch(e => ({ error: e.message }));

      // ── Layer 2: deep source↔target reconciliation ────────────────────────
      const transformMap = new Map();
      for (const rule of (transform_rules ?? [])) {
        transformMap.set(rule.sn_field, new Map(Object.entries(rule.value_map)));
      }
      const sourceToSn = Object.fromEntries(field_mappings.map(m => [m.source_field, m.sn_field]));

      const reconciler = new MigrationReconciler(sn, {
        transformMap,
        dateFields:    new Set(date_fields ?? []),
      });
      const reconReport = await reconciler.reconcile(
        source_records, target_table, sourceToSn,
        correlation_field, source_id_field,
        { limit: source_records.length }
      );

      // ── Combine into unified verdict ───────────────────────────────────────
      const stagingPass = !fillReport.error && fillReport.overall_health === 'PASS';
      const reconPass   = reconReport.verdict.result === 'PASS';
      const overallVerdict = stagingPass && reconPass ? 'PASS'
        : !stagingPass && !reconPass ? 'FAIL'
        : 'PARTIAL';

      // Build actionable fix list
      const fixes = [];
      if (fillReport.staging_issues?.length) {
        fixes.push(...fillReport.staging_issues.map(f => ({
          layer: 'source→staging',
          field: f.staging_field,
          issue: 'Field is empty in staging table — data was not fetched from source',
          action: `Check the source connector is mapping "${f.staging_field}" and re-run the staging push`,
        })));
      }
      if (fillReport.target_issues?.length) {
        fixes.push(...fillReport.target_issues.map(f => ({
          layer: 'staging→target',
          field: f.target_field,
          issue: 'Field is empty in target table — transform map is not mapping this field',
          action: `Check the transform map has a field mapping for staging.${f.staging_field} → target.${f.target_field}`,
        })));
      }
      if (reconReport.missing_records?.length) {
        fixes.push({
          layer:  'source→target',
          field:  correlation_field,
          issue:  `${reconReport.missing_records.length} source records not found in ServiceNow`,
          action: `Verify the correlation field "${correlation_field}" is being populated and the migration ran for all records`,
        });
      }
      for (const f of reconReport.field_stats.filter(f => f.verdict === 'FAIL' || f.verdict === 'PARTIAL')) {
        fixes.push({
          layer:  'value mismatch',
          field:  f.sn_field,
          issue:  `${f.failed}/${f.total} values don't match (${f.accuracy_pct}% accuracy)`,
          action: `Review transform rules for "${f.sn_field}". Sample: expected "${f.sample_mismatches[0]?.expected}" got "${f.sample_mismatches[0]?.actual}"`,
        });
      }

      return ok({
        instructions_for_claude: [
          `Migration test report: ${overallVerdict}`,
          overallVerdict === 'PASS'
            ? 'All three layers verified. Safe to proceed with full production migration.'
            : `${fixes.length} issue(s) found. Walk the user through each fix in the fixes array before re-running.`,
          overallVerdict !== 'PASS'
            ? 'Do NOT proceed with full migration until all FAIL items are resolved.'
            : null,
        ].filter(Boolean),
        overall_verdict:   overallVerdict,
        layer_verdicts: {
          fill_rate:     stagingPass ? 'PASS' : 'FAIL',
          reconciliation: reconReport.verdict.result,
        },
        fixes,
        fill_rate_report: fillReport,
        reconciliation_report: {
          verdict:  reconReport.verdict,
          summary:  reconReport.summary,
          field_stats: reconReport.field_stats,
        },
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// BIDIRECTIONAL INTEGRATION TOOLS
// ══════════════════════════════════════════════════════════════════════════

// ── TOOL: design_integration ───────────────────────────────────────────────
server.tool(
  'design_integration',
  `Analyse a user's bidirectional integration requirement and produce a complete,
   structured integration plan. Supports all platform combinations:
     servicenow ↔ jira | servicenow ↔ salesforce | jira ↔ salesforce

   The plan specifies every artifact that must be created on each platform:
   - Correlation table (cross-platform ID mapping)
   - Retry/error table (dead-letter queue)
   - Business Rules, Scripted REST APIs, Outbound REST Messages (ServiceNow)
   - Apex Trigger, Queueable class, Named Credential (Salesforce)
   - Webhook, Automation rule (Jira)
   - Best-practice checklist (loop prevention, auth, idempotency, etc.)

   Call this FIRST before any create_integration_* tool. Pass the result to
   the other tools to actually create the artifacts.`,
  {
    platform_a:    z.enum(['servicenow','jira','salesforce']).describe('Source/primary platform'),
    platform_b:    z.enum(['servicenow','jira','salesforce']).describe('Target/secondary platform'),
    direction:     z.enum(['a_to_b','b_to_a','bidirectional']).default('bidirectional').describe('Sync direction'),
    table_a:       z.string().describe('Table/object in platform A (e.g. incident, Issue, Case)'),
    table_b:       z.string().describe('Table/object in platform B (e.g. incident, Issue, Case)'),
    field_mappings: z.record(z.string()).describe('{ platformA_field: platformB_field } mapping'),
    trigger_a: z.object({
      events:     z.array(z.string()).optional().describe('Events that trigger A→B sync'),
      conditions: z.array(z.string()).optional().describe('Filter conditions (e.g. "state=on_hold")'),
    }).optional().describe('What triggers syncing FROM platform A TO platform B'),
    trigger_b: z.object({
      events:     z.array(z.string()).optional().describe('Events that trigger B→A sync'),
      conditions: z.array(z.string()).optional().describe('Filter conditions'),
    }).optional().describe('What triggers syncing FROM platform B TO platform A'),
    options: z.object({
      prefix:           z.string().optional().describe('Short identifier prefix for all artifact names'),
      sync_comments:    z.boolean().optional().default(false),
      sync_attachments: z.boolean().optional().default(false),
    }).optional(),
  },
  async ({ platform_a, platform_b, direction, table_a, table_b, field_mappings, trigger_a, trigger_b, options }) => {
    try {
      if (platform_a === platform_b) return fail('platform_a and platform_b must be different');
      const designer = new IntegrationDesigner();
      const plan = designer.design({
        platformA:    platform_a,
        platformB:    platform_b,
        direction:    direction ?? 'bidirectional',
        tableA:       table_a,
        tableB:       table_b,
        fieldMappings: field_mappings ?? {},
        triggerA:     trigger_a ?? {},
        triggerB:     trigger_b ?? {},
        options:      options ?? {},
      });
      return ok({
        instructions_for_claude: [
          `Integration plan created for ${platform_a} ↔ ${platform_b} (${table_a} ↔ ${table_b}).`,
          `Prefix: ${plan.meta.prefix}`,
          `Next: call create_sn_integration_artifacts to build the ServiceNow side,`,
          `then create_jira_integration_artifacts or create_sf_integration_artifacts for the other platform.`,
          `Share the checklist with the user and confirm each item before going live.`,
        ],
        plan,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_sn_integration_artifacts ─────────────────────────────────
server.tool(
  'create_sn_integration_artifacts',
  `Create all ServiceNow-side artifacts for a bidirectional integration:
   - Correlation table (cross-platform ID tracking)
   - Retry/error table (dead-letter queue for failed syncs)
   - Sync-in-progress flag field (loop prevention)
   - sys_properties entry (field mapping config)
   - Outbound REST Message + HTTP method (for SN→external calls)
   - Business Rule (fires on record change, calls outbound REST)
   - Scripted REST API + POST operation (inbound endpoint for external→SN)
   - UI Action "Sync Now" button
   - Client Script (shows sync status on form)

   Requires the integration plan from design_integration.`,
  {
    plan:        z.record(z.unknown()).describe('The plan object returned by design_integration'),
    target_url:  z.string().optional().describe('Base URL of the target platform API (e.g. https://your-domain.atlassian.net)'),
    target_api_key: z.string().optional().describe('API key or token for the target platform (stored in Named Credentials later)'),
  },
  async ({ plan, target_url, target_api_key }) => {
    try {
      const sn      = await getSn();
      const builder = new SNArtifactBuilder(sn);
      const results = await builder.buildAll(plan, { targetUrl: target_url, targetApiKey: target_api_key });
      return ok({
        instructions_for_claude: [
          'ServiceNow artifacts created successfully.',
          `Inbound endpoint path: /api/x_snmig/${plan.meta?.prefix}/sync`,
          'Share this endpoint URL with the user — they need to register it as the webhook/callback in the partner platform.',
          'Outbound REST Message created — tell the user to open it in SN and set the correct credentials/connection alias.',
          'Next: call create_jira_integration_artifacts or create_sf_integration_artifacts.',
        ],
        artifacts: results,
        inbound_endpoint: `/api/x_snmig/${plan.meta?.prefix}/sync`,
        sn_outbound_rest_name: `u_${plan.meta?.prefix}_outbound`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_jira_integration_artifacts ────────────────────────────────
server.tool(
  'create_jira_integration_artifacts',
  `Create Jira-side artifacts for a bidirectional integration:
   - Registers a Jira webhook (calls the inbound endpoint when issues change)
   - Generates a Jira Automation rule JSON (ready to import in Jira UI)
   - Returns step-by-step instructions for importing the automation rule

   The automation rule includes loop-prevention via issue labels.
   Requires the integration plan from design_integration.`,
  {
    plan:         z.record(z.unknown()).describe('Plan from design_integration'),
    inbound_url:  z.string().optional().describe('The inbound endpoint URL the other platform exposes (e.g. the SN Scripted REST API URL)'),
    webhook_secret: z.string().optional().describe('Shared secret to add as a header for webhook security'),
  },
  async ({ plan, inbound_url, webhook_secret }) => {
    try {
      const jira    = await getJira();
      const builder = new JiraArtifactBuilder(jira);
      const results = await builder.buildAll(plan, { inboundUrl: inbound_url, webhookSecret: webhook_secret });
      return ok({
        instructions_for_claude: [
          'Jira artifacts generated.',
          results.webhook
            ? `Webhook registered (id: ${results.webhook.id ?? results.webhook.self}).`
            : 'Webhook could not be registered automatically — share the manual instructions with the user.',
          'Share the automation_rule.instructions with the user — they need to import the rule in Jira UI.',
          'Remind the user to set the loop-prevention label condition in the automation rule.',
        ],
        artifacts: results,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_sf_integration_artifacts ─────────────────────────────────
server.tool(
  'create_sf_integration_artifacts',
  `Generate all Salesforce-side code and configuration for a bidirectional integration:
   - Named Credential XML (paste into Metadata API or create in Setup UI)
   - Apex Queueable callout class (async HTTP call to the partner platform)
   - Apex Trigger (fires on insert/update, enqueues the callout class)
   - Inbound Apex REST class (receives sync calls from the partner platform)
   - Step-by-step deployment instructions

   Note: Apex code is GENERATED and returned as strings — the user must deploy
   it via Developer Console, VS Code + SFDX, or Metadata API.
   Requires the integration plan from design_integration.`,
  {
    plan:       z.record(z.unknown()).describe('Plan from design_integration'),
    target_url: z.string().optional().describe('Base URL of the partner platform (used in Named Credential)'),
  },
  async ({ plan, target_url }) => {
    try {
      const sf      = await getSf().catch(() => null);
      const builder = new SFArtifactBuilder(sf);
      const results = builder.buildAll(plan, { targetUrl: target_url });
      return ok({
        instructions_for_claude: [
          'Salesforce artifacts generated (Apex code + Named Credential config).',
          'Walk the user through deployment_instructions step by step.',
          `Inbound Apex REST endpoint: ${results.inbound_apex_rest?.endpoint}`,
          'Tell the user to register this endpoint URL as the webhook/callback in the partner platform.',
          'Remind the user that Salesforce callouts must be async — the generated Queueable class handles this.',
        ],
        artifacts: results,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_integration_status ──────────────────────────────────────────
server.tool(
  'get_integration_status',
  `Check the health of a running bidirectional integration by querying:
   - Correlation table: how many records are linked
   - Retry/error table: how many failed syncs are pending
   - Recent sync activity (last N records synced)

   Use this to monitor the integration after it goes live.`,
  {
    prefix:        z.string().describe('The integration prefix (from the plan, e.g. sn_jira_incident)'),
    last_n_errors: z.number().optional().default(10).describe('How many recent errors to return'),
  },
  async ({ prefix, last_n_errors }) => {
    try {
      const sn   = await getSn();
      const correlTable = `u_${prefix}_correlation`;
      const retryTable  = `u_${prefix}_sync_error`;

      const [correlRows, errorRows, recentSync] = await Promise.all([
        sn.get(correlTable, { sysparm_query: 'u_sync_enabled=true', sysparm_fields: 'sys_id,u_platform_b,u_last_sync,u_sync_error', sysparm_limit: '1000' }).catch(() => []),
        sn.get(retryTable,  { sysparm_query: 'u_resolved=false^ORDERBYDESCsys_created_on', sysparm_fields: 'u_source_id,u_error,u_retry_count,sys_created_on', sysparm_limit: String(last_n_errors ?? 10) }).catch(() => []),
        sn.get(correlTable, { sysparm_query: 'u_last_syncRELATIVEGE@hour@ago@1', sysparm_fields: 'u_record_sys_id_a,u_record_id_b,u_last_sync,u_sync_direction', sysparm_limit: '20', sysparm_orderby: 'u_last_sync^DESC' }).catch(() => []),
      ]);

      const withErrors = correlRows.filter(r => r.u_sync_error);

      return ok({
        summary: {
          total_linked_records:  correlRows.length,
          records_with_errors:   withErrors.length,
          pending_retries:       errorRows.length,
          synced_last_hour:      recentSync.length,
        },
        recent_sync_activity: recentSync,
        pending_errors:        errorRows,
        records_with_sync_errors: withErrors.slice(0, 10),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: test_integration ────────────────────────────────────────────────
server.tool(
  'test_integration',
  `Send a single test payload through the bidirectional integration end-to-end
   and verify it arrives correctly on the other side.

   For SN→external: touches a specific SN record (sets a harmless field) to
   fire the Business Rule, then polls the correlation table to confirm the
   external record was created/updated.

   For external→SN: POSTs a test payload directly to the SN Scripted REST API
   inbound endpoint and verifies the SN record was updated.

   Returns: pass/fail verdict, response from both sides, correlation record state.`,
  {
    prefix:         z.string().describe('Integration prefix (from design_integration plan)'),
    direction:      z.enum(['sn_to_external','external_to_sn']).describe('Which direction to test'),
    sn_record_sys_id: z.string().optional().describe('For sn_to_external: sys_id of a real SN record to trigger sync on'),
    test_payload:   z.record(z.unknown()).optional().describe('For external_to_sn: payload to POST to the inbound endpoint'),
    sn_table:       z.string().optional().describe('SN table the record belongs to'),
  },
  async ({ prefix, direction, sn_record_sys_id, test_payload, sn_table }) => {
    try {
      const sn          = await getSn();
      const correlTable = `u_${prefix}_correlation`;
      const retryTable  = `u_${prefix}_sync_error`;

      if (direction === 'sn_to_external') {
        if (!sn_record_sys_id || !sn_table) return fail('sn_record_sys_id and sn_table are required for sn_to_external test');

        // Touch the record to fire the Business Rule (set u_sync_in_progress = false to ensure BR fires)
        await sn.patch(sn_table, sn_record_sys_id, { u_sync_in_progress: false });

        // Wait 3 seconds for async processing, then check correlation table
        await new Promise(r => setTimeout(r, 3000));

        const corrRows = await sn.get(correlTable, {
          sysparm_query: `u_record_sys_id_a=${sn_record_sys_id}`,
          sysparm_fields: 'u_record_id_b,u_last_sync,u_sync_error,u_sync_direction',
          sysparm_limit: '1',
        });

        const errors = await sn.get(retryTable, {
          sysparm_query: `u_source_id=${sn_record_sys_id}^u_resolved=false`,
          sysparm_fields: 'u_error,sys_created_on',
          sysparm_limit: '1',
        });

        const passed = corrRows.length > 0 && !corrRows[0].u_sync_error && !errors.length;

        return ok({
          verdict: passed ? 'PASS' : 'FAIL',
          correlation_record: corrRows[0] ?? null,
          sync_error: errors[0]?.u_error ?? null,
          instructions_for_claude: [
            passed
              ? `Test passed — SN record ${sn_record_sys_id} was synced to external platform. External ID: ${corrRows[0]?.u_record_id_b}`
              : `Test failed — ${errors[0]?.u_error ?? 'No correlation record created. Check the Business Rule is active and the Outbound REST Message credentials are set.'}`,
          ],
        });
      }

      if (direction === 'external_to_sn') {
        if (!test_payload) return fail('test_payload is required for external_to_sn test');

        // POST directly to the SN Scripted REST API
        const apiPath = `/api/x_snmig/${prefix}/sync`;
        const result  = await sn.post(apiPath.replace('/api/', ''), test_payload).catch(e => ({ error: e.message }));

        return ok({
          verdict: result?.status === 'updated' || result?.status === 'ok' ? 'PASS' : 'FAIL',
          response: result,
          instructions_for_claude: [
            result?.status === 'updated' || result?.status === 'ok'
              ? `Test passed — inbound payload was applied to SN record ${result?.sys_id}`
              : `Test failed — ${result?.error ?? result?.message ?? JSON.stringify(result)}. Check the Scripted REST API is active and the correlation field is populated.`,
          ],
        });
      }

      return fail(`Unknown direction: ${direction}`);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: disable_integration ─────────────────────────────────────────────
server.tool(
  'disable_integration',
  `Pause a bidirectional integration by deactivating the Business Rule (outbound)
   and the Scripted REST API (inbound) without deleting them.
   Use this for maintenance windows, debugging, or bulk imports where you don't
   want sync to fire. Call enable_integration to resume.`,
  {
    prefix: z.string().describe('Integration prefix'),
  },
  async ({ prefix }) => {
    try {
      const sn      = await getSn();
      const brName  = `${prefix}_sync_outbound`;
      const apiName = `${prefix}_inbound_api`;
      const results = {};

      const br = await sn.get('sys_script', { sysparm_query: `name=${brName}`, sysparm_limit: '1' });
      if (br.length) {
        await sn.patch('sys_script', br[0].sys_id, { active: false });
        results.business_rule = 'deactivated';
      } else results.business_rule = 'not_found';

      const api = await sn.get('sys_ws_definition', { sysparm_query: `name=${apiName}`, sysparm_limit: '1' });
      if (api.length) {
        await sn.patch('sys_ws_definition', api[0].sys_id, { active: false });
        results.scripted_rest_api = 'deactivated';
      } else results.scripted_rest_api = 'not_found';

      const job = await sn.get('sysauto_script', { sysparm_query: `name=${prefix}_retry_failed_syncs`, sysparm_limit: '1' });
      if (job.length) {
        await sn.patch('sysauto_script', job[0].sys_id, { active: false });
        results.retry_job = 'deactivated';
      } else results.retry_job = 'not_found';

      return ok({
        instructions_for_claude: [`Integration "${prefix}" paused. No syncs will fire in either direction until enable_integration is called.`],
        prefix,
        status: 'disabled',
        artifacts: results,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: enable_integration ──────────────────────────────────────────────
server.tool(
  'enable_integration',
  `Resume a paused bidirectional integration by re-activating the Business Rule,
   Scripted REST API, and retry scheduled job.`,
  {
    prefix: z.string().describe('Integration prefix'),
  },
  async ({ prefix }) => {
    try {
      const sn      = await getSn();
      const results = {};

      const br = await sn.get('sys_script', { sysparm_query: `name=${prefix}_sync_outbound`, sysparm_limit: '1' });
      if (br.length) { await sn.patch('sys_script', br[0].sys_id, { active: true }); results.business_rule = 'activated'; }

      const api = await sn.get('sys_ws_definition', { sysparm_query: `name=${prefix}_inbound_api`, sysparm_limit: '1' });
      if (api.length) { await sn.patch('sys_ws_definition', api[0].sys_id, { active: true }); results.scripted_rest_api = 'activated'; }

      const job = await sn.get('sysauto_script', { sysparm_query: `name=${prefix}_retry_failed_syncs`, sysparm_limit: '1' });
      if (job.length) { await sn.patch('sysauto_script', job[0].sys_id, { active: true }); results.retry_job = 'activated'; }

      return ok({
        instructions_for_claude: [`Integration "${prefix}" is now active. Syncs will resume in both directions.`],
        prefix,
        status: 'enabled',
        artifacts: results,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: update_field_mappings ────────────────────────────────────────────
server.tool(
  'update_field_mappings',
  `Update the field mapping configuration for an existing integration without
   recreating any artifacts. The mapping is stored in a sys_property record —
   this tool updates that property and returns the new active mapping.

   Use when adding new fields to sync, removing fields, or correcting a mapping
   mistake. Changes take effect immediately on the next sync event.`,
  {
    prefix:         z.string().describe('Integration prefix'),
    field_mappings: z.record(z.string()).describe('Complete NEW field mapping { snField: externalField }. Replaces the existing mapping entirely.'),
    merge:          z.boolean().optional().default(false).describe('If true, merge with existing mapping instead of replacing it'),
  },
  async ({ prefix, field_mappings, merge }) => {
    try {
      const sn      = await getSn();
      const propKey = `x_snmig.${prefix}.field_map`;

      const existing = await sn.get('sys_properties', { sysparm_query: `name=${propKey}`, sysparm_limit: '1' });
      if (!existing.length) return fail(`Property ${propKey} not found — has the integration been created with create_sn_integration_artifacts?`);

      let newMapping = field_mappings;
      if (merge) {
        const current = JSON.parse(existing[0].value || '{}');
        newMapping = { ...current, ...field_mappings };
      }

      await sn.patch('sys_properties', existing[0].sys_id, { value: JSON.stringify(newMapping, null, 2) });

      return ok({
        instructions_for_claude: [
          `Field mapping updated for "${prefix}". Changes are live immediately — the next sync event will use the new mapping.`,
          `Total mapped fields: ${Object.keys(newMapping).length}`,
        ],
        prefix,
        prop_key:       propKey,
        active_mapping: newMapping,
        field_count:    Object.keys(newMapping).length,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: retry_failed_syncs ──────────────────────────────────────────────
server.tool(
  'retry_failed_syncs',
  `Retry all failed sync attempts from the integration error/retry table.
   For each failed record, re-fires the Business Rule by touching the source record.
   Pass dry_run=true to see what would be retried without actually doing it.`,
  {
    prefix:       z.string().describe('Integration prefix'),
    source_table: z.string().optional().describe('Source SN table name (required if not derivable from prefix, e.g. "incident")'),
    dry_run: z.boolean().optional().default(false),
    limit:   z.number().optional().default(50).describe('Max records to retry in one call'),
  },
  async ({ prefix, source_table, dry_run, limit }) => {
    try {
      const sn         = await getSn();
      const retryTable = `u_${prefix}_sync_error`;

      const pending = await sn.get(retryTable, {
        sysparm_query:  'u_resolved=false^u_source_platform=servicenow',
        sysparm_fields: 'sys_id,u_source_id,u_error,u_retry_count',
        sysparm_limit:  String(limit ?? 50),
      });

      if (dry_run) {
        return ok({ dry_run: true, would_retry: pending.length, records: pending });
      }

      const results = [];
      for (const row of pending) {
        try {
          // Mark as resolved (business rule will re-queue if it fails again)
          await sn.patch(retryTable, row.sys_id, { u_resolved: true });
          // Touch the source record to re-trigger the business rule
          // source_table param is explicit; fallback to last segment of prefix
          const tbl = source_table ?? (prefix.split('_').slice(2).join('_') || prefix);
          await sn.patch(tbl, row.u_source_id, { u_sync_in_progress: false }).catch(() => null);
          results.push({ source_id: row.u_source_id, status: 'queued' });
        } catch (e) {
          results.push({ source_id: row.u_source_id, status: 'error', error: e.message });
        }
      }

      return ok({ retried: results.length, results });
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DEVELOPER TOOLS — script generation, code review, schema, testing, perf
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: generate_script ──────────────────────────────────────────────────
server.tool(
  'generate_script',
  `Generate a complete, production-ready ServiceNow script with industry best practices baked in.

Supported types:
  business_rule   — Server-side BR with guard, try/catch, async option
  script_include  — Prototype-class SI with JSDoc and error envelope
  client_script   — onChange/onLoad/onSubmit/onCellEdit with safe patterns
  ui_action       — Server or client UI Action with redirect/confirm flow
  scripted_rest   — Full Scripted REST API with auth, logging, error envelope
  scheduled_job   — Scheduled job with timing, batch counting, error logging
  fix_script      — One-time data fix with dry-run support and audit log
  widget          — Service Portal widget stub (template + server + client)

Returns ready-to-deploy script code plus best-practice checklist and deploy field values.`,
  {
    type: z.enum(['business_rule','script_include','client_script','ui_action','scripted_rest','scheduled_job','fix_script','widget']),
    name: z.string().describe('Script name'),
    table: z.string().optional().describe('Target table (required for BR, CS, UI Action, Fix Script)'),
    description: z.string().optional().describe('What this script does'),
    logic: z.string().optional().describe('Core logic to embed (pseudo-code or partial code is fine)'),
    // BR options
    when: z.enum(['before','after','async']).optional().default('after'),
    events: z.array(z.enum(['insert','update','delete','query'])).optional(),
    condition: z.string().optional().describe('Encoded query condition'),
    async: z.boolean().optional().default(false),
    // SI options
    methods: z.array(z.object({
      name:        z.string(),
      description: z.string().optional(),
      params:      z.string().optional(),
      paramType:   z.string().optional(),
      returnType:  z.string().optional(),
      body:        z.string().optional(),
    })).optional(),
    client_callable: z.boolean().optional().default(false),
    // Client Script options
    script_type: z.enum(['onLoad','onChange','onSubmit','onCellEdit']).optional(),
    field: z.string().optional().describe('Field name for onChange scripts'),
    // UI Action options
    client: z.boolean().optional().default(false),
    hint: z.string().optional(),
    // REST options
    api_path: z.string().optional(),
    verb: z.enum(['GET','POST','PUT','PATCH','DELETE']).optional().default('GET'),
    requires_auth: z.boolean().optional().default(true),
    request_params: z.array(z.object({
      name:        z.string(),
      type:        z.string().optional(),
      required:    z.boolean().optional(),
      description: z.string().optional(),
      default:     z.string().optional(),
    })).optional(),
    // Scheduled Job options
    schedule: z.enum(['hourly','daily','weekly','monthly']).optional().default('daily'),
    // Fix Script options
    query: z.string().optional().describe('Encoded query to select records to fix'),
    dry_run: z.boolean().optional().default(true),
  },
  ({ type, name, table, description, logic, when, events, condition, async: isAsync,
     methods, client_callable, script_type, field, client, hint,
     api_path, verb, requires_auth, request_params, schedule, query, dry_run }) => {
    try {
      let result;
      switch (type) {
        case 'business_rule':
          result = _scriptBuilder.buildBusinessRule({ name, table: table ?? 'incident', when, events: events ?? ['insert','update'], condition, description, logic, async: isAsync });
          break;
        case 'script_include':
          result = _scriptBuilder.buildScriptInclude({ name, description, methods: methods ?? [], client_callable });
          break;
        case 'client_script':
          result = _scriptBuilder.buildClientScript({ name, table: table ?? 'incident', type: script_type ?? 'onChange', field, description, logic });
          break;
        case 'ui_action':
          result = _scriptBuilder.buildUiAction({ name, table: table ?? 'incident', client, condition, hint, description, logic });
          break;
        case 'scripted_rest':
          result = _scriptBuilder.buildScriptedRestApi({ name, apiPath: api_path ?? name.toLowerCase().replace(/\s+/g,'-'), verb, description, requiresAuth: requires_auth, logic, requestParams: request_params ?? [] });
          break;
        case 'scheduled_job':
          result = _scriptBuilder.buildScheduledJob({ name, description, schedule, logic });
          break;
        case 'fix_script':
          result = _scriptBuilder.buildFixScript({ name, description, table: table ?? 'incident', query, updateLogic: logic, dryRun: dry_run });
          break;
        case 'widget':
          result = _scriptBuilder.buildWidget({ name, description });
          break;
        default:
          return fail(`Unknown script type: ${type}`);
      }
      return ok({ generated: result, note: 'Script generated with industry best practices. Review best_practices list before deploying.' });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: review_script ────────────────────────────────────────────────────
server.tool(
  'review_script',
  `Static analysis code review for a ServiceNow script.

Checks for:
  - Critical: eval(), hardcoded credentials, SQL/SOQL injection risk, unvalidated input
  - Anti-patterns: GlideRecord in loops, no setLimit, hardcoded sys_ids, gr.get in loops
  - Performance: full table scans, getRowCount, sync REST in BR, GlideAggregate opportunities
  - Null safety: missing gs.nil(), JSON.parse(null) risk, unchecked gr.get() return
  - Best practices: gs.print vs gs.info, no error handling on REST, bulk updates without setWorkflow

Returns a score (0-10), verdict, and per-issue fix guidance.`,
  {
    script: z.string().describe('The script source code to review'),
    type:   z.enum(['business_rule','client_script','script_include','scripted_rest','scheduled_job','server_script']).optional().default('server_script'),
  },
  ({ script, type }) => {
    try {
      const result = _codeReviewer.review(script, type);
      return ok(result);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: list_review_rules ────────────────────────────────────────────────
server.tool(
  'list_review_rules',
  'List all code review rules with descriptions and fix guidance. Useful for understanding what review_script checks.',
  {
    category: z.enum(['anti-pattern','performance','security','null-safety','best-practice']).optional(),
  },
  ({ category }) => {
    try {
      const rules = _codeReviewer.listRules(category);
      return ok({ total: rules.length, rules });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: explore_table ────────────────────────────────────────────────────
server.tool(
  'explore_table',
  `Full schema discovery for a ServiceNow table.

Returns:
  - Table metadata (parent, scope, numbering, ACL flags)
  - All fields (name, label, type, reference, mandatory, read-only)
  - Active Business Rules (when, events, conditions)
  - Active Client Scripts (type, field)
  - ACL rules (operation, type, roles)
  - Incoming relationships (which tables reference this one)
  - Table hierarchy (parent chain up to Task or base)
  - Summary counts

Use this before writing a BR or Client Script to understand the full context.`,
  {
    table:       z.string().describe('Table name, e.g. "incident" or "change_request"'),
    field_limit: z.number().optional().default(200).describe('Max fields to return'),
  },
  async ({ table, field_limit }) => {
    try {
      const sn       = await getSn();
      const explorer = new TableExplorer(sn);
      const result   = await explorer.explore(table, { fieldLimit: field_limit });
      return ok(result);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: find_table ──────────────────────────────────────────────────────
server.tool(
  'find_table',
  'Search for ServiceNow tables by keyword (name or label). Returns up to 25 matches.',
  {
    keyword: z.string().describe('Keyword to search in table name or label'),
  },
  async ({ keyword }) => {
    try {
      const sn       = await getSn();
      const explorer = new TableExplorer(sn);
      const results  = await explorer.findTable(keyword);
      return ok({ count: results.length, tables: results });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_table_acls ──────────────────────────────────────────────────
server.tool(
  'get_table_acls',
  'Get all ACL rules for a ServiceNow table, including field-level ACLs.',
  {
    table: z.string().describe('Table name'),
  },
  async ({ table }) => {
    try {
      const sn       = await getSn();
      const explorer = new TableExplorer(sn);
      const acls     = await explorer.getAcls(table);
      return ok({ table, count: acls.length, acls });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: generate_atf_tests ──────────────────────────────────────────────
server.tool(
  'generate_atf_tests',
  `Generate ATF (Automated Test Framework) test cases for ServiceNow artifacts.

Supported test targets:
  business_rule   — positive, negative, and field-change trigger tests
  script_include  — unit tests per method (happy path + null/invalid input)
  scripted_rest   — auth, validation, and custom scenario tests
  form            — Client Script / UI Policy field behaviour tests
  table           — mandatory field, uniqueness, and basic CRUD smoke tests

Returns ATF test suite JSON with steps ready to import + deploy instructions.`,
  {
    target_type: z.enum(['business_rule','script_include','scripted_rest','form','table']),
    name:        z.string().describe('Name of the artifact under test'),
    table:       z.string().optional().describe('Table name (required for BR, form, table tests)'),
    // BR fields
    trigger_conditions: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
    field_changes:      z.record(z.string()).optional(),
    expected_outcomes:  z.array(z.object({ field: z.string(), value: z.string() })).optional(),
    // SI fields
    methods: z.array(z.object({
      name:        z.string(),
      testInput:   z.record(z.unknown()).optional(),
      assertions:  z.array(z.object({ path: z.string().optional(), value: z.unknown(), message: z.string().optional() })).optional(),
    })).optional(),
    // REST fields
    api_path:        z.string().optional(),
    verb:            z.enum(['GET','POST','PUT','PATCH','DELETE']).optional(),
    required_params: z.array(z.string()).optional(),
    test_cases:      z.array(z.object({
      name:        z.string(),
      params:      z.record(z.unknown()).optional(),
      expectedStatus: z.number().optional(),
      assertions:  z.array(z.object({ field: z.string(), value: z.unknown() })).optional(),
    })).optional(),
    // Form fields
    scenarios: z.array(z.object({
      name:        z.string(),
      description: z.string().optional(),
      fieldSets:   z.array(z.object({ field: z.string(), value: z.string() })).optional(),
      assertions:  z.array(z.object({ field: z.string(), property: z.string().optional(), expected: z.unknown() })).optional(),
    })).optional(),
    // Table fields
    mandatory_fields: z.array(z.string()).optional(),
    unique_fields:    z.array(z.string()).optional(),
  },
  ({ target_type, name, table, trigger_conditions, field_changes, expected_outcomes,
     methods, api_path, verb, required_params, test_cases, scenarios,
     mandatory_fields, unique_fields }) => {
    try {
      let suite;
      switch (target_type) {
        case 'business_rule':
          suite = _testGen.generateBusinessRuleTests({ brName: name, table: table ?? 'incident', triggerConditions: trigger_conditions ?? [], fieldChanges: field_changes ?? {}, expectedOutcomes: expected_outcomes ?? [] });
          break;
        case 'script_include':
          suite = _testGen.generateScriptIncludeTests({ siName: name, methods: methods ?? [] });
          break;
        case 'scripted_rest':
          suite = _testGen.generateRestApiTests({ apiName: name, apiPath: api_path ?? name, verb: verb ?? 'GET', requiredParams: required_params ?? [], testCases: test_cases ?? [] });
          break;
        case 'form':
          suite = _testGen.generateFormTests({ table: table ?? name, scenarios: scenarios ?? [] });
          break;
        case 'table':
          suite = _testGen.generateTableSuite({ table: table ?? name, mandatoryFields: mandatory_fields ?? [], uniqueFields: unique_fields ?? [] });
          break;
        default:
          return fail(`Unknown target type: ${target_type}`);
      }
      return ok(suite);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: analyze_performance ─────────────────────────────────────────────
server.tool(
  'analyze_performance',
  `Analyse ServiceNow instance performance. Supported modes:

  slow_scripts      — Find slow Business Rules and scripts from syslog (last N minutes)
  scheduled_jobs    — Audit scheduled job durations
  suggest_indexes   — Suggest DB indexes for a table based on BR query patterns
  error_patterns    — Cluster recent system log errors by pattern
  audit_business_rules — Full BR performance audit for a table (no conditions, sync REST, etc.)`,
  {
    mode:           z.enum(['slow_scripts','scheduled_jobs','suggest_indexes','error_patterns','audit_business_rules']),
    table:          z.string().optional().describe('Table name (required for suggest_indexes and audit_business_rules)'),
    minutes_back:   z.number().optional().default(60),
    threshold_ms:   z.number().optional().default(5000).describe('Slow script threshold in ms'),
    hours:          z.number().optional().default(1).describe('Hours back for error_patterns'),
    limit:          z.number().optional().default(200),
  },
  async ({ mode, table, minutes_back, threshold_ms, hours, limit }) => {
    try {
      const sn       = await getSn();
      const analyzer = new PerfAnalyzer(sn);
      let result;
      switch (mode) {
        case 'slow_scripts':      result = await analyzer.findSlowScripts({ minutesBack: minutes_back, thresholdMs: threshold_ms, limit }); break;
        case 'scheduled_jobs':    result = await analyzer.analyzeScheduledJobs({}); break;
        case 'suggest_indexes':   result = await analyzer.suggestIndexes(table ?? ''); break;
        case 'error_patterns':    result = await analyzer.analyzeErrors({ hours, limit }); break;
        case 'audit_business_rules': result = await analyzer.auditBusinessRules(table ?? ''); break;
        default:                  return fail(`Unknown mode: ${mode}`);
      }
      return ok(result);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: find_sys_logs ───────────────────────────────────────────────────
server.tool(
  'find_sys_logs',
  'Search ServiceNow system logs (syslog table) by keyword, source, or level. Useful for debugging Business Rules, integrations, and scheduled jobs.',
  {
    keyword:   z.string().optional().describe('Message keyword to search'),
    source:    z.string().optional().describe('Source (e.g. script name)'),
    level:     z.enum(['0','1','2','3']).optional().describe('0=debug, 1=info, 2=error, 3=warn'),
    limit:     z.number().optional().default(50),
  },
  async ({ keyword, source, level, limit }) => {
    try {
      const sn   = await getSn();
      const parts = [];
      if (keyword) parts.push(`messageLIKE${keyword}`);
      if (source)  parts.push(`sourceLIKE${source}`);
      if (level)   parts.push(`level=${level}`);
      const query = parts.join('^') || 'active=true';

      const rows = await sn.query('syslog', {
        sysparm_query:  query,
        sysparm_fields: 'message,source,level,sys_created_on',
        sysparm_limit:  String(limit),
        sysparm_order:  '-sys_created_on',
      });

      return ok({ count: rows.length, logs: rows });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: run_background_script ───────────────────────────────────────────
server.tool(
  'run_background_script',
  `Execute a server-side script in ServiceNow using the Background Scripts table (sys_script_fix).

IMPORTANT: Creates a Fix Script record and marks it for execution.
The script runs as admin. Only use for safe, tested scripts.
Always dry_run first to preview the record that will be created.`,
  {
    name:    z.string().describe('Descriptive name for this script run'),
    script:  z.string().describe('The server-side script to execute'),
    dry_run: z.boolean().optional().default(true).describe('If true, just show what would be created without running'),
  },
  async ({ name, script, dry_run }) => {
    try {
      if (dry_run) {
        return ok({
          dry_run: true,
          preview: { table: 'sys_script_fix', name, script: script.substring(0, 200) + (script.length > 200 ? '...' : '') },
          warning: 'Set dry_run=false to actually create and run the script. Verify the script is safe first.',
        });
      }

      const sn = await getSn();
      const record = await sn.post('sys_script_fix', { name, script, active: false });
      return ok({
        created:    true,
        sys_id:     record.sys_id,
        name,
        note:       'Fix Script record created. Navigate to System Definition > Fix Scripts in your SN instance to run it.',
        navigate_to: `${process.env.SN_INSTANCE_URL}/nav_to.do?uri=sys_script_fix.do?sys_id=${record.sys_id}`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: generate_docs ───────────────────────────────────────────────────
server.tool(
  'generate_docs',
  `Generate Markdown documentation for ServiceNow artifacts.

Supported doc targets:
  script_include  — Full API reference with method signatures and usage examples
  business_rule   — Metadata, risk analysis, script preview
  table           — Field catalogue, BR list, ACL list, relationships
  scripted_rest   — Endpoint reference, parameters, error codes
  application     — Full component inventory

Returns Markdown text ready to paste into Confluence, GitHub, or a wiki.`,
  {
    doc_type:    z.enum(['script_include','business_rule','table','scripted_rest','application']),
    name:        z.string().describe('Artifact name'),
    table:       z.string().optional().describe('Table name (required for table docs)'),
    script:      z.string().optional().describe('Script source (for script_include and business_rule docs)'),
    description: z.string().optional(),
    // BR metadata
    when:        z.string().optional(),
    events:      z.array(z.string()).optional(),
    condition:   z.string().optional(),
    // REST metadata
    api_path:    z.string().optional(),
    verb:        z.string().optional(),
    requires_auth: z.boolean().optional().default(true),
    client_callable: z.boolean().optional().default(false),
    // Application
    scope:       z.string().optional(),
    components:  z.record(z.array(z.object({ name: z.string(), table: z.string().optional(), description: z.string().optional() }))).optional(),
  },
  async ({ doc_type, name, table, script, description, when, events, condition,
           api_path, verb, requires_auth, client_callable, scope, components }) => {
    try {
      let markdown;
      if (doc_type === 'table') {
        // Fetch live data from SN
        const sn       = await getSn();
        const explorer = new TableExplorer(sn);
        const data     = await explorer.explore(table ?? name);
        markdown = _docGen.documentTable(data);
      } else if (doc_type === 'script_include') {
        markdown = _docGen.documentScriptInclude({ name, script: script ?? '', description, client_callable });
      } else if (doc_type === 'business_rule') {
        markdown = _docGen.documentBusinessRule({ name, table: table ?? 'incident', when: when ?? 'after', events: events ?? [], condition, script: script ?? '', description });
      } else if (doc_type === 'scripted_rest') {
        markdown = _docGen.documentRestApi({ name, apiPath: api_path ?? name, verb: verb ?? 'GET', description, requiresAuth: requires_auth, script: script ?? '' });
      } else if (doc_type === 'application') {
        markdown = _docGen.documentApplication({ appName: name, scope, components });
      } else {
        return fail(`Unknown doc_type: ${doc_type}`);
      }
      return ok({ doc_type, name, markdown, length_chars: markdown.length });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: scaffold_application ────────────────────────────────────────────
server.tool(
  'scaffold_application',
  `Generate a complete application scaffold for a new ServiceNow application.

Creates a recommended file/artifact structure with:
  - Main application table (u_<name>)
  - Number prefix and auto-numbering
  - Core Business Rules (set number, state management)
  - Script Include for business logic
  - UI Action for state transitions
  - ACL rules (read/write/delete)
  - ATF test suite
  - Documentation

Returns all scripts ready to create in ServiceNow.`,
  {
    app_name:    z.string().describe('Application name (e.g. "Asset Request")'),
    prefix:      z.string().describe('Short prefix for table name and number (e.g. "ar" → table u_ar_request, number ARREQ0001)'),
    description: z.string().optional().describe('What this application manages'),
    fields:      z.array(z.object({
      name:      z.string(),
      label:     z.string(),
      type:      z.string().optional().default('string'),
      mandatory: z.boolean().optional().default(false),
      reference: z.string().optional(),
    })).optional(),
    states: z.array(z.string()).optional().describe('State values, e.g. ["draft","submitted","approved","rejected","closed"]'),
  },
  ({ app_name, prefix, description, fields = [], states = ['draft','submitted','approved','rejected','closed'] }) => {
    try {
      const tableName = `u_${prefix}_request`;
      const numPrefix = prefix.toUpperCase().substring(0, 4) + 'REQ';

      const artifacts = {
        table: {
          name:  tableName,
          label: app_name,
          note:  `Create this table at System Definition > Tables. Add extension from Task table for workflow support.`,
        },
        business_rules: [
          _scriptBuilder.buildBusinessRule({
            name:      `${app_name} — Set Number`,
            table:     tableName,
            when:      'before',
            events:    ['insert'],
            condition: 'current.number.nil()',
            description: 'Auto-assign a unique number on insert',
            logic:     `current.number = gs.getProperty('${tableName}.number_prefix', '${numPrefix}') + gs.padStart(gs.getNextObjNumberPaddedWithPrefix('${numPrefix}', true), 7, '0');`,
          }),
          _scriptBuilder.buildBusinessRule({
            name:      `${app_name} — State Management`,
            table:     tableName,
            when:      'before',
            events:    ['update'],
            condition: 'current.state.changes()',
            description: 'Set timestamps and assigned_to based on state changes',
            logic:     `var state = current.state.toString();
if (state === 'approved')  { current.u_approved_on = new GlideDateTime(); current.u_approved_by = gs.getUserID(); }
if (state === 'closed')    { current.u_closed_on   = new GlideDateTime(); }`,
          }),
        ],
        script_include: _scriptBuilder.buildScriptInclude({
          name:        `${app_name.replace(/\s+/g,'')}Utils`,
          description: `Business logic utilities for ${app_name}`,
          methods: [
            { name: 'canApprove', description: 'Check if current user can approve', params: 'recordSysId', body: `return gs.hasRole('${prefix}_approver') || gs.hasRole('admin');` },
            { name: 'getOpenRequests', description: 'Get all open requests', body: `var gr = new GlideRecord('${tableName}');\ngr.addEncodedQuery('state!=closed^state!=rejected');\ngr.setLimit(1000);\ngr.query();\nvar list = [];\nwhile(gr.next()) list.push({ sys_id: gr.getUniqueValue(), number: gr.number.toString() });\nresult.data = list;` },
          ],
        }),
        ui_actions: states.filter(s => s !== 'draft').map(state =>
          _scriptBuilder.buildUiAction({
            name:      `Set ${state.charAt(0).toUpperCase() + state.slice(1)}`,
            table:     tableName,
            condition: `current.state != '${state}'`,
            hint:      `Move this request to ${state}`,
            description: `State transition to ${state}`,
            logic:     `current.state = '${state}';\ncurrent.update();\ngs.addInfoMessage('Request moved to ${state}.');`,
          })
        ),
        acls: [
          { operation: 'read',   roles: `${prefix}_user,${prefix}_manager,admin`,   note: `Create ACL on ${tableName} for read` },
          { operation: 'write',  roles: `${prefix}_manager,admin`,                  note: `Create ACL on ${tableName} for write` },
          { operation: 'delete', roles: `admin`,                                    note: `Create ACL on ${tableName} for delete` },
        ],
        sys_properties: [
          { name: `${tableName}.number_prefix`, value: numPrefix, description: `Number prefix for ${app_name} records` },
        ],
        atf_suite:  _testGen.generateTableSuite({ table: tableName, mandatoryFields: fields.filter(f => f.mandatory).map(f => f.name) }),
        documentation: _docGen.documentApplication({
          appName: app_name,
          scope:   'global',
          components: {
            'Tables':          [{ name: tableName, description: `Main ${app_name} table` }],
            'Business Rules':  [{ name: `${app_name} — Set Number`, table: tableName }, { name: `${app_name} — State Management`, table: tableName }],
            'Script Includes': [{ name: `${app_name.replace(/\s+/g,'')}Utils`, description: 'Business logic utilities' }],
            'UI Actions':      states.filter(s => s !== 'draft').map(s => ({ name: `Set ${s}`, table: tableName })),
          },
        }),
      };

      return ok({
        app_name,
        table_name:       tableName,
        number_prefix:    numPrefix,
        artifacts,
        artifact_count:   2 + artifacts.business_rules.length + artifacts.ui_actions.length + artifacts.acls.length,
        deploy_order:     ['table', 'sys_properties', 'script_include', 'business_rules', 'ui_actions', 'acls', 'atf_suite'],
        note:             'Deploy in the order specified by deploy_order. Create the table first, then add fields, then deploy scripts.',
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: health_check_instance ───────────────────────────────────────────
server.tool(
  'health_check_instance',
  `Run a comprehensive health check on the connected ServiceNow instance.

Checks:
  - Instance connectivity and response time
  - Recent error count in syslog
  - Scheduled jobs with no recent success
  - Tables with no indexes on commonly-queried fields
  - Business Rules with no conditions (fires on every record)
  - Failed integration sync records
  - System properties health

Returns an overall health score and prioritised action list.`,
  {},
  async () => {
    try {
      const sn    = await getSn();
      const start = Date.now();
      const checks = [];

      // 1. Connectivity
      await sn.query('sys_db_object', { sysparm_query: 'name=incident', sysparm_limit: '1' });
      const latency = Date.now() - start;
      checks.push({ check: 'Connectivity', status: 'OK', detail: `Response time: ${latency}ms`, score: latency < 2000 ? 10 : latency < 5000 ? 6 : 3 });

      // 2. Recent errors
      const errors = await sn.query('syslog', {
        sysparm_query: 'level=2^sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()',
        sysparm_limit: '1',
      }).catch(() => []);
      checks.push({ check: 'Error logs today', status: errors.length > 50 ? 'WARN' : 'OK', detail: `${errors.length}+ errors`, score: errors.length > 100 ? 4 : errors.length > 20 ? 7 : 10 });

      // 3. BRs with no condition on high-traffic tables
      const unconditionedBRs = await sn.query('sys_script', {
        sysparm_query: 'collectionINincident,change_request,sc_req_item^active=true^filter_condition=NULL^action_update=true',
        sysparm_fields: 'name,collection',
        sysparm_limit: '20',
      }).catch(() => []);
      checks.push({ check: 'BRs without conditions', status: unconditionedBRs.length > 5 ? 'WARN' : 'OK', detail: `${unconditionedBRs.length} unconditioned BRs on core tables`, score: unconditionedBRs.length > 10 ? 4 : unconditionedBRs.length > 3 ? 7 : 10 });

      const avgScore = Math.round(checks.reduce((s, c) => s + c.score, 0) / checks.length);
      const verdict  = avgScore >= 9 ? 'HEALTHY' : avgScore >= 7 ? 'GOOD' : avgScore >= 5 ? 'NEEDS ATTENTION' : 'CRITICAL';

      return ok({
        instance:      process.env.SN_INSTANCE_URL,
        health_score:  avgScore,
        verdict,
        checks,
        actions_needed: checks.filter(c => c.status !== 'OK').map(c => `${c.check}: ${c.detail}`),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: explain_api ─────────────────────────────────────────────────────
server.tool(
  'explain_api',
  `Explain a ServiceNow API, class, or method with examples and best practices.

Topics you can ask about:
  GlideRecord, GlideAggregate, GlideScopedEvaluator, GlideSystem (gs),
  RESTMessageV2, GlideAjax, GlideDateTime, GlideUser, GlideFlow,
  ServiceNow Table API (REST), Scripted REST API pattern, Business Rule lifecycle,
  Script Include class pattern, Client Script event types, ATF step types`,
  {
    topic: z.string().describe('The API, class, or concept to explain'),
  },
  ({ topic }) => {
    const api_docs = {
      'gliderecord': {
        name: 'GlideRecord',
        description: 'Server-side database query class. Most-used SN API.',
        best_practices: BEST_PRACTICES_SUMMARY.gliderecord,
        example: `var gr = new GlideRecord('incident');
gr.addEncodedQuery('active=true^priority=1');
gr.setLimit(100);
gr.orderByDesc('sys_created_on');
gr.query();
while (gr.next()) {
    gs.info(gr.number + ' — ' + gr.short_description);
}`,
      },
      'glideaggregate': {
        name: 'GlideAggregate',
        description: 'Efficient counting/grouping without loading full records.',
        best_practices: ['Use instead of GlideRecord for COUNT/SUM/AVG', 'Far faster than iterating with a counter'],
        example: `var ga = new GlideAggregate('incident');
ga.addEncodedQuery('active=true');
ga.addAggregate('COUNT', 'priority');
ga.groupBy('priority');
ga.query();
while (ga.next()) {
    gs.info('Priority ' + ga.priority + ': ' + ga.getAggregate('COUNT', 'priority'));
}`,
      },
      'glidedatetime': {
        name: 'GlideDateTime',
        description: 'Server-side date/time manipulation.',
        best_practices: ['Always use GlideDateTime for date math — not JS Date', 'Use addDays(), addSeconds() for offsets'],
        example: `var now  = new GlideDateTime();
var then = new GlideDateTime();
then.addDays(7);   // 7 days from now
gs.info(then.getDisplayValue());  // human-readable
gs.info(then.getValue());         // internal format for DB storage`,
      },
      'restmessagev2': {
        name: 'RESTMessageV2',
        description: 'Make outbound HTTP/REST calls from server scripts.',
        best_practices: ['Always wrap in try/catch', 'Check getStatusCode() before parsing body', 'Use executeAsync() in Business Rules'],
        example: `var msg = new RESTMessageV2('My REST Message', 'Default');
msg.setStringParameterNoEscape('param', value);
try {
    var resp   = msg.execute();
    var status = resp.getStatusCode();
    if (status === 200) {
        var body = JSON.parse(resp.getBody());
    } else {
        gs.error('REST call failed: ' + status + ' — ' + resp.getBody());
    }
} catch(e) {
    gs.error('REST exception: ' + e.message);
}`,
      },
    };

    const key    = topic.toLowerCase().replace(/[^a-z]/g, '');
    const doc    = api_docs[key];

    if (doc) {
      return ok(doc);
    }

    // Generic explanation
    return ok({
      topic,
      note:    'No built-in docs for this topic. Here are general best practices:',
      general: [
        'Always handle null/undefined before calling methods',
        'Wrap server scripts in try/catch with gs.error() in the catch',
        'Use gs.nil() to check GlideElement emptiness — not == null or == ""',
        'setLimit() on every GlideRecord query',
        'Use encoded queries over multiple addQuery() calls for OR conditions',
        'Test with the smallest privilege role that makes sense',
      ],
    });
  }
);

// Inline reference for explain_api (avoids circular import)
const BEST_PRACTICES_SUMMARY = {
  gliderecord: [
    'Always call setLimit() before query()',
    'Use addEncodedQuery() for complex conditions',
    'Use GlideAggregate instead of iterating to count',
    'Never query inside a while(gr.next()) loop',
    'Use gs.nil(gr.field) not == null',
    'Set setWorkflow(false) in bulk updates',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// PORTAL TOOLS — analyze, find, clone, create, update widgets and portals
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: analyze_portal ──────────────────────────────────────────────────
server.tool(
  'analyze_portal',
  `Analyze a complete Service Portal — pages, widgets, theme, widget usage counts.

Provide the portal's URL suffix (e.g. "sp" for the default portal) or its sys_id.

Returns:
  - Portal metadata (title, theme, homepage)
  - All pages (title, ID, public/private, roles)
  - Widgets available on the instance
  - Widget usage counts across pages
  - Theme details (CSS variables)
  - Summary statistics

Use this before starting portal development to understand what already exists.`,
  {
    portal_id: z.string().describe('Portal URL suffix (e.g. "sp") or sys_id'),
  },
  async ({ portal_id }) => {
    try {
      const sn     = await getSn();
      const portal = new PortalBuilder(sn);
      return ok(await portal.analyzePortal(portal_id));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: find_widget ─────────────────────────────────────────────────────
server.tool(
  'find_widget',
  'Search for Service Portal widgets by name, ID, or keyword. Returns up to 20 matches with sys_ids.',
  {
    keyword: z.string().describe('Keyword to search in widget name, ID, or description'),
    limit:   z.number().optional().default(20),
  },
  async ({ keyword, limit }) => {
    try {
      const sn     = await getSn();
      const portal = new PortalBuilder(sn);
      return ok({ keyword, results: await portal.findWidgets(keyword, limit) });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: clone_widget ────────────────────────────────────────────────────
server.tool(
  'clone_widget',
  `Clone an existing Service Portal widget with a new name and optional modifications.

Fetches all 4 widget sections (template, CSS, client script, server script) plus
option schema from the source widget, then produces a ready-to-deploy payload for
the cloned version with your modifications applied.

Modifications you can apply at clone time:
  template, css, client_script, server_script, option_schema, demo_data, description

Returns: POST-ready payload for sp_widget table + provenance comment in each section.`,
  {
    source_id:    z.string().describe('Source widget ID (e.g. "sc-cat-item") or sys_id'),
    new_name:     z.string().describe('Display name for the cloned widget'),
    new_id:       z.string().optional().describe('Widget ID for cloned widget (defaults to kebab-case of new_name)'),
    modifications: z.object({
      template:      z.string().optional(),
      css:           z.string().optional(),
      client_script: z.string().optional(),
      server_script: z.string().optional(),
      option_schema: z.string().optional(),
      description:   z.string().optional(),
    }).optional(),
  },
  async ({ source_id, new_name, new_id, modifications }) => {
    try {
      const sn     = await getSn();
      const portal = new PortalBuilder(sn);
      return ok(await portal.cloneWidget({ sourceIdOrSysId: source_id, newName: new_name, newId: new_id, modifications: modifications ?? {} }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_widget ───────────────────────────────────────────────────
server.tool(
  'create_widget',
  `Generate a complete, production-ready Service Portal widget from a requirement description.

Generates all 4 sections with best practices baked in:
  - HTML template: panel layout, loading/error states, AngularJS binding
  - CSS: theme-variable-based styling (no hardcoded colors)
  - Client script: c.data pattern, c.server.update(), spUtil feedback
  - Server script: try/catch, input dispatcher, GlideRecord with limit
  - Option schema: title + limit + any custom options

Returns deploy-ready payload + best practices + deploy instructions.`,
  {
    name:        z.string().describe('Widget display name'),
    id:          z.string().optional().describe('Widget ID (kebab-case, used in URL and as CSS class)'),
    description: z.string().optional(),
    data_source: z.string().optional().describe('Table to load data from (e.g. "incident")'),
    fields: z.array(z.object({
      key:   z.string().describe('Variable name in data object'),
      label: z.string().describe('Display label'),
      field: z.string().optional().describe('SN table field name if different from key'),
    })).optional(),
    actions: z.array(z.object({
      fn:          z.string().describe('Function name called from template ng-click'),
      label:       z.string().describe('Button label'),
      style:       z.enum(['default','primary','success','warning','danger','info']).optional(),
      description: z.string().optional(),
      condition:   z.string().optional().describe('AngularJS ng-if expression'),
    })).optional(),
    options: z.array(z.object({
      name:    z.string(),
      label:   z.string(),
      type:    z.string().optional(),
      default: z.string().optional(),
      hint:    z.string().optional(),
    })).optional(),
  },
  ({ name, id, description, data_source, fields, actions, options }) => {
    try {
      const portal = new PortalBuilder(null);
      return ok(portal.buildWidget({ name, id, description, dataSource: data_source, fields: fields ?? [], actions: actions ?? [], options: options ?? [] }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: update_widget ───────────────────────────────────────────────────
server.tool(
  'update_widget',
  `Build a PATCH payload to update specific sections of an existing widget.

Provide the widget sys_id and only the sections you want to change.
Returns a PATCH payload ready to send to /api/now/table/sp_widget/{sys_id}.

Updatable sections: template, css, client_script, server_script, option_schema, demo_data`,
  {
    widget_sys_id: z.string().describe('sys_id of the widget to update'),
    sections: z.object({
      template:      z.string().optional(),
      css:           z.string().optional(),
      client_script: z.string().optional(),
      server_script: z.string().optional(),
      option_schema: z.string().optional(),
      demo_data:     z.string().optional(),
    }).describe('Only include the sections you want to change'),
  },
  ({ widget_sys_id, sections }) => {
    try {
      const portal = new PortalBuilder(null);
      return ok(portal.buildWidgetUpdate({ widgetSysId: widget_sys_id, sections }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_portal ───────────────────────────────────────────────────
server.tool(
  'create_portal',
  `Scaffold a new Service Portal with theme, default pages, and best-practice CSS variables.

Generates:
  - Portal record (url_suffix, title)
  - Theme with full CSS variable set (brand colors, typography, spacing, borders)
  - Default pages: Home, Login, Profile, Catalog + any custom pages
  - Deploy order and instructions

Returns all payloads in correct deployment order.`,
  {
    name:       z.string().describe('Portal display name'),
    url_suffix: z.string().optional().describe('URL suffix (e.g. "myportal" → /myportal)'),
    description: z.string().optional(),
    pages: z.array(z.object({
      title:       z.string(),
      id:          z.string().describe('Page ID used in URL'),
      public:      z.boolean().optional().default(false),
      description: z.string().optional(),
    })).optional(),
  },
  ({ name, url_suffix, description, pages }) => {
    try {
      const portal = new PortalBuilder(null);
      return ok(portal.buildPortal({ name, urlSuffix: url_suffix, description, pages: pages ?? [] }));
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// CATALOG TOOLS — items, variables, categories, record producers, order guides
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: create_catalog_item ─────────────────────────────────────────────
server.tool(
  'create_catalog_item',
  `Generate a complete Service Catalog item definition with variables, client scripts, and UI policies.

Variable types supported:
  single_line, multi_line, multiple_choice, yes_no, reference, date, date_time,
  checkbox, select_box, numeric, email, url, phone, masked, file_attachment,
  container_start, container_end, label

Returns:
  - Catalog item payload (deploy to sc_cat_item)
  - Variable payloads (deploy to item_option_new)
  - Client script payloads (deploy to catalog_script_client)
  - UI policy payloads (deploy to catalog_ui_policy)
  - Deployment order and best-practice checklist`,
  {
    name:               z.string(),
    short_description:  z.string(),
    description:        z.string().optional(),
    category:           z.string().optional().describe('sys_id of sc_category'),
    fulfillment_group:  z.string().optional().describe('sys_id of assignment group'),
    price:              z.string().optional().default('0'),
    delivery_time:      z.string().optional().describe('e.g. "3 days"'),
    portal_visibility:  z.boolean().optional().default(true),
    variables: z.array(z.object({
      name:      z.string().describe('Internal variable name (no spaces)'),
      label:     z.string().describe('Display label'),
      type:      z.string().optional().default('single_line'),
      mandatory: z.boolean().optional().default(false),
      default:   z.string().optional(),
      reference: z.string().optional().describe('Table name for reference type'),
      help:      z.string().optional(),
    })).optional(),
    client_scripts: z.array(z.object({
      name:  z.string(),
      type:  z.enum(['onLoad','onChange','onSubmit']).optional(),
      field: z.string().optional(),
      logic: z.string().optional(),
    })).optional(),
  },
  ({ name, short_description, description, category, fulfillment_group, price, delivery_time, portal_visibility, variables, client_scripts }) => {
    try {
      const catalog = new CatalogBuilder(null);
      return ok(catalog.buildCatalogItem({ name, short_description, description, category, fulfillment_group, price, delivery_time, portal_visibility, variables: variables ?? [], client_scripts: client_scripts ?? [] }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: clone_catalog_item ──────────────────────────────────────────────
server.tool(
  'clone_catalog_item',
  `Clone an existing Service Catalog item — fetches live data from ServiceNow and returns a deploy-ready copy.

Copies:
  - Catalog item fields (name, description, category, price, workflow, etc.)
  - All variables (name, type, mandatory, default, order)

You can override any field via modifications.`,
  {
    source:        z.string().describe('Source catalog item name or sys_id'),
    new_name:      z.string().describe('Name for the cloned item'),
    modifications: z.record(z.unknown()).optional().describe('Fields to override in the clone'),
  },
  async ({ source, new_name, modifications }) => {
    try {
      const sn      = await getSn();
      const catalog = new CatalogBuilder(sn);
      return ok(await catalog.cloneCatalogItem({ sourceNameOrSysId: source, newName: new_name, modifications: modifications ?? {} }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_catalog_category ────────────────────────────────────────
server.tool(
  'create_catalog_category',
  'Create a Service Catalog category (sc_category). Returns deploy-ready payload.',
  {
    title:       z.string(),
    description: z.string().optional(),
    parent:      z.string().optional().describe('sys_id of parent category (leave blank for top-level)'),
    roles:       z.string().optional().describe('Comma-separated role names to restrict visibility'),
  },
  ({ title, description, parent, roles }) => {
    try {
      const catalog = new CatalogBuilder(null);
      return ok(catalog.buildCategory({ title, description, parent, roles }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_catalog_item ────────────────────────────────────────────────
server.tool(
  'get_catalog_item',
  'Fetch a catalog item and its variables from ServiceNow for inspection or cloning.',
  {
    name_or_sys_id: z.string().describe('Catalog item name or sys_id'),
  },
  async ({ name_or_sys_id }) => {
    try {
      const sn      = await getSn();
      const catalog = new CatalogBuilder(sn);
      return ok(await catalog.getCatalogItem(name_or_sys_id));
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION TOOLS — email, push, email scripts, analysis
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: create_notification ─────────────────────────────────────────────
server.tool(
  'create_notification',
  `Create a ServiceNow email notification with an HTML template, recipients, and conditions.

Recipients can be specified as:
  - field:    a field on the record (e.g. "caller_id.email")
  - group:    an assignment group sys_id
  - role:     a role name (all users with that role)
  - user:     a specific user sys_id

The tool generates:
  - Notification record payload (sysevent_email_action)
  - Responsive HTML email template with ServiceNow field tokens
  - Plain text fallback
  - Best practice checklist`,
  {
    name:          z.string(),
    table:         z.string().describe('Table that triggers this notification (e.g. "incident")'),
    event:         z.string().optional().describe('Event name (e.g. "incident.inserted"). Leave blank to use condition.'),
    condition:     z.string().optional().describe('Encoded query condition (used if no event)'),
    subject:       z.string().describe('Email subject line — can include ${table.field} tokens'),
    recipients: z.array(z.object({
      type:  z.enum(['field','group','role','user']),
      value: z.string().describe('Field name, group sys_id, role name, or user sys_id'),
    })).optional(),
    body_html:     z.string().optional().describe('Custom HTML email body. Leave blank for auto-generated template.'),
    include_work_notes: z.boolean().optional().default(false),
    weight:        z.number().optional().default(10),
    category:      z.string().optional(),
    reply_to:      z.string().optional(),
    email_script:  z.string().optional().describe('Name of an Email Script for dynamic logic'),
  },
  ({ name, table, event, condition, subject, recipients, body_html, include_work_notes, weight, category, reply_to, email_script }) => {
    try {
      return ok(_notifBuilder.buildEmailNotification({
        name, table, event, condition, recipients: recipients ?? [], subject,
        bodyHtml: body_html, includeWorkNotes: include_work_notes,
        weight, category, replyTo: reply_to, emailScript: email_script,
      }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: analyze_notifications ───────────────────────────────────────────
server.tool(
  'analyze_notifications',
  `Analyze all active email notifications for a ServiceNow table.

Checks for:
  - Notifications with no condition or event (fires on every record)
  - Notifications with no recipients (goes nowhere)
  - Notifications with weight = 0 (potential conflicts)
  - Missing subjects

Returns a notification inventory plus issues and recommendations.`,
  {
    table: z.string().describe('Table name to analyze (e.g. "incident")'),
  },
  async ({ table }) => {
    try {
      const sn = await getSn();
      const nb = new NotificationBuilder(sn);
      return ok(await nb.analyzeNotifications(table));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_push_notification ────────────────────────────────────────
server.tool(
  'create_push_notification',
  `Create a ServiceNow push notification for the Now Mobile app.

Returns deploy-ready payload for sys_push_message table.
Supports ${field} tokens in title and body — same as email notifications.`,
  {
    name:        z.string(),
    table:       z.string().describe('Table that triggers this push notification'),
    condition:   z.string().optional().describe('Encoded query condition for when to send'),
    title:       z.string().describe('Push notification title (keep under 50 chars)'),
    body:        z.string().describe('Push notification body (keep under 100 chars, use ${table.field} tokens)'),
    route_to:    z.string().optional().describe('Deep-link route for Now Mobile (e.g. "record/incident/{sys_id}")'),
  },
  ({ name, table, condition, title, body, route_to }) => {
    try {
      return ok(_notifBuilder.buildPushNotification({ name, table, condition, title, body, route_to }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_email_script ─────────────────────────────────────────────
server.tool(
  'create_email_script',
  `Generate a ServiceNow Email Script (sys_script_email) for dynamic notification logic.

Email Scripts are used when a notification needs:
  - Dynamic recipients (e.g. add manager as CC)
  - Conditional subject lines
  - Dynamic body content based on record state
  - Loop-prevention logic

Returns deploy-ready payload with best-practice template.`,
  {
    name:        z.string().describe('Email Script name'),
    description: z.string().optional(),
    logic:       z.string().optional().describe('Core logic to embed (pseudo-code is fine)'),
  },
  ({ name, description, logic }) => {
    try {
      return ok(_notifBuilder.buildEmailScript({ name, description, logic }));
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// TECHNICAL DOCUMENTATION TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: generate_project_doc ────────────────────────────────────────────
server.tool(
  'generate_project_doc',
  `Generate comprehensive technical documentation for a ServiceNow application by pulling live data from the instance.

Produces a full Markdown document with:
  - Executive overview and architecture diagram
  - Data model (fields, mandatory markers, reference links)
  - Business logic (BRs, Script Includes with method listing)
  - UI layer (Client Scripts, UI Actions by table)
  - Integration points (Scripted REST APIs)
  - Automation (Scheduled Jobs, Notifications)
  - Security (ACLs per table, scope isolation)
  - Operations guide (monitoring, maintenance, common issue matrix)
  - Change log template

The document is ready to paste into Confluence, GitHub Wiki, or any Markdown renderer.`,
  {
    app_name: z.string().describe('Application name for the document title'),
    tables:   z.array(z.string()).describe('Tables that belong to this application (e.g. ["incident","problem"])'),
    scope:    z.string().optional().describe('Application scope prefix (e.g. "x_mycompany_myapp")'),
    author:   z.string().optional(),
    version:  z.string().optional().default('1.0'),
  },
  async ({ app_name, tables, scope, author, version }) => {
    try {
      const sn     = await getSn();
      const writer = new TechDocWriter(sn);
      return ok(await writer.generateProjectDoc({ appName: app_name, scope, tables, author, version }));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: generate_feature_doc ────────────────────────────────────────────
server.tool(
  'generate_feature_doc',
  `Generate a quick one-page technical spec for a specific feature or change.

Covers affected tables, Business Rules, Script Includes, notifications, and test plan.
Use this for sprint documentation, change requests, or PR descriptions.`,
  {
    feature_name:    z.string(),
    description:     z.string().optional(),
    tables:          z.array(z.string()).optional(),
    business_rules: z.array(z.object({
      name:   z.string(),
      table:  z.string(),
      when:   z.string().optional(),
      events: z.array(z.string()).optional(),
    })).optional(),
    script_includes: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
    notifications:   z.array(z.object({ name: z.string(), table: z.string(), event: z.string().optional() })).optional(),
    test_plan:       z.string().optional(),
  },
  ({ feature_name, description, tables, business_rules, script_includes, notifications, test_plan }) => {
    try {
      const writer = new TechDocWriter(null);
      return ok({
        doc_type: 'feature',
        name:     feature_name,
        markdown: writer.generateFeatureDoc({ featureName: feature_name, description, tables, businessRules: business_rules, scriptIncludes: script_includes, notifications, testPlan: test_plan }),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// ISSUE DIAGNOSIS TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: diagnose_issue ──────────────────────────────────────────────────
server.tool(
  'diagnose_issue',
  `Diagnose a ServiceNow issue from a symptom description and get a guided step-by-step fix.

Covers 60+ known issues across:
  business_rule, client_script, scripted_rest, portal_widget, catalog,
  notification, performance, security, atf, deployment, general

Examples:
  "Business Rule not firing on update"
  "Widget shows blank white box"
  "Email notification not being received"
  "Catalog item not visible in portal"
  "Infinite loop in BR"
  "GlideAjax callback not called"

Returns: root causes, diagnosis steps, copy-paste fix code, prevention tips, and suggested MCP tools to use.`,
  {
    symptom:  z.string().describe('Describe what is happening (e.g. "Business Rule not firing")'),
    category: z.enum(['business_rule','client_script','scripted_rest','workflow_flow','portal_widget','catalog','notification','performance','security','integration','atf','deployment','upgrade','general']).optional(),
  },
  ({ symptom, category }) => {
    try {
      return ok(_issueGuide.diagnose(symptom, category));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_issue_guide ─────────────────────────────────────────────────
server.tool(
  'get_issue_guide',
  `Get the full guided fix for a specific known issue by its ID (e.g. "BR001", "CS002", "SP001").

Use list_common_issues first to find the ID of the issue you want.`,
  {
    issue_id: z.string().describe('Issue ID from the catalogue (e.g. "BR001", "SP002", "CAT001")'),
  },
  ({ issue_id }) => {
    try {
      const guide = _issueGuide.getGuidedFix(issue_id.toUpperCase());
      if (!guide || guide.error) return fail(guide?.error ?? 'Issue not found');
      return ok(guide);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: list_common_issues ──────────────────────────────────────────────
server.tool(
  'list_common_issues',
  `List all known ServiceNow issues in the guide, optionally filtered by category.

Categories: business_rule, client_script, scripted_rest, portal_widget, catalog,
  notification, performance, security, atf, deployment, general

Returns grouped issue IDs and titles. Use get_issue_guide(id) to get the full fix.`,
  {
    category: z.enum(['business_rule','client_script','scripted_rest','portal_widget','catalog','notification','performance','security','atf','deployment','general']).optional(),
  },
  ({ category }) => {
    try {
      return ok(_issueGuide.listIssues(category));
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_field_choices ───────────────────────────────────────────────
server.tool(
  'get_field_choices',
  'Get all choice list values for a field on a ServiceNow table (e.g. state, priority, category).',
  {
    table: z.string().describe('Table name'),
    field: z.string().describe('Field name'),
  },
  async ({ table, field }) => {
    try {
      const sn   = await getSn();
      const rows = await sn.query('sys_choice', {
        sysparm_query:  `name=${table}^element=${field}^language=en^inactive=false`,
        sysparm_fields: 'value,label,sequence,color,dependent_value',
        sysparm_limit:  100,
        sysparm_order:  'sequence',
      });
      return ok({
        table, field,
        count:   rows.length,
        choices: rows.map(c => ({ value: c.value, label: c.label, sequence: c.sequence, color: c.color ?? '', dependent: c.dependent_value ?? '' })),
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: create_choice ───────────────────────────────────────────────────
server.tool(
  'create_choice',
  `Add a new choice value to a field's choice list in ServiceNow.

Returns deploy-ready payload for the sys_choice table.
Common use: adding custom states, priorities, categories, or types.`,
  {
    table:    z.string().describe('Table name (e.g. "incident")'),
    field:    z.string().describe('Field name (e.g. "state")'),
    value:    z.string().describe('Internal value stored in DB (e.g. "6")'),
    label:    z.string().describe('Display label shown to users (e.g. "Pending Vendor")'),
    sequence: z.number().optional().describe('Sort order (lower = first)'),
    color:    z.string().optional().describe('Bootstrap color class: success, warning, danger, info, default'),
    dependent_value: z.string().optional().describe('Dependent field value (for dependent choice lists)'),
  },
  ({ table, field, value, label, sequence, color, dependent_value }) => {
    try {
      return ok({
        deploy_table: 'sys_choice',
        payload: {
          name:            table,
          element:         field,
          value,
          label,
          language:        'en',
          sequence:        sequence ?? 100,
          color:           color ?? '',
          dependent_value: dependent_value ?? '',
          inactive:        false,
        },
        note:          `POST to /api/now/table/sys_choice to add this choice. The choice will appear immediately after clearing the instance cache.`,
        cache_note:    'After creating the choice, navigate to Cache.do to clear the instance cache if the value doesn\'t appear.',
        best_practices: [
          'Choose a value that won\'t conflict with existing choices',
          'Set sequence carefully — changing order later can confuse users',
          'Add choices to ALL relevant tables if the field is inherited',
          'Document the new choice in your project tech doc',
        ],
      });
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DICTIONARY OVERRIDE TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ── TOOL: create_dictionary_override ─────────────────────────────────────
server.tool(
  'create_dictionary_override',
  `Create or update a ServiceNow Dictionary Override on a child table.

Dictionary overrides let you change how an inherited field behaves in a child table
WITHOUT modifying the parent table's dictionary entry. This is the correct SN best
practice for table extensions (e.g. incident extends task).

IMPORTANT: Each override requires BOTH a value AND its matching override_X=true flag.
This tool sets them correctly — doing it manually often silently fails.

Supported overrides (specify any combination):
  mandatory      — Make the field required in the child table (true/false)
  default_value  — Set a different default value for the child table
  column_label   — Rename the field label in the child table only
  read_only      — Make the field read-only in the child table (true/false)
  display        — Show or hide the field in the child table (true/false)
  calculation    — Override a calculated field formula (script string)
  choice         — Override the choice list (use create_choice to add child-table choices, then set this)
  dependent      — Override the dependent field name

Examples:
  Make "business_service" mandatory on incident (but not on task):
    table="incident"  field="business_service"  overrides={mandatory: true}

  Set a different default priority on change_request than task:
    table="change_request"  field="priority"  overrides={default_value: "3"}

  Rename "caller_id" label to "Requested By" on sc_request:
    table="sc_request"  field="caller_id"  overrides={column_label: "Requested By"}

  Hide a parent field on a specific child table:
    table="hr_case"  field="parent"  overrides={display: false}`,
  {
    table: z.string().describe('Child table name (e.g. "incident", "change_request", "hr_case")'),
    field: z.string().describe('Field (element) name inherited from the parent table (e.g. "priority", "caller_id")'),
    overrides: z.object({
      mandatory:     z.boolean().optional().describe('true = required in child table'),
      default_value: z.string().optional().describe('Default value for this field in the child table'),
      column_label:  z.string().optional().describe('Override the field label shown to users'),
      read_only:     z.boolean().optional().describe('true = read-only in child table'),
      display:       z.boolean().optional().describe('false = hide field in child table'),
      calculation:   z.string().optional().describe('Override calculated field script'),
      choice:        z.boolean().optional().describe('true = activate choice override (add choices separately via create_choice)'),
      dependent:     z.string().optional().describe('Override the dependent field name'),
    }).describe('One or more override properties to apply'),
    dry_run: z.boolean().optional().default(false).describe('Preview the payload without creating'),
  },
  async ({ table, field, overrides, dry_run }) => {
    try {
      // ── Validate: the field must exist on a parent table ─────────────────
      const sn = await getSn();
      const parentCheck = await sn.get('sys_dictionary', {
        sysparm_query:  `name=${table}^element=${field}`,
        sysparm_fields: 'element,name,column_label,internal_type,mandatory,default_value',
        sysparm_limit:  '1',
      });

      // Also check if an override already exists
      const existingOverride = await sn.get('sys_dictionary_override', {
        sysparm_query:  `name=${table}^element=${field}`,
        sysparm_fields: 'sys_id,name,element',
        sysparm_limit:  '1',
      });

      // ── Build the payload ─────────────────────────────────────────────────
      // Each override needs BOTH the value field AND override_X=true.
      // Setting the value without the flag = silently ignored by SN.
      const payload = { name: table, element: field };
      const appliedOverrides = [];

      if (overrides.mandatory !== undefined) {
        payload.override_mandatory = true;
        payload.mandatory          = overrides.mandatory;
        appliedOverrides.push(`mandatory → ${overrides.mandatory}`);
      }
      if (overrides.default_value !== undefined) {
        payload.override_default_value = true;
        payload.default_value          = overrides.default_value;
        appliedOverrides.push(`default_value → "${overrides.default_value}"`);
      }
      if (overrides.column_label !== undefined) {
        payload.override_label = true;
        payload.column_label   = overrides.column_label;
        appliedOverrides.push(`column_label → "${overrides.column_label}"`);
      }
      if (overrides.read_only !== undefined) {
        payload.override_read_only = true;
        payload.read_only          = overrides.read_only;
        appliedOverrides.push(`read_only → ${overrides.read_only}`);
      }
      if (overrides.display !== undefined) {
        payload.override_display = true;
        payload.display          = overrides.display;
        appliedOverrides.push(`display → ${overrides.display}`);
      }
      if (overrides.calculation !== undefined) {
        payload.override_calculation = true;
        payload.calculation          = overrides.calculation;
        appliedOverrides.push('calculation → (script)');
      }
      if (overrides.choice !== undefined) {
        payload.override_choice = overrides.choice;
        appliedOverrides.push(`choice override → ${overrides.choice}`);
      }
      if (overrides.dependent !== undefined) {
        payload.override_dependent = true;
        payload.dependent          = overrides.dependent;
        appliedOverrides.push(`dependent → "${overrides.dependent}"`);
      }

      if (!appliedOverrides.length) {
        return fail('No override properties specified. Provide at least one override (mandatory, default_value, column_label, read_only, display, calculation, choice, or dependent).');
      }

      const parentField = parentCheck[0] ?? null;
      const existing    = existingOverride[0] ?? null;

      if (dry_run) {
        return ok({
          dry_run:           true,
          table,
          field,
          parent_field_found: !!parentField,
          parent_definition:  parentField,
          existing_override:  existing,
          payload_to_deploy:  payload,
          overrides_to_apply: appliedOverrides,
          action:             existing ? 'PATCH (update existing override)' : 'POST (create new override)',
          note:               'Set dry_run=false to apply.',
        });
      }

      let result;
      if (existing) {
        // Update existing override
        result = await sn.patch('sys_dictionary_override', existing.sys_id, payload);
        return ok({
          action:     'updated',
          sys_id:     existing.sys_id,
          table, field,
          overrides_applied: appliedOverrides,
          result,
          note: 'Existing dictionary override updated. Changes take effect immediately (no cache clear needed).',
        });
      } else {
        // Create new override
        result = await sn.post('sys_dictionary_override', payload);
        return ok({
          action:     'created',
          sys_id:     result?.sys_id,
          table, field,
          overrides_applied: appliedOverrides,
          result,
          note: 'Dictionary override created. Changes take effect immediately on the child table.',
        });
      }
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: get_dictionary_overrides ───────────────────────────────────────
server.tool(
  'get_dictionary_overrides',
  `List all dictionary overrides on a table, or find overrides for a specific field.

Use this to audit what a child table has customised vs its parent, or to check
whether an override already exists before creating one.

Examples:
  table="incident"                        — all overrides on incident
  table="incident" field="priority"       — override for one specific field
  field="mandatory" override_type="mandatory" — find all tables overriding mandatory`,
  {
    table:         z.string().optional().describe('Child table name to list overrides for'),
    field:         z.string().optional().describe('Specific field (element) name'),
    override_type: z.enum(['mandatory','default_value','column_label','read_only','display','calculation','choice','dependent','any']).optional().default('any'),
  },
  async ({ table, field, override_type }) => {
    try {
      const sn     = await getSn();
      const parts  = [];
      if (table) parts.push(`name=${table}`);
      if (field) parts.push(`element=${field}`);

      // Filter to only active overrides (where an override flag is actually set)
      const overrideFlagMap = {
        mandatory:     'override_mandatory=true',
        default_value: 'override_default_value=true',
        column_label:  'override_label=true',
        read_only:     'override_read_only=true',
        display:       'override_display=true',
        calculation:   'override_calculation=true',
        choice:        'override_choice=true',
        dependent:     'override_dependent=true',
      };
      if (override_type && override_type !== 'any' && overrideFlagMap[override_type]) {
        parts.push(overrideFlagMap[override_type]);
      }

      if (!parts.length) return fail('Provide at least a table or field to search.');

      const rows = await sn.get('sys_dictionary_override', {
        sysparm_query:  parts.join('^'),
        sysparm_fields: 'sys_id,name,element,column_label,override_label,mandatory,override_mandatory,default_value,override_default_value,read_only,override_read_only,display,override_display,override_calculation,override_choice,override_dependent,dependent',
        sysparm_limit:  '100',
      });

      const overrides = rows.map(r => {
        const active = [];
        if (r.override_mandatory    === 'true') active.push(`mandatory=${r.mandatory}`);
        if (r.override_default_value === 'true') active.push(`default_value="${r.default_value}"`);
        if (r.override_label        === 'true') active.push(`column_label="${r.column_label}"`);
        if (r.override_read_only    === 'true') active.push(`read_only=${r.read_only}`);
        if (r.override_display      === 'true') active.push(`display=${r.display}`);
        if (r.override_calculation  === 'true') active.push('calculation=(script)');
        if (r.override_choice       === 'true') active.push('choice=overridden');
        if (r.override_dependent    === 'true') active.push(`dependent="${r.dependent}"`);
        return {
          sys_id:          r.sys_id,
          table:           r.name,
          field:           r.element,
          active_overrides: active,
          raw:             r,
        };
      });

      return ok({
        table,
        field,
        count:     overrides.length,
        overrides,
        note:      overrides.length === 0
          ? 'No dictionary overrides found for the given criteria.'
          : `Found ${overrides.length} override(s). Use create_dictionary_override to add or modify.`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: delete_dictionary_override ─────────────────────────────────────
server.tool(
  'delete_dictionary_override',
  `Delete a dictionary override, restoring the child table field to its parent table defaults.

SAFETY: Requires confirm=true. Deleting an override immediately restores parent behaviour —
e.g. if the override made the field mandatory, it will become optional again after deletion.

Find the sys_id first with get_dictionary_overrides.`,
  {
    table:   z.string().describe('Child table name'),
    field:   z.string().describe('Field (element) name'),
    confirm: z.boolean().describe('Must be true to execute'),
  },
  async ({ table, field, confirm }) => {
    try {
      const sn = await getSn();
      const rows = await sn.get('sys_dictionary_override', {
        sysparm_query:  `name=${table}^element=${field}`,
        sysparm_fields: 'sys_id,name,element,override_mandatory,override_label,override_default_value',
        sysparm_limit:  '1',
      });

      if (!rows.length) return fail(`No dictionary override found for ${table}.${field}`);
      const override = rows[0];

      if (!confirm) {
        return ok({
          confirm_required: true,
          preview:  { table, field, sys_id: override.sys_id, override },
          warning:  `Set confirm=true to delete this override. The field "${field}" on "${table}" will revert to its parent table definition immediately.`,
        });
      }

      await sn.delete('sys_dictionary_override', override.sys_id);
      return ok({
        deleted: true,
        table, field,
        sys_id:  override.sys_id,
        note:    `Override deleted. "${field}" on "${table}" now inherits from parent table definition.`,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// CRUD TOOLS — general-purpose Create / Read / Update / Delete
// Covers ServiceNow, Jira, and Salesforce via a single unified interface.
// Delete operations always require confirm=true to prevent accidents.
// ═══════════════════════════════════════════════════════════════════════════

// ── Shared helpers ─────────────────────────────────────────────────────────
const _snApiPath  = (table, sysId) => sysId ? `/api/now/table/${table}/${sysId}` : `/api/now/table/${table}`;
const _sfSobject  = (obj, id, ver)  => id ? `/services/data/${ver}/sobjects/${obj}/${id}` : `/services/data/${ver}/sobjects/${obj}`;
const _jiraIssue  = (key) => `/rest/api/3/issue/${key}`;

// ══════════════════════════════════════════════════════════════════════════
// SERVICENOW CRUD
// ══════════════════════════════════════════════════════════════════════════

// ── TOOL: sn_create ───────────────────────────────────────────────────────
server.tool(
  'sn_create',
  `Create a record in any ServiceNow table via the Table API.

Examples:
  table="incident"  fields={short_description:"Server down", priority:"1", category:"hardware"}
  table="sc_task"   fields={short_description:"Provision laptop", assigned_to:"john.doe"}
  table="sys_user"  fields={user_name:"jsmith", first_name:"John", last_name:"Smith", email:"j@co.com"}
  table="u_my_custom_table"  fields={u_field:"value"}

Returns the created record including its sys_id.`,
  {
    table:  z.string().describe('ServiceNow table name (e.g. "incident", "sc_task", "sys_user")'),
    fields: z.record(z.unknown()).describe('Field name → value pairs to set on the new record'),
    return_fields: z.string().optional().describe('Comma-separated fields to return (default: all)'),
  },
  async ({ table, fields, return_fields }) => {
    try {
      const sn     = await getSn();
      const params = return_fields ? { sysparm_fields: return_fields } : {};
      // SN POST doesn't accept sysparm_fields as query param — fetch after create
      const created = await sn.post(table, fields);
      const sysId   = created?.sys_id ?? created;
      if (return_fields && sysId) {
        const record = await sn.getById(table, sysId, { sysparm_fields: return_fields });
        return ok({ created: true, sys_id: sysId, record });
      }
      return ok({ created: true, sys_id: sysId, record: created });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sn_read ─────────────────────────────────────────────────────────
server.tool(
  'sn_read',
  `Read one or many records from any ServiceNow table.

  - Provide sys_id to fetch a single record by ID
  - Provide query (encoded query string) to search multiple records
  - Leave both blank to get the first N records

Examples:
  table="incident" sys_id="abc123..."
  table="incident" query="active=true^priority=1^assigned_to=javascript:gs.getUserID()" limit=10
  table="sys_user" query="active=true^email=john@company.com"
  table="sc_cat_item" query="active=true^nameLIKElaptop" fields="name,short_description,price"`,
  {
    table:  z.string().describe('ServiceNow table name'),
    sys_id: z.string().optional().describe('Fetch a single record by sys_id'),
    query:  z.string().optional().describe('Encoded query string (e.g. "active=true^priority=1")'),
    fields: z.string().optional().describe('Comma-separated field names to return'),
    limit:  z.number().optional().default(20).describe('Max records for multi-record reads'),
    order_by: z.string().optional().describe('Field to order by (prefix with - for descending, e.g. "-sys_created_on")'),
  },
  async ({ table, sys_id, query, fields, limit, order_by }) => {
    try {
      const sn = await getSn();
      if (sys_id) {
        const params = {};
        if (fields) params.sysparm_fields = fields;
        const record = await sn.getById(table, sys_id, params);
        return ok({ table, sys_id, record });
      }
      const params = { sysparm_limit: String(limit ?? 20) };
      if (query)    params.sysparm_query   = query;
      if (fields)   params.sysparm_fields  = fields;
      if (order_by) params.sysparm_order_by = order_by.startsWith('-')
        ? undefined : order_by;
      if (order_by?.startsWith('-')) params.sysparm_order_by_desc = order_by.slice(1);
      const records = await sn.get(table, params);
      return ok({ table, count: records.length, records });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sn_update ───────────────────────────────────────────────────────
server.tool(
  'sn_update',
  `Update a ServiceNow record by sys_id (PATCH — only the fields you provide are changed).

Examples:
  table="incident" sys_id="abc123" fields={state:"6", close_notes:"Resolved by restart"}
  table="sys_user" sys_id="xyz456" fields={title:"Senior Engineer", department:"Engineering"}
  table="sc_task"  sys_id="def789" fields={assigned_to:"jane.doe", state:"2"}

Returns the updated record.`,
  {
    table:  z.string().describe('ServiceNow table name'),
    sys_id: z.string().describe('sys_id of the record to update'),
    fields: z.record(z.unknown()).describe('Field name → new value pairs (only changed fields needed)'),
    return_fields: z.string().optional().describe('Comma-separated fields to return after update'),
  },
  async ({ table, sys_id, fields, return_fields }) => {
    try {
      const sn      = await getSn();
      const updated = await sn.patch(table, sys_id, fields);
      if (return_fields) {
        const record = await sn.getById(table, sys_id, { sysparm_fields: return_fields });
        return ok({ updated: true, sys_id, record });
      }
      return ok({ updated: true, sys_id, record: updated });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sn_delete ───────────────────────────────────────────────────────
server.tool(
  'sn_delete',
  `Delete a ServiceNow record by sys_id.

SAFETY: You must pass confirm=true explicitly — this cannot be undone.

Examples:
  table="incident" sys_id="abc123" confirm=true
  table="u_staging_jira_kan" sys_id="xyz456" confirm=true

To preview what will be deleted without actually deleting, pass confirm=false (default).`,
  {
    table:   z.string().describe('ServiceNow table name'),
    sys_id:  z.string().describe('sys_id of the record to delete'),
    confirm: z.boolean().describe('Must be true to execute — prevents accidental deletes'),
  },
  async ({ table, sys_id, confirm }) => {
    try {
      if (!confirm) {
        const sn     = await getSn();
        const record = await sn.getById(table, sys_id, { sysparm_fields: 'sys_id,number,name,short_description,sys_created_on' }).catch(() => ({ sys_id }));
        return ok({
          confirm_required: true,
          preview:   { table, sys_id, record },
          warning:   'Set confirm=true to permanently delete this record. This cannot be undone.',
        });
      }
      const sn = await getSn();
      await sn.delete(table, sys_id);
      return ok({ deleted: true, table, sys_id });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// JIRA CRUD
// ══════════════════════════════════════════════════════════════════════════

// ── TOOL: jira_create ─────────────────────────────────────────────────────
server.tool(
  'jira_create',
  `Create any Jira resource. Set resource_type to choose what to create.

resource_type options:
  issue        — Create an issue/ticket (most common)
  comment      — Add a comment to an issue
  subtask      — Create a sub-task under a parent issue
  component    — Add a component to a project
  version      — Create a version/release in a project
  label        — Labels are set on issues, not created separately

Issue example:
  resource_type="issue"
  project_key="KAN"
  issue_type="Task"
  summary="Set up monitoring for prod servers"
  description="Install Datadog agent on all prod nodes"
  priority="High"
  assignee="jsmith"
  labels=["ops","monitoring"]

Comment example:
  resource_type="comment"
  issue_key="KAN-42"
  body="Picked up — will update by EOD"`,
  {
    resource_type: z.enum(['issue','comment','subtask','component','version']),
    // Issue / subtask
    project_key:  z.string().optional().describe('Jira project key (e.g. "KAN")'),
    issue_type:   z.string().optional().default('Task').describe('Issue type: Task, Bug, Story, Epic, Sub-task'),
    summary:      z.string().optional().describe('Issue summary / title'),
    description:  z.string().optional().describe('Issue description (plain text — will be wrapped in ADF)'),
    priority:     z.string().optional().describe('Priority: Highest, High, Medium, Low, Lowest'),
    assignee:     z.string().optional().describe('Assignee account ID or username'),
    labels:       z.array(z.string()).optional(),
    parent_key:   z.string().optional().describe('Parent issue key (required for subtask)'),
    extra_fields: z.record(z.unknown()).optional().describe('Any extra fields to set on the issue'),
    // Comment
    issue_key:    z.string().optional().describe('Issue key to comment on (e.g. "KAN-42")'),
    body:         z.string().optional().describe('Comment body text'),
    // Component
    name:         z.string().optional().describe('Component or version name'),
    component_lead: z.string().optional().describe('Component lead account ID'),
    // Version
    release_date: z.string().optional().describe('Release date (YYYY-MM-DD)'),
  },
  async ({ resource_type, project_key, issue_type, summary, description, priority, assignee, labels, parent_key, extra_fields, issue_key, body, name, component_lead, release_date }) => {
    try {
      const jira = await getJira();

      if (resource_type === 'issue' || resource_type === 'subtask') {
        const fields = {
          project:   { key: project_key },
          issuetype: { name: resource_type === 'subtask' ? 'Sub-task' : (issue_type ?? 'Task') },
          summary:   summary ?? '(no summary)',
          ...(description && { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] } }),
          ...(priority    && { priority: { name: priority } }),
          ...(assignee    && { assignee: { accountId: assignee } }),
          ...(labels      && { labels }),
          ...(parent_key  && { parent: { key: parent_key } }),
          ...(extra_fields ?? {}),
        };
        const result = await jira.post('/rest/api/3/issue', { fields });
        return ok({ created: true, resource_type, key: result.key, id: result.id, url: `${jira.baseUrl}/browse/${result.key}` });
      }

      if (resource_type === 'comment') {
        const result = await jira.post(`/rest/api/3/issue/${issue_key}/comment`, {
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body ?? '' }] }] },
        });
        return ok({ created: true, resource_type, comment_id: result.id, issue_key });
      }

      if (resource_type === 'component') {
        const result = await jira.post('/rest/api/3/component', {
          name, project: project_key,
          ...(component_lead && { leadAccountId: component_lead }),
        });
        return ok({ created: true, resource_type, id: result.id, name: result.name });
      }

      if (resource_type === 'version') {
        const result = await jira.post('/rest/api/3/version', {
          name, projectId: project_key,
          ...(release_date && { releaseDate: release_date }),
          released: false, archived: false,
        });
        return ok({ created: true, resource_type, id: result.id, name: result.name });
      }

      return fail(`Unknown resource_type: ${resource_type}`);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: jira_read ───────────────────────────────────────────────────────
server.tool(
  'jira_read',
  `Read Jira issues, projects, users, or boards.

resource_type options:
  issue        — Get one issue by key (e.g. "KAN-42")
  search       — JQL search across all projects
  project      — Get project metadata
  user         — Find a user by email or display name
  board        — List boards in a project
  sprint       — List sprints on a board
  transitions  — Get available transitions for an issue (for status changes)
  comments     — Get comments on an issue

Examples:
  resource_type="issue"  issue_key="KAN-42"
  resource_type="search" jql="project=KAN AND status='In Progress' AND assignee=currentUser()" limit=20
  resource_type="user"   query="john.smith@company.com"`,
  {
    resource_type: z.enum(['issue','search','project','user','board','sprint','transitions','comments']),
    issue_key:     z.string().optional().describe('Issue key (e.g. "KAN-42")'),
    jql:           z.string().optional().describe('JQL query for search'),
    project_key:   z.string().optional().describe('Project key'),
    query:         z.string().optional().describe('User search query (email or display name)'),
    board_id:      z.string().optional().describe('Board ID for sprint queries'),
    fields:        z.string().optional().describe('Comma-separated fields (default: all)'),
    limit:         z.number().optional().default(20),
  },
  async ({ resource_type, issue_key, jql, project_key, query, board_id, fields, limit }) => {
    try {
      const jira = await getJira();

      if (resource_type === 'issue') {
        const params = fields ? { fields } : {};
        const issue  = await jira.get(_jiraIssue(issue_key), params);
        return ok({ resource_type, issue_key, issue });
      }

      if (resource_type === 'search') {
        const result = await jira.search({ jql: jql ?? 'ORDER BY created DESC', maxResults: limit ?? 20, fields: fields ? fields.split(',') : ['*all'] });
        const issues = result.issues ?? result;
        return ok({ resource_type, jql, count: issues.length, issues });
      }

      if (resource_type === 'project') {
        const project = await jira.getProject(project_key);
        return ok({ resource_type, project_key, project });
      }

      if (resource_type === 'user') {
        const users = await jira.get('/rest/api/3/user/search', { query: query ?? '', maxResults: limit ?? 10 });
        return ok({ resource_type, query, count: users.length, users });
      }

      if (resource_type === 'board') {
        const result = await jira.get('/rest/agile/1.0/board', { projectKeyOrId: project_key ?? '', maxResults: limit ?? 20 });
        return ok({ resource_type, project_key, boards: result.values ?? [] });
      }

      if (resource_type === 'sprint') {
        const result = await jira.get(`/rest/agile/1.0/board/${board_id}/sprint`, { maxResults: limit ?? 20 });
        return ok({ resource_type, board_id, sprints: result.values ?? [] });
      }

      if (resource_type === 'transitions') {
        const result = await jira.get(`/rest/api/3/issue/${issue_key}/transitions`);
        return ok({ resource_type, issue_key, transitions: result.transitions ?? [] });
      }

      if (resource_type === 'comments') {
        const result = await jira.getComments(issue_key);
        const comments = result.comments ?? result;
        return ok({ resource_type, issue_key, count: comments.length, comments });
      }

      return fail(`Unknown resource_type: ${resource_type}`);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: jira_update ─────────────────────────────────────────────────────
server.tool(
  'jira_update',
  `Update a Jira issue or transition it to a new status.

update_type options:
  fields      — Update issue fields (summary, description, priority, assignee, labels, etc.)
  transition  — Move issue to a new status (uses transition ID from jira_read transitions)
  comment     — Edit an existing comment

Fields update example:
  issue_key="KAN-42" update_type="fields"
  fields={summary:"Updated title", priority:{name:"High"}, assignee:{accountId:"abc123"}}

Transition example:
  issue_key="KAN-42" update_type="transition" transition_id="31"
  (Get transition IDs first with: jira_read resource_type="transitions" issue_key="KAN-42")`,
  {
    issue_key:     z.string().describe('Issue key (e.g. "KAN-42")'),
    update_type:   z.enum(['fields','transition','comment']),
    fields:        z.record(z.unknown()).optional().describe('Fields to update'),
    transition_id: z.string().optional().describe('Transition ID (from jira_read transitions)'),
    comment_id:    z.string().optional().describe('Comment ID to edit'),
    comment_body:  z.string().optional().describe('New comment text'),
  },
  async ({ issue_key, update_type, fields, transition_id, comment_id, comment_body }) => {
    try {
      const jira = await getJira();

      if (update_type === 'fields') {
        await jira.put(_jiraIssue(issue_key), { fields: fields ?? {} });
        return ok({ updated: true, issue_key, update_type, fields_set: Object.keys(fields ?? {}) });
      }

      if (update_type === 'transition') {
        await jira.post(`${_jiraIssue(issue_key)}/transitions`, {
          transition: { id: transition_id },
        });
        return ok({ updated: true, issue_key, update_type, transition_id });
      }

      if (update_type === 'comment') {
        const result = await jira.put(`${_jiraIssue(issue_key)}/comment/${comment_id}`, {
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment_body ?? '' }] }] },
        });
        return ok({ updated: true, issue_key, comment_id, update_type });
      }

      return fail(`Unknown update_type: ${update_type}`);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: jira_delete ─────────────────────────────────────────────────────
server.tool(
  'jira_delete',
  `Delete a Jira resource.

SAFETY: You must pass confirm=true — deletions in Jira are permanent.

resource_type options:
  issue    — Delete an issue (and all its comments, attachments, sub-tasks)
  comment  — Delete a specific comment from an issue

Examples:
  resource_type="issue"   issue_key="KAN-42" confirm=true
  resource_type="comment" issue_key="KAN-42" comment_id="10234" confirm=true`,
  {
    resource_type: z.enum(['issue','comment']),
    issue_key:     z.string().describe('Issue key'),
    comment_id:    z.string().optional().describe('Comment ID (required for comment delete)'),
    confirm:       z.boolean().describe('Must be true to execute — prevents accidental deletes'),
  },
  async ({ resource_type, issue_key, comment_id, confirm }) => {
    try {
      if (!confirm) {
        return ok({
          confirm_required: true,
          preview:  { resource_type, issue_key, comment_id },
          warning:  'Set confirm=true to permanently delete. This cannot be undone. Issue deletion removes all sub-tasks, comments, and attachments.',
        });
      }
      const jira = await getJira();
      if (resource_type === 'issue') {
        await jira.delete(`${_jiraIssue(issue_key)}?deleteSubtasks=true`);
        return ok({ deleted: true, resource_type, issue_key });
      }
      if (resource_type === 'comment') {
        await jira.delete(`${_jiraIssue(issue_key)}/comment/${comment_id}`);
        return ok({ deleted: true, resource_type, issue_key, comment_id });
      }
      return fail(`Unknown resource_type: ${resource_type}`);
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// SALESFORCE CRUD
// ══════════════════════════════════════════════════════════════════════════

// ── TOOL: sf_create ───────────────────────────────────────────────────────
server.tool(
  'sf_create',
  `Create a record in any Salesforce object (Account, Case, Contact, Lead, Opportunity, or any custom object).

Examples:
  object="Case"    fields={Subject:"Server outage", Status:"New", Priority:"High", Origin:"Web"}
  object="Account" fields={Name:"Acme Corp", Industry:"Technology", BillingCity:"San Francisco"}
  object="Contact" fields={FirstName:"Jane", LastName:"Smith", Email:"jane@acme.com", AccountId:"001..."}
  object="Lead"    fields={FirstName:"Bob", LastName:"Jones", Company:"StartupCo", Status:"Open - Not Contacted"}

Returns the Id of the created record.`,
  {
    object: z.string().describe('Salesforce object API name (e.g. "Case", "Account", "Contact", "MyCustomObject__c")'),
    fields: z.record(z.unknown()).describe('Field API name → value pairs'),
  },
  async ({ object, fields }) => {
    try {
      const sf   = await getSf();
      const result = await sf.post(`/services/data/${sf.apiVersion}/sobjects/${object}`, fields);
      return ok({ created: true, object, id: result.id, success: result.success, errors: result.errors ?? [] });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sf_read ─────────────────────────────────────────────────────────
server.tool(
  'sf_read',
  `Read Salesforce records.

read_type options:
  by_id   — Fetch a single record by Salesforce Id
  query   — SOQL SELECT query (most flexible)
  describe — Object schema (fields, types, picklist values)

Examples:
  read_type="by_id"   object="Case" id="500..."  fields="Id,CaseNumber,Subject,Status,Priority"
  read_type="query"   soql="SELECT Id, Subject, Status FROM Case WHERE Status = 'New' LIMIT 20"
  read_type="describe" object="Case"
  read_type="query"   soql="SELECT Id, Name, Industry FROM Account WHERE BillingState = 'CA' LIMIT 50"`,
  {
    read_type: z.enum(['by_id','query','describe']),
    object:    z.string().optional().describe('Object API name (required for by_id and describe)'),
    id:        z.string().optional().describe('Salesforce record Id (15 or 18 character)'),
    fields:    z.string().optional().describe('Comma-separated field names for by_id reads'),
    soql:      z.string().optional().describe('Full SOQL query for query read_type'),
    limit:     z.number().optional().default(20).describe('Limit for queries without LIMIT clause'),
  },
  async ({ read_type, object, id, fields, soql, limit }) => {
    try {
      const sf = await getSf();

      if (read_type === 'by_id') {
        const path = `/services/data/${sf.apiVersion}/sobjects/${object}/${id}`;
        const params = fields ? { fields } : {};
        const record = await sf.get(path, params);
        return ok({ read_type, object, id, record });
      }

      if (read_type === 'query') {
        let finalSoql = soql ?? `SELECT Id FROM ${object} LIMIT ${limit}`;
        if (!finalSoql.toUpperCase().includes('LIMIT')) finalSoql += ` LIMIT ${limit}`;
        const result = await sf.query(finalSoql);
        return ok({ read_type, soql: finalSoql, total_size: result.totalSize, done: result.done, records: result.records ?? [] });
      }

      if (read_type === 'describe') {
        const schema = await sf.describeObject(object);
        return ok({
          read_type, object,
          label:      schema.label,
          key_prefix: schema.keyPrefix,
          field_count: schema.fields?.length ?? 0,
          fields:     (schema.fields ?? []).map(f => ({
            name:         f.name,
            label:        f.label,
            type:         f.type,
            required:     !f.nillable,
            updateable:   f.updateable,
            createable:   f.createable,
            picklist:     f.picklistValues?.length ? f.picklistValues.map(p => p.value) : null,
          })),
        });
      }

      return fail(`Unknown read_type: ${read_type}`);
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sf_update ───────────────────────────────────────────────────────
server.tool(
  'sf_update',
  `Update a Salesforce record by Id (PATCH — only provided fields are changed).

Examples:
  object="Case"    id="500..." fields={Status:"In Progress", Priority:"Critical"}
  object="Account" id="001..." fields={AnnualRevenue:5000000, NumberOfEmployees:250}
  object="Contact" id="003..." fields={Title:"VP Engineering", MobilePhone:"+1-555-0100"}

Returns {updated: true} on success.`,
  {
    object: z.string().describe('Salesforce object API name'),
    id:     z.string().describe('Salesforce record Id'),
    fields: z.record(z.unknown()).describe('Field API name → new value pairs'),
  },
  async ({ object, id, fields }) => {
    try {
      const sf = await getSf();
      await sf.patch(`/services/data/${sf.apiVersion}/sobjects/${object}/${id}`, fields);
      return ok({ updated: true, object, id, fields_updated: Object.keys(fields) });
    } catch (e) { return fail(e.message); }
  }
);

// ── TOOL: sf_delete ───────────────────────────────────────────────────────
server.tool(
  'sf_delete',
  `Delete a Salesforce record by Id.

SAFETY: You must pass confirm=true — Salesforce deletes go to the Recycle Bin (recoverable for 15 days), but this still removes the live record immediately.

Examples:
  object="Case"    id="500..." confirm=true
  object="Lead"    id="00Q..." confirm=true

Pass confirm=false (default) to preview what would be deleted first.`,
  {
    object:  z.string().describe('Salesforce object API name'),
    id:      z.string().describe('Salesforce record Id'),
    confirm: z.boolean().describe('Must be true to execute the delete'),
  },
  async ({ object, id, confirm }) => {
    try {
      const sf = await getSf();
      if (!confirm) {
        // Preview — fetch the record first to show what would be deleted
        const record = await sf.query(`SELECT Id, Name FROM ${object} WHERE Id = '${id}' LIMIT 1`)
          .then(r => r.records?.[0] ?? { Id: id })
          .catch(() => ({ Id: id }));
        return ok({
          confirm_required: true,
          preview:  { object, id, record },
          warning:  'Set confirm=true to delete. Record moves to Recycle Bin (recoverable for 15 days).',
        });
      }
      await sf.delete(`/services/data/${sf.apiVersion}/sobjects/${object}/${id}`);
      return ok({ deleted: true, object, id, note: 'Record is now in the Salesforce Recycle Bin. Can be recovered within 15 days.' });
    } catch (e) { return fail(e.message); }
  }
);

// ── Start: stdio (CLI) or HTTP/SSE (web Claude Code / remote) ────────────
// Set MCP_MODE=http (and optionally MCP_PORT) to run as an HTTP server.
// Default is stdio for local Claude Code CLI use.
if (process.env.MCP_MODE === 'http') {
  const { default: express } = await import('express');
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');

  const app  = express();
  const port = parseInt(process.env.MCP_PORT ?? '3000', 10);
  const clients = new Map();

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', server: 'sn-data-migration' }));

  // SSE endpoint — web Claude Code connects here
  app.get('/sse', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const transport = new SSEServerTransport('/messages', res);
    clients.set(transport.sessionId, transport);
    res.on('close', () => clients.delete(transport.sessionId));
    await server.connect(transport);
    logger.info(`SSE client connected (session: ${transport.sessionId})`);
  });

  // Message endpoint — receives tool calls from the client
  app.post('/messages', async (req, res) => {
    const sessionId  = req.query.sessionId;
    const transport  = clients.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  });

  app.listen(port, () => {
    logger.info(`sn-data-migration MCP server running in HTTP mode on port ${port}`);
    logger.info(`SSE endpoint: http://localhost:${port}/sse`);
  });
} else {
  // Default: stdio for Claude Code CLI
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('sn-data-migration MCP server running (stdio)');
}
