/**
 * ServiceNow Service Catalog Builder
 *
 * Create and manage:
 *  - Catalog Items (sc_cat_item) with variables, categories, and fulfillment
 *  - Variable sets (io_set_item)
 *  - Catalog categories (sc_category)
 *  - Order guides (sc_cat_item_guide)
 *  - Record producers (sc_cat_item_producer)
 *  - Catalog client scripts and UI policies
 *  - Clone existing catalog items
 *
 * All builders return deploy-ready payloads + best-practice guidance.
 */

// Variable types and their SN internal codes
export const VARIABLE_TYPES = {
  single_line:     1,
  multi_line:      2,
  multiple_choice: 3,  // radio buttons
  yes_no:          4,
  reference:       8,
  date:            9,
  date_time:       10,
  checkbox:        11,  // boolean
  select_box:      12,  // dropdown
  lookup_select:   14,  // reference via lookup
  html:            19,
  label:           20,
  break:           21,
  macro:           22,
  ui_page:         23,
  wide_single:     24,
  numeric:         6,
  email:           25,
  url:             26,
  phone:           27,
  ip_address:      28,
  masked:          29,  // password
  file_attachment: 16,
  container_start: 17,
  container_end:   18,
};

export class CatalogBuilder {
  constructor(snConnector) {
    this.sn = snConnector;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Build a catalog item definition
  // ══════════════════════════════════════════════════════════════════════════
  buildCatalogItem({
    name,
    short_description,
    description,
    category,
    icon,
    price = '0',
    delivery_time,
    fulfillment_group,
    workflow,
    variables = [],
    client_scripts = [],
    ui_policies = [],
    sla_commitment,
    portal_visibility = true,
  }) {
    const item = {
      deploy_table: 'sc_cat_item',
      payload: {
        name,
        short_description,
        description:   description ?? short_description,
        category,
        icon,
        price,
        delivery_time,
        group:         fulfillment_group,
        workflow:      workflow,
        active:        true,
        no_quantity:   true,   // most items are single-quantity
        hide_sp:       !portal_visibility,
        sc_catalogs:   'e0d08b13c3330100c8b837659bba8fb4', // default catalog sys_id
        // SLA
        meta_phases:   sla_commitment ?? '',
      },
    };

    const variablePayloads = variables.map((v, idx) => this._buildVariable(v, idx));
    const clientScriptPayloads = client_scripts.map(cs => this._buildCatalogClientScript(cs, name));
    const uiPolicyPayloads     = ui_policies.map(p  => this._buildCatalogUiPolicy(p, name));

    return {
      catalog_item:    item,
      variables:       variablePayloads,
      client_scripts:  clientScriptPayloads,
      ui_policies:     uiPolicyPayloads,
      deploy_order:    ['catalog_item', 'variables', 'client_scripts', 'ui_policies'],
      note:            'Create the catalog item first to get its sys_id, then link variables/scripts to it.',
      best_practices: [
        'Group related variables with container_start / container_end',
        'Mark mandatory variables in the variable definition — not in a client script',
        'Use "Reference Qualifier" on reference variables to limit the lookup list',
        'Set a meaningful short_description — it appears on the catalog card',
        'Assign a fulfillment group so requests route automatically',
        'Use a workflow or Flow for fulfillment — never just email a team',
        'Test the item as an end user (not admin) to verify UI policies and mandatory fields',
        'Set "no_quantity=true" for service requests — quantity rarely makes sense',
        'Always set an SLA commitment for the catalog item',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Clone a catalog item from SN (fetches live + returns modified copy)
  // ══════════════════════════════════════════════════════════════════════════
  async cloneCatalogItem({ sourceNameOrSysId, newName, modifications = {} }) {
    // Fetch source item
    const items = await this.sn.query('sc_cat_item', {
      sysparm_query:  `name=${sourceNameOrSysId}^ORsys_id=${sourceNameOrSysId}`,
      sysparm_fields: 'sys_id,name,short_description,description,category,price,workflow,group,active',
      sysparm_limit:  1,
    });
    if (!items.length) throw new Error(`Catalog item not found: ${sourceNameOrSysId}`);
    const source = items[0];

    // Fetch variables
    const vars = await this.sn.query('item_option_new', {
      sysparm_query:  `cat_item=${source.sys_id}`,
      sysparm_fields: 'sys_id,name,question_text,type,mandatory,default_value,order,active,reference,choices',
      sysparm_limit:  100,
    });

    const clonedItem = {
      ...source,
      ...modifications,
      name:        newName,
      description: `Cloned from "${source.name}". ${modifications.description ?? ''}`.trim(),
      sys_id:      undefined,  // will be assigned on POST
    };
    delete clonedItem.sys_id;

    return {
      action:          'clone_catalog_item',
      source:          { sys_id: source.sys_id, name: source.name },
      cloned_item:     { deploy_table: 'sc_cat_item', payload: clonedItem },
      cloned_variables: vars.map(v => {
        const c = { ...v };
        delete c.sys_id;
        delete c.cat_item;
        return { deploy_table: 'item_option_new', payload: c, note: 'Set cat_item to the new item sys_id after creating it.' };
      }),
      note: 'Create the cloned item first, capture its sys_id, then create each variable with that sys_id as cat_item.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Catalog category
  // ══════════════════════════════════════════════════════════════════════════
  buildCategory({ title, description, parent, image, roles }) {
    return {
      deploy_table: 'sc_category',
      payload: {
        title,
        description:   description ?? title,
        parent,        // sys_id of parent category (or leave blank for top-level)
        image,
        roles:         roles ?? '',
        active:        true,
        show_in_cms:   false,
      },
      best_practices: [
        'Keep categories broad — too many sub-categories confuse users',
        'Use meaningful icons and descriptions for catalog cards',
        'Restrict categories with roles only when needed — prefer item-level restrictions',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Record producer (creates a record when submitted, vs a service request)
  // ══════════════════════════════════════════════════════════════════════════
  buildRecordProducer({ name, short_description, table, variables = [], script }) {
    const itemPayload = {
      name,
      short_description,
      active:      true,
      category:    '',
      type:        'record_producer',
      table_name:  table,
    };

    const producerScript = script ?? `
/**
 * Record Producer Script: ${name}
 * Maps catalog variables (producer.variableName) to target table fields.
 */
producer.short_description = producer.variables.getQuestion('summary').getValue();

// Map each variable to the target table field
// producer.field_name = producer.variables.getQuestion('variable_name').getValue();
`.trim();

    return {
      deploy_table: 'sc_cat_item_producer',
      payload:     itemPayload,
      script:      producerScript,
      variables:   variables.map((v, i) => this._buildVariable(v, i)),
      best_practices: [
        'Use record producers instead of catalog items when creating Task/Incident/Change records',
        'Map all required fields in the producer script — use producer.variables.getQuestion()',
        'Set the table_name to the exact target table (e.g., incident, change_request)',
        'Use conditions on variables to show/hide based on other answers',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Order Guide (multi-item bundle)
  // ══════════════════════════════════════════════════════════════════════════
  buildOrderGuide({ name, short_description, items = [], script }) {
    return {
      deploy_table: 'sc_cat_item_guide',
      payload: {
        name,
        short_description,
        active: true,
        two_step: false,
      },
      guide_items: items.map((item, idx) => ({
        deploy_table: 'sc_cat_item_guide_items',
        payload: {
          order:    (idx + 1) * 100,
          cat_item: item.sys_id,
          guide:    null,  // set after guide is created
        },
      })),
      rule_script: script ?? `
/**
 * Order Guide Rule Script
 * Use addItem(sys_id) to conditionally include items.
 * 'rule' is the order guide GlideRecord.
 */
// Example: addItem('item_sys_id');
`.trim(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Fetch catalog item details from SN
  // ══════════════════════════════════════════════════════════════════════════
  async getCatalogItem(nameOrSysId) {
    const items = await this.sn.query('sc_cat_item', {
      sysparm_query:  `name=${nameOrSysId}^ORsys_id=${nameOrSysId}`,
      sysparm_fields: 'sys_id,name,short_description,description,category,price,workflow,group,active,type',
      sysparm_limit:  1,
    });
    if (!items.length) throw new Error(`Catalog item not found: ${nameOrSysId}`);
    const item = items[0];

    const vars = await this.sn.query('item_option_new', {
      sysparm_query:  `cat_item=${item.sys_id}^active=true`,
      sysparm_fields: 'name,question_text,type,mandatory,default_value,order,reference',
      sysparm_limit:  100,
      sysparm_order:  'order',
    });

    return { ...item, variables: vars };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ══════════════════════════════════════════════════════════════════════════
  _buildVariable(v, idx) {
    return {
      deploy_table: 'item_option_new',
      payload: {
        cat_item:       null,           // caller must fill after item is created
        name:           v.name,
        question_text:  v.label ?? v.name,
        type:           VARIABLE_TYPES[v.type] ?? VARIABLE_TYPES.single_line,
        mandatory:      v.mandatory === true,
        default_value:  v.default ?? '',
        order:          (idx + 1) * 100,
        active:         true,
        reference:      v.reference ?? '',    // for type=reference
        help_text:      v.help ?? '',
        attributes:     v.attributes ?? '',
      },
    };
  }

  _buildCatalogClientScript(cs, itemName) {
    const typeSignatures = {
      onLoad:   'function onLoad() {',
      onChange:  `function onChange(control, oldValue, newValue, isLoading) {\n  if (isLoading) return;`,
      onSubmit: 'function onSubmit() {\n  // return false; to block submission',
    };
    return {
      deploy_table: 'catalog_script_client',
      payload: {
        name:        cs.name,
        cat_item:    null,  // fill after item created
        type:        cs.type ?? 'onChange',
        applies_to:  cs.field ?? '',
        active:      true,
        script: `/**
 * Catalog Client Script: ${cs.name} on ${itemName}
 */
${typeSignatures[cs.type ?? 'onChange'] ?? 'function onLoad() {'}
  try {
    ${cs.logic ?? '// TODO: implement'}
  } catch(e) {
    console.error('${cs.name}: ' + e.message);
  }
}`,
      },
    };
  }

  _buildCatalogUiPolicy(p, itemName) {
    return {
      deploy_table: 'catalog_ui_policy',
      payload: {
        name:          p.name ?? itemName + ' Policy',
        cat_item:      null,
        conditions:    p.conditions ?? '',
        active:        true,
        reverse_if_false: p.reverse ?? true,
        script_true:   p.script_true  ?? '',
        script_false:  p.script_false ?? '',
        actions:       (p.actions ?? []).map(a => ({
          deploy_table: 'catalog_ui_policy_action',
          payload: {
            variable_name: a.field,
            mandatory:     a.mandatory ?? '-',
            visible:       a.visible   ?? '-',
            read_only:     a.read_only ?? '-',
          },
        })),
      },
    };
  }
}
