# SN Migration Agent — Claude Instructions

## CRITICAL: Always use the sn-migration MCP tools

This project has a registered MCP server called **`sn-migration`**. For ANY request involving migration, data movement, Jira, Salesforce, or ServiceNow — **always use the `sn-migration` MCP tools**. Never use built-in skills, bash commands, or any other approach.

Trigger phrases that must use `sn-migration` MCP tools (not skills):
- "migrate jira data to servicenow"
- "migrate salesforce to servicenow"
- "migrate data"
- "check servicenow connection"
- "run migration"
- "build staging table"
- "clean up migration"
- anything involving Jira, Salesforce, or ServiceNow

The correct first action for ANY of these is to call the `mcp__sn-migration__get_config` tool — not a skill, not a bash command.

---

## Credentials are already configured — never ask

All credentials are in `.env`. **Never ask the user for credentials, passwords, API tokens, or URLs.**

- **ServiceNow** — `SN_INSTANCE_URL`, `SN_USERNAME`, `SN_PASSWORD`
- **Jira** — `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- **Salesforce** — `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`

---

## Session start — always follow this order

```
1. mcp__sn-migration__get_config          → confirm what platforms are configured
2. mcp__sn-migration__connect             → verify live connections
3. mcp__sn-migration__check_migration_state → find existing SN artifacts
4. proceed with the user's request
```

---

## Full migration workflow

| Step | Tool | When |
|------|------|------|
| 1 | `get_config` | Always first — reads .env, no questions needed |
| 2 | `connect` | Verify platforms are reachable |
| 3 | `list_update_sets` | Check for existing update sets |
| 4 | `create_update_set` | **Ask user for a name**, then create — captures all SN config changes |
| 5 | `check_migration_state` | Before setup — skip what already exists |
| 6 | `analyze_dependencies` | Before build — check record order and references |
| 7 | `discover_schema` | Show source + target fields, suggest mappings |
| 8 | `build_artifacts` | Create SN staging table, transform map, field maps |
| 9 | `complete_update_set` | Mark update set complete after build_artifacts |
| 10 | `run_test_migration` | Push sample records, get data quality report |
| 11 | `run_full_migration` | Migrate all records after user approval |
| 12 | `verify_migration_counts` | Confirm counts match across all layers |
| — | `cleanup_migration` | Delete migrated records (with confirmation) |
| — | `cleanup_artifacts` | Delete SN setup artifacts (with confirmation) |

---

## Rules

- Use `sn-migration` MCP tools for everything — never use skills or bash for migration work
- Never ask for credentials — they are in `.env`
- Never ask the user to run node commands — use the MCP tools
- Always call `check_migration_state` before `build_artifacts`
- Always wait for explicit user approval after test migration before running the full migration
- Use plain English — avoid jargon like "sys_transform_entry" or "sys_import_set_row"
