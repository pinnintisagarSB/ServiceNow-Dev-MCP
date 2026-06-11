import { Progress } from '../utils/progress.js';

/**
 * Field mapping strategy (best practice):
 *
 *   FIELD MAP SCRIPT (use_source_script=true on sys_transform_entry)
 *     ✓ Single source field → single target field with value translation
 *     ✓ Picklist / status / priority mapping (e.g. High → 1)
 *     ✓ String manipulation (join array, trim, format date)
 *     ✓ Simple conditional on one source value
 *
 *   TRANSFORM SCRIPT (sys_transform_script, when=onBefore)
 *     ✓ Logic that reads or writes multiple target fields at once
 *     ✓ GlideRecord lookups (e.g. find user by email across two fields)
 *     ✓ Complex conditional spanning several source values
 *
 *   REFERENCE FIELD MAP (reference_value set, no script)
 *     ✓ Reference fields (caller_id, assigned_to) resolved by a display value
 *
 * This builder analyses each mapping and picks the correct approach automatically.
 */
export class ArtifactBuilder {
  constructor(sn) {
    this.sn      = sn;
    this.results = {};
  }

  // ── Decide approach for each mapping ─────────────────────────────────────
  _classifyMapping(m) {
    if (!m.sn_target) return 'skip';

    // Reference fields resolved by display value — no script needed
    if (m.is_reference && m.reference_value) return 'reference';

    // Script that touches multiple fields or uses GlideRecord → transform script
    // needs_script:true with no explicit script also goes through field_map_script path
    // (a default inline script will be generated at build time)
    if (m.transform_script || m.needs_script) {
      const s = m.transform_script ?? '';
      if (s.includes('GlideRecord') || (s.match(/answer\s*=/g) ?? []).length > 1) {
        return 'transform_script';
      }
      return 'field_map_script';
    }

    return 'direct';
  }

  // ── Default inline field map scripts for common field types ──────────────
  // These are sensible starting points; users can customise them after the
  // transform map is created.
  _defaultScript(m) {
    const f = m.staging_field;
    const t = m.source_type ?? '';
    const target = m.sn_target ?? '';

    // Jira priority / SF Priority → SN priority integer (1 = Critical … 5 = Lowest)
    if (t === 'priority' || target === 'priority') {
      return (
        `var _p = source.getValue('${f}');\n` +
        `answer = ({Highest:'1',Critical:'1',High:'2',Medium:'3',Low:'4',Lowest:'5'})[_p] || '3';`
      );
    }

    // Jira status → SN state integer
    if (t === 'status' || target === 'state') {
      return (
        `var _s = source.getValue('${f}');\n` +
        `answer = ({'To Do':'1','Open':'1','Backlog':'1','In Progress':'2','In Review':'2',` +
        `'Done':'7','Closed':'7','Resolved':'6',"Won't Fix":'8'})[_s] || '1';`
      );
    }

    // Array / list fields → join to comma-separated string
    if (['array', 'list', 'combobox'].includes(t)) {
      return (
        `var _v = source.getValue('${f}');\n` +
        `try { answer = JSON.parse(_v || '[]').join(', '); } catch(e) { answer = _v || ''; }`
      );
    }

    // Boolean → SN true/false string
    if (t === 'boolean') {
      return (
        `var _b = source.getValue('${f}');\n` +
        `answer = (_b === 'true' || _b === '1') ? 'true' : 'false';`
      );
    }

    // String → integer (e.g. story points, votes)
    if (target && ['integer', 'decimal', 'float'].includes(target)) {
      return (
        `var _n = parseInt(source.getValue('${f}'), 10);\n` +
        `answer = isNaN(_n) ? null : String(_n);`
      );
    }

    // Nested option/resolution objects — extract the .name value stored as JSON
    if (['option', 'resolution'].includes(t)) {
      return (
        `var _o = source.getValue('${f}');\n` +
        `try { answer = JSON.parse(_o || '{}').name || _o || ''; } catch(e) { answer = _o || ''; }`
      );
    }

    // Jira issuetype → SN category
    if (t === 'issuetype' || target === 'category') {
      return (
        `var _i = source.getValue('${f}');\n` +
        `answer = ({Bug:'software',Task:'request',Story:'request','Sub-task':'request',Epic:'request',Improvement:'enhancement'})[_i] || 'request';`
      );
    }

    // Generic picklist / anything else with needs_script — pass value through;
    // user should review and add a value map if needed
    return `answer = source.getValue('${f}');`;
  }

