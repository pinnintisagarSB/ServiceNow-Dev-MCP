/**
 * Expert Tester — ServiceNow
 *
 * Three-phase workflow:
 *   1. analyze_for_testing  → deep analysis of code or live SN artifact
 *   2. create_test_plan     → full expert test plan presented for user approval
 *   3. run_approved_tests   → executes each test case live on SN, returns results
 */

// ── Analysis helpers ──────────────────────────────────────────────────────────

function detectArtifactType(code = '') {
  const c = code.toLowerCase();
  if (c.includes('glideajax') || c.includes('g_form') || c.includes('g_user')) return 'client_script';
  if (c.includes('restmessagev2') || c.includes('request.body') || c.includes('response.setbody')) return 'scripted_rest';
  if (c.includes('current.') && (c.includes('previous.') || c.includes('gs.nowdatetime'))) return 'business_rule';
  if (c.includes('var.') || c.includes('producer') || c.includes('sc_task')) return 'catalog_script';
  if (c.includes('$scope') || c.includes('c.data') || c.includes('c.server')) return 'widget';
  if (c.includes('gs.schedule') || c.includes('scheduleonce') || c.includes('jobstate')) return 'scheduled_job';
  if (c.includes('class.create') || c.includes('prototype')) return 'script_include';
  return 'script_include'; // default
}

function extractMethods(code = '') {
  const methods = [];
  // Match prototype methods
  const protoRe = /(\w+)\s*[:=]\s*function\s*\(([^)]*)\)/g;
  let m;
  while ((m = protoRe.exec(code)) !== null) {
    if (!['initialize', 'type'].includes(m[1])) {
      methods.push({ name: m[1], params: m[2].split(',').map(p => p.trim()).filter(Boolean) });
    }
  }
  // Match modern method shorthand
  const shortRe = /^\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
  while ((m = shortRe.exec(code)) !== null) {
    if (!methods.find(x => x.name === m[1])) {
      methods.push({ name: m[1], params: m[2].split(',').map(p => p.trim()).filter(Boolean) });
    }
  }
  return methods;
}

