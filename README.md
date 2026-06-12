# ServiceNow Dev MCP

> AI-powered ServiceNow developer toolkit for **Claude Code** — 90 tools that help you build, review, test, document, and deploy ServiceNow artifacts faster and with fewer errors.

---

## What is this?

**ServiceNow Dev MCP** is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude Code directly to your ServiceNow instance. Instead of switching between tabs, writing boilerplate from scratch, or Googling best practices, you just describe what you need and Claude handles it end-to-end.

```
"Create a Business Rule that sets priority to Critical when the category is Security"
"Clone the sc-cat-item widget and add a real-time search bar"
"Review this Script Include for performance issues"
"Generate full technical documentation for my HR application"
"My widget is showing a blank white box — help me diagnose it"
```

---

## Capabilities at a glance

| Category | What it does |
|---|---|
| **Script Generation** | Generate Business Rules, Script Includes, Client Scripts, UI Actions, Scripted REST APIs, Scheduled Jobs, Fix Scripts, and Widgets with best practices baked in |
| **Code Review** | Static analysis across 20 rules — anti-patterns, performance, security, null-safety. Scores 0–10 with per-issue fix guidance |
| **Service Portal** | Analyze portals, find/clone/create/update widgets, scaffold new portals with CSS-variable themes |
| **Service Catalog** | Create catalog items with typed variables, client scripts, and UI policies; clone existing items; manage categories and record producers |
| **Notifications** | Build email notifications with responsive HTML templates, push notifications, email scripts, and analyze existing notifications for issues |
| **Table Explorer** | Full schema discovery — fields, Business Rules, Client Scripts, ACLs, relationships, parent hierarchy |
| **ATF Testing** | Generate Automated Test Framework test suites for BRs, Script Includes, REST APIs, forms, and tables |
| **Performance** | Detect slow scripts, missing indexes, Business Rules without conditions, error pattern analysis |
| **Technical Docs** | Generate full project documentation from live SN data (data model, BRs, APIs, security, ops guide) |
| **Issue Diagnosis** | 60+ catalogued issues with step-by-step diagnosis, copy-paste fixes, and prevention tips |
| **Data Migration** | Migrate Jira/Salesforce data into any ServiceNow table with full artifact generation |
| **Bidirectional Integration** | Design and implement SN↔Jira, SN↔Salesforce integrations with Business Rules, Scripted REST, Apex code |

---

## Tool count: 90 tools

