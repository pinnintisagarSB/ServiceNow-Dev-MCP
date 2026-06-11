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
import { DependencyAnalyzer }   from './migration/dependency.js';
import { MigrationValidator }   from './migration/validator.js';
import { BatchMigrationRunner } from './migration/batch.js';
import { MigrationCleanup }     from './migration/cleanup.js';
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
// TOOL: check_migration_state  (run before build_artifacts on any revisit)
// ══════════════════════════════════════════════════════════════════════════
server.tool(
  'check_migration_state',
  `Inspect ServiceNow to see what migration artifacts already exist for a given source→target combination.
   Call this at the very start of any migration session (before build_artifacts) to avoid re-creating things.
   Returns a gap analysis: what exists, what's missing, and what needs to be added.
   Works for ANY source platform and ANY ServiceNow target table.`,
  {
    platform:      z.enum(['salesforce', 'jira']).describe('Source platform'),
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
    object_name: z.string().describe('Salesforce object (e.g. Account, Contact, Case) or Jira project key (e.g. KAN, EMAL)'),
    sn_table:    z.string().describe('ServiceNow target table — any table the user wants (e.g. incident, problem, change_request, cmdb_ci, hr_case, sc_request, core_company)'),
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
    platform:      z.enum(['salesforce', 'jira']),
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
   For Jira: scans all referenced users, checks if they exist in ServiceNow,
   identifies issue type hierarchy (Epic → Story → Task → Subtask), and proposes
   a sequenced migration plan (Tier 1 = parents, Tier 2 = children, etc.).
   Always call this after discover_schema and before build_artifacts.
   If users are missing, ask the user whether to auto-create them in SN.`,
  {
    platform:     z.enum(['salesforce', 'jira']),
    project_keys: z.array(z.string()).describe('Jira project keys to analyse (e.g. ["EMAL","KAN"])'),
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
        return fail('Dependency analysis for Salesforce not yet implemented');
      }

      let usersCreated = [];
      if (auto_create_users && analysis.users.missing.length) {
        usersCreated = await analyzer.createMissingUsers(analysis.users.missing);
      }

      return ok({
        instructions_for_claude: [
          'Show the dependency summary to the user.',
          analysis.users.missing.length && !auto_create_users
            ? 'Tell the user that missing users must exist in SN for assignee/reporter references to resolve. Ask: "Should I auto-create them now?"'
            : 'All users are ready.',
          'Present the migration sequence (Tier 1 → 2 → 3) so the user understands the order.',
          'After user confirms, proceed to build_artifacts.',
        ],
        users: {
          found:   analysis.users.found.map(u => u.email),
          missing: analysis.users.missing,
          created: usersCreated,
        },
        issue_hierarchy: analysis.issueHierarchy,
        migration_sequence: analysis.migrationSequence.map(s => ({
          tier:  s.tier,
          types: s.types,
          count: s.count,
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
    platform:      z.enum(['salesforce', 'jira']),
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

        // Dependency analysis + auto-create missing users
        const analysis = await analyzer.analyze('jira', jira, projectKeys);
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

        // Filter sequence if JQL filter provided
        let sequence = analysis.migrationSequence;
        if (filter) {
          sequence = sequence.map(tier => ({
            ...tier,
            issues: tier.issues.filter(i => {
              // basic project filter support
              return projectKeys.includes(i.fields?.project?.key);
            }),
          })).filter(t => t.issues.length);
        }

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
    platform:      z.enum(['salesforce', 'jira']).describe('Source platform used during setup'),
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
    platform:      z.enum(['salesforce', 'jira']),
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
    platform:       z.enum(['salesforce', 'jira']),
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

// ── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('sn-data-migration MCP server running');
