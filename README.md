# SN Data Migration — MCP Server

An MCP (Model Context Protocol) server for **Claude Code** that migrates data from **Salesforce** or **Jira** into any **ServiceNow** table. Claude drives the entire workflow — it asks you questions at each step, waits for your review and approval, and only proceeds when you say so. No manual commands or scripts needed.

---

## What it does

### Data migration (any source → any ServiceNow table)

- Checks ServiceNow for existing artifacts before doing anything — skips what's already set up
- Discovers source and target schemas side by side
- Auto-suggests a staging table definition and field mappings for your review
- Builds all ServiceNow artifacts: staging table, columns, transform map, field maps, transform scripts, data source, REST message
- Analyses dependencies before migrating (Jira: users, Epic→Story→Task→Subtask hierarchy)
- Runs a small test migration (configurable sample size) and produces a field-level data quality report
- Runs the full migration in batches with up to 5 parallel import sets
- Cleans up both migrated records and the migration setup itself when needed

### Flow migration (Salesforce → ServiceNow Flow Designer)

- Lists and retrieves Salesforce flow metadata via the Tooling API
- Analyses triggers, variables, and elements
- Builds the ServiceNow flow automatically where possible
- Produces a step-by-step manual build guide for Screen Flows and complex elements

---

## Architecture

```
src/
├── mcp-server.js          # All MCP tools — entry point
├── connectors/
│   ├── servicenow.js      # SN Table API + Import Set API + artifact builders
│   ├── salesforce.js      # SF REST + Tooling API + SOQL pagination
│   └── jira.js            # Jira REST API v3
├── migration/
│   ├── schema.js          # Schema discovery + staging table + mapping suggestions
│   ├── staging.js         # Artifact builder — idempotent, classifies field map vs transform script
│   ├── runner.js          # Test migration + paginated full migration (Salesforce)
│   ├── batch.js           # Parallel batch runner — max 5 import sets, dynamic batch sizing
│   ├── dependency.js      # Jira user/hierarchy analysis, migration sequence planner
│   ├── validator.js       # Source → staging → target field-level data quality report
│   └── cleanup.js         # Delete migrated records and/or migration artifacts
├── flows/
│   ├── retriever.js       # Salesforce flow metadata parser
│   └── builder.js         # ServiceNow flow artifact builder
└── utils/
    ├── logger.js          # Structured console logging
    ├── progress.js        # Plain-English step tracker for non-technical users
    └── sn-auth.js         # ServiceNow auth (basic or SDK OAuth)
```

---

## Requirements

- **Node.js 18+**
- **Claude Code** (CLI, desktop app, or IDE extension) with MCP support
- **ServiceNow** instance — user needs `admin` or `import_admin` role to create staging tables and transform maps
- **Jira** Cloud account + API token (for Jira migrations)
- **Salesforce** Connected App with OAuth credentials (for Salesforce migrations)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/pinnintisagarSB/SN-Migration-Agent.git
cd SN-Migration-Agent
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in your values. The sections below explain each credential.

---

#### ServiceNow credentials

| Variable | Description |
|---|---|
| `SN_INSTANCE_URL` | Full URL of your SN instance, e.g. `https://dev12345.service-now.com` |
| `SN_USERNAME` | ServiceNow username (basic auth) |
| `SN_PASSWORD` | ServiceNow password (basic auth) |
| `SN_USE_SDK_AUTH` | Set `true` to use OAuth via `@servicenow/sdk` instead of username/password |
| `SN_SCOPE_PREFIX` | Table name prefix — `u` for global scope, `x_myapp` for scoped app |

**Basic auth (recommended for most setups):**
```env
SN_INSTANCE_URL=https://yourinstance.service-now.com
SN_USERNAME=admin
SN_PASSWORD=yourpassword
SN_USE_SDK_AUTH=false
SN_SCOPE_PREFIX=u
```

