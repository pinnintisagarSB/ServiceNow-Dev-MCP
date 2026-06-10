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
import { MigrationRunner }      from './migration/runner.js';
import { FlowRetriever }        from './flows/retriever.js';
import { FlowBuilder }          from './flows/builder.js';
import { logger }               from './utils/logger.js';

// ── Connector cache (reuse within a session) ───────────────────────────────
let _sn   = null;
let _sf   = null;
let _jira = null;

async function getSn()   { return (_sn   ??= await new ServiceNowConnector().init()); }
async function getSf()   { return (_sf   ??= await new SalesforceConnector().connect()); }
async function getJira() { return (_jira ??= await new JiraConnector().connect()); }

// ── Response helpers ───────────────────────────────────────────────────────
const ok  = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });

// ── Server ─────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'sn-data-migration', version: '1.0.0' });

// ══════════════════════════════════════════════════════════════════════════
// TOOL: connect
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'connect',
  `Test connections to one or all platforms.
   Always call this first before any migration or flow work.
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
// TOOL: discover_schema  (Phase 2 → Checkpoint 1)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'discover_schema',
  `Phase 2: Discover and display source (Salesforce/Jira) and ServiceNow target schemas side by side.
   Returns full field lists + auto-suggested staging table definition + field mapping proposals.
   After calling this, STOP and present the schemas to the user for Checkpoint 1 review.
   Ask: (1) Are all needed source fields present? (2) Any fields to exclude? (3) Any corrections?
   Only call build_artifacts after the user explicitly approves.`,
  {
    platform:    z.enum(['salesforce', 'jira']).describe('Source platform'),
    object_name: z.string().describe('Salesforce object (e.g. Account, Contact, Case) or Jira project key (e.g. BUG, PROJ)'),
    sn_table:    z.string().describe('ServiceNow target table name (e.g. core_company, incident, sys_user)'),
  },
  async ({ platform, object_name, sn_table }) => {
    try {
      const sn        = await getSn();
      const discovery = new SchemaDiscovery(sn);
      let sourceFields;

      if (platform === 'salesforce') {
        sourceFields = await discovery.discoverSalesforceSchema(await getSf(), object_name);
      } else {
        sourceFields = await discovery.discoverJiraSchema(await getJira(), object_name);
      }

      const snFields   = await discovery.discoverSnSchema(sn_table);
      const stagingDef = discovery.buildStagingDefinition(platform, object_name, sourceFields);
      const mappings   = discovery.suggestMappings(sourceFields, snFields);

      const unmapped   = mappings.filter(m => !m.sn_target).length;
      const autoMapped = mappings.filter(m => m.auto_matched).length;

      return ok({
        checkpoint: 1,
        instructions_for_claude: [
          'Present the source_fields and sn_fields tables to the user side by side.',
          'Show the suggested_mappings highlighting any unmapped fields.',
          'Ask the user: (1) Are all needed source fields present? (2) Any fields to exclude? (3) Any mapping corrections?',
          'Wait for explicit "Approved" before calling build_artifacts.',
        ],
        summary: {
          source_fields_count:   sourceFields.length,
          sn_fields_count:       snFields.length,
          auto_mapped_count:     autoMapped,
          unmapped_count:        unmapped,
          staging_table:         stagingDef.tableName,
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
    platform:    z.enum(['salesforce', 'jira']),
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
  `Phase 5: Push exactly 10 records from source to the SN staging table to validate the transform.
   Only call after Checkpoint 3 (artifacts validated in ServiceNow).
   After this, show results and ask the user to verify the 10 records in ServiceNow (Checkpoint 4).
   Only call run_full_migration if the user explicitly approves.`,
  {
    platform:      z.enum(['salesforce', 'jira']),
    object_name:   z.string(),
    staging_table: z.string().describe('Staging table name returned by build_artifacts'),
    mappings: z.array(z.object({
      staging_field: z.string(),
      source_field:  z.string().optional(),
    })),
    filter: z.string().optional().describe('Optional SOQL WHERE clause or JQL to target specific records'),
  },
  async ({ platform, object_name, staging_table, mappings, filter }) => {
    try {
      const sn     = await getSn();
      const runner = new MigrationRunner(sn);
      const limit  = parseInt(process.env.MIGRATION_TEST_LIMIT ?? '10', 10);
      let records;

      if (platform === 'salesforce') {
        const sf     = await getSf();
        const fields = [...new Set(mappings.map(m => m.source_field).filter(Boolean))].join(',');
        const where  = filter ? ` WHERE ${filter}` : '';
        const result = await sf.query(`SELECT ${fields} FROM ${object_name}${where} LIMIT ${limit}`);
        records = result.records.map(r => {
          const flat = {};
          mappings.forEach(m => { if (m.source_field) flat[m.staging_field] = r[m.source_field] ?? null; });
          return flat;
        });
      } else {
        const jira   = await getJira();
        const jql    = filter ? `project=${object_name} AND ${filter}` : `project=${object_name}`;
        const result = await jira.search({ jql, maxResults: limit });
        records = result.issues.map(JiraConnector.flattenIssue);
      }

      const testResults = await runner.runTestMigration(staging_table, records);

      return ok({
        checkpoint: 4,
        instructions_for_claude: [
          'Show the test results breakdown to the user.',
          `Ask them to open ServiceNow and check the ${staging_table} staging table for the 10 records.`,
          'If there are errors, diagnose and suggest fixes before asking them to approve.',
          'Ask: "Do the 10 test records look correct in ServiceNow? Reply \'Approved — run full migration\' to proceed."',
          'Only call run_full_migration after explicit approval.',
        ],
        records_pushed: records.length,
        results:        testResults.results,
        counts:         testResults.counts,
        staging_table,
      });
    } catch (e) { return fail(e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// TOOL: run_full_migration  (Phase 6)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'run_full_migration',
  `Phase 6: Migrate ALL records from source to ServiceNow via paginated import.
   Only call after explicit user approval at Checkpoint 4.
   Stops immediately on any error and reports what happened — never silently skips errors.`,
  {
    platform:      z.enum(['salesforce', 'jira']),
    object_name:   z.string(),
    staging_table: z.string(),
    mappings: z.array(z.object({
      staging_field: z.string(),
      source_field:  z.string().optional(),
    })),
    filter: z.string().optional().describe('Optional SOQL WHERE clause or JQL to scope the migration'),
  },
  async ({ platform, object_name, staging_table, mappings, filter }) => {
    try {
      const sn     = await getSn();
      const runner = new MigrationRunner(sn);

      const flattenSf = (r) => {
        const flat = {};
        mappings.forEach(m => { if (m.source_field) flat[m.staging_field] = r[m.source_field] ?? null; });
        return flat;
      };

      let result;
      if (platform === 'salesforce') {
        const sf     = await getSf();
        const fields = [...new Set(mappings.map(m => m.source_field).filter(Boolean))].join(',');
        const where  = filter ? ` WHERE ${filter}` : '';
        const iter   = sf.fetchAllRecords(`SELECT ${fields} FROM ${object_name}${where}`);
        result       = await runner.runFullMigration(staging_table, iter, flattenSf);
      } else {
        const jira = await getJira();
        const jql  = filter ? `project=${object_name} AND ${filter}` : `project=${object_name}`;
        const iter = jira.fetchAllIssues(jql);
        result     = await runner.runFullMigration(staging_table, iter, JiraConnector.flattenIssue);
      }

      return ok({
        ...result,
        instructions_for_claude: result.stopped
          ? [
              'Migration stopped due to an error. Show the error details to the user.',
              'Ask: "Resume from where we stopped", "Skip this record and continue", or "Stop here".',
            ]
          : ['Migration complete. Show the final stats to the user.'],
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
          index:        i + 1,
          api_name:     f.ApiName,
          label:        f.Label,
          process_type: f.ProcessType,
          trigger_type: f.TriggerType ?? null,
          manual_only:  f.ProcessType === 'Flow',
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
// TOOL: build_flow  (Phase F5 → Summary)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'build_flow',
  `Phase F5: Create the ServiceNow flow artifacts (sys_hub_flow, variables, trigger, steps).
   Only call after Checkpoint F1 (understanding confirmed) AND Checkpoint F2 (translation plan approved).
   Returns what was automated and what needs manual build in Flow Designer.`,
  {
    flow_api_name:  z.string(),
    sn_table:       z.string(),
    flow_scope:     z.string().optional().describe('Scope prefix e.g. x_mig — flow name becomes scope_ApiName'),
    field_mappings: z.record(z.string()).optional().describe('SF field name → SN field name map'),
    app_scope_id:   z.string().optional().describe('sys_id of the SN scoped app (if using scoped app)'),
  },
  async ({ flow_api_name, sn_table, flow_scope, field_mappings, app_scope_id }) => {
    try {
      const retriever = new FlowRetriever(await getSf());
      const builder   = new FlowBuilder(await getSn());
      const raw       = await retriever.getFlowMetadata(flow_api_name);
      const structure = retriever.parseFlowStructure(raw);

      const result = await builder.build({
        flowStructure:  structure,
        snTableName:    sn_table,
        fieldMappings:  field_mappings ?? {},
        flowScope:      flow_scope ?? null,
        appScopeId:     app_scope_id ?? null,
      });

      return ok({
        instructions_for_claude: [
          'Show the flow build summary to the user.',
          'If there are manual_build_items, present each one with the step-by-step guide.',
          'For Screen Flows, explain what needs to be built as a Service Catalog item in Now Experience.',
          'Ask the user to test the flow in their dev instance before promoting.',
        ],
        result,
        manual_build_items: builder.manualList,
        flow_designer_url:  result.flow?.sys_id
          ? `${(await getSn()).baseUrl}/now/flow-designer/home`
          : null,
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

// ── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('sn-data-migration MCP server running');