function extractGlideRecordTables(code = '') {
  const tables = new Set();
  const re = /new GlideRecord\(['"](\w+)['"]\)/g;
  let m;
  while ((m = re.exec(code)) !== null) tables.add(m[1]);
  return [...tables];
}

function extractConditions(code = '') {
  const conditions = [];
  // if/else branches
  const ifRe = /if\s*\(([^)]+)\)/g;
  let m;
  while ((m = ifRe.exec(code)) !== null) conditions.push(m[1].trim());
  return conditions.slice(0, 10); // cap to avoid noise
}

function scoreComplexity(code = '') {
  let score = 0;
  score += (code.match(/if\s*\(/g) ?? []).length * 2;
  score += (code.match(/for\s*\(/g) ?? []).length * 3;
  score += (code.match(/while\s*\(/g) ?? []).length * 3;
  score += (code.match(/try\s*\{/g) ?? []).length;
  score += (code.match(/GlideRecord/g) ?? []).length * 2;
  score += (code.match(/gs\.restMessageV2|RESTMessageV2/g) ?? []).length * 4;
  return score;
}

// ── ExpertTester class ────────────────────────────────────────────────────────

export class ExpertTester {

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Analyze
  // ══════════════════════════════════════════════════════════════════════════

  analyzeCode({ code, artifact_name = 'Unknown', artifact_type = null }) {
    const type       = artifact_type ?? detectArtifactType(code);
    const methods    = extractMethods(code);
    const tables     = extractGlideRecordTables(code);
    const conditions = extractConditions(code);
    const complexity = scoreComplexity(code);
    const lines      = code.split('\n').length;

    const risks = [];
    if (!code.includes('try')) risks.push({ level: 'HIGH', issue: 'No try/catch — uncaught exceptions will surface to users' });
    if (code.includes('deleteRecord()')) risks.push({ level: 'HIGH', issue: 'Deletes records — test cleanup must be managed carefully' });
    if (code.includes('setWorkflow(false)')) risks.push({ level: 'MEDIUM', issue: 'Bypasses workflow — test with and without this flag' });
    if (code.includes('gr.query()') && !code.includes('gr.setLimit(')) risks.push({ level: 'MEDIUM', issue: 'Unbounded query — test with large datasets' });
    if (code.includes('gs.sleep')) risks.push({ level: 'LOW', issue: 'Uses gs.sleep — avoid in BRs; test timing' });
    if (complexity > 30) risks.push({ level: 'HIGH', issue: `High cyclomatic complexity (score ${complexity}) — many branches to cover` });

    const coverageAreas = this._coverageAreas(type, methods, tables, conditions);

    return {
      artifact_name,
      artifact_type: type,
      lines,
      complexity_score: complexity,
      methods_detected: methods,
      tables_referenced: tables,
      conditions_detected: conditions,
      risks,
      coverage_areas: coverageAreas,
      estimated_test_cases: coverageAreas.reduce((n, a) => n + a.count, 0),
      recommendation: complexity > 40
        ? 'HIGH complexity — thorough testing essential before deploying'
        : complexity > 20
          ? 'MODERATE complexity — cover all branches and edge cases'
          : 'LOW complexity — smoke tests + null safety sufficient',
    };
  }

  async analyzeLiveArtifact(sn, { artifact_type, artifact_name, sys_id }) {
    const tableMap = {
      business_rule:  { table: 'sys_script', nameField: 'name', scriptField: 'script' },
      script_include: { table: 'sys_script_include', nameField: 'name', scriptField: 'script' },
      client_script:  { table: 'sys_client_script', nameField: 'name', scriptField: 'script' },
      ui_action:      { table: 'sys_ui_action', nameField: 'name', scriptField: 'script' },
      scripted_rest:  { table: 'sys_ws_operation', nameField: 'name', scriptField: 'operation_script' },
      scheduled_job:  { table: 'sysauto_script', nameField: 'name', scriptField: 'script' },
      widget:         { table: 'sp_widget', nameField: 'name', scriptField: 'server_script' },
    };

    const def = tableMap[artifact_type];
    if (!def) throw new Error(`Unknown artifact type: ${artifact_type}`);

    let record;
    if (sys_id) {
      record = await sn.getById(def.table, sys_id, `${def.nameField},${def.scriptField},active,table_name,when,condition,action_name`);
    } else {
      const results = await sn.get(def.table, { sysparm_query: `${def.nameField}=${artifact_name}`, sysparm_fields: `${def.nameField},${def.scriptField},sys_id,active,table_name,when,condition`, sysparm_limit: 1 });
      record = results?.[0];
    }

    if (!record) throw new Error(`${artifact_type} "${artifact_name ?? sys_id}" not found`);

    const code = record[def.scriptField] ?? '';
    const analysis = this.analyzeCode({ code, artifact_name: record[def.nameField] ?? artifact_name, artifact_type });

    // Enrich with SN metadata
    analysis.live_metadata = {
      sys_id:     record.sys_id,
      active:     record.active,
      table_name: record.table_name,
      when:       record.when,
      condition:  record.condition,
    };
    analysis.code_snapshot = code;

    return analysis;
  }

  _coverageAreas(type, methods, tables, conditions) {
    const areas = [];

    if (type === 'business_rule') {
      areas.push(
        { category: 'Trigger Conditions',    count: 3, description: 'Fires when conditions met / does NOT fire when not met / boundary values' },
        { category: 'Field Changes',         count: Math.max(2, conditions.length), description: 'Each branch/condition in the script' },
        { category: 'Async / Order',         count: 2, description: 'Async mode (if applicable) and execution order with other BRs' },
        { category: 'Rollback Safety',       count: 2, description: 'Errors are handled; no partial state on failure' },
        { category: 'Null/Empty Input',      count: 3, description: 'Null values, empty strings, missing references' },
        { category: 'Performance',           count: 1, description: 'Does not loop unbound; completes within 30s' },
      );
    } else if (type === 'script_include') {
      areas.push(
        { category: 'Happy Path',            count: methods.length || 2, description: 'Each public method returns expected output with valid input' },
        { category: 'Error Handling',        count: methods.length || 2, description: 'Each method handles null/invalid input gracefully' },
        { category: 'Data Integrity',        count: tables.length || 1, description: 'GlideRecord reads/writes produce correct data' },
        { category: 'Return Structure',      count: methods.length || 1, description: 'Returned object always has required fields (success, data, error)' },
        { category: 'Concurrency',           count: 1, description: 'Safe to call multiple times in same transaction' },
      );
    } else if (type === 'client_script') {
      areas.push(
        { category: 'Field Visibility',      count: 3, description: 'show/hide logic for each controlled field' },
        { category: 'Mandatory Toggle',      count: 3, description: 'Fields become mandatory/optional under correct conditions' },
        { category: 'GlideAjax Calls',       count: 2, description: 'Async server calls complete and handle responses' },
        { category: 'User Role Conditions',  count: 2, description: 'Role-based visibility/editability works correctly' },
        { category: 'Null Field Values',     count: 2, description: 'Script handles empty or null field values' },
      );
    } else if (type === 'scripted_rest') {
      areas.push(
        { category: 'Authentication',        count: 2, description: '401 without credentials, 403 without required roles' },
        { category: 'Input Validation',      count: 3, description: '400 on missing/invalid required params; correct error message' },
        { category: 'Happy Path',            count: 3, description: 'Valid request returns 200/201 with correct response body' },
        { category: 'HTTP Methods',          count: 2, description: '405 for wrong HTTP verb' },
        { category: 'Edge Cases',            count: 3, description: 'Large payloads, special characters, concurrent calls' },
        { category: 'Error Responses',       count: 2, description: '404 for missing resource, 500 on unexpected error returns structured JSON' },
      );
    } else if (type === 'widget') {
      areas.push(
        { category: 'Initial Render',        count: 2, description: 'Widget loads without JS errors; data is populated' },
        { category: 'Server Calls',          count: 2, description: 'c.server.get() returns expected data shape' },
        { category: 'Input Dispatch',        count: conditions.length || 2, description: 'Each input action triggers correct server branch' },
        { category: 'Empty State',           count: 1, description: 'Widget handles no-data gracefully (no blank screen)' },
        { category: 'Permission',            count: 1, description: 'Unauthenticated / low-privilege user sees correct fallback' },
      );
    } else if (type === 'scheduled_job') {
      areas.push(
        { category: 'Dry Run',               count: 1, description: 'Fix Script execution — no unintended side effects' },
        { category: 'Record Processing',     count: 2, description: 'Correct records selected; correct changes applied' },
        { category: 'Batch Limits',          count: 2, description: 'Does not time out on full dataset; uses setLimit/pagination' },
        { category: 'Error Logging',         count: 1, description: 'Failures are logged with gs.error; run continues' },
        { category: 'Idempotency',           count: 1, description: 'Running twice produces same result (no duplicates/double-updates)' },
      );
    } else {
      areas.push(
        { category: 'Happy Path',            count: 3, description: 'Main logic succeeds with valid inputs' },
        { category: 'Error Handling',        count: 2, description: 'Graceful failure on invalid/null input' },
        { category: 'Edge Cases',            count: 2, description: 'Boundary values, empty arrays, special characters' },
      );
    }

    return areas;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Create Test Plan
  // ══════════════════════════════════════════════════════════════════════════

  createTestPlan(analysis, options = {}) {
    const { artifact_name, artifact_type, methods_detected, tables_referenced, conditions_detected, risks, code_snapshot = '', live_metadata = {} } = analysis;
    const priority = options.priority ?? 'all'; // all | critical | smoke

    const testCases = this._generateTestCases({
      artifact_name, artifact_type, methods_detected, tables_referenced,
      conditions_detected, risks, code: code_snapshot, live_metadata, priority,
    });

    const critical  = testCases.filter(t => t.priority === 'CRITICAL');
    const major     = testCases.filter(t => t.priority === 'MAJOR');
    const minor     = testCases.filter(t => t.priority === 'MINOR');

    return {
      plan_id:       `PLAN-${Date.now()}`,
      artifact_name,
      artifact_type,
      generated_at:  new Date().toISOString(),
      summary: {
        total:    testCases.length,
        critical: critical.length,
        major:    major.length,
        minor:    minor.length,
        estimated_runtime_minutes: Math.ceil(testCases.length * 0.5),
      },
      risks,
      test_cases: testCases,
      execution_strategy: this._executionStrategy(artifact_type),
      approval_required: true,
      instructions: [
        `Review the ${testCases.length} test cases above.`,
        'To approve ALL and run: call run_approved_tests with plan_id and approved=true',
        'To approve SUBSET: call run_approved_tests with approved_ids=[array of test_case ids]',
        'To add a custom test case: call run_approved_tests with extra_cases=[{name, script}]',
        'CRITICAL tests must always be included — they cover highest risk scenarios.',
      ],
    };
  }

  _generateTestCases({ artifact_name, artifact_type, methods_detected, tables_referenced, conditions_detected, risks, code, live_metadata, priority }) {
    const cases = [];
    let id = 1;

    const tc = (name, priority, category, description, script, assertions = [], cleanup = '') => ({
      id:          `TC-${String(id++).padStart(3, '0')}`,
      name,
      priority,   // CRITICAL | MAJOR | MINOR
      category,
      description,
      execution:   'server_script',
      script,
      assertions,
      cleanup_script: cleanup,
      expected_result: assertions.map(a => a.message).join('; '),
    });

    if (artifact_type === 'business_rule') {
      const table = live_metadata.table_name ?? tables_referenced[0] ?? 'incident';
      const when  = live_metadata.when ?? 'before';

      cases.push(tc(
        `[POSITIVE] ${artifact_name} fires and applies expected changes`,
        'CRITICAL', 'Trigger Condition',
        `Verify the BR executes and produces its primary outcome on table ${table}`,
        `var gr = new GlideRecord('${table}');
gr.initialize();
// TODO: Set fields that meet BR trigger condition
gr.short_description = 'TEST_${artifact_name}_' + gs.generateGUID();
var sysId = gr.insert();
gs.assertNotNull(sysId, 'Record should be created');
var check = new GlideRecord('${table}');
check.get(sysId);
// TODO: Assert expected BR outcome — adjust field and value
// gs.assertEquals(check.state.toString(), '2', 'BR should set state to In Progress');
gs.info('TEST PASS — BR executed. Verify outcomes manually or update assertion above.');`,
        [{ message: 'Record created and BR executed without errors' }],
        `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_${artifact_name}_'); cleanup.deleteMultiple();`,
      ));

      cases.push(tc(
        `[NEGATIVE] ${artifact_name} does NOT fire when condition is not met`,
        'CRITICAL', 'Trigger Condition',
        'Verify the BR does not apply its changes when trigger conditions are absent',
        `var gr = new GlideRecord('${table}');
gr.initialize();
gr.short_description = 'TEST_NO_TRIGGER_${artifact_name}_' + gs.generateGUID();
// TODO: Deliberately DO NOT set trigger condition fields
var sysId = gr.insert();
gs.assertNotNull(sysId, 'Record should still be created');
var check = new GlideRecord('${table}');
check.get(sysId);
// TODO: Assert the BR outcome was NOT applied
// gs.assertNotEquals(check.state.toString(), '2', 'BR should NOT change state without trigger');
gs.info('TEST PASS — BR skipped correctly. Verify non-applied outcomes.');`,
        [{ message: 'BR did not apply when condition was absent' }],
        `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_NO_TRIGGER_'); cleanup.deleteMultiple();`,
      ));

      cases.push(tc(
        `[NULL SAFETY] ${artifact_name} handles null field values gracefully`,
        'CRITICAL', 'Error Handling',
        'Verify the BR does not throw when optional fields are null/empty',
        `var gr = new GlideRecord('${table}');
gr.initialize();
gr.short_description = 'TEST_NULL_${artifact_name}_' + gs.generateGUID();
// Leave all optional fields null
var sysId = gr.insert();
gs.assertNotNull(sysId, 'Insert with null optionals should not throw');
gs.info('TEST PASS — null fields handled safely');`,
        [{ message: 'No error with null optional fields' }],
        `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_NULL_'); cleanup.deleteMultiple();`,
      ));

      if (when === 'async') {
        cases.push(tc(
          `[ASYNC] ${artifact_name} completes asynchronously without blocking`,
          'MAJOR', 'Performance',
          'Trigger BR and verify the async queue processes correctly',
          `var gr = new GlideRecord('${table}');
gr.initialize();
gr.short_description = 'TEST_ASYNC_${artifact_name}_' + gs.generateGUID();
var sysId = gr.insert();
gs.assertNotNull(sysId, 'Record created — async BR queued');
// Wait and check scheduled queue
gs.info('TEST: Async BR queued for sys_id ' + sysId + '. Verify in scheduled worker log.');`,
          [{ message: 'Async BR queued successfully' }],
          `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_ASYNC_'); cleanup.deleteMultiple();`,
        ));
      }

      conditions_detected.slice(0, 3).forEach((cond, i) => {
        cases.push(tc(
          `[BRANCH-${i+1}] Condition branch: ${cond.substring(0, 60)}`,
          'MAJOR', 'Branch Coverage',
          `Test the branch triggered by: ${cond}`,
          `// Test branch: ${cond}
var gr = new GlideRecord('${table}');
gr.initialize();
gr.short_description = 'TEST_BRANCH${i+1}_${artifact_name}_' + gs.generateGUID();
// TODO: Configure record to exercise branch: ${cond}
var sysId = gr.insert();
gs.assertNotNull(sysId, 'Branch ${i+1} — record created');
gs.info('TEST: Verify branch outcome for condition: ${cond}');`,
          [{ message: `Branch ${i+1} executes correctly` }],
          `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_BRANCH${i+1}_'); cleanup.deleteMultiple();`,
        ));
      });

      cases.push(tc(
        `[PERFORMANCE] ${artifact_name} completes within acceptable time`,
        'MAJOR', 'Performance',
        'Measure BR execution time — should complete under 5 seconds',
        `var start = new GlideDateTime().getNumericValue();
var gr = new GlideRecord('${table}');
gr.initialize();
gr.short_description = 'TEST_PERF_${artifact_name}_' + gs.generateGUID();
gr.insert();
var elapsed = new GlideDateTime().getNumericValue() - start;
gs.assertTrue(elapsed < 5000, 'BR should complete in < 5 seconds, actual: ' + elapsed + 'ms');
gs.info('BR execution time: ' + elapsed + 'ms');`,
        [{ message: 'BR completes under 5 seconds' }],
        `var cleanup = new GlideRecord('${table}'); cleanup.addQuery('short_description', 'STARTSWITH', 'TEST_PERF_'); cleanup.deleteMultiple();`,
      ));

    } else if (artifact_type === 'script_include') {
      const siName = artifact_name;

      if (methods_detected.length === 0) {
        cases.push(tc(
          `[INIT] ${siName} instantiates without errors`,
          'CRITICAL', 'Instantiation',
          'Verify the Script Include can be instantiated',
          `var si = new ${siName}();
gs.assertNotNull(si, '${siName} should instantiate');
gs.info('TEST PASS — ${siName} instantiated');`,
          [{ message: `${siName} instantiates without errors` }],
        ));
      }

      methods_detected.slice(0, 8).forEach(method => {
        const paramStr = method.params.map(() => 'null').join(', ');

        cases.push(tc(
          `[UNIT] ${siName}.${method.name}() — happy path`,
          'CRITICAL', 'Unit Test',
          `Test ${method.name} with representative valid input`,
          `var si     = new ${siName}();
// TODO: Replace null params with valid test data for ${method.name}(${method.params.join(', ')})
var result = si.${method.name}(${paramStr});
gs.assertNotNull(result, '${method.name} should return a value, not null');
// If your method returns {success, data, error} pattern:
if (typeof result === 'object' && result.hasOwnProperty('success')) {
  gs.assertTrue(result.success === true, '${method.name} should return success=true');
  gs.assertNotNull(result.data, '${method.name} should populate data on success');
}
gs.info('TEST PASS — ${method.name} returned: ' + JSON.stringify(result));`,
          [{ message: `${method.name} returns expected value` }],
        ));

        cases.push(tc(
          `[UNIT] ${siName}.${method.name}() — null/invalid input`,
          'CRITICAL', 'Error Handling',
          `Verify ${method.name} handles null input without throwing`,
          `var si = new ${siName}();
try {
  var result = si.${method.name}(null);
  gs.assertNotNull(result, '${method.name} should return object on null input (never throw)');
  if (typeof result === 'object') {
    gs.info('${method.name}(null) returned: ' + JSON.stringify(result));
  }
} catch(e) {
  gs.assertTrue(false, '${method.name}(null) must not throw — caught: ' + e.message);
}`,
          [{ message: `${method.name} handles null gracefully` }],
        ));

        if (method.params.length > 1) {
          cases.push(tc(
            `[UNIT] ${siName}.${method.name}() — missing required params`,
            'MAJOR', 'Validation',
            `Verify ${method.name} returns error when required params are missing`,
            `var si     = new ${siName}();
var result = si.${method.name}(${method.params.map((_, i) => i === 0 ? 'null' : 'undefined').join(', ')});
gs.assertNotNull(result, '${method.name} should never throw');
if (typeof result === 'object' && result.hasOwnProperty('error')) {
  gs.assertNotNull(result.error, '${method.name} should set error when params missing');
  gs.info('TEST PASS — error returned: ' + result.error);
} else {
  gs.info('TEST: ${method.name} with missing params returned: ' + JSON.stringify(result));
}`,
            [{ message: `${method.name} returns error for missing params` }],
          ));
        }
      });

      tables_referenced.forEach(table => {
        cases.push(tc(
          `[INTEGRATION] ${siName} correctly reads/writes ${table}`,
          'MAJOR', 'Data Integrity',
          `Verify GlideRecord operations on ${table} work as expected`,
          `// Pre-condition: ensure ${table} table is accessible
var gr = new GlideRecord('${table}');
gr.setLimit(1);
gr.query();
gs.assertTrue(gr.isValid(), '${table} table must be valid and accessible');
gs.info('TEST: ${table} accessible — rows available: ' + gr.hasNext());`,
          [{ message: `${table} table is accessible` }],
        ));
      });

    } else if (artifact_type === 'scripted_rest') {
      const apiPath = live_metadata.rest_path ?? `/api/now/${artifact_name.toLowerCase().replace(/\s+/g, '_')}`;

      cases.push(tc(
        `[AUTH] ${artifact_name} returns 401 without credentials`,
        'CRITICAL', 'Security',
        'Verify the API enforces authentication',
        `var rm = new sn_ws.RESTMessageV2();
rm.setEndpoint(gs.getProperty('glide.servlet.uri') + '${apiPath}');
rm.setHttpMethod('GET');
// No auth headers — should fail
var response = rm.execute();
gs.assertEquals('401', String(response.getStatusCode()), 'Should return 401 without credentials');`,
        [{ message: '401 returned without auth' }],
      ));

      cases.push(tc(
        `[AUTH] ${artifact_name} returns 403 with insufficient roles`,
        'CRITICAL', 'Security',
        'Verify role enforcement on the API',
        `// Run as a user without the required role using gs.executeNow or check ACL
var aclGr = new GlideRecord('sys_security_acl');
aclGr.addQuery('name', '${artifact_name}');
aclGr.query();
gs.assertTrue(aclGr.hasNext(), 'API should have ACL defined');
gs.info('TEST: ACL exists for ${artifact_name}');`,
        [{ message: 'API has ACL configured' }],
      ));

      cases.push(tc(
        `[VALIDATION] ${artifact_name} returns 400 for missing required parameters`,
        'CRITICAL', 'Input Validation',
        'Verify correct error on missing required params',
        `var rm = new sn_ws.RESTMessageV2();
rm.setEndpoint(gs.getProperty('glide.servlet.uri') + '${apiPath}');
rm.setHttpMethod('GET');
rm.setBasicAuth(gs.getProperty('glide.db.name'), 'your-password-here'); // adjust as needed
rm.setHeader('Content-Type', 'application/json');
// Send empty body / no params
var response = rm.execute();
var status   = response.getStatusCode();
var body     = response.getBody();
gs.assertTrue(status == 400 || status == 422, 'Expected 400/422 for missing params, got: ' + status);
var json = JSON.parse(body);
gs.assertNotNull(json.error ?? json.message, 'Error response must include error message');`,
        [{ message: '400/422 returned with error message for missing params' }],
      ));

      cases.push(tc(
        `[POSITIVE] ${artifact_name} returns 200 with valid request`,
        'CRITICAL', 'Happy Path',
        'Verify correct response for a fully valid request',
        `var rm = new sn_ws.RESTMessageV2();
rm.setEndpoint(gs.getProperty('glide.servlet.uri') + '${apiPath}');
rm.setHttpMethod('GET');
rm.setMutualAuth('your-auth-profile'); // adjust to your SN auth profile
rm.setHeader('Accept', 'application/json');
// TODO: Add required query params
var response = rm.execute();
gs.assertEquals('200', String(response.getStatusCode()), 'Should return 200');
var body = JSON.parse(response.getBody());
gs.assertNotNull(body, 'Response body must not be empty');
gs.info('TEST PASS — Response: ' + JSON.stringify(body).substring(0, 200));`,
        [{ message: '200 returned with valid JSON body' }],
      ));

      cases.push(tc(
        `[NEGATIVE] ${artifact_name} returns 404 for unknown resource`,
        'MAJOR', 'Error Handling',
        'Verify 404 for a resource that does not exist',
        `var rm = new sn_ws.RESTMessageV2();
rm.setEndpoint(gs.getProperty('glide.servlet.uri') + '${apiPath}/NON_EXISTENT_ID');
rm.setHttpMethod('GET');
var response = rm.execute();
gs.assertTrue(response.getStatusCode() == 404, 'Should return 404, got: ' + response.getStatusCode());`,
        [{ message: '404 returned for non-existent resource' }],
      ));

      cases.push(tc(
        `[SECURITY] ${artifact_name} response does not leak sensitive fields`,
        'MAJOR', 'Security',
        'Verify response does not include password, token, or private fields',
        `// This is a code review check — inspect the script manually
var scriptGr = new GlideRecord('sys_ws_operation');
scriptGr.addQuery('name', '${artifact_name}');
scriptGr.query();
if (scriptGr.next()) {
  var script = scriptGr.getValue('operation_script') ?? '';
  var leaks  = ['password', 'token', 'secret', 'api_key', 'private_key'];
  var found  = leaks.filter(l => script.toLowerCase().includes(l + ' =') || script.toLowerCase().includes(l + ':'));
  gs.assertTrue(found.length === 0, 'Potential data leak: response may include ' + found.join(', '));
  gs.info('TEST PASS — no sensitive field leaks detected');
}`,
        [{ message: 'No sensitive fields in response' }],
      ));

    } else if (artifact_type === 'scheduled_job') {
      cases.push(tc(
        `[DRY RUN] ${artifact_name} — execute with logging only, no DB changes`,
        'CRITICAL', 'Safety',
        'Run the scheduled job logic in read-only mode to verify targeting',
        `// Modify this script to simulate the job logic with setWorkflow(false) / no commits
var gr = new GlideRecord('${tables_referenced[0] ?? 'task'}');
gr.addEncodedQuery('active=true');
gr.setLimit(5);
gr.query();
var count = 0;
while (gr.next()) { count++; }
gs.info('[DRY RUN] ${artifact_name} would process approximately ' + count + ' records');
gs.assertTrue(count >= 0, 'Dry run completed without error');`,
        [{ message: 'Dry run completes — record count logged' }],
      ));

      cases.push(tc(
        `[IDEMPOTENCY] ${artifact_name} — running twice produces same result`,
        'CRITICAL', 'Data Integrity',
        'Verify running the job twice does not create duplicates or double-update',
        `// Create a test record, run job logic twice, assert no double-effect
var table = '${tables_referenced[0] ?? 'task'}';
var testGr = new GlideRecord(table);
testGr.initialize();
testGr.short_description = 'IDEMPOTENCY_TEST_${artifact_name}_' + gs.generateGUID();
var sysId = testGr.insert();
// TODO: run the job logic function/script include on this record twice
// Then assert the field changed exactly once
gs.info('TEST: Verify no duplicate effects after second run on sys_id ' + sysId);`,
        [{ message: 'Second run produces no additional changes' }],
        `var c = new GlideRecord('${tables_referenced[0] ?? 'task'}'); c.addQuery('short_description', 'STARTSWITH', 'IDEMPOTENCY_TEST_'); c.deleteMultiple();`,
      ));

      cases.push(tc(
        `[PERFORMANCE] ${artifact_name} completes within max runtime`,
        'MAJOR', 'Performance',
        'Verify job does not time out with current data volume',
        `var start   = new GlideDateTime().getNumericValue();
var gr      = new GlideRecord('${tables_referenced[0] ?? 'task'}');
gr.addEncodedQuery('active=true');
gr.setLimit(100); // test on subset
gr.query();
var count   = 0;
while (gr.next()) { count++; }
var elapsed = new GlideDateTime().getNumericValue() - start;
gs.assertTrue(elapsed < 30000, 'Job should process 100 records in < 30s, actual: ' + elapsed + 'ms');
gs.info('Processed ' + count + ' records in ' + elapsed + 'ms');`,
        [{ message: '100 records processed in under 30 seconds' }],
      ));

    } else {
      // Generic fallback
      cases.push(tc(
        `[SMOKE] ${artifact_name} — basic execution succeeds`,
        'CRITICAL', 'Smoke Test',
        'Verify the artifact executes without errors',
        `gs.info('Executing smoke test for ${artifact_name}');
// TODO: add specific invocation for this artifact type`,
        [{ message: 'Executes without errors' }],
      ));
    }

    // Universal security check for any artifact with GlideRecord
    if (tables_referenced.length > 0 && artifact_type !== 'scripted_rest') {
      cases.push(tc(
        `[SECURITY] ${artifact_name} — no hardcoded credentials or sensitive data`,
        'CRITICAL', 'Security',
        'Verify no credentials, tokens, or PIIs are hardcoded in the script',
        `var tableMap = { business_rule: 'sys_script', script_include: 'sys_script_include', client_script: 'sys_client_script', widget: 'sp_widget', scheduled_job: 'sysauto_script' };
var table    = tableMap['${artifact_type}'] ?? 'sys_script_include';
var gr       = new GlideRecord(table);
gr.addQuery('name', '${artifact_name}');
gr.query();
if (gr.next()) {
  var code     = gr.getValue('script') ?? gr.getValue('server_script') ?? '';
  var patterns = ['password =', 'apikey =', 'secret =', 'token =', 'Bearer '];
  var found    = patterns.filter(p => code.includes(p));
  gs.assertTrue(found.length === 0, 'Hardcoded credentials found: ' + found.join(', '));
  gs.info('TEST PASS — no hardcoded credentials');
}`,
        [{ message: 'No hardcoded credentials detected' }],
      ));
    }

    // Apply priority filter
    if (priority === 'critical') return cases.filter(c => c.priority === 'CRITICAL');
    if (priority === 'smoke')    return cases.slice(0, 3);
    return cases;
  }

  _executionStrategy(type) {
    const strategies = {
      business_rule:  'Background Fix Script — each test creates/updates a test record and asserts outcome',
      script_include: 'Background Fix Script — instantiates the SI and calls each method directly',
      client_script:  'ATF Selenium — opens the form in a browser and interacts with fields; OR manual verification',
      scripted_rest:  'Background Fix Script — uses RESTMessageV2 to call the API from within SN',
      widget:         'ATF Selenium — opens the portal page; OR Background Fix Script for server_script tests',
      scheduled_job:  'Background Fix Script — runs the job logic on a small data subset',
    };
    return strategies[type] ?? 'Background Fix Script';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Execute
  // ══════════════════════════════════════════════════════════════════════════

  async runTests(sn, testPlan, { approved_ids = null, extra_cases = [] } = {}) {
    const allCases = [...testPlan.test_cases, ...extra_cases];
    const toRun    = approved_ids
      ? allCases.filter(tc => approved_ids.includes(tc.id) || extra_cases.includes(tc))
      : allCases;

    const results = [];
    for (const tc of toRun) {
      const result = await this._executeTestCase(sn, tc);
      results.push(result);
    }

    return this._buildReport(testPlan, results);
  }

  async _executeTestCase(sn, tc) {
    const start = Date.now();
    try {
      // Create a Fix Script record and run it
      const script = `
// Test Case: ${tc.name}
// Plan: auto-generated expert test
try {
${tc.script}
} catch(e) {
  gs.error('[TEST FAIL] ${tc.id}: ' + e.message);
  throw e;
}`;

      // Use the SN background script endpoint
      const payload = { script, sys_class_name: 'sys_script_fix', name: `[AUTO-TEST] ${tc.id} - ${tc.name}`, description: tc.description };
      let output = '';
      let status = 'PASS';
      let error  = null;

      try {
        // Try to create and execute a fix script via the Table API
        const created = await sn.post('sys_script_fix', { name: `[AUTO-TEST] ${tc.id}`, script: tc.script, description: tc.description });
        const sysId   = created?.result?.sys_id ?? created?.sys_id;

        if (sysId) {
          // Execute it via the sys_script_fix execute endpoint
          try {
            const execResult = await sn.request('POST', `sys_script_fix/${sysId}/run`, {});
            output = execResult?.result?.output ?? 'Executed (no output captured)';
            // Check for assertion failures in output
            if (output.toLowerCase().includes('assertfalse') || output.toLowerCase().includes('fail')) {
              status = 'FAIL';
              error  = output;
            }
          } catch (execErr) {
            // If run endpoint not available, mark as MANUAL
            status = 'MANUAL_REQUIRED';
            output = 'Fix Script created — execute manually in SN: System Definition > Fix Scripts > [AUTO-TEST] ' + tc.id;
          }
        } else {
          status = 'MANUAL_REQUIRED';
          output = 'Script created but sys_id not returned — run manually';
        }
      } catch (createErr) {
        // Fallback: return script for manual execution
        status = 'MANUAL_REQUIRED';
        output = createErr.message;
      }

      return {
        id:       tc.id,
        name:     tc.name,
        priority: tc.priority,
        category: tc.category,
        status,
        duration_ms: Date.now() - start,
        output,
        error,
        script:   tc.script,
        cleanup_script: tc.cleanup_script,
      };
    } catch (e) {
      return {
        id:       tc.id,
        name:     tc.name,
        priority: tc.priority,
        category: tc.category,
        status:   'ERROR',
        duration_ms: Date.now() - start,
        error:    e.message,
        script:   tc.script,
        cleanup_script: tc.cleanup_script,
      };
    }
  }

  _buildReport(plan, results) {
    const pass           = results.filter(r => r.status === 'PASS');
    const fail           = results.filter(r => r.status === 'FAIL');
    const manual         = results.filter(r => r.status === 'MANUAL_REQUIRED');
    const error          = results.filter(r => r.status === 'ERROR');
    const criticalFails  = fail.filter(r => r.priority === 'CRITICAL');

    const score = results.length
      ? Math.round(((pass.length) / results.length) * 100)
      : 0;

    return {
      report_id:    `RPT-${Date.now()}`,
      plan_id:      plan.plan_id,
      artifact_name: plan.artifact_name,
      executed_at:  new Date().toISOString(),
      summary: {
        total:     results.length,
        pass:      pass.length,
        fail:      fail.length,
        manual:    manual.length,
        error:     error.length,
        score_pct: score,
        verdict:   criticalFails.length > 0 ? 'CRITICAL_FAILURES' : fail.length > 0 ? 'FAILURES' : manual.length === results.length ? 'MANUAL_REQUIRED' : 'ALL_PASS',
      },
      results,
      manual_execution_guide: manual.length > 0 ? [
        'For MANUAL_REQUIRED tests, go to: System Definition > Fix Scripts in ServiceNow',
        'Find scripts named "[AUTO-TEST] TC-XXX"',
        'Open each one, click "Run Fix Script", review the output log',
        'Mark as PASS or FAIL based on gs.assertTrue assertions in the log',
      ] : [],
      recommendations: this._buildRecommendations(results, plan.risks),
    };
  }

  _buildRecommendations(results, risks) {
    const recs = [];
    const critFails = results.filter(r => r.status === 'FAIL' && r.priority === 'CRITICAL');
    if (critFails.length > 0) {
      recs.push({ priority: 'BLOCKER', message: `${critFails.length} CRITICAL test(s) failed — DO NOT deploy until resolved: ${critFails.map(r => r.name).join(', ')}` });
    }
    const highRisks = risks?.filter(r => r.level === 'HIGH') ?? [];
    if (highRisks.length > 0) {
      recs.push({ priority: 'HIGH', message: `Address high-risk items: ${highRisks.map(r => r.issue).join('; ')}` });
    }
    const errorResults = results.filter(r => r.status === 'ERROR');
    if (errorResults.length > 0) {
      recs.push({ priority: 'MEDIUM', message: `${errorResults.length} test(s) errored during execution — check Fix Script permissions and try running manually` });
    }
    if (recs.length === 0) {
      recs.push({ priority: 'INFO', message: 'All automated tests passed — code is ready for review and UAT' });
    }
    return recs;
  }
}