  // ── Analyse mappings and return a human-readable plan ─────────────────────
  analyzeMappings(mappings) {
    return mappings.map(m => ({
      ...m,
      approach: this._classifyMapping(m),
    }));
  }

  // ── Check what already exists in SN (idempotency pre-scan) ──────────────
  async checkExisting({ stagingDef, targetTable, platform, objectName }) {
    const mapName  = `${stagingDef.tableName}_to_${targetTable}`;
    const dsName   = `${stagingDef.tableName}_datasource`;
    const rmName   = `Pull ${platform} ${objectName} Records`;

    const [table, transformMap, dataSource, restMessage] = await Promise.all([
      this.sn.findStagingTable(stagingDef.tableName),
      this.sn.findTransformMap(mapName),
      this.sn.findDataSource(dsName),
      this.sn.findRestMessage(rmName),
    ]);

    let existingColumns   = [];
    let existingFieldMaps = [];
    let existingTxScripts = [];

    if (table) {
      existingColumns = await this.sn.findStagingColumns(stagingDef.tableName);
    }
    if (transformMap) {
      [existingFieldMaps, existingTxScripts] = await Promise.all([
        this.sn.findFieldMaps(transformMap.sys_id),
        this.sn.findTransformScripts(transformMap.sys_id),
      ]);
    }

    return {
      stagingTable:    table   ? { ...table,   exists: true  } : { name: stagingDef.tableName, exists: false },
      transformMap:    transformMap ? { ...transformMap, exists: true } : { name: mapName, exists: false },
      dataSource:      dataSource   ? { ...dataSource,  exists: true } : { name: dsName,  exists: false },
      restMessage:     restMessage  ? { ...restMessage, exists: true } : { name: rmName,  exists: false },
      existingColumns,
      existingFieldMaps,
      existingTxScripts,
    };
  }

