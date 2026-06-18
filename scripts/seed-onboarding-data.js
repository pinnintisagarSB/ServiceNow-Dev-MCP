#!/usr/bin/env node
// Seeds onboarding test data for 4 users in ServiceNow
import 'dotenv/config';

const instance = process.env.SN_INSTANCE_URL?.replace(/\/$/, '');
const auth = Buffer.from(`${process.env.SN_USERNAME}:${process.env.SN_PASSWORD}`).toString('base64');
const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };

const USERS = [
  { email: 'sagar.pinninti@zetechno.com',        role: 'Software Engineer',  started_days_ago: 5 },
  { email: 'sucharitha.pothuganty@zetechno.com', role: 'Business Analyst',   started_days_ago: 10 },
  { email: 'satyanarayana.adari@zetechno.com',   role: 'Project Manager',    started_days_ago: 3 },
  { email: 'sabyasachi.sahoo@zetechno.com',      role: 'QA Engineer',        started_days_ago: 15 },
];

async function get(path) {
  const res = await fetch(`${instance}${path}`, { headers });
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${instance}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.error ?? data));
  return data.result;
}

async function patch(path, body) {
  const res = await fetch(`${instance}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.error ?? data));
  return data.result;
}

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log('  ✓ ' + msg); }
function skip(msg) { console.log('  – ' + msg); }
function err(msg)  { console.log('  ✗ ' + msg); }

const fmt = d => d.toISOString().split('T')[0];
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

// Tasks per category. Prefix is stripped when displaying; kept here for grouping.
const DEFAULT_TASKS = [
  // HR — done early (days 1-2)
  { category: 'HR', name: 'Complete personal information form',       complete: true },
  { category: 'HR', name: 'Submit government ID and address proof',   complete: true },
  { category: 'HR', name: 'Sign employment contract and NDA',         complete: true },
  { category: 'HR', name: 'Enroll in health insurance and benefits',  complete: false },
  { category: 'HR', name: 'Set up direct deposit / payroll details',  complete: false },
  { category: 'HR', name: 'Complete emergency contact form',          complete: false },
  // IT
  { category: 'IT', name: 'Receive and set up laptop / workstation',  complete: true },
  { category: 'IT', name: 'Activate corporate email account',         complete: true },
  { category: 'IT', name: 'Set up multi-factor authentication (MFA)', complete: true },
  { category: 'IT', name: 'Join company Slack / Teams workspace',     complete: true },
  { category: 'IT', name: 'Request access to required systems',       complete: false },
  { category: 'IT', name: 'Complete IT security orientation',         complete: false },
  // Facilities
  { category: 'Facilities', name: 'Collect building access card / badge',              complete: true },
  { category: 'Facilities', name: 'Complete office safety and emergency training',     complete: false },
  { category: 'Facilities', name: 'Set up desk / workstation',                         complete: true },
  { category: 'Facilities', name: 'Register vehicle for parking (if applicable)',      complete: false },
  // Learning
  { category: 'Learning', name: 'Complete mandatory compliance training',              complete: false },
  { category: 'Learning', name: 'Complete data privacy and GDPR training',             complete: false },
  { category: 'Learning', name: 'Attend company culture and values session',           complete: false },
  { category: 'Learning', name: 'Meet with manager for 30-day goal setting',           complete: false },
  { category: 'Learning', name: 'Complete role-specific onboarding course',            complete: false },
];

// Per-user completion overrides (more senior / been here longer = more done)
const COMPLETION_OVERRIDES = {
  'sabyasachi.sahoo@zetechno.com': {
    // 15 days in — most basics done
    'Enroll in health insurance and benefits': true,
    'Set up direct deposit / payroll details': true,
    'Complete emergency contact form': true,
    'Request access to required systems': true,
    'Complete IT security orientation': true,
    'Complete office safety and emergency training': true,
    'Complete mandatory compliance training': true,
    'Complete data privacy and GDPR training': true,
    'Attend company culture and values session': true,
  },
  'sucharitha.pothuganty@zetechno.com': {
    // 10 days in — getting there
    'Enroll in health insurance and benefits': true,
    'Set up direct deposit / payroll details': true,
    'Request access to required systems': true,
    'Complete office safety and emergency training': true,
    'Attend company culture and values session': true,
  },
};

log('\n── Seeding Onboarding Data ──────────────────────────\n');

for (const u of USERS) {
  log(`\n▶ ${u.email} (${u.role})`);

  // Resolve user
  const userRes = await get(`/api/now/table/sys_user?sysparm_query=email=${u.email}&sysparm_fields=sys_id,name,email&sysparm_limit=1`);
  const user = userRes.result?.[0];
  if (!user) { err(`User not found — skipping`); continue; }
  ok(`Found: ${user.name}`);

  // Check existing onboarding case
  const caseRes = await get(`/api/now/table/sn_onboarding_case?sysparm_query=opened_for=${user.sys_id}^ORuser_name=${user.email}&sysparm_fields=sys_id,number&sysparm_limit=1`);
  let caseId, caseNumber;

  if (caseRes.result?.[0]) {
    caseId = caseRes.result[0].sys_id;
    caseNumber = caseRes.result[0].number;
    skip(`Onboarding case already exists: ${caseNumber}`);
  } else {
    const startDate = addDays(new Date(), -u.started_days_ago);
    const dueDate   = addDays(startDate, 30);
    const newCase = await post('/api/now/table/sn_onboarding_case', {
      short_description: `Onboarding - ${user.name} (${u.role})`,
      opened_for: user.sys_id,
      user_name: user.email,
      state: 'open',
      due_date: fmt(dueDate),
    });
    caseId = newCase.sys_id;
    caseNumber = newCase.number;
    ok(`Created onboarding case: ${caseNumber}`);
  }

  // Check existing checklist
  const clRes = await get(`/api/now/table/checklist?sysparm_query=document=${caseId}^table=sn_onboarding_case&sysparm_fields=sys_id,name&sysparm_limit=1`);
  let checklistId;

  if (clRes.result?.[0]) {
    checklistId = clRes.result[0].sys_id;
    skip(`Checklist already exists — skipping item creation`);
    continue;
  }

  const cl = await post('/api/now/table/checklist', {
    name: `Onboarding Checklist - ${user.name}`,
    document: caseId,
    table: 'sn_onboarding_case',
    owner: user.sys_id,
  });
  checklistId = cl.sys_id;
  ok(`Created checklist: ${cl.name}`);

  // Create items
  const overrides = COMPLETION_OVERRIDES[u.email] ?? {};
  let order = 100;
  let doneCount = 0;

  for (const task of DEFAULT_TASKS) {
    const isComplete = overrides[task.name] ?? task.complete;
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    await post('/api/now/table/checklist_item', {
      checklist: checklistId,
      name: `[${task.category}] ${task.name}`,
      complete: isComplete,
      completed: isComplete ? now : null,
      completed_by: isComplete ? user.sys_id : null,
      order,
    });
    if (isComplete) doneCount++;
    order += 100;
  }

  ok(`Created ${DEFAULT_TASKS.length} tasks (${doneCount} completed, ${DEFAULT_TASKS.length - doneCount} pending)`);
}

log('\n── Done! ────────────────────────────────────────────');
log('\nTest by asking Claude:');
log('  • "What do I still need to finish for onboarding?"');
log('  • "Show me my IT onboarding tasks"');
log('  • "What should I do next for my onboarding?"');
log('  • "Mark my compliance training as done"\n');
