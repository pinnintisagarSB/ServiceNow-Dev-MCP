/**
 * ServiceNow Notification Builder
 *
 * Create and manage:
 *  - Email notifications (sysevent_email_action) with HTML templates
 *  - Push notifications (sys_push_message)
 *  - Notification devices/channels
 *  - Email scripts (for dynamic content)
 *  - Notification categories
 *
 * All builders follow SN best practices:
 *  - Use ${table.field} syntax in templates (not inline scripting)
 *  - Email Script only for complex dynamic content
 *  - Always test with a specific condition before going broad
 */

export class NotificationBuilder {

  // ══════════════════════════════════════════════════════════════════════════
  // Email notification
  // ══════════════════════════════════════════════════════════════════════════
  buildEmailNotification({
    name,
    table,
    event,                // e.g. 'incident.inserted', or null to use condition
    condition,            // encoded query, used instead of event
    recipients,           // array of { type: 'field'|'group'|'role'|'user', value }
    subject,
    bodyHtml,
    replyTo,
    sendToRecipients = true,
    sendToEvent     = false,
    weight          = 0,
    category,
    active          = true,
    includeWorkNotes = false,
    emailScript,          // name of an Email Script for dynamic content
  }) {
    // ── Build recipient strings ───────────────────────────────────────────
    const recipientFields = (recipients ?? [])
      .filter(r => r.type === 'field')
      .map(r => r.value)
      .join(',');

    const recipientGroups = (recipients ?? [])
      .filter(r => r.type === 'group')
      .map(r => r.value)
      .join(',');

    const recipientRoles = (recipients ?? [])
      .filter(r => r.type === 'role')
      .map(r => r.value)
      .join(',');

    const recipientUsers = (recipients ?? [])
      .filter(r => r.type === 'user')
      .map(r => r.value)
      .join(',');

    // ── Default HTML template if not provided ─────────────────────────────
    const defaultBody = this._defaultEmailTemplate({
      title:    name,
      table,
      subject:  subject ?? name,
      includeWorkNotes,
    });

    return {
      deploy_table: 'sysevent_email_action',
      payload: {
        name,
        active,
        weight,
        category:          category ?? '',
        table:             table,
        event_name:        event ?? '',
        condition:         condition ?? '',
        send_self:         false,
        send_to_event_creator: sendToEvent,
        recipient_fields:  recipientFields,
        recipient_groups:  recipientGroups,
        recipient_roles:   recipientRoles,
        users:             recipientUsers,
        subject,
        message_html:      bodyHtml ?? defaultBody,
        message:           this._htmlToPlainText(bodyHtml ?? defaultBody),
        reply_to:          replyTo ?? '',
        email_script:      emailScript ?? '',
        from:              '',  // leave blank to use instance default
        omit_watermark:    false,
        push_message_only: false,
        'force_delivery':  false,
      },
      best_practices: [
        'Use ${table.field} syntax for field values — e.g. ${incident.number}',
        'Use ${table.field.getDisplayValue()} for reference field labels',
        'Avoid complex logic in subject/body — use an Email Script instead',
        'Set a weight > 0 to prevent duplicate notifications (higher weight wins)',
        'Always set a condition to limit which records trigger the notification',
        'Test with a single specific user before setting roles/groups as recipients',
        'Use "Send to event creator" only for acknowledgement notifications',
        'Set omit_watermark=true only for external-facing notifications',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Email Script (for dynamic recipient/content logic)
  // ══════════════════════════════════════════════════════════════════════════
  buildEmailScript({ name, description, logic }) {
    const script = `/**
 * Email Script: ${name}
 * ${description ?? ''}
 *
 * Available objects:
 *   current  — the triggering record GlideRecord
 *   event    — the sys_event record (if event-based)
 *   email    — the GlideEmailOutbound object (set recipients/subject/body)
 *   template — the notification template
 *
 * Best practices:
 *  - Use email.addAddress() to add recipients dynamically
 *  - Use template.print() to append to the email body
 *  - Keep this script focused — complex logic belongs in a Script Include
 */

(function runMailScript(current, email, event, template) {

    try {
        ${logic ?? `
        // Example: Add manager of the assigned user as CC
        if (!gs.nil(current.assigned_to)) {
            var manager = current.assigned_to.manager.getDisplayValue();
            if (manager) {
                email.addAddress('cc', current.assigned_to.manager.email.toString());
            }
        }
        `}
    } catch(e) {
        gs.error('Email Script [${name}] failed: ' + e.message);
    }

})(current, email, event, template);
`.trim();

    return {
      deploy_table: 'sys_script_email',
      payload: { name, active: true, script },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Push notification
  // ══════════════════════════════════════════════════════════════════════════
  buildPushNotification({ name, table, condition, title, body, sound, route_to, badge_count }) {
    return {
      deploy_table: 'sys_push_message',
      payload: {
        name,
        active:     true,
        table,
        condition:  condition ?? '',
        title:      title   ?? name,
        body:       body    ?? '${' + table + '.short_description}',
        sound:      sound   ?? 'default',
        badge_count: badge_count ?? '1',
        extra_data: route_to ? JSON.stringify({ route: route_to }) : '',
      },
      best_practices: [
        'Keep push notification body under 100 characters — most devices truncate',
        'Use ${field} tokens same as email notifications',
        'Set a tight condition — push notifications are more intrusive than email',
        'Test on both iOS and Android if using the Now Mobile app',
        'Use route_to (extra_data) to deep-link to the record in the mobile app',
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Analyze existing notifications for a table
  // ══════════════════════════════════════════════════════════════════════════
  async analyzeNotifications(table) {
    const rows = await this.sn.query('sysevent_email_action', {
      sysparm_query:  `table=${table}^active=true`,
      sysparm_fields: 'name,event_name,condition,subject,recipient_fields,recipient_groups,recipient_roles,weight,category',
      sysparm_limit:  50,
    });

    const issues = [];
    for (const n of rows) {
      if (!n.condition && !n.event_name)
        issues.push({ notification: n.name, issue: 'No condition or event — fires on every insert/update' });
      if (!n.recipient_fields && !n.recipient_groups && !n.recipient_roles)
        issues.push({ notification: n.name, issue: 'No recipients defined — notification goes nowhere' });
      if (n.weight === '0' || !n.weight)
        issues.push({ notification: n.name, issue: 'Weight = 0 — may conflict with other notifications for same event' });
    }

    return {
      table,
      count:       rows.length,
      notifications: rows.map(n => ({
        name:       n.name,
        event:      n.event_name ?? '(condition-based)',
        condition:  n.condition  ?? '(none)',
        recipients: [n.recipient_fields, n.recipient_groups, n.recipient_roles].filter(Boolean).join(' | '),
        subject:    n.subject,
        weight:     n.weight,
        category:   n.category ?? '(none)',
      })),
      issues,
      recommendation: issues.length
        ? `${issues.length} issue(s) found. Fix notifications with no conditions first — they fire on every record change.`
        : 'Notifications look healthy.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ══════════════════════════════════════════════════════════════════════════
  _defaultEmailTemplate({ title, table, subject, includeWorkNotes }) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #333; margin: 0; padding: 0; }
  .header { background: #293e40; color: #fff; padding: 16px 24px; }
  .header h2 { margin: 0; font-size: 18px; }
  .body { padding: 24px; background: #f4f4f4; }
  .card { background: #fff; border-radius: 4px; padding: 20px; margin-bottom: 16px; border: 1px solid #e0e0e0; }
  .field-row { margin-bottom: 12px; }
  .field-label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
  .field-value { margin-top: 4px; }
  .action-btn { display: inline-block; padding: 10px 20px; background: #293e40; color: #fff !important; text-decoration: none; border-radius: 4px; margin-top: 16px; }
  .footer { padding: 16px 24px; font-size: 11px; color: #888; }
</style>
</head>
<body>

<div class="header">
  <h2>${title}</h2>
</div>

<div class="body">
  <div class="card">
    <div class="field-row">
      <div class="field-label">Number</div>
      <div class="field-value"><strong>\${${table}.number}</strong></div>
    </div>
    <div class="field-row">
      <div class="field-label">Summary</div>
      <div class="field-value">\${${table}.short_description}</div>
    </div>
    <div class="field-row">
      <div class="field-label">State</div>
      <div class="field-value">\${${table}.state}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Priority</div>
      <div class="field-value">\${${table}.priority}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Assigned To</div>
      <div class="field-value">\${${table}.assigned_to.name}</div>
    </div>
    ${includeWorkNotes ? `
    <div class="field-row">
      <div class="field-label">Work Notes</div>
      <div class="field-value">\${${table}.work_notes}</div>
    </div>` : ''}
  </div>

  <a class="action-btn" href="\${URI}">View Record →</a>
</div>

<div class="footer">
  This is an automated message from ServiceNow. Do not reply directly to this email.
</div>

</body>
</html>`;
  }

  _htmlToPlainText(html) {
    return (html ?? '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1000);
  }
}

// Allow analyze_notifications to be called without snConnector
NotificationBuilder.prototype.analyzeNotifications = async function(table) {
  if (!this.sn) throw new Error('analyzeNotifications requires a ServiceNow connector. Instantiate NotificationBuilder with snConnector.');
  const rows = await this.sn.query('sysevent_email_action', {
    sysparm_query:  `table=${table}^active=true`,
    sysparm_fields: 'name,event_name,condition,subject,recipient_fields,recipient_groups,recipient_roles,weight,category',
    sysparm_limit:  50,
  });

  const issues = [];
  for (const n of rows) {
    if (!n.condition && !n.event_name)
      issues.push({ notification: n.name, issue: 'No condition or event — fires on every insert/update' });
    if (!n.recipient_fields && !n.recipient_groups && !n.recipient_roles)
      issues.push({ notification: n.name, issue: 'No recipients defined' });
    if (!n.weight || n.weight === '0')
      issues.push({ notification: n.name, issue: 'Weight = 0 — potential notification conflicts' });
  }

  return {
    table,
    count:         rows.length,
    notifications: rows.map(n => ({
      name:       n.name,
      event:      n.event_name ?? '(condition-based)',
      condition:  n.condition  ?? '(none)',
      recipients: [n.recipient_fields, n.recipient_groups, n.recipient_roles].filter(Boolean).join(' | '),
      subject:    n.subject,
      weight:     n.weight,
    })),
    issues,
    recommendation: issues.length
      ? `${issues.length} issue(s) found.`
      : 'Notifications look healthy.',
  };
};
