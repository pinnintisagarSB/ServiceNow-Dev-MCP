/**
 * User & Group Mapping
 *
 * Resolves source-platform users (Jira / Salesforce) to ServiceNow sys_user sys_ids
 * by matching on email address. Groups are matched by name against sys_user_group.
 *
 * Usage:
 *   const mapper = new UserGroupMapper(snConnector);
 *   await mapper.build(sourceUsers);            // load SN users once
 *   const sysId = mapper.resolveUser('a@b.com'); // fast lookup
 */

import { logger } from '../utils/logger.js';

export class UserGroupMapper {
  constructor(sn) {
    this.sn          = sn;
    this.userMap     = new Map();   // email.lower → sys_id
    this.groupMap    = new Map();   // name.lower  → sys_id
    this.fallbackUser  = null;
    this.fallbackGroup = null;
    this.unmatchedUsers  = new Set();
    this.unmatchedGroups = new Set();
  }

  // ── Load SN users and groups into memory ──────────────────────────────────
  async build(opts = {}) {
    this.fallbackUser  = opts.fallbackUser  ?? null;
    this.fallbackGroup = opts.fallbackGroup ?? null;

    logger.step('Loading ServiceNow users…');
    let offset = 0;
    while (true) {
      const batch = await this.sn.get('sys_user', {
        sysparm_query:  'active=true',
        sysparm_fields: 'sys_id,email,user_name,name',
        sysparm_limit:  '1000',
        sysparm_offset: String(offset),
      });
      if (!batch.length) break;
      batch.forEach(u => {
        if (u.email) this.userMap.set(u.email.toLowerCase(), u.sys_id);
        if (u.user_name) this.userMap.set(u.user_name.toLowerCase(), u.sys_id);
      });
      offset += batch.length;
      if (batch.length < 1000) break;
    }
    logger.info(`  ${this.userMap.size} user email/username entries loaded`);

    logger.step('Loading ServiceNow groups…');
    const groups = await this.sn.get('sys_user_group', {
      sysparm_query:  'active=true',
      sysparm_fields: 'sys_id,name',
      sysparm_limit:  '1000',
    });
    groups.forEach(g => this.groupMap.set(g.name.toLowerCase(), g.sys_id));
    logger.info(`  ${this.groupMap.size} groups loaded`);

    return this;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────
  resolveUser(emailOrUsername) {
    if (!emailOrUsername) return this.fallbackUser;
    const key = String(emailOrUsername).toLowerCase();
    const id  = this.userMap.get(key);
    if (!id) this.unmatchedUsers.add(emailOrUsername);
    return id ?? this.fallbackUser;
  }

  resolveGroup(name) {
    if (!name) return this.fallbackGroup;
    const key = String(name).toLowerCase();
    const id  = this.groupMap.get(key);
    if (!id) this.unmatchedGroups.add(name);
    return id ?? this.fallbackGroup;
  }

  // ── Match a batch of source users and return full mapping report ───────────
  async matchSourceUsers(sourceUsers) {
    // sourceUsers: [{ email, displayName, accountId? }]
    const results = { matched: [], unmatched: [] };
    for (const u of sourceUsers) {
      const email = u.email ?? u.emailAddress ?? u.Email ?? '';
      const id    = this.resolveUser(email);
      if (id) results.matched.push({ source: u, sn_user_sys_id: id });
      else    results.unmatched.push({ source: u, suggestion: 'Create user manually or set a fallback' });
    }
    return results;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  summary() {
    return {
      users_in_sn:      this.userMap.size,
      groups_in_sn:     this.groupMap.size,
      fallback_user:    this.fallbackUser,
      fallback_group:   this.fallbackGroup,
      unmatched_users:  [...this.unmatchedUsers],
      unmatched_groups: [...this.unmatchedGroups],
    };
  }
}