<details>
<summary><strong>Developer Productivity (35 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `generate_script` | Generate any SN artifact (BR, SI, CS, UI Action, REST, Scheduled Job, Fix Script, Widget) |
| `review_script` | Code review: 20 rules, score 0–10, per-issue fix guidance |
| `list_review_rules` | Browse all 20 review rules by category |
| `explore_table` | Full schema: fields, BRs, Client Scripts, ACLs, relationships, hierarchy |
| `find_table` | Search tables by keyword |
| `get_table_acls` | All ACL rules for a table |
| `generate_atf_tests` | ATF test suites for BRs, SIs, REST APIs, forms, tables |
| `analyze_performance` | Slow scripts, index gaps, error patterns, BR audit |
| `find_sys_logs` | Search system logs by keyword / source / level |
| `run_background_script` | Create and run Fix Script records (dry_run safe) |
| `generate_docs` | Markdown API docs for SIs, BRs, tables, REST APIs, applications |
| `scaffold_application` | Full app scaffold: table + BRs + SI + UI Actions + ACLs + ATF + docs |
| `health_check_instance` | Instance health score with actionable findings |
| `explain_api` | Explain SN APIs (GlideRecord, GlideAggregate, RESTMessageV2, etc.) |
| `analyze_portal` | Analyze a complete Service Portal (pages, widgets, theme, usage) |
| `find_widget` | Search widgets by name, ID, or keyword |
| `clone_widget` | Clone a widget with modifications (all 4 sections) |
| `create_widget` | Generate a complete widget from a requirement |
| `update_widget` | Build PATCH payload for specific widget sections |
| `create_portal` | Scaffold a new portal with theme and pages |
| `create_catalog_item` | Catalog item with variables, client scripts, UI policies |
| `clone_catalog_item` | Clone a live catalog item from SN |
| `create_catalog_category` | Create a catalog category |
| `get_catalog_item` | Fetch catalog item and variables for inspection |
| `create_notification` | Email notification with responsive HTML template |
| `analyze_notifications` | Analyze and find issues in existing notifications |
| `create_push_notification` | Push notification for Now Mobile |
| `create_email_script` | Dynamic email script (Email Script record) |
| `generate_project_doc` | Full project technical doc from live SN data |
| `generate_feature_doc` | Feature one-pager for sprint/change docs |
| `diagnose_issue` | Diagnose any SN issue from a symptom description |
| `get_issue_guide` | Step-by-step guided fix for a specific known issue |
| `list_common_issues` | Browse 60+ catalogued SN issues by category |
| `get_field_choices` | Get all choice list values for a field |
| `create_choice` | Add a new choice to a field's choice list |

</details>

<details>
<summary><strong>Data Migration (30 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `get_config` | Show current credential/connection status |
| `configure_credentials` | Set per-session credentials (web Claude Code) |
| `connect` | Test connectivity to SN / Jira / Salesforce |
| `check_migration_state` | Scan SN for existing artifacts, return gap analysis |
| `discover_schema` | Pull source + target schemas, auto-suggest mappings |
| `analyze_dependencies` | Jira hierarchy analysis, user mapping, migration sequence |
| `build_artifacts` | Create staging table, transform map, field maps (idempotent) |
| `run_test_migration` | Push sample records, field-level data quality report |
| `run_full_migration` | Full migration in dependency order with parallel batches |
| `map_users` | Map source users to SN users |
| `pre_migration_check` | Pre-flight validation before migration starts |
| `transform_preview` | Preview a transform rule on sample data |
| `convert_rich_text` | Convert Jira ADF / Salesforce HTML to SN HTML |
| `topological_sort` | Dependency-ordered migration sequence |
| `start_audit_session` | Start an audit trail for a migration |
| `get_audit_stats` | Get migration audit statistics |
| `reconcile_migration` | Field-level comparison: source vs SN records |
| `reconcile_staging` | Compare staging vs target (PASS/PARTIAL/FAIL verdict) |
| `migration_test_report` | Full migration test report |
| `fetch_sn_records` | Query any SN table |
| `analyze_transform_map` | Audit an existing transform map |
| `get_report_data` | Structured data for sign-off documents |
| `cleanup_migration` | Delete migrated records (with confirmation) |
| `cleanup_artifacts` | Delete all migration setup artifacts |
| `list_sf_flows` | List Salesforce flows |
| `analyze_flow` | Parse Salesforce flow structure |
| `build_flow` | Build equivalent SN Flow Designer flow |

</details>

<details>
<summary><strong>Bidirectional Integration (25 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `design_integration` | Design a full bidirectional integration plan (SN↔Jira, SN↔SF, SF↔Jira) |
| `create_sn_integration_artifacts` | Create SN Business Rules, Scripted REST APIs, Correlation/Retry tables |
| `create_jira_integration_artifacts` | Create Jira webhooks and automation rules |
| `create_sf_integration_artifacts` | Create Salesforce Apex triggers, Named Credentials, REST callout classes |
| `get_integration_status` | Check sync health and error counts |
| `retry_failed_syncs` | Retry records in the error/dead-letter table |
| `test_integration` | End-to-end integration test |
| `disable_integration` | Pause all syncs (maintenance mode) |
| `enable_integration` | Resume syncs after maintenance |
| `update_field_mappings` | Update field mappings in a live integration |

</details>

---

## Quick start

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

Edit `.env`:

```env
# ServiceNow (required for all tools)
SN_INSTANCE_URL=https://yourinstance.service-now.com
SN_USERNAME=admin
SN_PASSWORD=yourpassword
SN_SCOPE_PREFIX=u

# Jira (required for Jira migration tools)
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_api_token

# Salesforce (required for Salesforce migration/integration tools)
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=your_consumer_key
SF_CLIENT_SECRET=your_consumer_secret
SF_USERNAME=your_sf_username@example.com
SF_PASSWORD=your_sf_password
SF_SECURITY_TOKEN=your_security_token
```

### 3. Register with Claude Code

```bash
claude mcp add sn-dev-mcp node "$(pwd)/src/mcp-server.js"
```

Verify:
```bash
claude mcp list
# sn-dev-mcp: node /path/to/... ✔ Connected
```

### 4. Restart Claude Code

Close and reopen Claude Code. All 90 tools are now available.

---

## Usage examples

### Developer productivity

```
Generate a Business Rule on the incident table that sends a Slack webhook
when priority changes to Critical

Review this Script Include for performance and security issues:
[paste code]

Explore the change_request table — show me all fields, BRs, ACLs, and relationships

Clone the "sc-cat-item" widget and rename it "My Catalog Item" — I want to add
a related items panel below the main content

Create a catalog item for a Laptop Request with these variables:
- Employee name (text, mandatory)
- Laptop model (dropdown: MacBook Pro 14, MacBook Pro 16, Dell XPS 15)
- Justification (multi-line)
- Manager approval needed? (yes/no)

Create a notification for when an incident is assigned to a group —
send to the group manager with the incident number and priority in the subject

My widget shows a blank white box when it loads — diagnose the issue

Generate full technical documentation for our IT Asset application
(tables: u_asset, u_asset_request, u_asset_category)
```

### Data migration

```
Migrate all Jira issues from project KAN to the incident table

Run a test migration of 5 records first and show me the field quality report

Clean up all test records without touching the transform map
```

### Integration

```
Design a bidirectional integration between ServiceNow incidents and Jira issues.
When an incident is put On Hold, create a Jira ticket.
When that ticket is resolved, close the incident.

Create all the ServiceNow artifacts for the SN↔Jira integration
```

---

## Architecture

```
src/
├── mcp-server.js              # 90 MCP tools — single entry point
├── connectors/
│   ├── servicenow.js          # SN Table API, Import Set API, bulk ops
│   ├── salesforce.js          # SF REST + Tooling API + Bulk API 2.0
│   └── jira.js                # Jira REST API v3
├── developer/
│   ├── script-builder.js      # Generate BR, SI, CS, UI Action, REST, Job, Widget
│   ├── code-reviewer.js       # 20-rule static analyser
│   ├── table-explorer.js      # Schema discovery — fields, BRs, ACLs, relationships
│   ├── test-generator.js      # ATF test suite generator
│   ├── perf-analyzer.js       # Slow scripts, indexes, error patterns
│   ├── doc-generator.js       # Markdown API docs per artifact
│   ├── portal-builder.js      # Analyze / clone / create / update SP widgets & portals
│   ├── catalog-builder.js     # Catalog items, variables, categories, record producers
│   ├── notification-builder.js # Email & push notifications, email scripts
│   ├── tech-doc-writer.js     # Full project docs from live SN data
│   └── issue-guide.js         # 60+ issue catalogue with guided fixes
├── migration/
│   ├── schema.js              # Schema discovery + staging + mapping suggestions
│   ├── staging.js             # Artifact builder (idempotent)
│   ├── runner.js              # Migration runner with topo sort + ETA tracker
│   ├── batch.js               # Parallel batch runner + dedup
│   ├── dependency.js          # User/hierarchy analysis
│   ├── validator.js           # Field-level data quality report
│   ├── transform-engine.js    # 15+ transform types with preset mappings
│   ├── reconciler.js          # 3-layer reconciliation (PASS/PARTIAL/FAIL)
│   ├── audit.js               # NDJSON audit trail
│   ├── user-mapping.js        # Source → SN user mapping
│   ├── pre-migration-checks.js # Pre-flight validation
│   └── cleanup.js             # Delete records and artifacts
├── integration/
│   ├── designer.js            # Integration plan designer
│   ├── sn-artifacts.js        # SN Business Rules, Scripted REST, correlation tables
│   ├── jira-artifacts.js      # Jira webhooks + automation rules
│   └── sf-artifacts.js        # Salesforce Apex triggers, callout classes, REST handler
├── flows/
│   ├── retriever.js           # Salesforce flow parser
│   └── jira-automation.js     # Jira automation retriever
└── utils/
    ├── logger.js              # Structured logging
    ├── rich-text.js           # ADF → HTML, SF HTML → SN HTML
    └── sn-auth.js             # Basic auth + SDK OAuth
```

---

## Running modes

### Local CLI (default)

Standard `stdio` mode — Claude Code CLI, VS Code extension, JetBrains plugin.

```bash
node src/mcp-server.js
```

### HTTP/SSE mode (web Claude Code)

For use with [claude.ai/code](https://claude.ai/code) or remote deployments.

```bash
MCP_MODE=http MCP_PORT=3000 node src/mcp-server.js
# SSE endpoint: http://localhost:3000/sse
```

Update `.mcp.json` in your repo root to point at the deployed URL:

```json
{
  "mcpServers": {
    "sn-dev-mcp": {
      "type": "http",
      "url": "https://your-deployed-server.example.com/sse"
    }
  }
}
```

In HTTP mode, use the `configure_credentials` tool to set per-session credentials — credentials are held in memory only and never logged.

---

## ServiceNow permissions required

| Capability | Minimum role |
|---|---|
| Read any table | `read` on the table ACL |
| Create scripts, BRs, SIs, widgets | `admin` |
| Create catalog items | `catalog_admin` |
| Create notifications | `admin` |
| Data migration (staging tables, transform maps) | `import_admin` |
| ATF tests | `atf_test_designer` |
| Background scripts | `admin` |

---

## Requirements

- **Node.js 18+**
- **Claude Code** (CLI, desktop app, web, or IDE extension)
- **ServiceNow** developer or sub-production instance (PDI recommended for development)
- **Jira** Cloud API token (for Jira tools)
- **Salesforce** Connected App credentials (for Salesforce tools)

---

## Issue categories in the guide

Use `list_common_issues` or `diagnose_issue` in Claude Code:

| Category | Examples |
|---|---|
| `business_rule` | BR not firing, infinite loop, BR slowing transactions |
| `client_script` | CS not running, GlideAjax not returning data |
| `portal_widget` | Widget blank, c.server.update() not working |
| `catalog` | Item not visible, UI Policy not working |
| `notification` | Email not sent, no recipients |
| `scripted_rest` | 401/403/500 errors |
| `performance` | Slow lists, missing indexes |
| `security` | Records visible to wrong users |
| `atf` | Test failing unexpectedly |
| `deployment` | Update set conflicts, works in dev not prod |

---

## Contributing

This MCP is designed to grow. New tools can be added by:

1. Adding a method to an existing module in `src/developer/` or `src/integration/`
2. Registering a `server.tool()` in `src/mcp-server.js`
3. Committing and pushing — no build step required

The tool count grows with every use case. Current: **90 tools**.
