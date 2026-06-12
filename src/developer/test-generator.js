/**
 * ServiceNow ATF (Automated Test Framework) Test Generator
 *
 * Generates complete ATF test suites for:
 *  - Business Rules (before/after, conditions, async)
 *  - Script Includes (unit tests for each method)
 *  - UI Actions (server execution, redirect)
 *  - Scripted REST APIs (request/response tests)
 *  - Form behaviour (Client Scripts, UI Policies)
 *  - Field validation (mandatory, regex, choice list)
 *
 * Output: ATF test JSON that can be imported or created via Table API.
 */

export class TestGenerator {

  // ══════════════════════════════════════════════════════════════════════════
  // Business Rule tests
  // ══════════════════════════════════════════════════════════════════════════
  generateBusinessRuleTests({ brName, table, triggerConditions = [], fieldChanges = {}, expectedOutcomes = [] }) {
    const suite = this._suite(`ATF: ${brName}`, `Auto-generated tests for Business Rule "${brName}" on ${table}`);

    // Test 1: BR fires under trigger conditions
    suite.tests.push({
      name:        `[POSITIVE] ${brName} fires when condition is met`,
      description: `Create/update a ${table} record with trigger conditions set. Verify expected outcomes.`,
      steps: [
        this._step('create_record', { table, fields: triggerConditions.reduce((a, f) => ({ ...a, [f.field]: f.value }), {}) }),
        ...expectedOutcomes.map(o =>
          this._step('assert_field', { table, field: o.field, expected: o.value, message: `Expected ${o.field} = ${o.value}` })
        ),
      ],
    });

    // Test 2: BR does NOT fire when condition is not met
    if (triggerConditions.length > 0) {
      suite.tests.push({
        name:        `[NEGATIVE] ${brName} does NOT fire when condition is not met`,
        description: `Create a ${table} record WITHOUT trigger conditions. Verify outcomes did NOT apply.`,
        steps: [
          this._step('create_record', { table, fields: {} }),
          ...expectedOutcomes.map(o =>
            this._step('assert_field_not', { table, field: o.field, notExpected: o.value, message: `${o.field} should NOT be ${o.value}` })
          ),
        ],
      });
    }

    // Test 3: Field change triggers BR
    if (Object.keys(fieldChanges).length > 0) {
      suite.tests.push({
        name:        `[UPDATE] ${brName} triggers on field change`,
        description: `Update specific fields on an existing record and verify BR behaviour.`,
        steps: [
          this._step('create_record', { table, fields: {} }),
          this._step('update_record', { table, fields: fieldChanges }),
          ...expectedOutcomes.map(o =>
            this._step('assert_field', { table, field: o.field, expected: o.value })
          ),
        ],
      });
    }

    return suite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Script Include unit tests
  // ══════════════════════════════════════════════════════════════════════════
  generateScriptIncludeTests({ siName, methods = [] }) {
    const suite = this._suite(`ATF: ${siName}`, `Unit tests for Script Include "${siName}"`);

    for (const method of methods) {
      // Happy path
      suite.tests.push({
        name:        `[UNIT] ${siName}.${method.name} — happy path`,
        description: `Test ${method.name} with valid inputs. Expected: ${method.expectedReturn ?? 'success=true'}`,
        steps: [
          this._step('run_server_script', {
            script: `
var si     = new ${siName}();
var result = si.${method.name}(${JSON.stringify(method.testInput ?? {})});
gs.assertTrue(result.success === true, '${siName}.${method.name} should succeed');
${method.assertions ? method.assertions.map(a => `gs.assertEquals(result.data${a.path ?? ''}, ${JSON.stringify(a.value)}, '${a.message ?? ''}');`).join('\n') : ''}
`.trim(),
          }),
        ],
      });

      // Failure/null input
      suite.tests.push({
        name:        `[UNIT] ${siName}.${method.name} — null/invalid input`,
        description: `Test ${method.name} with null/invalid inputs. Expected: graceful error handling.`,
        steps: [
          this._step('run_server_script', {
            script: `
var si     = new ${siName}();
var result = si.${method.name}(null);
gs.assertNotNull(result,       '${siName}.${method.name} should never throw — return object even on null input');
gs.assertNotNull(result.error, '${siName}.${method.name} should set result.error on invalid input');
`.trim(),
          }),
        ],
      });
    }

    return suite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scripted REST API tests
  // ══════════════════════════════════════════════════════════════════════════
  generateRestApiTests({ apiName, apiPath, verb = 'GET', requiredParams = [], testCases = [] }) {
    const suite = this._suite(`ATF: REST ${apiName}`, `Integration tests for Scripted REST API "${apiName}"`);

    // Auth test
    suite.tests.push({
      name:  `[AUTH] ${apiName} returns 401 without credentials`,
      steps: [
        this._step('rest_call', { url: apiPath, verb, auth: false, expectedStatus: 401 }),
      ],
    });

    // Missing required params
    if (requiredParams.length > 0) {
      suite.tests.push({
        name:  `[VALIDATION] ${apiName} returns 400 with missing required params`,
        steps: [
          this._step('rest_call', { url: apiPath, verb, auth: true, params: {}, expectedStatus: 400 }),
          this._step('assert_response_field', { field: 'status', expected: 'error' }),
        ],
      });
    }

    // Custom test cases
    for (const tc of testCases) {
      suite.tests.push({
        name:  tc.name,
        steps: [
          this._step('rest_call', { url: apiPath, verb, auth: true, params: tc.params, expectedStatus: tc.expectedStatus ?? 200 }),
          ...(tc.assertions ?? []).map(a =>
            this._step('assert_response_field', { field: a.field, expected: a.value })
          ),
        ],
      });
    }

    return suite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Form / Client Script tests
  // ══════════════════════════════════════════════════════════════════════════
  generateFormTests({ table, scenarios = [] }) {
    const suite = this._suite(`ATF: Form ${table}`, `Form/Client Script tests for ${table}`);

    for (const scenario of scenarios) {
      suite.tests.push({
        name:        scenario.name,
        description: scenario.description ?? '',
        steps: [
          this._step('open_form', { table, view: scenario.view ?? 'Default view' }),
          ...(scenario.fieldSets ?? []).map(fs =>
            this._step('set_field_value', { field: fs.field, value: fs.value })
          ),
          ...(scenario.assertions ?? []).map(a =>
            this._step('assert_form_field', {
              field:    a.field,
              property: a.property ?? 'value',  // visible | mandatory | read_only | value
              expected: a.expected,
            })
          ),
        ],
      });
    }

    return suite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Generate a full suite for a table (meta-generator)
  // ══════════════════════════════════════════════════════════════════════════
  generateTableSuite({ table, mandatoryFields = [], uniqueFields = [], choiceFields = [] }) {
    const suite = this._suite(`ATF: Table ${table}`, `Smoke tests for table ${table}`);

    // Mandatory field validation
    if (mandatoryFields.length > 0) {
      suite.tests.push({
        name:  `[VALIDATION] Cannot insert ${table} without mandatory fields`,
        steps: [
          this._step('run_server_script', {
            script: `
var gr = new GlideRecord('${table}');
var inserted = gr.insert();
// At least one mandatory field should block insert
gs.assertFalse(inserted, 'Insert without mandatory fields should fail or set error');
`.trim(),
          }),
        ],
      });
    }

    // Unique field constraint
    for (const uf of uniqueFields) {
      suite.tests.push({
        name:  `[UNIQUENESS] ${table}.${uf} must be unique`,
        steps: [
          this._step('run_server_script', {
            script: `
var value = 'TEST_UNIQUE_' + new Date().getTime();
var gr1 = new GlideRecord('${table}');
gr1.${uf} = value;
var sys1 = gr1.insert();
gs.assertNotNull(sys1, 'First insert should succeed');
var gr2 = new GlideRecord('${table}');
gr2.${uf} = value;
var sys2 = gr2.insert();
gs.assertNull(sys2, 'Duplicate ${uf} should be rejected');
// Cleanup
if (sys1) { var cleanup = new GlideRecord('${table}'); cleanup.get(sys1); cleanup.deleteRecord(); }
`.trim(),
          }),
        ],
      });
    }

    return suite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════════
  _suite(name, description) {
    return {
      type:        'atf_test_suite',
      name,
      description,
      generated_at: new Date().toISOString(),
      tests:        [],
      deploy_instructions: [
        '1. Navigate to Automated Test Framework > Tests in ServiceNow',
        '2. Create a Test Suite with the given name',
        '3. Create each Test and paste the steps',
        '4. For "run_server_script" steps, use the "Run Server Side Script" step type',
        '5. For "rest_call" steps, use the "REST Test Step" step type',
        '6. For "open_form" steps, use the "Open a URL" step type',
        '7. Run the suite and review results',
      ],
    };
  }

  _step(type, params) {
    return { step_type: type, params };
  }
}
