import { Progress } from '../utils/progress.js';

/**
 * Cleanup utility — deletes records created during a migration run.
 * Removes both staging table rows and target table records (e.g. incidents).
 * Always asks for explicit confirmation before deleting anything.
 */
export class MigrationCleanup {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Discover what was created ─────────────────────────────────────────────
  async discover({ stagingTable, targetTable, projectKeys = [], projectField = null, importSets = [] }) {
    const progress = new Progress(2, 'Cleanup Discovery');
    progress.section('Discovering Records to Clean Up');

    // Find staging rows — scope by project if a filter field is provided
    progress.step('Finding staging table records from this migration');
    let stagingQuery = 'ORDERBYDESCsys_created_on';
    if (projectKeys.length && projectField) {
      stagingQuery = `${projectField}IN${projectKeys.join(',')}^ORDERBYDESCsys_created_on`;
    } else if (projectKeys.length) {
      // Try common project field names
      stagingQuery = `u_jira_projectIN${projectKeys.join(',')}^ORDERBYDESCsys_created_on`;
    }
    const stagingRows = await this.sn.get(stagingTable, {
      sysparm_query:  stagingQuery,
      sysparm_fields: 'sys_id,sys_target_sys_id,sys_created_on',
      sysparm_limit:  '500',
      sysparm_display_value: 'true',
    });
    progress.ok(`Found ${stagingRows.length} staging records`);

    // Extract target sys_ids from staging rows
    progress.step(`Finding the ${targetTable} records that were created`);
    const targetSysIds = stagingRows
      .map(r => r.sys_target_sys_id?.link?.split('/').pop()
             ?? r.sys_target_sys_id?.value
             ?? r.sys_target_sys_id)
      .filter(id => id && id !== 'null');

    const targetRows = [];
    for (const sysId of targetSysIds) {
      try {
        const rec = await this.sn.getById(targetTable, sysId, {
          sysparm_fields: 'sys_id,sys_created_on',
          sysparm_display_value: 'true',
        });
        if (rec?.sys_id) targetRows.push(rec);
      } catch (_) {}
    }
    progress.ok(`Found ${targetRows.length} incidents linked to staging records`);

    return {
      staging: { table: stagingTable, count: stagingRows.length, rows: stagingRows },
      target:  { table: targetTable,  count: targetRows.length,  rows: targetRows },
    };
  }

