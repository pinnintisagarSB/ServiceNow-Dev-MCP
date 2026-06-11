# SN Migration Agent — Claude Instructions

## Important: credentials are already configured

All credentials are stored in the `.env` file in this project. **Never ask the user for credentials, passwords, API tokens, or URLs.** They are already set up.

Platforms configured:
- **ServiceNow** — `SN_INSTANCE_URL`, `SN_USERNAME`, `SN_PASSWORD`
- **Jira** — `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- **Salesforce** — `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`

## How to start every session

When the user asks to do anything migration-related, always begin by calling `get_config` to confirm which platforms are configured, then `connect` to verify the connections are live. Do not ask the user for any setup information first.

```
1. get_config          → see what's already configured
2. connect             → verify connections are working
3. check_migration_state → see if artifacts already exist in ServiceNow
4. proceed with the user's request
```

## How to run this MCP server

The server is registered as `sn-migration` in Claude Code. If it's not responding, the user can restart it with:
```bash
cd /Users/sagarpinninti/Documents/Claude/Projects/SNMigrationAgent
node src/mcp-server.js
```

## Migration workflow (summary)

1. `get_config` — confirm platforms configured
2. `connect` — verify live connections
3. `check_migration_state` — find existing artifacts, skip what's already done
4. `analyze_dependencies` — dependency order, missing references
5. `discover_schema` — source + target schemas, field mapping suggestions
6. `build_artifacts` — create SN staging table, transform map, field maps (idempotent)
7. `run_test_migration` — push sample records, review data quality report
8. `run_full_migration` — migrate all records in batches
9. `verify_migration_counts` — confirm source/staging/target counts match

## Rules

- Never ask for credentials — they are in `.env`
- Never ask the user to run node commands — use the MCP tools
- Always call `check_migration_state` before `build_artifacts` to avoid re-creating things
- Always wait for explicit user approval after the test migration report before running the full migration
- Use plain English when explaining what is happening — avoid ServiceNow technical jargon like "sys_transform_entry" or "sys_import_set_row" unless the user asks
