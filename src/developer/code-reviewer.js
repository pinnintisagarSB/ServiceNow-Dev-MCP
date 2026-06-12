/**
 * ServiceNow Code Reviewer
 *
 * Static analysis for SN scripts. Detects:
 *  - Anti-patterns (GlideRecord in loops, full table scans, setLimit missing)
 *  - Performance risks (missing encoded query, getRowCount before next, etc.)
 *  - Security issues (eval, hardcoded credentials, unvalidated input)
 *  - Null-safety gaps (missing gs.nil checks, optional chaining)
 *  - Best-practice violations (gr.get inside loop, hardcoded sys_ids, etc.)
 */

// ── Rule definitions ──────────────────────────────────────────────────────────
const RULES = [
  // ── Anti-patterns ──────────────────────────────────────────────────────────
  {
    id:       'AP001',
    severity: 'critical',
    category: 'anti-pattern',
    name:     'GlideRecord query inside loop',
    pattern:  /while\s*\(\s*\w+\.next\(\)\s*\)[^}]*(?:new GlideRecord|\.query\(\))/s,
    message:  'GlideRecord.query() inside a loop causes N+1 DB round-trips. Build a map before the loop or use an IN query.',
    fix:      'Build an encoded query with sys_id IN (…) or collect values first, then do one query outside the loop.',
  },
  {
    id:       'AP002',
    severity: 'critical',
    category: 'anti-pattern',
    name:     'GlideRecord with no limit',
    pattern:  /new GlideRecord\(['"][^'"]+['"]\)[\s\S]{0,400}\.query\(\)(?![\s\S]{0,200}setLimit)/,
    message:  'GlideRecord.query() without setLimit can return thousands of rows and freeze transactions.',
    fix:      'Add gr.setLimit(N) before gr.query(). Use encoded queries to narrow the result set.',
  },
  {
    id:       'AP003',
    severity: 'major',
    category: 'anti-pattern',
    name:     'getRowCount before iterating',
    pattern:  /\.getRowCount\(\)/,
    message:  'GlideRecord.getRowCount() runs a second COUNT query. Use a counter variable instead.',
    fix:      'Remove getRowCount() — increment a counter in the while(gr.next()) loop.',
  },
  {
    id:       'AP004',
    severity: 'major',
    category: 'anti-pattern',
    name:     'GlideRecord.get() in a loop',
    pattern:  /while\s*\(.*\.next\(\)\)[^}]*\bget\s*\(/s,
    message:  'Calling gr.get() inside a loop causes N DB queries — one per iteration.',
    fix:      'Pre-fetch all needed records into a JavaScript object/map before the loop.',
  },
  {
    id:       'AP005',
    severity: 'major',
    category: 'anti-pattern',
    name:     'Hardcoded sys_id',
    pattern:  /['"]{1}[0-9a-f]{32}['"]{1}/,
    message:  'Hardcoded sys_ids break in non-production instances.',
    fix:      'Use gs.getProperty(), a sys_property, or a lookup by name/number instead.',
  },

  // ── Performance ────────────────────────────────────────────────────────────
  {
    id:       'PF001',
    severity: 'major',
    category: 'performance',
    name:     'Full table scan — no encoded query',
    pattern:  /new GlideRecord\(['"][^'"]+['"]\)[\s\S]{0,100}\.query\(\)(?![\s\S]{0,300}addEncodedQuery|addQuery)/,
    message:  'GlideRecord.query() with no addQuery/addEncodedQuery scans the entire table.',
    fix:      'Add gr.addEncodedQuery(\'active=true\') or appropriate query conditions.',
  },
  {
    id:       'PF002',
    severity: 'minor',
    category: 'performance',
    name:     'GlideAggregate for counts',
    pattern:  /new GlideRecord[\s\S]{0,300}while\s*\([\s\S]{0,100}\.next\(\)\)[\s\S]{0,200}count\s*\+\+/s,
    message:  'Using GlideRecord to count rows is slower than GlideAggregate.',
    fix:      'Use GlideAggregate with addAggregate(\'COUNT\') instead of iterating and incrementing a counter.',
  },
  {
    id:       'PF003',
    severity: 'major',
    category: 'performance',
    name:     'Synchronous REST call in Business Rule',
    pattern:  /var\s+\w+\s*=\s*new RESTMessageV2[\s\S]{0,300}\.execute\(\)(?![\s\S]{0,50}async)/,
    message:  'Synchronous REST calls in BRs block the transaction and can time out.',
    fix:      'Move REST calls to an async Business Rule or a Scheduled Job.',
  },
  {
    id:       'PF004',
    severity: 'minor',
    category: 'performance',
    name:     'Missing choiceList on Reference field lookup',
    pattern:  /gr\.getValue\(['"][^'"]+['"]\)/,
    message:  'gr.getValue() returns the display value for Reference fields — use gr.getUniqueValue() for sys_id and gr.getDisplayValue() explicitly.',
    fix:      'Use gr.field.toString() for sys_id or gr.getDisplayValue(\'field\') for label.',
  },

  // ── Security ───────────────────────────────────────────────────────────────
  {
    id:       'SEC001',
    severity: 'critical',
    category: 'security',
    name:     'eval() usage',
    pattern:  /\beval\s*\(/,
    message:  'eval() is a code injection vector and banned by ServiceNow CSP.',
    fix:      'Rewrite without eval — use explicit logic or JSON.parse() for data parsing.',
  },
  {
    id:       'SEC002',
    severity: 'critical',
    category: 'security',
    name:     'Hardcoded password/secret',
    pattern:  /(?:password|secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i,
    message:  'Hardcoded credential detected.',
    fix:      'Store credentials in a MID Server extension, Named Credential, or encrypted sys_property.',
  },
  {
    id:       'SEC003',
    severity: 'critical',
    category: 'security',
    name:     'Unvalidated REST input used in GlideRecord query',
    pattern:  /request\.queryParams[\s\S]{0,200}addQuery|addEncodedQuery/s,
    message:  'Request parameter used directly in a DB query — potential injection risk.',
    fix:      'Sanitize and validate all input: check type, length, and allowlist expected values before using in queries.',
  },
  {
    id:       'SEC004',
    severity: 'major',
    category: 'security',
    name:     'No role check in UI Action or REST',
    pattern:  /\(function\s*(?:executeRule|process)\b[\s\S]{0,300}GlideRecord(?![\s\S]{0,300}gs\.hasRole|hasRole|checkMandatoryFields)/s,
    message:  'Script accesses data without a role check.',
    fix:      'Add gs.hasRole(\'admin\') or a specific role guard at the top of the function.',
  },

  // ── Null safety ────────────────────────────────────────────────────────────
  {
    id:       'NS001',
    severity: 'major',
    category: 'null-safety',
    name:     'Missing gs.nil() check on GlideElement',
    pattern:  /current\.\w+\s*==\s*(?:null|''|"")/,
    message:  'Use gs.nil(current.field) instead of == null or == "" for GlideElement null checks.',
    fix:      'Replace with if (gs.nil(current.field)) { ... }',
  },
  {
    id:       'NS002',
    severity: 'major',
    category: 'null-safety',
    name:     'JSON.parse without null guard',
    pattern:  /JSON\.parse\s*\([^)]*gs\.getProperty\b/,
    message:  'gs.getProperty() returns null if the property doesn\'t exist — JSON.parse(null) throws.',
    fix:      'Wrap: var raw = gs.getProperty(\'key\'); if (raw) { JSON.parse(raw); }',
  },
  {
    id:       'NS003',
    severity: 'minor',
    category: 'null-safety',
    name:     'gr.next() result not checked',
    pattern:  /\.get\s*\([^)]+\)\s*;[\s\S]{0,100}(?:current\.|gr\.)(?![\s\S]{0,50}if\s*\()/s,
    message:  'GlideRecord.get() returns false if not found — accessing fields without checking leads to null errors.',
    fix:      'Wrap in: if (gr.get(\'sys_id\', value)) { /* use gr */ }',
  },

  // ── Best practices ─────────────────────────────────────────────────────────
  {
    id:       'BP001',
    severity: 'minor',
    category: 'best-practice',
    name:     'gs.print instead of gs.info/error',
    pattern:  /gs\.print\s*\(/,
    message:  'gs.print() only outputs to the system log at "info" level without context.',
    fix:      'Use gs.info(), gs.warn(), or gs.error() with a descriptive message prefix.',
  },
  {
    id:       'BP002',
    severity: 'minor',
    category: 'best-practice',
    name:     'No error handling on REST call',
    pattern:  /new RESTMessageV2[\s\S]{0,300}\.execute\(\)(?![\s\S]{0,300}try|catch|getStatusCode)/s,
    message:  'REST calls can fail — always check getStatusCode() and wrap in try/catch.',
    fix:      'Wrap in try/catch, check response.getStatusCode(), log failures with gs.error().',
  },
  {
    id:       'BP003',
    severity: 'minor',
    category: 'best-practice',
    name:     'setWorkflow not disabled in bulk update',
    pattern:  /while\s*\([\s\S]{0,50}\.next\(\)\)[\s\S]{0,300}\.update\(\)(?![\s\S]{0,300}setWorkflow)/s,
    message:  'Bulk updates without setWorkflow(false) trigger Business Rules on every record — very slow.',
    fix:      'Add gr.setWorkflow(false) before gr.update() in bulk loops.',
  },
  {
    id:       'BP004',
    severity: 'major',
    category: 'best-practice',
    name:     'Client-side GlideRecord usage',
    pattern:  /new GlideRecord/,   // will only flag in client script context
    message:  'GlideRecord is not available in Client Scripts — use GlideAjax or REST to fetch server data.',
    fix:      'Create a Script Include with client_callable=true and call it via GlideAjax.',
  },
];

export class CodeReviewer {
  /**
   * Review a script string.
   * @param {string} code  — the script source
   * @param {string} type  — 'business_rule' | 'client_script' | 'script_include' | 'scripted_rest' | etc.
   * @returns {ReviewResult}
   */
  review(code, type = 'server_script') {
    const isClient = type === 'client_script';
    const findings = [];

    for (const rule of RULES) {
      // Skip client-only rules for server scripts and vice versa
      if (rule.id === 'BP004' && !isClient)   continue;
      if (rule.id === 'PF003' && isClient)    continue;
      if (rule.id === 'SEC004' && isClient)   continue;

      if (rule.pattern.test(code)) {
        // Find the approximate line number
        const lineNum = this._findLine(code, rule.pattern);
        findings.push({
          rule_id:    rule.id,
          severity:   rule.severity,
          category:   rule.category,
          name:       rule.name,
          message:    rule.message,
          fix:        rule.fix,
          line:       lineNum,
        });
      }
    }

    const counts = { critical: 0, major: 0, minor: 0 };
    findings.forEach(f => counts[f.severity] = (counts[f.severity] || 0) + 1);

    const score = Math.max(0, 10
      - (counts.critical * 3)
      - (counts.major    * 1.5)
      - (counts.minor    * 0.5));

    const verdict =
      counts.critical > 0             ? 'FAIL — critical issues must be fixed before deployment' :
      counts.major    > 2             ? 'NEEDS WORK — multiple significant issues' :
      counts.major    > 0             ? 'ACCEPTABLE — fix major issues' :
      counts.minor    > 0             ? 'GOOD — minor improvements available' : 'EXCELLENT';

    return {
      verdict,
      score:    Math.round(score * 10) / 10,
      summary:  `${findings.length} issue(s) found: ${counts.critical} critical, ${counts.major} major, ${counts.minor} minor`,
      counts,
      findings: findings.sort((a, b) => {
        const order = { critical: 0, major: 1, minor: 2 };
        return order[a.severity] - order[b.severity];
      }),
      quick_wins: findings.filter(f => f.severity === 'minor').map(f => f.name),
      must_fix:   findings.filter(f => f.severity === 'critical').map(f => f.name),
    };
  }

  /** Return rule catalogue for documentation / explain_api */
  listRules(category) {
    if (category) return RULES.filter(r => r.category === category);
    return RULES;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  _findLine(code, pattern) {
    const match = code.search(pattern);
    if (match === -1) return null;
    return code.substring(0, match).split('\n').length;
  }
}