**OAuth via ServiceNow SDK (optional):**
```bash
npx @servicenow/sdk auth --add https://yourinstance.service-now.com
```
Then set `SN_USE_SDK_AUTH=true` and leave `SN_USERNAME` / `SN_PASSWORD` blank.

**Required SN roles:**
- `import_admin` — create staging tables, transform maps, field maps
- `rest_api_explorer` — push records via Import Set REST API

---

#### Jira credentials

Generate an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

```env
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_api_token_here
JIRA_PAGE_SIZE=50
```

---

#### Salesforce credentials

Create a **Connected App** in Salesforce: Setup → App Manager → New Connected App. Enable OAuth and add the `Full access (full)` scope.

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=your_connected_app_consumer_key
SF_CLIENT_SECRET=your_connected_app_consumer_secret
SF_USERNAME=your_sf_username@example.com
SF_PASSWORD=your_sf_password
SF_SECURITY_TOKEN=your_sf_security_token
SF_API_VERSION=v59.0
```

> **Security token:** Reset at Salesforce → My Settings → Personal → Reset My Security Token. Leave it blank if your IP address is whitelisted in Salesforce.

---

#### Migration settings

```env
MIGRATION_TEST_LIMIT=5     # Records to use in the test migration (default: 5)
MIGRATION_PAGE_SIZE=200    # Records per page for Salesforce pagination
LOG_LEVEL=info
```

---

### 3. Register with Claude Code

Run this once from inside the project folder:

```bash
cd SN-Migration-Agent
claude mcp add sn-migration node "$(pwd)/src/mcp-server.js"
```

This registers the server in your local Claude Code config. The server starts automatically whenever Claude Code opens this project.

**Verify the registration:**
```bash
claude mcp list
```

You should see:

```
sn-migration: node /path/to/SN-Migration-Agent/src/mcp-server.js - ✔ Connected
```

### 4. Test the server starts cleanly

```bash
node src/mcp-server.js
```

Expected output:

```
[info]  sn-data-migration MCP server running
```

Press `Ctrl+C` to stop. If you see an error about a missing `.env` variable, open `.env` and fill in the missing value.

### 5. Restart Claude Code

Close and reopen Claude Code (or reload your IDE extension). The `sn-migration` tools will be available in your next session.

**Verify tools are loaded** — type `/mcp` in the Claude Code chat window. You should see `sn-migration` listed with all its tools.

---

## Using the MCP in Claude Code chat

Once registered, just talk to Claude naturally — no commands or tool names needed:

```
can you migrate jira data to servicenow
```

Claude will automatically call `get_config` first, confirm credentials are in place, then walk through the full workflow step by step.

Other example prompts:

```
migrate Jira project KAN to the incident table in ServiceNow
migrate Salesforce Account records to ServiceNow core_company
check if the migration setup already exists before doing anything
run a test migration of 5 records first
clean up all the test records that were created
delete all the migration tables and transform maps
```

> **Tip:** Type `/mcp` at any time to see all available tools and their current status.

---

## Full migration workflow

### Step 1 — Check existing setup

Before building anything, Claude calls `check_migration_state` to scan ServiceNow:

- If all artifacts already exist → Claude skips straight to test migration
- If some are missing → Claude shows the gap and only creates what's needed
- If nothing exists → Claude starts fresh

### Step 2 — Analyse dependencies (Jira only)

`analyze_dependencies` scans the Jira project before any data is moved:

- Finds all users referenced in issues and checks which ones exist in ServiceNow
- If users are missing, offers to create them automatically (required for assignee/reporter fields to resolve correctly)
- Identifies the issue hierarchy (Epic → Story → Task/Bug → Subtask)
- Builds a sequenced migration plan so parent issues always migrate before their children

### Step 3 — Discover schemas

`discover_schema` pulls the source fields and target ServiceNow fields side by side:

- Shows all Jira fields / Salesforce object fields with their types
- Shows all ServiceNow target table fields
- Auto-suggests a staging table name and field mappings
- Highlights unmapped fields and asks for your corrections

**Checkpoint 1:** Review and approve the schema before continuing.

### Step 4 — Build artifacts

`build_artifacts` creates everything in ServiceNow — **only for what doesn't already exist**:

| Artifact | ServiceNow table |
|---|---|
| Staging table | `sys_db_object` |
| Staging columns | `sys_dictionary` |
| Transform map | `sys_transform_map` |
| Field maps | `sys_transform_entry` |
| Transform scripts (complex only) | `sys_transform_script` |
| Data source | `sys_data_source` |
| REST message | `sys_rest_message` |

The builder automatically classifies each mapping:

| Approach | When it's used |
|---|---|
| **Direct** | Plain value copy, no transformation needed |
| **Field map script** | Inline script on the field map (`use_source_script=true`) — picklist, priority, status value translation |
| **Reference** | Resolves a reference field (e.g. `caller_id`) by display value — no script needed |
| **Transform script** | Separate `sys_transform_script` — only when a GlideRecord lookup or multi-field logic is required |

**Checkpoint 3:** Verify the transform map in ServiceNow before pushing data.

### Step 5 — Test migration

`run_test_migration` pushes a small sample (default 5 records) and produces a data quality report:

```
Field-by-Field Data Quality:
Staging Column                  → SN Field                  Staging    Target
─────────────────────────────────────────────────────────────────────────────
u_jira_summary                  → short_description         100% ✓     100% ✓
u_jira_priority                 → priority                  100% ✓     100% ✓
u_jira_assignee                 → assigned_to               80%  ~     80%  ~
u_jira_description              → description               100% ✓     100% ✓
u_jira_environment              → u_environment             0%   ✗  ⚠ BLANK IN STAGING
```

- `BLANK IN STAGING` — data didn't arrive from the source (source mapping issue)
- `BLANK IN TARGET` — data was in staging but didn't reach the target record (transform issue)

**Checkpoint 4:** Review the report, fix any issues, approve the full run.

### Step 6 — Full migration

`run_full_migration` migrates all records with:

- **Dependency ordering** (Jira): Tier 1 (Epic/Story) → Tier 2 (Task/Bug) → Tier 3 (Subtask)
- **Dynamic batch sizing**: total records ÷ 10, clamped to 10–200 per import set
- **Parallel import sets**: up to 5 running concurrently — checks `sys_import_set_run` before each wave
- **Capacity waiting**: if the instance is already at the 5-import-set limit, waits up to 60 seconds and retries
- **Error tracking**: every import set ID is recorded and reported so no batch is missed

---

## Cleanup

### Delete migrated records

`cleanup_migration` removes the records created in the staging table and in the target table (e.g. incidents). Use this to roll back a test run before running the real migration.

```
Delete all the test migration records for project KAN
```

Claude discovers what exists first and shows you the count. You must confirm before anything is deleted.

### Delete all migration artifacts (full reset)

`cleanup_artifacts` removes all the ServiceNow configuration that was created during setup — use this when you want a completely clean slate or need to redo the field mappings from scratch.

Deletes in safe order to avoid dependency errors:

1. Field maps (`sys_transform_entry`)
2. Transform scripts (`sys_transform_script`)
3. Transform map (`sys_transform_map`)
4. Staging column definitions (`sys_dictionary`)
5. Staging table (`sys_db_object`)
6. Data source (`sys_data_source`)
7. REST message (`sys_rest_message`)

```
Delete all the migration tables and transform maps from ServiceNow
```

Same two-phase pattern: Claude shows you exactly what will be deleted, then waits for your explicit confirmation.

---

## MCP Tools reference

| Tool | Phase | What it does |
|---|---|---|
| `check_migration_state` | Start | Scans SN for existing artifacts, returns gap analysis and recommendation |
| `connect` | Start | Tests connections to SN / Salesforce / Jira |
| `discover_schema` | 2 | Pulls source + target schemas side by side, auto-suggests mappings |
| `analyze_dependencies` | 3 | Jira: checks users exist in SN, builds hierarchy + sequenced migration plan |
| `build_artifacts` | 4 | Creates staging table, transform map, field maps in SN (idempotent — skips what exists) |
| `run_test_migration` | 5 | Pushes sample records, returns field-level source→staging→target quality report |
| `run_full_migration` | 6 | Migrates all records in dependency order with parallel batches |
| `analyze_transform_map` | Utility | Audits an existing transform map, flags orphan scripts and issues |
| `fetch_sn_records` | Utility | Queries any SN table — check staging results, verify target records |
| `get_report_data` | Reporting | Returns structured data for a client sign-off Word/Excel document |
| `cleanup_migration` | Cleanup | Deletes migrated staging rows and target records (with confirmation) |
| `cleanup_artifacts` | Cleanup | Deletes all migration setup artifacts — tables, maps, scripts (with confirmation) |
| `list_sf_flows` | Flow F2 | Lists available Salesforce flows with their types |
| `analyze_flow` | Flow F3 | Parses flow structure, asks clarifying questions |
| `build_flow` | Flow F5 | Builds the equivalent flow in SN Flow Designer |

---

## Supported source → target combinations

The server is fully generic — any Jira project or Salesforce object can be migrated to any ServiceNow table:

| Source | Example ServiceNow target tables |
|---|---|
| Jira project | `incident`, `problem`, `change_request`, `hr_case`, `sc_request`, any custom table |
| Salesforce Case | `incident`, `sn_si_incident` |
| Salesforce Account | `core_company`, `customer_account` |
| Salesforce Contact | `sys_user`, `customer_contact` |
| Salesforce Opportunity | Any custom table |

The staging table name is auto-derived from the source (e.g. `u_stg_jira_kan`, `u_stg_sf_account`) but can be overridden with the `staging_table` parameter.

---

## Troubleshooting

**Auth errors with `SN_USE_SDK_AUTH=true`**
OAuth tokens expire. Switch to basic auth: set `SN_USE_SDK_AUTH=false` and fill in `SN_USERNAME` and `SN_PASSWORD`.

**Staging columns are empty after migration**
ServiceNow's Import Set API processes records immediately — staging data is transient and may not persist after the transform runs. Check the target table (e.g. incidents) instead; the data should be there.

**Priority / status always shows a default value**
Check the transform map in ServiceNow (System Import Sets → Transform Maps). Field maps for `priority` and `state` should have `use_source_script=true` with an inline script. Use `analyze_transform_map` to audit.

**`Cannot find package 'dotenv'`**
Run commands from the project root: `cd /path/to/SN-Migration-Agent && node ...`

**Permission denied creating the staging table**
Your SN user needs the `import_admin` role. Ask your ServiceNow admin, or create the table manually: System Definition → Tables → New → set parent to `sys_import_set_row`.

**Jira API returning 410 Gone**
The old `/rest/api/3/search` endpoint is deprecated. This repo already uses `/rest/api/3/search/jql` — make sure you have the latest version.

**ServiceNow at import set limit**
If you see "ServiceNow already has 5 import sets running", wait a few minutes for the existing jobs to finish and try again. The batch runner will also wait automatically during a full migration run.

---

## Adding more source platforms

The connector pattern makes it straightforward to add a new source (e.g. HubSpot, Azure DevOps, ServiceNow-to-ServiceNow):

1. Create `src/connectors/yourplatform.js` — implement `connect()`, a method to list fields, and a pagination/fetch method
2. Add credentials to `.env.example`
3. Add `yourplatform` to the `platform` enum in the relevant tools in `src/mcp-server.js`
4. Add a `discoverYourPlatformSchema()` branch in `src/migration/schema.js`