  // ── Delete staging rows ───────────────────────────────────────────────────
  async cleanupStaging(stagingTable, rows) {
    const progress = new Progress(1, 'Staging Cleanup');
    progress.section(`Deleting ${rows.length} Staging Records`);
    progress.step(`Removing staging table records from "${stagingTable}"`);

    let deleted = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.sn.delete(stagingTable, rows[i].sys_id);
        deleted++;
        progress.batch(i + 1, rows.length, 'staging rows deleted');
      } catch (e) {
        failed++;
        progress.warn(`Could not delete staging row ${rows[i].sys_id}: ${e.message}`);
      }
    }

    progress.ok(`Deleted ${deleted} staging records${failed ? `, ${failed} failed` : ''}`);
    return { deleted, failed };
  }

  // ── Delete target records ─────────────────────────────────────────────────
  async cleanupTarget(targetTable, rows) {
    const progress = new Progress(1, 'Target Cleanup');
    progress.section(`Deleting ${rows.length} Incidents from ServiceNow`);
    progress.step(`Removing incidents from "${targetTable}"`);

    let deleted = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.sn.delete(targetTable, rows[i].sys_id);
        deleted++;
        progress.batch(i + 1, rows.length, 'incidents deleted');
      } catch (e) {
        failed++;
        progress.warn(`Could not delete incident ${rows[i].sys_id}: ${e.message}`);
      }
    }

    progress.ok(`Deleted ${deleted} incidents${failed ? `, ${failed} failed` : ''}`);
    return { deleted, failed };
  }

  // ── Full cleanup (staging + target) ──────────────────────────────────────
  async cleanupAll({ stagingTable, targetTable, projectKeys = [], projectField = null }) {
    const discovery = await this.discover({ stagingTable, targetTable, projectKeys, projectField });

    const stagingResult = await this.cleanupStaging(stagingTable, discovery.staging.rows);
    const targetResult  = await this.cleanupTarget(targetTable,  discovery.target.rows);

    return {
      staging: { ...stagingResult, table: stagingTable },
      target:  { ...targetResult,  table: targetTable  },
      summary: `Removed ${stagingResult.deleted} staging rows and ${targetResult.deleted} ${targetTable} records`,
    };
  }

  // ── Discover migration artifacts in SN (tables, maps, scripts, columns) ──
  async discoverArtifacts({ stagingTable, targetTable, platform, objectName }) {
    const progress = new Progress(4, 'Artifact Discovery');
    progress.section('Discovering Migration Artifacts in ServiceNow');

    const transformMapName = `${stagingTable}_to_${targetTable}`;
    const dataSourceName   = `${stagingTable}_datasource`;
    const restMessageName  = `Pull ${platform} ${objectName} Records`;

    progress.step('Looking up staging table');
    const table = await this.sn.findStagingTable(stagingTable);
    progress.ok(table ? `Staging table found: ${stagingTable}` : `Staging table not found: ${stagingTable}`);

    progress.step('Looking up transform map, field maps and transform scripts');
    const transformMap = await this.sn.findTransformMap(transformMapName);
    let fieldMaps = [], transformScripts = [];
    if (transformMap) {
      [fieldMaps, transformScripts] = await Promise.all([
        this.sn.findFieldMaps(transformMap.sys_id),
        this.sn.findTransformScripts(transformMap.sys_id),
      ]);
    }
    progress.ok(transformMap
      ? `Transform map found: ${transformMapName} (${fieldMaps.length} field maps, ${transformScripts.length} transform scripts)`
      : `Transform map not found: ${transformMapName}`);

    progress.step('Looking up data source and REST message');
    const [dataSource, restMessage] = await Promise.all([
      this.sn.findDataSource(dataSourceName),
      this.sn.findRestMessage(restMessageName),
    ]);
    progress.ok([
      dataSource  ? `Data source found: ${dataSourceName}`   : null,
      restMessage ? `REST message found: ${restMessageName}` : null,
    ].filter(Boolean).join(', ') || 'No data source or REST message found');

    progress.step('Looking up staging table columns');
    const columns = table ? await this.sn.findStagingColumns(stagingTable) : [];
    progress.ok(`${columns.length} staging columns found`);

    return {
      stagingTable:     table        ? { sys_id: table.sys_id,         name: stagingTable,    exists: true  } : { exists: false, name: stagingTable },
      transformMap:     transformMap ? { sys_id: transformMap.sys_id,   name: transformMapName, exists: true } : { exists: false, name: transformMapName },
      fieldMaps,
      transformScripts,
      dataSource:       dataSource   ? { sys_id: dataSource.sys_id,    name: dataSourceName,  exists: true  } : { exists: false, name: dataSourceName },
      restMessage:      restMessage  ? { sys_id: restMessage.sys_id,   name: restMessageName, exists: true  } : { exists: false, name: restMessageName },
      columns,
    };
  }

  // ── Delete all migration artifacts ────────────────────────────────────────
  async cleanupArtifacts({ stagingTable, targetTable, platform, objectName }) {
    const artifacts = await this.discoverArtifacts({ stagingTable, targetTable, platform, objectName });
    const progress  = new Progress(6, 'Artifact Cleanup');
    progress.section('Removing Migration Artifacts from ServiceNow');

    const report = { deleted: [], failed: [] };

    const tryDelete = async (table, sysId, label) => {
      try {
        await this.sn.delete(table, sysId);
        report.deleted.push(label);
        return true;
      } catch (e) {
        report.failed.push(`${label} — ${e.message}`);
        return false;
      }
    };

    // 1. Field maps (before transform map)
    if (artifacts.fieldMaps.length) {
      progress.step(`Deleting ${artifacts.fieldMaps.length} field map(s)`);
      for (const fm of artifacts.fieldMaps) await tryDelete('sys_transform_entry', fm.sys_id, `field_map:${fm.target_field ?? fm.sys_id}`);
      progress.ok(`${artifacts.fieldMaps.length} field map(s) processed`);
    } else { progress.info('No field maps found'); }

    // 2. Transform scripts (before transform map)
    if (artifacts.transformScripts.length) {
      progress.step(`Deleting ${artifacts.transformScripts.length} transform script(s)`);
      for (const ts of artifacts.transformScripts) await tryDelete('sys_transform_script', ts.sys_id, `transform_script:${ts.field_name ?? ts.sys_id}`);
      progress.ok(`${artifacts.transformScripts.length} transform script(s) processed`);
    } else { progress.info('No transform scripts found'); }

    // 3. Transform map
    if (artifacts.transformMap.exists) {
      progress.step(`Deleting transform map: ${artifacts.transformMap.name}`);
      const ok = await tryDelete('sys_transform_map', artifacts.transformMap.sys_id, `transform_map:${artifacts.transformMap.name}`);
      if (ok) progress.ok('Transform map removed'); else progress.warn('Could not delete transform map — check permissions');
    } else { progress.info('No transform map found'); }

    // 4. Staging columns (before table drop)
    if (artifacts.columns.length) {
      progress.step(`Deleting ${artifacts.columns.length} staging column definition(s)`);
      for (const col of artifacts.columns) await tryDelete('sys_dictionary', col.sys_id, `column:${col.element}`);
      progress.ok(`${artifacts.columns.length} column definition(s) processed`);
    } else { progress.info('No staging columns found'); }

    // 5. Staging table
    if (artifacts.stagingTable.exists) {
      progress.step(`Deleting staging table: ${artifacts.stagingTable.name}`);
      const ok = await tryDelete('sys_db_object', artifacts.stagingTable.sys_id, `staging_table:${artifacts.stagingTable.name}`);
      if (ok) progress.ok('Staging table removed'); else progress.warn('Could not delete staging table — check permissions');
    } else { progress.info('No staging table found'); }

    // 6. Data source + REST message
    progress.step('Deleting data source and REST message');
    if (artifacts.dataSource.exists)  await tryDelete('sys_data_source',   artifacts.dataSource.sys_id,  `data_source:${artifacts.dataSource.name}`);
    if (artifacts.restMessage.exists) await tryDelete('sys_rest_message',  artifacts.restMessage.sys_id, `rest_message:${artifacts.restMessage.name}`);
    if (artifacts.dataSource.exists || artifacts.restMessage.exists) progress.ok('Data source and REST message processed');
    else progress.info('No data source or REST message found');

    progress.done(`Artifact cleanup done — ${report.deleted.length} removed${report.failed.length ? `, ${report.failed.length} could not be deleted` : ''}`);
    return {
      deleted: report.deleted,
      failed:  report.failed,
      summary: `Removed ${report.deleted.length} migration artifact(s) from ServiceNow${report.failed.length ? ` (${report.failed.length} failed — may need manual deletion or higher permissions)` : ''}`,
    };
  }
}
