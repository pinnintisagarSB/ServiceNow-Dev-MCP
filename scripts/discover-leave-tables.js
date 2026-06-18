#!/usr/bin/env node
// Discovers leave/absence/holiday related tables in your ServiceNow instance
// Usage: node scripts/discover-leave-tables.js

import 'dotenv/config';

const instance = process.env.SN_INSTANCE_URL?.replace(/\/$/, '');
const username = process.env.SN_USERNAME;
const password = process.env.SN_PASSWORD;

if (!instance || !username || !password) {
  console.error('Set SN_INSTANCE_URL, SN_USERNAME, SN_PASSWORD in .env');
  process.exit(1);
}

const auth = Buffer.from(`${username}:${password}`).toString('base64');

const keywords = ['leave', 'absence', 'vacation', 'holiday', 'time_off', 'pto', 'hr_leave', 'sn_hr'];

async function queryTables(keyword) {
  const url = `${instance}/api/now/table/sys_db_object?sysparm_query=nameLIKE${keyword}^ORlabelLIKE${keyword}&sysparm_fields=name,label,super_class.name&sysparm_limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.result ?? [];
}

const seen = new Set();
const results = [];

for (const kw of keywords) {
  try {
    const tables = await queryTables(kw);
    for (const t of tables) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        results.push(t);
      }
    }
  } catch (e) {
    console.error(`Error querying "${kw}":`, e.message);
  }
}

if (results.length === 0) {
  console.log('No leave/absence/holiday tables found.');
  console.log('Your instance may not have the HR Service Delivery module installed.');
  console.log('\nWe can create custom tables. Run this script with --suggest to see the schema.');
} else {
  console.log(`\nFound ${results.length} table(s):\n`);
  console.log('NAME'.padEnd(50) + 'LABEL');
  console.log('-'.repeat(80));
  for (const t of results.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(t.name.padEnd(50) + (t.label || ''));
  }
}
