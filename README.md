# SN Data Migration

MCP server for Claude Code that migrates data and flows from **Salesforce** or **Jira** into **ServiceNow**.

Claude drives the entire process — it asks you questions at each step, waits for your review and approval, and only proceeds when you say so. No manual commands needed.

---

## What it does

**Data migration** (6 phases with checkpoints):
- Discovers source + target schemas side by side
- Auto-suggests staging table + field mappings for your review
- Builds all artifacts in ServiceNow (staging table, transform map, field maps, data source, REST message)
- Runs a 10-record test migration for validation
- Runs the full paginated migration with error handling

**Flow migration** (Salesforce → ServiceNow Flow Designer):
- Lists and retrieves Salesforce flow metadata via Tooling API
- Analyzes trigger, variables, and elements
- Builds the ServiceNow flow automatically where possible
- Produces a manual build guide for Screen Flows and complex elements

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd sn-data-migration
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

| Variable | Required for |
|---|---|
| `SN_INSTANCE_URL` | Always |
| `SN_USERNAME` + `SN_PASSWORD` | ServiceNow basic auth (default) |
| `SF_CLIENT_ID/SECRET/USERNAME/PASSWORD` | Salesforce migrations |
| `JIRA_BASE_URL/EMAIL/API_TOKEN` | Jira migrations |

> **ServiceNow OAuth (optional):** If you use the `@servicenow/sdk`, run `npx @servicenow/sdk auth --add <instance>` and set `SN_USE_SDK_AUTH=true` instead of username/password.

### 3. Register with Claude Code

```bash
claude mcp add sn-migration -- node /absolute/path/to/sn-data-migration/src/mcp-server.js
```

Replace `/absolute/path/to/sn-data-migration` with the actual path where you cloned the repo.

### 4. Restart Claude Code

The `sn-migration` MCP tools will be available in your next session.

---

## Usage

Just tell Claude what you want to do:

```
"Migrate Salesforce Account records to ServiceNow core_company"
"Migrate Jira project BUG to ServiceNow incident table"
"Migrate the Account_Status_Update flow from Salesforce"
"Fetch all P1 incidents from ServiceNow"
```

Claude will call the MCP tools, show you schema comparisons, ask for approvals at each checkpoint, and build everything in your ServiceNow instance.

---

## MCP Tools

| Tool | What it does |
|---|---|
| `connect` | Test connections to SN / Salesforce / Jira |
| `discover_schema` | Pull and compare schemas → **Checkpoint 1** |
| `build_artifacts` | Create staging table, transform map, field maps in SN → **Checkpoint 3** |
| `run_test_migration` | Push 10 records to validate → **Checkpoint 4** |
| `run_full_migration` | Migrate all records with pagination |
| `list_sf_flows` | List available Salesforce flows |
| `analyze_flow` | Parse flow structure and ask clarifying questions → **Checkpoint F1** |
| `build_flow` | Build the flow in SN Flow Designer |
| `fetch_sn_records` | Query any SN table (verify results, check incidents, etc.) |

---

## Adding more source platforms

The architecture is connector-based. To add a new platform (e.g. HubSpot, Azure DevOps):

1. Create `src/connectors/hubspot.js` following the pattern in `salesforce.js`
2. Add auth config to `src/config.js` and `.env.example`
3. Add the platform option to the relevant tools in `src/mcp-server.js`

---

## Requirements

- Node.js 18+
- Claude Code with MCP support
- ServiceNow instance (admin or `import_admin` role for migration artifacts)
- Salesforce Connected App (for Salesforce migrations)
- Jira API token (for Jira migrations)
