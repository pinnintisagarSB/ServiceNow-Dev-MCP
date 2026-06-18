#!/usr/bin/env node
// Seeds leave test data for 4 users in ServiceNow
import 'dotenv/config';

const instance = process.env.SN_INSTANCE_URL?.replace(/\/$/, '');
const auth = Buffer.from(`${process.env.SN_USERNAME}:${process.env.SN_PASSWORD}`).toString('base64');
const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };

const USERS = [
  'sagar.pinninti@zetechno.com',
  'sucharitha.pothuganty@zetechno.com',
  'satyanarayana.adari@zetechno.com',
  'sabyasachi.sahoo@zetechno.com',
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

function log(msg) { console.log(msg); }
function ok(msg)  { console.log('  ✓ ' + msg); }
function skip(msg){ console.log('  – ' + msg); }

// ── Step 1: Resolve or create leave types ─────────────────────────────────
const LEAVE_TYPES = [
  { name: 'Annual Leave',      external_id: 'ANNUAL' },
  { name: 'Sick Leave',        external_id: 'SICK' },
  { name: 'Casual Leave',      external_id: 'CASUAL' },
  { name: 'Maternity Leave',   external_id: 'MATERNITY' },
  { name: 'Paternity Leave',   external_id: 'PATERNITY' },
];

log('\n── Step 1: Leave Types ─────────────────────────────');
const leaveTypeMap = {}; // name → sys_id

const existingTypes = await get('/api/now/table/sn_hr_core_emp_time_off_type?sysparm_fields=sys_id,name,external_id&sysparm_limit=100');
for (const t of existingTypes.result ?? []) {
  leaveTypeMap[t.name] = t.sys_id;
}

for (const lt of LEAVE_TYPES) {
  if (leaveTypeMap[lt.name]) {
    skip(`${lt.name} already exists`);
  } else {
    const created = await post('/api/now/table/sn_hr_core_emp_time_off_type', lt);
    leaveTypeMap[lt.name] = created.sys_id;
    ok(`Created leave type: ${lt.name}`);
  }
}

// ── Step 2: Seed holidays ─────────────────────────────────────────────────
log('\n── Step 2: Holidays ────────────────────────────────');
const HOLIDAYS = [
  { name: 'Independence Day',  date: '2025-08-15' },
  { name: 'Gandhi Jayanti',    date: '2025-10-02' },
  { name: 'Diwali',            date: '2025-10-20' },
  { name: 'Christmas',         date: '2025-12-25' },
  { name: 'New Year',          date: '2026-01-01' },
  { name: 'Republic Day',      date: '2026-01-26' },
  { name: 'Holi',              date: '2026-03-03' },
];

for (const h of HOLIDAYS) {
  const existing = await get(`/api/now/table/sys_holiday?sysparm_query=date=${h.date}^name=${h.name}&sysparm_limit=1`);
  if (existing.result?.length > 0) {
    skip(`Holiday already exists: ${h.name} (${h.date})`);
  } else {
    await post('/api/now/table/sys_holiday', h);
    ok(`Created holiday: ${h.name} on ${h.date}`);
  }
}

// ── Step 3: Resolve users and HR profiles ─────────────────────────────────
log('\n── Step 3: Users & HR Profiles ─────────────────────');

const userData = []; // { email, user_id, profile_id }

for (const email of USERS) {
  const userRes = await get(`/api/now/table/sys_user?sysparm_query=email=${email}&sysparm_fields=sys_id,name,email&sysparm_limit=1`);
  const user = userRes.result?.[0];

  if (!user) {
    console.log(`  ✗ User not found: ${email} — skipping`);
    continue;
  }

  ok(`Found user: ${user.name} (${email})`);

  // Find or create HR profile
  const profRes = await get(`/api/now/table/sn_hr_core_profile?sysparm_query=user=${user.sys_id}&sysparm_fields=sys_id&sysparm_limit=1`);
  let profile_id = profRes.result?.[0]?.sys_id;

  if (!profile_id) {
    const newProfile = await post('/api/now/table/sn_hr_core_profile', { user: user.sys_id });
    profile_id = newProfile.sys_id;
    ok(`  Created HR profile for ${user.name}`);
  } else {
    skip(`  HR profile already exists`);
  }

  userData.push({ email, name: user.name, user_id: user.sys_id, profile_id });
}

if (userData.length === 0) {
  console.log('\n✗ No users found. Check that the emails match sys_user.email in your instance.');
  process.exit(1);
}

// ── Step 4: Leave balances ────────────────────────────────────────────────
log('\n── Step 4: Leave Balances ──────────────────────────');

const BALANCES = [
  { type: 'Annual Leave',    total: 21, used: 5  },
  { type: 'Sick Leave',      total: 12, used: 2  },
  { type: 'Casual Leave',    total: 6,  used: 1  },
  { type: 'Maternity Leave', total: 90, used: 0  },
  { type: 'Paternity Leave', total: 15, used: 0  },
];

// Slight variation per user
const USER_BALANCE_OVERRIDES = {
  'sagar.pinninti@zetechno.com':         { 'Annual Leave': { used: 8 },  'Sick Leave': { used: 0 } },
  'sucharitha.pothuganty@zetechno.com':  { 'Annual Leave': { used: 12 }, 'Casual Leave': { used: 3 } },
  'satyanarayana.adari@zetechno.com':    { 'Annual Leave': { used: 2 },  'Sick Leave': { used: 5 } },
  'sabyasachi.sahoo@zetechno.com':       { 'Annual Leave': { used: 15 }, 'Casual Leave': { used: 6 } },
};

for (const u of userData) {
  log(`\n  ${u.name}:`);
  for (const b of BALANCES) {
    const typeId = leaveTypeMap[b.type];
    if (!typeId) continue;

    const override = USER_BALANCE_OVERRIDES[u.email]?.[b.type] ?? {};
    const used = override.used ?? b.used;
    const available = b.total - used;

    // Check if balance already exists
    const existing = await get(`/api/now/table/sn_hr_core_emp_time_off_balance?sysparm_query=hr_profile=${u.profile_id}^type=${typeId}&sysparm_limit=1`);
    if (existing.result?.length > 0) {
      await patch(`/api/now/table/sn_hr_core_emp_time_off_balance/${existing.result[0].sys_id}`, {
        total_balance: b.total, used_pto: used, available_balance: available,
      });
      skip(`Updated balance: ${b.type} — ${available}/${b.total} days available`);
    } else {
      await post('/api/now/table/sn_hr_core_emp_time_off_balance', {
        hr_profile: u.profile_id, type: typeId,
        total_balance: b.total, used_pto: used, available_balance: available,
      });
      ok(`Balance: ${b.type} — ${available}/${b.total} days available`);
    }
  }
}

// ── Step 5: Sample leave requests ─────────────────────────────────────────
log('\n── Step 5: Sample Leave Requests ───────────────────');

const today = new Date();
const fmt = d => d.toISOString().split('T')[0];
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const REQUESTS_PER_USER = [
  { type: 'Annual Leave', daysFromNow: -30, duration: 3, status: 'approved' },
  { type: 'Sick Leave',   daysFromNow: -10, duration: 1, status: 'approved' },
  { type: 'Annual Leave', daysFromNow: 7,   duration: 2, status: 'pending' },
];

for (const u of userData) {
  log(`\n  ${u.name}:`);
  for (const r of REQUESTS_PER_USER) {
    const typeId = leaveTypeMap[r.type];
    if (!typeId) continue;

    const start = addDays(today, r.daysFromNow);
    const end   = addDays(start, r.duration - 1);

    // Skip weekends for start date
    while ([0, 6].includes(start.getDay())) start.setDate(start.getDate() + 1);
    while ([0, 6].includes(end.getDay()))   end.setDate(end.getDate() + 1);

    const existing = await get(`/api/now/table/sn_hr_core_emp_time_off?sysparm_query=hr_profile=${u.profile_id}^type=${typeId}^start_date=${fmt(start)}&sysparm_limit=1`);
    if (existing.result?.length > 0) {
      skip(`Request already exists: ${r.type} from ${fmt(start)}`);
      continue;
    }

    await post('/api/now/table/sn_hr_core_emp_time_off', {
      hr_profile: u.profile_id, type: typeId,
      start_date: fmt(start), end_date: fmt(end),
      quantity: r.duration, status: r.status,
    });
    ok(`${r.status.toUpperCase()}: ${r.type} — ${fmt(start)} to ${fmt(end)} (${r.duration} day(s))`);
  }
}

log('\n── Done! ────────────────────────────────────────────');
log(`Seeded data for ${userData.length} user(s). Test with:\n`);
for (const u of userData) {
  log(`  • ${u.name} <${u.email}>`);
}
log('\nTry asking Claude: "Check my leave balance" or "Can I take leave next Friday?"\n');
