/**
 * ServiceNow Table Explorer
 *
 * Rich schema discovery: fields, business rules, client scripts, ACLs,
 * related lists, relationships, table hierarchy, and usage stats.
 *
 * All methods return structured data suitable for the MCP tools.
 */

export class TableExplorer {
  constructor(snConnector) {
    this.sn = snConnector;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Core: field schema
  // ══════════════════════════════════════════════════════════════════════════
  async getFields(tableName, opts = {}) {
    const params = {
      sysparm_query: `name=${tableName}`,
      sysparm_fields: 'element,column_label,internal_type,reference,max_length,mandatory,read_only,default_value,active,comments',
      sysparm_limit: opts.limit ?? 500,
    };

    const rows = await this.sn.query('sys_dictionary', params);

    return rows.map(f => ({
      field:         f.element,
      label:         f.column_label,
      type:          f.internal_type?.display_value ?? f.internal_type,
      reference_to:  f.reference?.display_value ?? null,
      max_length:    f.max_length,
      mandatory:     f.mandatory === 'true',
      read_only:     f.read_only === 'true',
      default_value: f.default_value ?? null,
      active:        f.active !== 'false',
      notes:         f.comments ?? null,
    })).sort((a, b) => a.field.localeCompare(b.field));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Table metadata
  // ══════════════════════════════════════════════════════════════════════════
  async getTableInfo(tableName) {
    const rows = await this.sn.query('sys_db_object', {
      sysparm_query:  `name=${tableName}`,
      sysparm_fields: 'name,label,super_class,scope,is_extendable,number_ref,create_access,read_access,write_access,delete_access,access,ws_access',
      sysparm_limit:  1,
    });

    if (!rows.length) return null;
    const t = rows[0];
    return {
      name:          t.name,
      label:         t.label,
      parent_table:  t.super_class?.display_value ?? null,
      scope:         t.scope?.display_value ?? 'global',
      is_extendable: t.is_extendable === 'true',
      numbering:     t.number_ref?.display_value ?? null,
      acl_create:    t.create_access === 'true',
      acl_read:      t.read_access === 'true',
      acl_write:     t.write_access === 'true',
      acl_delete:    t.delete_access === 'true',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Business Rules on a table
  // ══════════════════════════════════════════════════════════════════════════
  async getBusinessRules(tableName) {
    const rows = await this.sn.query('sys_script', {
      sysparm_query:  `collection=${tableName}^active=true`,
      sysparm_fields: 'name,when,action_insert,action_update,action_delete,action_query,filter_condition,is_rest,abort_action,add_message,advanced,condition',
      sysparm_limit:  200,
    });

    return rows.map(br => ({
      name:      br.name,
      when:      br.when,
      events:    [
        br.action_insert === 'true' && 'insert',
        br.action_update === 'true' && 'update',
        br.action_delete === 'true' && 'delete',
        br.action_query  === 'true' && 'query',
      ].filter(Boolean),
      condition: br.filter_condition ?? br.condition ?? '',
      is_rest:   br.is_rest === 'true',
      aborts:    br.abort_action === 'true',
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Client Scripts on a table
  // ══════════════════════════════════════════════════════════════════════════
  async getClientScripts(tableName) {
    const rows = await this.sn.query('sys_script_client', {
      sysparm_query:  `table=${tableName}^active=true`,
      sysparm_fields: 'name,type,field_name,ui_type,description',
      sysparm_limit:  200,
    });

    return rows.map(cs => ({
      name:    cs.name,
      type:    cs.type,       // onChange | onLoad | onSubmit
      field:   cs.field_name ?? null,
      ui_type: cs.ui_type,   // 0=desktop, 10=mobile
      description: cs.description ?? '',
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACLs (Access Control Rules)
  // ══════════════════════════════════════════════════════════════════════════
  async getAcls(tableName) {
    const rows = await this.sn.query('sys_security_acl', {
      sysparm_query:  `name=${tableName}^ORname=${tableName}.*`,
      sysparm_fields: 'name,operation,type,active,roles,condition,script',
      sysparm_limit:  200,
    });

    return rows.map(acl => ({
      name:      acl.name,
      operation: acl.operation,  // read | write | create | delete | execute
      type:      acl.type,       // record | field
      active:    acl.active === 'true',
      roles:     acl.roles ?? '(none)',
      has_condition: !!acl.condition,
      has_script:    !!acl.script,
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI Policies on a table
  // ══════════════════════════════════════════════════════════════════════════
  async getUiPolicies(tableName) {
    const rows = await this.sn.query('sys_ui_policy', {
      sysparm_query:  `table=${tableName}^active=true`,
      sysparm_fields: 'short_description,conditions,run_scripts,reverse_if_false',
      sysparm_limit:  100,
    });

    return rows.map(p => ({
      description:     p.short_description,
      conditions:      p.conditions ?? '',
      runs_scripts:    p.run_scripts === 'true',
      reverse_if_false: p.reverse_if_false === 'true',
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Relationships / related lists
  // ══════════════════════════════════════════════════════════════════════════
  async getRelationships(tableName) {
    // Tables that reference this table
    const refs = await this.sn.query('sys_dictionary', {
      sysparm_query:  `reference=${tableName}^internal_type=reference`,
      sysparm_fields: 'name,element,column_label',
      sysparm_limit:  100,
    });

    return refs.map(r => ({
      from_table: r.name,
      field:      r.element,
      label:      r.column_label,
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Table hierarchy (parent chain)
  // ══════════════════════════════════════════════════════════════════════════
  async getHierarchy(tableName) {
    const chain = [tableName];
    let current = tableName;

    for (let depth = 0; depth < 10; depth++) {
      const rows = await this.sn.query('sys_db_object', {
        sysparm_query:  `name=${current}`,
        sysparm_fields: 'super_class',
        sysparm_limit:  1,
      });
      const parent = rows[0]?.super_class?.display_value;
      if (!parent || parent === current) break;
      chain.push(parent);
      current = parent;
    }

    return chain;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Full explorer — all of the above in one call
  // ══════════════════════════════════════════════════════════════════════════
  async explore(tableName, opts = {}) {
    const [info, fields, brs, css, acls, rels, hierarchy] = await Promise.all([
      this.getTableInfo(tableName),
      this.getFields(tableName, { limit: opts.fieldLimit ?? 200 }),
      this.getBusinessRules(tableName),
      this.getClientScripts(tableName),
      this.getAcls(tableName),
      this.getRelationships(tableName),
      this.getHierarchy(tableName),
    ]);

    return {
      table:            tableName,
      info,
      hierarchy,
      field_count:      fields.length,
      fields,
      business_rules:   brs,
      client_scripts:   css,
      acls,
      relationships:    rels,
      summary: {
        total_fields:       fields.length,
        mandatory_fields:   fields.filter(f => f.mandatory).length,
        reference_fields:   fields.filter(f => f.reference_to).length,
        business_rules:     brs.length,
        client_scripts:     css.length,
        acl_rules:          acls.length,
        incoming_relations: rels.length,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Find tables by keyword
  // ══════════════════════════════════════════════════════════════════════════
  async findTable(keyword) {
    const rows = await this.sn.query('sys_db_object', {
      sysparm_query:  `nameLIKE${keyword}^ORlabelLIKE${keyword}`,
      sysparm_fields: 'name,label,scope',
      sysparm_limit:  25,
    });

    return rows.map(r => ({
      name:  r.name,
      label: r.label,
      scope: r.scope?.display_value ?? 'global',
    }));
  }
}
