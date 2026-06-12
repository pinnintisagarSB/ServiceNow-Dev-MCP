/**
 * ServiceNow Service Portal Builder
 *
 * Full lifecycle for portals and widgets:
 *  - Analyze an existing portal (pages, widgets, themes, menu items)
 *  - Find and inspect widgets
 *  - Clone a widget (copy all 4 scripts + option schema + CSS)
 *  - Create a new widget from a requirement description
 *  - Update individual sections of an existing widget
 *  - Scaffold a new portal
 *  - Export widget code for review
 *
 * All write operations return a deploy payload that can be POSTed
 * to the SN Table API — or previewed via dry_run.
 */

export class PortalBuilder {
  constructor(snConnector) {
    this.sn = snConnector;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Analyze a full portal
  // ══════════════════════════════════════════════════════════════════════════
  async analyzePortal(portalId) {
    // Resolve by url_suffix or sys_id
    const portals = await this.sn.query('sp_portal', {
      sysparm_query:  `url_suffix=${portalId}^ORsys_id=${portalId}`,
      sysparm_fields: 'sys_id,title,url_suffix,homepage,kb_knowledge_base,sc_catalog,theme,login_page,css_variables',
      sysparm_limit:  1,
    });
    if (!portals.length) throw new Error(`Portal not found: ${portalId}`);
    const portal = portals[0];

    const [pages, widgets, theme, menuItems] = await Promise.all([
      this.sn.query('sp_page', {
        sysparm_query:  `sp_portal=${portal.sys_id}`,
        sysparm_fields: 'sys_id,title,id,public,roles,short_description',
        sysparm_limit:  100,
      }),
      this.sn.query('sp_widget', {
        sysparm_fields: 'sys_id,name,id,description,category,has_preview,internal',
        sysparm_limit:  200,
      }),
      portal.theme?.value ? this.sn.query('sp_theme', {
        sysparm_query:  `sys_id=${portal.theme.value}`,
        sysparm_fields: 'sys_id,name,css_variables,js_includes,css_includes',
        sysparm_limit:  1,
      }) : Promise.resolve([]),
      this.sn.query('sp_instance', {
        sysparm_query:  `sp_page.sp_portal=${portal.sys_id}`,
        sysparm_fields: 'widget,sp_page',
        sysparm_limit:  500,
      }),
    ]);

    // Count widget usage across pages
    const widgetUsageMap = {};
    for (const inst of menuItems) {
      const wid = inst.widget?.display_value ?? inst.widget;
      widgetUsageMap[wid] = (widgetUsageMap[wid] ?? 0) + 1;
    }

    return {
      portal: {
        sys_id:     portal.sys_id,
        title:      portal.title,
        url_suffix: portal.url_suffix,
        homepage:   portal.homepage?.display_value ?? null,
        theme:      portal.theme?.display_value ?? null,
      },
      page_count:   pages.length,
      pages:        pages.map(p => ({
        sys_id:      p.sys_id,
        title:       p.title,
        id:          p.id,
        public:      p.public === 'true',
        roles:       p.roles ?? '(none)',
        description: p.short_description ?? '',
      })),
      widget_count:  widgets.length,
      top_widgets:   widgets.slice(0, 30).map(w => ({
        sys_id:      w.sys_id,
        name:        w.name,
        id:          w.id,
        description: w.description ?? '',
        category:    w.category ?? '',
        usage_count: widgetUsageMap[w.name] ?? 0,
      })),
      theme:    theme[0] ?? null,
      summary:  {
        pages:          pages.length,
        public_pages:   pages.filter(p => p.public === 'true').length,
        secured_pages:  pages.filter(p => p.public !== 'true').length,
        widgets:        widgets.length,
        widget_instances: menuItems.length,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Find widgets by name / keyword
  // ══════════════════════════════════════════════════════════════════════════
  async findWidgets(keyword, limit = 20) {
    const rows = await this.sn.query('sp_widget', {
      sysparm_query:  `nameLIKE${keyword}^ORidLIKE${keyword}^ORdescriptionLIKE${keyword}`,
      sysparm_fields: 'sys_id,name,id,description,category',
      sysparm_limit:  limit,
    });
    return rows.map(w => ({
      sys_id:      w.sys_id,
      name:        w.name,
      id:          w.id,
      description: w.description ?? '',
      category:    w.category ?? '',
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Get full widget code
  // ══════════════════════════════════════════════════════════════════════════
  async getWidget(widgetIdOrSysId) {
    const rows = await this.sn.query('sp_widget', {
      sysparm_query:  `id=${widgetIdOrSysId}^ORsys_id=${widgetIdOrSysId}`,
      sysparm_fields: 'sys_id,name,id,description,category,template,css,client_script,server_script,option_schema,demo_data,public,roles,has_preview',
      sysparm_limit:  1,
    });
    if (!rows.length) throw new Error(`Widget not found: ${widgetIdOrSysId}`);
    return rows[0];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Clone a widget
  // ══════════════════════════════════════════════════════════════════════════
  async cloneWidget({ sourceIdOrSysId, newName, newId, modifications = {} }) {
    const source = await this.getWidget(sourceIdOrSysId);

    const cloned = {
      name:          newName,
      id:            newId ?? newName.toLowerCase().replace(/\s+/g, '-'),
      description:   `Cloned from "${source.name}". ${modifications.description ?? ''}`.trim(),
      template:      modifications.template    ?? source.template    ?? '',
      css:           modifications.css         ?? source.css         ?? '',
      client_script: modifications.client_script ?? source.client_script ?? '',
      server_script: modifications.server_script ?? source.server_script ?? '',
      option_schema: modifications.option_schema ?? source.option_schema ?? '[]',
      demo_data:     modifications.demo_data    ?? source.demo_data    ?? '{}',
      public:        source.public,
    };

    // Add provenance comment to each section
    const stamp = `/* Cloned from: ${source.name} (${source.id}) on ${new Date().toISOString().split('T')[0]} */\n`;
    if (cloned.css)           cloned.css           = stamp + cloned.css;
    if (cloned.client_script) cloned.client_script = stamp.replace('/*','//').replace('*/','') + cloned.client_script;
    if (cloned.server_script) cloned.server_script = stamp.replace('/*','//').replace('*/','') + cloned.server_script;

    return {
      action:        'clone_widget',
      source_widget: { sys_id: source.sys_id, name: source.name, id: source.id },
      cloned_widget: cloned,
      deploy_table:  'sp_widget',
      note:          'POST cloned_widget to /api/now/table/sp_widget to create it.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Generate a new widget from a requirement
  // ══════════════════════════════════════════════════════════════════════════
  buildWidget({ name, id, description, dataSource, fields = [], actions = [], options = [] }) {
    const widgetId = id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // ── HTML template ──────────────────────────────────────────────────────
    const fieldRows = fields.map(f =>
      `    <div class="form-group">\n      <label>{{::c.data.labels.${f.key}}}</label>\n      <span ng-if="!c.data.editing">{{::c.data.record.${f.key}}}</span>\n      <input ng-if="c.data.editing" type="text" class="form-control" ng-model="c.data.record.${f.key}">\n    </div>`
    ).join('\n');

    const actionBtns = actions.map(a =>
      `  <button class="btn btn-${a.style ?? 'default'}" ng-click="c.${a.fn}()" ng-if="${a.condition ?? 'true'}">${a.label}</button>`
    ).join('\n');

    const template = `<div class="widget-${widgetId} panel panel-default">
  <div class="panel-heading">
    <h3 class="panel-title">{{::c.data.title}}</h3>
  </div>
  <div class="panel-body">

    <!-- Loading state -->
    <div ng-if="c.data.loading" class="text-center">
      <i class="fa fa-spinner fa-spin fa-2x"></i>
    </div>

    <!-- Error state -->
    <div ng-if="c.data.error" class="alert alert-danger">
      <i class="fa fa-exclamation-triangle"></i> {{c.data.error}}
    </div>

    <!-- Content -->
    <div ng-if="!c.data.loading && !c.data.error">
${fieldRows || '      <!-- TODO: add fields -->'}
    </div>

  </div>

  <!-- Actions -->
  <div class="panel-footer" ng-if="!c.data.loading">
${actionBtns || '    <!-- TODO: add action buttons -->'}
  </div>
</div>`;

    // ── CSS ────────────────────────────────────────────────────────────────
    const css = `.widget-${widgetId} {
  /* Uses Bootstrap variables from portal theme — avoid hardcoding colors */
  margin-bottom: 16px;
}

.widget-${widgetId} .panel-heading {
  background: var(--color-primary, #293e40);
  color: #fff;
}

.widget-${widgetId} .panel-footer {
  background: transparent;
  border-top: 1px solid #e8e8e8;
  padding: 8px 16px;
}`;

    // ── Client script ──────────────────────────────────────────────────────
    const actionFns = actions.map(a => `
    /**
     * ${a.label} — ${a.description ?? ''}
     */
    c.${a.fn} = function() {
      c.data.loading = true;
      c.data.error   = null;
      c.server.update().then(function() {
        c.data.loading = false;
        if (c.data.serverError) {
          c.data.error = c.data.serverError;
        } else {
          spUtil.addInfoMessage('${a.label} completed.');
        }
      }, function(err) {
        c.data.loading = false;
        c.data.error   = err;
      });
    };`).join('\n');

    const clientScript = `/**
 * Widget: ${name}
 * ${description ?? ''}
 *
 * Best practices:
 *  - Use c.data.X (not $scope) for all data binding
 *  - Use c.server.update() for server round-trips — never GlideRecord directly
 *  - Use spUtil.addInfoMessage() / spUtil.addErrorMessage() for user feedback
 *  - Keep all business logic server-side
 */
function(/* services injected below */) {
  /* @ngInject */
  var c = this;

  // Initialise loading state — server script runs first
  c.data.loading = false;
  c.data.editing = false;
  c.data.error   = null;

${actionFns || '  // TODO: add action functions'}

}`;

    // ── Server script ──────────────────────────────────────────────────────
    const serverScript = `/**
 * Server-side controller for widget: ${name}
 * ${description ?? ''}
 *
 * Best practices:
 *  - Set data.X to pass values to the client
 *  - Use input.X to receive values from client (c.server.update())
 *  - Always setLimit() on GlideRecord queries
 *  - Handle errors: set data.serverError for the client to display
 */
(function() {

  data.title       = '${name}';
  data.loading     = false;
  data.serverError = null;

  // ── Labels (internationalisation-ready) ────────────────────────────────
  data.labels = {
${fields.map(f => `    ${f.key}: gs.getMessage('${f.label ?? f.key}')`).join(',\n') || '    // field: gs.getMessage(\'Label\')'}
  };

  // ── Server action dispatcher ────────────────────────────────────────────
  if (input && input.action) {
    try {
      if (input.action === 'save') {
        // TODO: handle save
      }
      // Add more action handlers here
    } catch(e) {
      gs.error('[${name}] Server error: ' + e.message);
      data.serverError = e.message;
    }
    return; // Do not re-run fetch on action calls
  }

  // ── Initial data load ──────────────────────────────────────────────────
  try {
${dataSource ? `    var gr = new GlideRecord('${dataSource}');
    gr.addEncodedQuery('active=true');
    gr.setLimit(50);
    gr.orderByDesc('sys_created_on');
    gr.query();
    data.records = [];
    while (gr.next()) {
      data.records.push({
        sys_id: gr.getUniqueValue(),
${fields.map(f => `        ${f.key}: gr.getDisplayValue('${f.field ?? f.key}')`).join(',\n')}
      });
    }` : '    // TODO: load data from GlideRecord'}
  } catch(e) {
    gs.error('[${name}] Load error: ' + e.message);
    data.serverError = 'Failed to load data. Please try again.';
  }

})();`;

    // ── Option schema ──────────────────────────────────────────────────────
    const optionSchema = JSON.stringify([
      { name: 'title', label: 'Widget Title', default_value: name, type: 'string', hint: 'Displayed in panel header' },
      { name: 'limit', label: 'Record Limit', default_value: '10', type: 'integer', hint: 'Max records to display' },
      ...options.map(o => ({ name: o.name, label: o.label, default_value: o.default ?? '', type: o.type ?? 'string', hint: o.hint ?? '' })),
    ], null, 2);

    return {
      type:          'sp_widget',
      deploy_table:  'sp_widget',
      widget: {
        name,
        id:            widgetId,
        description,
        template,
        css,
        client_script: clientScript,
        server_script: serverScript,
        option_schema: optionSchema,
        demo_data:     '{}',
        public:        false,
      },
      best_practices: [
        'Use c.data.X — never $scope — for two-way binding',
        'Use c.server.update() for server calls — never synchronous GlideRecord from client',
        'Use spUtil.addInfoMessage() / addErrorMessage() for user feedback',
        'Always check c.data.error in template and show user-friendly message',
        'Load data server-side; only pass serializable values to data.X',
        'Use gs.getMessage() for all display strings — portal supports i18n',
        'Use portal theme CSS variables (--color-primary etc.) — never hardcode colors',
        'Add option_schema for all configurable values so pages can override per-instance',
      ],
      deploy_instructions: [
        '1. POST widget object to /api/now/table/sp_widget',
        '2. Add an instance of the widget to a portal page via the Page Designer',
        '3. Configure options per-page in the widget instance record',
        '4. Test with the Page Designer Preview before going live',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Update specific sections of an existing widget
  // ══════════════════════════════════════════════════════════════════════════
  buildWidgetUpdate({ widgetSysId, sections }) {
    const allowed = ['template', 'css', 'client_script', 'server_script', 'option_schema', 'demo_data'];
    const invalid  = Object.keys(sections).filter(k => !allowed.includes(k));
    if (invalid.length) throw new Error(`Invalid sections: ${invalid.join(', ')}. Allowed: ${allowed.join(', ')}`);

    return {
      action:       'update_widget',
      widget_sys_id: widgetSysId,
      patch:         sections,
      deploy_table:  'sp_widget',
      note:          `PATCH to /api/now/table/sp_widget/${widgetSysId} with the patch object.`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scaffold a new portal
  // ══════════════════════════════════════════════════════════════════════════
  buildPortal({ name, urlSuffix, description, pages = [], theme }) {
    const defaultPages = [
      { title: 'Home',     id: 'index',   public: true  },
      { title: 'Login',    id: 'login',   public: true  },
      { title: 'Profile',  id: 'profile', public: false },
      { title: 'Catalog',  id: 'catalog', public: false },
      ...pages,
    ];

    const themeTemplate = theme ?? {
      name:         `${name} Theme`,
      css_variables: `
/* ── Brand Colors ───────────────────────────────────────── */
--color-primary:    #293e40;
--color-secondary:  #e8a000;
--color-accent:     #3b9ddd;
--color-text:       #333333;
--color-text-muted: #757575;
--color-bg:         #f4f4f4;
--color-white:      #ffffff;

/* ── Typography ─────────────────────────────────────────── */
--font-primary:  'Source Sans Pro', sans-serif;
--font-size-base: 14px;
--line-height:   1.5;

/* ── Spacing ─────────────────────────────────────────────── */
--padding-xs: 4px;
--padding-sm: 8px;
--padding-md: 16px;
--padding-lg: 24px;
--padding-xl: 32px;

/* ── Borders ─────────────────────────────────────────────── */
--border-radius: 4px;
--border-color:  #ddd;
`.trim(),
    };

    return {
      portal: {
        deploy_table: 'sp_portal',
        payload: {
          title:      name,
          url_suffix: urlSuffix ?? name.toLowerCase().replace(/\s+/g, '-'),
          description,
        },
      },
      theme: {
        deploy_table: 'sp_theme',
        payload: themeTemplate,
      },
      pages: defaultPages.map(p => ({
        deploy_table: 'sp_page',
        payload: {
          title:      p.title,
          id:         p.id,
          public:     p.public,
          description: p.description ?? '',
        },
      })),
      deploy_order: ['theme', 'portal', 'pages'],
      note:         'Create theme first, then portal (link theme), then pages (link to portal).',
      best_practices: [
        'Always create a custom theme — never modify the baseline theme',
        'Use CSS variables in your theme for all colors and spacing',
        'Give every page a meaningful ID — it becomes the URL path',
        'Mark only truly public pages as public — all others require login',
        'Use Page Designer for page layout — avoid editing records directly',
        'Test every page in incognito (logged out) to verify auth behaviour',
      ],
    };
  }
}
