import { logger } from '../utils/logger.js';

/**
 * Builds all Phase 4 artifacts in ServiceNow:
 * staging table, columns, transform map, field maps, transform scripts, data source, REST message.
 */
export class ArtifactBuilder {
  constructor(sn) {
    this.sn = sn;
    this.results = {};
  }

  async build({ stagingDef, mappings, targetTable, platform, objectName, sourceBaseUrl }) {
    logger.header('Phase 4 — Building ServiceNow Artifacts');
    const results = {};

    // 4.1 Staging table
    logger.step('4.1 Creating staging table...');
    const parentSysId = await this.sn.getImportSetRowSysId();
    try {
      const table = await this.sn.createStagingTable(stagingDef.tableName, stagingDef.label, parentSysId);
      results.stagingTable = { name: stagingDef.tableName, sys_id: table.sys_id };
      logger.success(`Staging table: ${stagingDef.tableName} (${table.sys_id})`);
    } catch (e) {
      if (e.message.includes('403')) {
        logger.warn('Permission denied for sys_db_object. Manual step required:');
        logger.warn(`  System Definition → Tables → New → Name: ${stagingDef.tableName}, extends: sys_import_set_row`);
        results.stagingTable = { name: stagingDef.tableName, sys_id: null, manual: true };
      } else throw e;
    }

    // 4.2 Staging columns
    logger.step('4.2 Creating staging columns...');
    let colsOk = 0, colsFailed = 0;
    for (const col of stagingDef.columns) {
      try {
        await this.sn.createStagingColumn(
          stagingDef.tableName, col.element, col.column_label, col.internal_type, col.max_length
        );
        colsOk++;
      } catch (e) {
        if (e.message.includes('403')) {
          logger.warn(`  Manual column needed: ${col.element} (${col.internal_type})`);
          colsFailed++;
        } else {
          logger.warn(`  Column ${col.element} skipped: ${e.message}`);
          colsFailed++;
        }
      }
    }
    logger.success(`Columns: ${colsOk} created${colsFailed ? `, ${colsFailed} need manual addition` : ''}`);
    results.columns = { ok: colsOk, failed: colsFailed };

    // 4.3 Transform map
    logger.step('4.3 Creating transform map...');
    const mapName = `${stagingDef.tableName}_to_${targetTable}`;
    const tmResult = await this.sn.createTransformMap(mapName, stagingDef.tableName, targetTable);
    results.transformMap = { name: mapName, sys_id: tmResult.sys_id };
    logger.success(`Transform map: ${mapName} (${tmResult.sys_id})`);

    // 4.4 Field maps
    logger.step('4.4 Creating field maps...');
    let mapsOk = 0;
    for (const m of mappings.filter(m => m.sn_target)) {
      await this.sn.createFieldMap(
        tmResult.sys_id, m.staging_field, m.sn_target,
        m.coalesce,
        m.is_reference && m.reference_value ? m.reference_value : null
      );
      mapsOk++;
    }
    logger.success(`Field maps: ${mapsOk} created`);
    results.fieldMaps = mapsOk;

    // 4.5 Transform scripts
    const scriptMappings = mappings.filter(m => m.transform_script);
    if (scriptMappings.length) {
      logger.step('4.5 Creating transform scripts...');
      let order = 100;
      for (const m of scriptMappings) {
        await this.sn.createTransformScript(tmResult.sys_id, m.sn_target, m.transform_script, order);
        order += 100;
      }
      logger.success(`Transform scripts: ${scriptMappings.length} created`);
    }
    results.scripts = scriptMappings.length;

    // 4.6 Data source
    logger.step('4.6 Creating data source...');
    const dsName   = `${stagingDef.tableName}_datasource`;
    const dsResult = await this.sn.createDataSource(dsName, stagingDef.tableName);
    results.dataSource = { name: dsName, sys_id: dsResult.sys_id };
    logger.success(`Data source: ${dsName} (${dsResult.sys_id})`);

    // 4.7 REST Message
    logger.step('4.7 Creating outbound REST Message...');
    const rmName   = `Pull ${platform} ${objectName} Records`;
    const rmResult = await this.sn.createRestMessage(rmName, sourceBaseUrl);
    results.restMessage = { name: rmName, sys_id: rmResult.sys_id };
    logger.success(`REST Message: ${rmName} (${rmResult.sys_id})`);

    this.results = results;
    return results;
  }

  printSummary(instanceUrl) {
    logger.header('Checkpoint 3 — Artifact Summary');
    const r = this.results;
    const ok  = (label, sysId) => logger.success(`${label.padEnd(30)} ${sysId ? `(${sysId})` : '— manual step needed'}`);
    const info = (label, val)  => logger.info(`${label.padEnd(30)} ${val}`);

    ok('Staging table', r.stagingTable?.sys_id);
    info('Columns', `${r.columns?.ok} created${r.columns?.failed ? `, ${r.columns?.failed} manual` : ''}`);
    ok('Transform map', r.transformMap?.sys_id);
    info('Field maps', String(r.fieldMaps));
    info('Transform scripts', String(r.scripts));
    ok('Data source', r.dataSource?.sys_id);
    ok('REST Message', r.restMessage?.sys_id);

    if (r.stagingTable?.sys_id) {
      console.log(`\n  Transform map: ${instanceUrl}/nav_to.do?uri=sys_transform_map.do?sys_id=${r.transformMap.sys_id}`);
    }
  }
}
