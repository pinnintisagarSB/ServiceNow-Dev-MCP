# ServiceNow Dev MCP

> AI-powered ServiceNow developer toolkit for **Claude Code** — 116 tools covering script generation, code review, portal & catalog development, notifications, user & group management, CRUD operations, dictionary overrides, data migration, bidirectional integrations, ATF testing, performance analysis, technical documentation, and issue diagnosis.

---

## What is this?

**ServiceNow Dev MCP** is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude Code directly to your ServiceNow, Jira, and Salesforce instances. Instead of switching between tabs, writing boilerplate from scratch, or Googling best practices, you just describe what you need and Claude handles it end-to-end.

```
"Create a Business Rule that sets priority to Critical when the category is Security"
"Clone the sc-cat-item widget and add a real-time search bar"
"Review this Script Include for performance issues"
"Create a user John Smith with role itil and add him to the Network Operations group"
"Make the business_service field mandatory on incident but not on task"
"Generate full technical documentation for my HR application"
"My widget shows a blank white box — help me diagnose it"
"Create a high-priority Jira ticket and link it to incident INC0012345"
"Migrate all Jira issues from project KAN to the incident table in ServiceNow"
```

---

## Capabilities

| Category | What it does |
|---|---|
| **Script Generation** | Business Rules, Script Includes, Client Scripts, UI Actions, Scripted REST APIs, Scheduled Jobs, Fix Scripts, Widgets — best practices built in |
| **Code Review** | 20-rule static analyser — anti-patterns, performance, security, null-safety. Score 0–10 with per-issue fix guidance |
| **Service Portal** | Analyze portals, find / clone / create / update widgets, scaffold new portals with CSS-variable themes |
| **Service Catalog** | Catalog items with typed variables, client scripts, UI policies; clone existing items; categories; record producers |
| **Notifications** | Email notifications with HTML templates, push notifications, email scripts, notification analysis |
| **User & Group Management** | Create users/groups, assign roles, manage membership — ServiceNow, Jira, and Salesforce |
| **CRUD Operations** | Full Create / Read / Update / Delete on any table/object across all three platforms |
| **Dictionary Overrides** | Create, inspect, and delete field overrides on child tables with correct `override_X` flag handling |
| **Table Explorer** | Schema discovery — fields, BRs, Client Scripts, ACLs, relationships, parent hierarchy |
| **ATF Testing** | Generate Automated Test Framework suites for BRs, SIs, REST APIs, forms, tables |
| **Performance Analysis** | Slow script detection, missing index suggestions, BR audits, error pattern analysis |
| **Technical Docs** | Full project documentation generated from live SN data; feature one-pagers |
| **Issue Diagnosis** | 60+ catalogued issues with step-by-step diagnosis, copy-paste fixes, prevention tips |
| **Data Migration** | Migrate Jira / Salesforce data into any ServiceNow table with full artifact generation |
| **Bidirectional Integration** | Design and implement SN↔Jira, SN↔Salesforce integrations with BRs, Scripted REST, Apex |

---

## Tool count: 116