  // ── Build all Phase 4 artifacts (idempotent — skips anything already present) ─
  async build({ stagingDef, mappings, targetTable, platform, objectName, sourceBaseUrl }) {
    const progress = new Progress(6, 'Building ServiceNow Artifacts');
    progress.section('Setting Up ServiceNow Migration Artifacts');

    // Pre-scan: find what's already in ServiceNow
    progress.step('Checking ServiceNow for existing migration artifacts (tables, maps, scripts)');
    const existing = await this.checkExisting({ stagingDef, targetTable, platform, objectName });

    const existingColNames     = new Set(existing.existingColumns.map(c => c.element));
    const existingFieldTargets = new Set(existing.existingFieldMaps.map(f => f.target_field));
    const existingTxTargets    = new Set(existing.existingTxScripts.map(s => s.field_name));

    const skipped = [];
    if (existing.stagingTable.exists)  skipped.push('staging table');
    if (existing.transformMap.exists)  skipped.push('transform map');
    if (existing.dataSource.exists)    skipped.push('data source');
    if (existing.restMessage.exists)   skipped.push('REST message');
    if (skipped.length) {
      progress.info(`Already in ServiceNow — will skip: ${skipped.join(', ')}`);
    } else {
      progress.info('No existing artifacts found — will create everything fresh');
    }

    const classified = this.analyzeMappings(mappings);
    const results    = {};

    // Log what we're about to do
    const direct    = classified.filter(m => m.approach === 'direct').length;
    const scripted  = classified.filter(m => m.approach === 'field_map_script').length;
    const refs      = classified.filter(m => m.approach === 'reference').length;
    const txScripts = classified.filter(m => m.approach === 'transform_script').length;
    progress.info(`Field mapping plan: ${direct} direct, ${scripted} with value transforms, ${refs} reference lookups, ${txScripts} complex scripts`);

    // 4.1 Staging table
    progress.step(`${existing.stagingTable.exists ? 'Using existing' : 'Creating'} the staging table where source data will land temporarily`);
    if (existing.stagingTable.exists) {
      results.stagingTable = { name: stagingDef.tableName, sys_id: existing.stagingTable.sys_id, reused: true };
      progress.ok(`Staging table already exists: ${stagingDef.tableName}`);
    } else {
      const parentSysId = await this.sn.getImportSetRowSysId();
      try {
        const table = await this.sn.createStagingTable(stagingDef.tableName, stagingDef.label, parentSysId);
        results.stagingTable = { name: stagingDef.tableName, sys_id: table.sys_id };
        progress.ok(`Staging table created: ${stagingDef.tableName}`);
      } catch (e) {
        if (e.message.includes('403')) {
          progress.warn('No permission to create the table automatically — you will need to create it manually in ServiceNow:');
          progress.warn(`  Go to System Definition → Tables → New → Name: ${stagingDef.tableName}, Extends: sys_import_set_row`);
          results.stagingTable = { name: stagingDef.tableName, sys_id: null, manual: true };
        } else throw e;
      }
    }

    // 4.2 Staging columns (only add missing ones)
    progress.step('Adding any missing columns to the staging table');
    let colsOk = 0, colsSkipped = 0, colsFailed = 0;
    for (const col of stagingDef.columns) {
      const dbElement = col.element.startsWith('u_') ? col.element : `u_${col.element}`;
      if (existingColNames.has(col.element) || existingColNames.has(dbElement)) {
        colsSkipped++;
        continue;
      }
      try {
        await this.sn.createStagingColumn(
          stagingDef.tableName, col.element, col.column_label, col.internal_type, col.max_length
        );
        colsOk++;
      } catch (e) {
        progress.warn(`Column "${col.column_label}" skipped: ${e.message.includes('403') ? 'permission denied' : e.message}`);
        colsFailed++;
      }
    }
    const colMsg = [
      colsOk      ? `${colsOk} new columns added`       : '',
      colsSkipped ? `${colsSkipped} already existed`     : '',
      colsFailed  ? `${colsFailed} failed`               : '',
    ].filter(Boolean).join(', ');
    progress.ok(`Staging columns: ${colMsg || 'none needed'}`);
    results.columns = { ok: colsOk, skipped: colsSkipped, failed: colsFailed };

    // 4.3 Transform map
    progress.step(`${existing.transformMap.exists ? 'Using existing' : 'Creating'} the transform map`);
    let tmResult;
    if (existing.transformMap.exists) {
      tmResult = existing.transformMap;
      results.transformMap = { name: existing.transformMap.name, sys_id: existing.transformMap.sys_id, reused: true };
      progress.ok(`Transform map already exists: ${existing.transformMap.name}`);
    } else {
      const mapName = `${stagingDef.tableName}_to_${targetTable}`;
      tmResult      = await this.sn.createTransformMap(mapName, stagingDef.tableName, targetTable);
      results.transformMap = { name: mapName, sys_id: tmResult.sys_id };
      progress.ok(`Transform map created: ${mapName}`);
    }

    // 4.4 Field maps — only add mappings that don't already exist
    progress.step('Setting up field-by-field mapping rules (skipping any already configured)');
    let directCount = 0, scriptedCount = 0, refCount = 0, txScriptCount = 0;
    let fmSkipped   = 0;

    for (const m of classified) {
      if (m.approach === 'skip') continue;

      // Skip if this target field already has a field map
      if (existingFieldTargets.has(m.sn_target)) { fmSkipped++; continue; }

      const refValue = m.is_reference && m.reference_value ? m.reference_value : null;

      if (m.approach === 'field_map_script') {
        const rawScript = m.transform_script ?? this._defaultScript(m);
        const script = this._wrapScript(rawScript, m.staging_field);
        await this.sn.createFieldMap(tmResult.sys_id, m.staging_field, m.sn_target, m.coalesce, null, script);
        scriptedCount++;
      } else if (m.approach === 'reference') {
        await this.sn.createFieldMap(tmResult.sys_id, m.staging_field, m.sn_target, m.coalesce, refValue);
        refCount++;
      } else if (m.approach === 'direct') {
        await this.sn.createFieldMap(tmResult.sys_id, m.staging_field, m.sn_target, m.coalesce, null);
        directCount++;
      }
    }
    const fmMsg = `${directCount} direct, ${scriptedCount} with inline scripts, ${refCount} reference lookups${fmSkipped ? `, ${fmSkipped} already existed` : ''}`;
    progress.ok(`Field maps: ${fmMsg}`);
    results.fieldMaps = { direct: directCount, scripted: scriptedCount, references: refCount, skipped: fmSkipped };

    // 4.5 Complex transform scripts (only add missing)
    const txMappings = classified.filter(m => m.approach === 'transform_script');
    if (txMappings.length) {
      progress.step('Adding any missing complex transform scripts (multi-field logic)');
      let order = 100;
      let txSkipped = 0;
      for (const m of txMappings) {
        if (existingTxTargets.has(m.sn_target)) { txSkipped++; order += 100; continue; }
        await this.sn.createTransformScript(tmResult.sys_id, m.sn_target, m.transform_script, order);
        order += 100;
        txScriptCount++;
      }
      progress.ok(`${txScriptCount} complex transform script(s) created${txSkipped ? `, ${txSkipped} already existed` : ''}`);
    }
    results.transformScripts = txScriptCount;

    // 4.6 Data source
    progress.step('Registering the data source and outbound REST connection (if not already there)');
    const dsName = `${stagingDef.tableName}_datasource`;
    if (existing.dataSource.exists) {
      results.dataSource = { name: existing.dataSource.name, sys_id: existing.dataSource.sys_id, reused: true };
      progress.info('Data source already exists — reusing');
    } else {
      const dsResult = await this.sn.createDataSource(dsName, stagingDef.tableName);
      results.dataSource = { name: dsName, sys_id: dsResult.sys_id };
    }

    const rmName = `Pull ${platform} ${objectName} Records`;
    if (existing.restMessage.exists) {
      results.restMessage = { name: existing.restMessage.name, sys_id: existing.restMessage.sys_id, reused: true };
      progress.info('REST message already exists — reusing');
    } else {
      const rmResult = await this.sn.createRestMessage(rmName, sourceBaseUrl);
      results.restMessage = { name: rmName, sys_id: rmResult.sys_id };
    }
    progress.ok('Data source and REST connection ready');

    const totalMapped = directCount + scriptedCount + refCount;
    progress.done(`ServiceNow artifacts ready — ${totalMapped} field mappings configured (${fmSkipped} already existed)`);
    this.results = results;
    return results;
  }

  // Ensure script body correctly sets `answer`
  _wrapScript(expression, stagingField) {
    if (expression.includes('answer') && expression.includes('=')) return expression;
    return `answer = (${expression});`;
  }

  printSummary(instanceUrl) {
    const r = this.results;
    process.stderr.write('\n  What was created in ServiceNow:\n');
    process.stderr.write(`    Staging table  : ${r.stagingTable?.name} ${r.stagingTable?.sys_id ? '✓' : '— manual step needed'}\n`);
    process.stderr.write(`    Transform map  : ${r.transformMap?.name} ✓\n`);
    process.stderr.write(`    Field maps     : ${(r.fieldMaps?.direct ?? 0) + (r.fieldMaps?.scripted ?? 0) + (r.fieldMaps?.references ?? 0)} total\n`);
    process.stderr.write(`    Data source    : ${r.dataSource?.name} ✓\n`);
    if (r.transformMap?.sys_id) {
      process.stderr.write(`\n    View in ServiceNow:\n    ${instanceUrl}/nav_to.do?uri=sys_transform_map.do?sys_id=${r.transformMap.sys_id}\n`);
    }
  }
}