<details>
<summary><strong>Developer Productivity (35 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `generate_script` | Generate any SN artifact with best practices |
| `review_script` | Code review — 20 rules, score 0–10, fix guidance |
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
| `analyze_portal` | Analyze a complete Service Portal |
| `find_widget` | Search widgets by name, ID, or keyword |
| `clone_widget` | Clone a widget with modifications |
| `create_widget` | Generate a complete widget from a requirement |
| `update_widget` | PATCH specific widget sections |
| `create_portal` | Scaffold a new portal with theme and pages |
| `create_catalog_item` | Catalog item with variables, client scripts, UI policies |
| `clone_catalog_item` | Clone a live catalog item from SN |
| `create_catalog_category` | Create a catalog category |
| `get_catalog_item` | Fetch catalog item and variables |
| `create_notification` | Email notification with responsive HTML template |
| `analyze_notifications` | Audit and find issues in existing notifications |
| `create_push_notification` | Push notification for Now Mobile |
| `create_email_script` | Dynamic email script (sys_script_email) |
| `generate_project_doc` | Full project technical doc from live SN data |
| `generate_feature_doc` | Feature one-pager for sprint / change docs |
| `diagnose_issue` | Diagnose any SN issue from a symptom description |
| `get_issue_guide` | Step-by-step guided fix for a known issue |
| `list_common_issues` | Browse 60+ catalogued issues by category |
| `get_field_choices` | Get choice list values for any field |
| `create_choice` | Add a new value to a choice list |

</details>

<details>
<summary><strong>User & Group Management (11 tools)</strong></summary>

| Tool | Platform | What it does |
|---|---|---|
| `sn_create_user` | ServiceNow | Create sys_user — roles + groups in one call, manager resolution, auto username |
| `sn_create_group` | ServiceNow | Create sys_user_group — duplicate check, members, roles, parent group |
| `sn_manage_group_members` | ServiceNow | Add / remove / list group members |
| `sn_assign_roles` | ServiceNow | Assign or revoke roles on users or groups |
| `sn_get_user` | ServiceNow | Full user profile with roles and group memberships |
| `sn_get_group` | ServiceNow | Group detail with member list and assigned roles |
| `sn_list_roles` | ServiceNow | Browse sys_user_role with keyword filter |
| `jira_create_group` | Jira | Create group and add initial members |
| `jira_manage_group_members` | Jira | Add / remove / list Jira group members |
| `sf_create_user` | Salesforce | Create User with all required system fields |
| `sf_manage_group` | Salesforce | Create Public Groups / Queues, manage members |

</details>

<details>
<summary><strong>CRUD Operations (12 tools)</strong></summary>

| Tool | Platform | What it does |
|---|---|---|
| `sn_create` | ServiceNow | Create any record in any table |
| `sn_read` | ServiceNow | Read by sys_id or encoded query |
| `sn_update` | ServiceNow | PATCH a record — only changed fields |
| `sn_delete` | ServiceNow | Delete with confirm=true safety gate |
| `jira_create` | Jira | Create issues, comments, subtasks, components, versions |
| `jira_read` | Jira | Read issues, JQL search, projects, users, boards, sprints, transitions |
| `jira_update` | Jira | Update fields, transition status, edit comments |
| `jira_delete` | Jira | Delete issues or comments with confirm gate |
| `sf_create` | Salesforce | Create any sObject record |
| `sf_read` | Salesforce | Read by Id, SOQL query, or object describe |
| `sf_update` | Salesforce | PATCH a record — only changed fields |
| `sf_delete` | Salesforce | Delete with confirm gate (recoverable via Recycle Bin) |

</details>

<details>
<summary><strong>Dictionary Overrides (3 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `create_dictionary_override` | Create or update a field override on a child table. Correctly sets both the value **and** the required `override_X=true` flag — the step most developers miss. Supports: mandatory, default_value, column_label, read_only, display, calculation, choice, dependent. Dry-run mode available. |
| `get_dictionary_overrides` | List all active overrides on a table or field — shows which flags are set and their effective values |
| `delete_dictionary_override` | Delete an override, reverting the field to parent table defaults. Requires confirm=true. |

</details>

<details>
<summary><strong>Data Migration (30 tools)</strong></summary>

| Tool | What it does |
|---|---|
| `get_config` | Show credential/connection status |
| `configure_credentials` | Set per-session credentials (web Claude Code) |
| `connect` | Test connectivity to SN / Jira / Salesforce |
| `check_migration_state` | Scan SN for existing artifacts, return gap analysis |
| `discover_schema` | Pull source + target schemas, auto-suggest mappings |
| `analyze_dependencies` | Jira hierarchy analysis, user mapping, migration sequence |
| `build_artifacts` | Create staging table, transform map, field maps (idempotent) |
| `run_test_migration` | Push sample records, field-level data quality report |
| `run_full_migration` | Full migration in dependency order with parallel batches |
| `map_users` | Map source users to SN users |
| `pre_migration_check` | Pre-flight validation |
| `transform_preview` | Preview a transform rule on sample data |
| `convert_rich_text` | Convert Jira ADF / Salesforce HTML to SN HTML |
| `topological_sort` | Dependency-ordered migration sequence |
| `start_audit_session` | Start an audit trail for a migration |
| `get_audit_stats` | Migration audit statistics |
| `reconcile_migration` | Field-level comparison: source vs SN |
| `reconcile_staging` | Compare staging vs target (PASS/PARTIAL/FAIL) |
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
| `create_sn_integration_artifacts` | Business Rules, Scripted REST APIs, correlation/retry tables |
| `create_jira_integration_artifacts` | Jira webhooks and automation rules |
| `create_sf_integration_artifacts` | Salesforce Apex triggers, Named Credentials, REST callout classes |
| `get_integration_status` | Check sync health and error counts |
| `retry_failed_syncs` | Retry records in the dead-letter table |
| `test_integration` | End-to-end integration test |
| `disable_integration` | Pause all syncs (maintenance mode) |
| `enable_integration` | Resume syncs after maintenance |
| `update_field_mappings` | Update field mappings in a live integration |

</details>

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/pinnintisagarSB/ServiceNow-Dev-MCP.git
cd ServiceNow-Dev-MCP
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

# Jira (required for Jira tools)
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_api_token

# Salesforce (required for Salesforce tools)
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

Close and reopen Claude Code. All 116 tools are now available. Type `/mcp` to confirm.

---

## Example prompts

### Script development
```
Generate a Business Rule on incident that creates a Jira ticket when priority changes to 1

Review this Script Include for performance and security issues — [paste code]

Clone the "sc-cat-item" widget and rename it "My Catalog Item"

Create a catalog item for a Laptop Request with employee name (mandatory),
model (dropdown), justification (text), and manager approval (yes/no)

Create an email notification for when an incident is assigned —
send to the assigned user and their manager
```

### User & group management
```
Create user Jane Smith, email jane@company.com, title "Senior Analyst",
role itil, add to groups "Service Desk" and "Change Approvers"

Create a group "Network Operations APAC" managed by john.doe,
add members [alice, bob, carol], assign role itil

What roles and groups does david.jones have?

Add sarah.connor to the "Problem Management" group

Remove the admin role from temp.contractor@company.com
```

### CRUD across platforms
```
Create a high-priority incident in ServiceNow for the network outage in Building 3

Find all open Jira tickets assigned to john@company.com in project OPS

Update Salesforce Case 500ABC — set Status to Escalated, Priority to Critical

Create a Jira comment on KAN-55: "Picked up, will update by EOD"

Move Jira ticket KAN-55 to Done status
```

### Dictionary overrides
```
Make the business_service field mandatory on incident but not on task

Rename the caller_id label to "Requested By" on sc_request

Hide the parent field on hr_case

Show me all dictionary overrides on the change_request table
```

### Data migration
```
Migrate all Jira issues from project KAN to the incident table

Run a test migration of 5 records first and show me the field quality report

Design a bidirectional integration between ServiceNow incidents and Jira issues
```

### Debugging & docs
```
My widget shows a blank white box when it loads — diagnose the issue

The email notification for incidents isn't being received — what could be wrong?

Generate full technical documentation for our IT Asset application
(tables: u_asset, u_asset_request)
```

---

## Architecture

```
src/
├── mcp-server.js              # 116 MCP tools — single entry point
├── connectors/
│   ├── servicenow.js          # SN Table API, Import Set API, bulk ops
│   ├── salesforce.js          # SF REST + Tooling API + Bulk API 2.0
│   └── jira.js                # Jira REST API v3 — full CRUD
├── developer/
│   ├── script-builder.js      # Generate BR, SI, CS, UI Action, REST, Job, Widget
│   ├── code-reviewer.js       # 20-rule static analyser
│   ├── table-explorer.js      # Schema: fields, BRs, ACLs, relationships
│   ├── test-generator.js      # ATF test suite generator
│   ├── perf-analyzer.js       # Slow scripts, indexes, error patterns
│   ├── doc-generator.js       # Markdown API docs per artifact
│   ├── portal-builder.js      # SP widget / portal builder
│   ├── catalog-builder.js     # Catalog items, variables, categories
│   ├── notification-builder.js # Email & push notifications
│   ├── tech-doc-writer.js     # Full project docs from live SN data
│   └── issue-guide.js         # 60+ issue catalogue with guided fixes
├── migration/
│   ├── schema.js              # Schema discovery + mapping suggestions
│   ├── staging.js             # Artifact builder (idempotent)
│   ├── runner.js              # Migration runner with topo sort + ETA
│   ├── batch.js               # Parallel batch runner + dedup
│   ├── dependency.js          # User/hierarchy analysis
│   ├── validator.js           # Field-level data quality report
│   ├── transform-engine.js    # 15+ transform types
│   ├── reconciler.js          # 3-layer reconciliation (PASS/PARTIAL/FAIL)
│   ├── audit.js               # NDJSON audit trail
│   ├── user-mapping.js        # Source → SN user mapping
│   ├── pre-migration-checks.js # Pre-flight validation
│   └── cleanup.js             # Delete records and artifacts
├── integration/
│   ├── designer.js            # Integration plan designer
│   ├── sn-artifacts.js        # SN BRs, Scripted REST, correlation tables
│   ├── jira-artifacts.js      # Jira webhooks + automation rules
│   └── sf-artifacts.js        # Salesforce Apex triggers, callout classes
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

```bash
node src/mcp-server.js
```

### HTTP/SSE (web Claude Code or remote deployment)

```bash
MCP_MODE=http MCP_PORT=3000 node src/mcp-server.js
```

Update `.mcp.json` with your deployed URL:

```json
{
  "mcpServers": {
    "sn-dev-mcp": {
      "type": "http",
      "url": "https://your-server.example.com/sse"
    }
  }
}
```

In HTTP mode, use `configure_credentials` to set per-session credentials — never logged or persisted.

---

## Permissions required

| Capability | Minimum role |
|---|---|
| Read any table | `read` ACL on the table |
| Scripts, BRs, widgets, notifications | `admin` |
| Catalog items | `catalog_admin` |
| User / group management | `admin` or `user_admin` |
| Data migration (staging tables, transform maps) | `import_admin` |
| ATF tests | `atf_test_designer` |
| Background scripts | `admin` |

---

## Requirements

- **Node.js 18+**
- **Claude Code** (CLI, desktop app, web, or IDE extension)
- **ServiceNow** developer or sub-production instance (PDI recommended)
- **Jira** Cloud API token (for Jira tools)
- **Salesforce** Connected App credentials (for Salesforce tools)

---

## Tool growth

The MCP is designed to grow with every use case. New tools are added by:

1. Adding a method to an existing module in `src/developer/` or `src/integration/`
2. Registering a `server.tool()` in `src/mcp-server.js`
3. Pushing — no build step required

| Version | Tools | Key additions |
|---|---|---|
| 1.0 | 27 | Data migration (Jira → SN, SF → SN) |
| 1.5 | 55 | Bidirectional integrations, reconciliation, audit |
| 2.0 | 90 | Developer toolkit: scripts, review, portal, catalog, notifications, docs, issue guide |
| 2.1 | 105 | Full CRUD (SN + Jira + SF), dictionary overrides |
| 2.2 | 116 | User & group management across all 3 platforms |
