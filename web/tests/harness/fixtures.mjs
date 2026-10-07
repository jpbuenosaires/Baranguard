/**
 * fixtures.mjs — fake server responses in the API's real WIRE format
 * (snake_case keys, bare `YYYY-MM-DD HH:MM:SS` UTC datetimes), so the app's
 * own apiClient.js mapping is what turns them into camelCase — the same
 * path production data takes.
 *
 * Field lists follow apiClient.js's hand-written mappings exactly; enum
 * values follow backend/migrations. All data is synthetic.
 *
 * Server-side rules the real API enforces are mirrored where a page's
 * behaviour depends on them — most importantly, only a Secretary's token
 * receives `raw_narrative` and the party fields from GET /incidents/:id
 * (REFERENCE.md §2 Rule 1). The session token encodes the role
 * (`test-token-<role>`), see render.mjs.
 */

/** Markup that must never become live DOM. Tests look for `[data-xss-canary]`. */
export const XSS = '<img src=x data-xss-canary onerror="window.__xssFired=true"><b data-xss-canary>x</b>';

const MIN = 60 * 1000;
export function sqlAgo(minutes) {
  return new Date(Date.now() - minutes * MIN).toISOString().slice(0, 19).replace('T', ' ');
}
function dateAgo(days) {
  return new Date(Date.now() + 8 * 60 * MIN - days * 1440 * MIN).toISOString().slice(0, 10);
}

function roleFromAuth(headers) {
  const m = /test-token-([a-z_]+)/.exec(headers?.authorization || '');
  return m ? m[1] : null;
}

function paginate(items, query) {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 25);
  return { items: items.slice((page - 1) * limit, page * limit), page, limit, total: items.length };
}

const ok = (body) => ({ status: 200, body });
const notFound = (message = 'Not found.') => ({ status: 404, body: { error: { code: 'NOT_FOUND', message } } });

// ---------------------------------------------------------------------------

export function buildRoutes(scenario) {
  const empty = scenario === 'empty';
  const t = (text) => (scenario === 'xss' ? `${text} ${XSS}` : text);

  // --- People ---------------------------------------------------------------
  const users = [
    { user_id: 1, full_name: t('Ramon Elcano'), username: t('admin.dao'), role: 'admin', contact_number: '09170000001', is_active: 1, is_suspended: 0, created_at: sqlAgo(90 * 1440), last_login_at: sqlAgo(5) },
    { user_id: 2, full_name: t('Liwayway Ferrer'), username: 'secretary.dao', role: 'secretary', contact_number: '09170000002', is_active: 1, is_suspended: 0, created_at: sqlAgo(90 * 1440), last_login_at: sqlAgo(60) },
    { user_id: 3, full_name: t('Teresa Magbanua'), username: 'kapitan.dao', role: 'punong_barangay', contact_number: t('09170000003'), is_active: 1, is_suspended: 0, created_at: sqlAgo(90 * 1440), last_login_at: null },
    { user_id: 4, full_name: t('Jose Reyes'), username: 'tanod.reyes', role: 'tanod', contact_number: '09170000004', is_active: 1, is_suspended: 0, created_at: sqlAgo(60 * 1440), last_login_at: sqlAgo(10) },
    { user_id: 5, full_name: t('Maria Dela Cruz'), username: 'tanod.delacruz', role: 'tanod', contact_number: '09170000005', is_active: 1, is_suspended: 0, created_at: sqlAgo(60 * 1440), last_login_at: sqlAgo(30) },
    { user_id: 6, full_name: t('Pedro Gubaton'), username: 'tanod.gubaton', role: 'tanod', contact_number: null, is_active: 1, is_suspended: 1, created_at: sqlAgo(60 * 1440), last_login_at: null },
    { user_id: 7, full_name: t('Ana Dichoso'), username: 'tanod.dichoso', role: 'tanod', contact_number: '09170000007', is_active: 0, is_suspended: 0, created_at: sqlAgo(60 * 1440), last_login_at: null },
  ];
  const tanodName = (id) => users.find((u) => u.user_id === id)?.full_name ?? null;
  // Contract section 2: official_title + approval_authority (an array on the
  // wire). Only admin / secretary / punong_barangay accounts may hold any.
  const authorityByUser = {
    1: [t('Chief Tanod'), ['note_report', 'prepare_annex_d']],
    2: ['Kagawad', ['note_report']],
    3: ['Punong Barangay', ['note_report', 'approve_report', 'approve_roster', 'approve_annex_d']],
  };
  for (const u of users) {
    const [title, authority] = authorityByUser[u.user_id] ?? [null, []];
    u.official_title = title;
    u.approval_authority = authority;
  }

  // --- Incidents --------------------------------------------------------------
  // 901 pending/high with coords · 902 dispatched/critical with two responders
  // 903 resolved · 904 pending, NO coords.
  // The 'empty' scenario empties LISTS only; a detail page's own incident
  // still exists (an empty barangay, not a deleted record).
  const allIncidents = [
    { incident_id: 901, barangay_id: 1, reported_by: 4, incident_type: 'theft', priority: 'high', status: 'pending', source: 'app', latitude: 12.9201, longitude: 123.6702, created_at: sqlAgo(12), device_offline_created_at: null, synced_at: sqlAgo(11), location_description: t('Purok 3, near the market'), display_id: 'INC-2026-901', officer_name: tanodName(4) },
    { incident_id: 902, barangay_id: 1, reported_by: 5, incident_type: 'medical_emergency', priority: 'critical', status: 'dispatched', source: 'sms', latitude: 12.9172, longitude: 123.6655, created_at: sqlAgo(45), device_offline_created_at: sqlAgo(50), synced_at: sqlAgo(44), location_description: t('Purok 6, beside the chapel'), display_id: 'INC-2026-902', officer_name: tanodName(5) },
    { incident_id: 903, barangay_id: 1, reported_by: 4, incident_type: 'disturbance', priority: 'normal', status: 'resolved', source: 'web', latitude: 12.9190, longitude: 123.6690, created_at: sqlAgo(3 * 1440), device_offline_created_at: null, synced_at: sqlAgo(3 * 1440), location_description: t('Roadside stalls, Purok 4'), display_id: 'INC-2026-903', officer_name: tanodName(4) },
    { incident_id: 904, barangay_id: 1, reported_by: 2, incident_type: 'vandalism', priority: 'normal', status: 'pending', source: 'web', latitude: null, longitude: null, created_at: sqlAgo(200), device_offline_created_at: null, synced_at: null, location_description: null, display_id: 'INC-2026-904', officer_name: null },
  ];
  // Contract section 7: every incident carries school_id + the three C-1 fields.
  for (const inc of allIncidents) {
    inc.school_id = null;
    inc.c1_summary = null;
    inc.c1_action_taken = null;
    inc.c1_status_notes = null;
  }
  Object.assign(allIncidents.find((i) => i.incident_id === 902), {
    school_id: 11,
    c1_summary: t('Pupil felt faint near the school gate.'),
    c1_action_taken: t('First aid given, ambulance called.'),
    c1_status_notes: null,
  });
  const incidents = empty ? [] : allIncidents;

  // --- Schools / referrals / availability (sections 3, 5, 7) -----------------
  const schools = empty ? [] : [
    { school_id: 11, barangay_id: 1, name: t('Dao Elementary School'), school_type: 'public', level: 'primary_elementary', address: t('Purok 1, Dao'), focal_person: null, focal_contact: null, remarks: null, latitude: 12.9205, longitude: 123.6698, is_active: 1 },
    { school_id: 12, barangay_id: 1, name: t('Dao Integrated High School'), school_type: 'public', level: 'secondary_high_school', address: t('Purok 2, Dao'), focal_person: t('Mrs. Reyes'), focal_contact: '09170000020', remarks: null, latitude: null, longitude: null, is_active: 1 },
    { school_id: 13, barangay_id: 1, name: t('Old Daycare Center'), school_type: 'private', level: 'preschool_daycare_eccd', address: t('Purok 5, Dao'), focal_person: null, focal_contact: null, remarks: null, latitude: null, longitude: null, is_active: 0 },
  ];
  const referrals = empty ? [] : [
    { referral_id: 1, incident_id: 902, barangay_id: 1, referred_to: 'ambulance_ems', other_text: null, contact_name: t('Pilar Rescue Unit 2'), referred_at: sqlAgo(30), reference_no: 'EMS-0042', created_by: 1, created_at: sqlAgo(30) },
    { referral_id: 2, incident_id: 903, barangay_id: 1, referred_to: 'other', other_text: t('Municipal Engineering Office'), contact_name: null, referred_at: sqlAgo(2 * 1440), reference_no: null, created_by: 2, created_at: sqlAgo(2 * 1440) },
  ];
  const availability = empty ? [] : [
    { avail_id: 31, barangay_id: 1, user_id: 4, period_start: '2026-10-05', period_end: '2026-10-11', windows_json: [{ date: '2026-10-05', start: '08:00', end: '16:00' }, { date: '2026-10-06', start: '22:00', end: '23:59' }], status: 'submitted', reviewed_by: null, reviewed_at: null, review_note: null, version: 1, created_at: sqlAgo(300), updated_at: sqlAgo(300) },
    { avail_id: 32, barangay_id: 1, user_id: 5, period_start: '2026-10-05', period_end: '2026-10-11', windows_json: [{ date: '2026-10-07', start: '06:00', end: '14:00' }], status: 'accepted', reviewed_by: 1, reviewed_at: sqlAgo(60), review_note: t('Thanks.'), version: 1, created_at: sqlAgo(400), updated_at: sqlAgo(60) },
  ];
  const accomplishmentReports = empty ? [] : [
    { report_id: 71, barangay_id: 1, user_id: 4, full_name: tanodName(4), month: '2026-09', status: 'prepared', entry_count: 2, total_minutes: 960, flagged_entries: 1, total_minutes_confirmed: null, prepared_at: sqlAgo(1440), noted_by: null, noted_at: null, approved_by: null, approved_at: null, return_reason: null, version: 2 },
    { report_id: 72, barangay_id: 1, user_id: 5, full_name: tanodName(5), month: '2026-09', status: 'noted', entry_count: 1, total_minutes: 480, flagged_entries: 0, total_minutes_confirmed: null, prepared_at: sqlAgo(2880), noted_by: 2, noted_at: sqlAgo(1440), approved_by: null, approved_at: null, return_reason: null, version: 3 },
  ];
  const accomplishmentEntries = (reportId) => (reportId === 71 ? [
    { entry_id: 501, report_id: 71, user_id: 4, work_date: '2026-09-03', accomplishment_text: t('Foot patrol, Purok 3 and 4.'), start_time: '08:00:00', end_time: '16:00:00', duration_minutes: 480, suggested_duration_minutes: 470, duration_flag: 0 },
    { entry_id: 502, report_id: 71, user_id: 4, work_date: '2026-09-04', accomplishment_text: t('Assisted at the market.'), start_time: null, end_time: null, duration_minutes: 480, suggested_duration_minutes: 120, duration_flag: 1 },
  ] : [
    { entry_id: 503, report_id: 72, user_id: 5, work_date: '2026-09-05', accomplishment_text: t('Traffic assistance.'), start_time: null, end_time: null, duration_minutes: 480, suggested_duration_minutes: 480, duration_flag: 0 },
  ]);
  const sszTermReports = empty ? [] : [
    { report_id: 81, barangay_id: 1, term_label: 'Term 1 S.Y. 2026-2027', term_start: '2026-08-24', term_end: '2026-10-30', status: 'draft', total_tanods: 3, total_schools: 2, total_deployment_days: 12, total_incidents: 1, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0, incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 1, other_institutions: 'Ambulance/EMS', remarks: null, prepared_by: null, prepared_at: null, approved_by: null, approved_at: null, mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 1 },
    { report_id: 82, barangay_id: 1, term_label: 'Term 4 S.Y. 2025-2026', term_start: '2026-03-02', term_end: '2026-04-10', status: 'prepared', total_tanods: 3, total_schools: 2, total_deployment_days: 20, total_incidents: 0, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0, incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 0, other_institutions: null, remarks: null, prepared_by: 1, prepared_at: sqlAgo(1440), approved_by: null, approved_at: null, mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 2 },
  ];

  const dispatches = empty ? [] : [
    { dispatch_id: 7001, incident_id: 902, tanod_id: 5, tanod_name: tanodName(5), priority: 'critical', route_json: { mode: 'foot', geometry: { type: 'LineString', coordinates: [[123.665, 12.917], [123.6655, 12.9172]] }, distance_m: 420, duration_s: 300, steps: [{ instruction: t('Head north'), maneuver: 'depart', distance_m: 420, duration_s: 300 }] }, route_status: 'available', status: 'en_route', dispatched_at: sqlAgo(40), en_route_at: sqlAgo(38), arrived_at: null, completed_at: null, cancelled_at: null },
    { dispatch_id: 7002, incident_id: 902, tanod_id: 4, tanod_name: tanodName(4), priority: 'critical', route_json: null, route_status: 'unavailable', status: 'assigned', dispatched_at: sqlAgo(20), en_route_at: null, arrived_at: null, completed_at: null, cancelled_at: null },
    { dispatch_id: 7003, incident_id: 903, tanod_id: 4, tanod_name: tanodName(4), priority: 'normal', route_json: null, route_status: 'stale', status: 'completed', dispatched_at: sqlAgo(3 * 1440 - 5), en_route_at: sqlAgo(3 * 1440 - 7), arrived_at: sqlAgo(3 * 1440 - 20), completed_at: sqlAgo(3 * 1440 - 60), cancelled_at: null },
  ];

  const incidentDetail = (inc, role) => {
    const own = dispatches.filter((d) => d.incident_id === inc.incident_id);
    const first = own[0];
    const detail = {
      ...inc,
      dispatched_at: first?.dispatched_at ?? null,
      arrived_at: first?.arrived_at ?? null,
      has_active_dispatch: own.some((d) => ['assigned', 'en_route', 'arrived'].includes(d.status)),
      dispatches: own.map(({ dispatch_id, tanod_id, tanod_name, status, dispatched_at, en_route_at, arrived_at, completed_at, cancelled_at }) => ({ dispatch_id, tanod_id, tanod_name, status, dispatched_at, en_route_at, arrived_at, completed_at, cancelled_at })),
    };
    // REFERENCE.md §2 Rule 1: raw narrative + party fields reach a Secretary only.
    if (role === 'secretary') {
      detail.raw_narrative = t(`RAW-NARRATIVE-${inc.incident_id}: Complainant Juan Santos reported the incident at 0917-555-0101.`);
      detail.complainant_name = t('Juan Santos');
      detail.respondent_name = inc.incident_id === 903 ? t('Carlos Mendoza') : null;
      detail.complainant_contact_number = '09175550101';
    }
    return detail;
  };

  const citizenReports = empty ? [] : [
    { report_id: 301, description: t('Loud videoke past midnight near the covered court'), contact_number: t('09181234567'), latitude: 12.9188, longitude: 123.6661, submitted_at: sqlAgo(25), incident_id: null },
    { report_id: 302, description: t('Fallen tree blocking the road to Purok 2'), contact_number: null, latitude: null, longitude: null, submitted_at: sqlAgo(300), incident_id: null },
    { report_id: 303, description: t('Stray dogs near the school gate'), contact_number: '09181112222', latitude: 12.921, longitude: 123.668, submitted_at: sqlAgo(2 * 1440), incident_id: 903 },
  ];

  const shifts = empty ? [] : [
    { shift_id: 501, user_id: 4, patrol_zone: t('Zone 1 - Riverside'), start_at: sqlAgo(120), end_at: sqlAgo(-600), version: 1, approval_status: 'published', approved_by: 3, approved_at: sqlAgo(600), source_availability_id: null },
    { shift_id: 502, user_id: 5, patrol_zone: t('Zone 2 - Market'), start_at: sqlAgo(-1440), end_at: sqlAgo(-720), version: 3, approval_status: 'draft', approved_by: null, approved_at: null, source_availability_id: 32 },
    { shift_id: 503, user_id: null, patrol_zone: null, start_at: sqlAgo(-2880), end_at: sqlAgo(-2160), version: 1, approval_status: 'draft', approved_by: null, approved_at: null, source_availability_id: null },
    { shift_id: 504, user_id: 4, patrol_zone: 'Zone 3', start_at: sqlAgo(3 * 1440), end_at: sqlAgo(3 * 1440 - 720), version: 2, approval_status: 'published', approved_by: 3, approved_at: sqlAgo(3 * 1440 + 60), source_availability_id: null },
  ];

  const swapRequests = empty ? [] : [
    { request_id: 601, requesting_user_id: 5, shift_id: 502, target_user_id: 4, reason: t('Family emergency'), status: 'pending', requested_at: sqlAgo(90), resolved_at: null, resolved_by: null, version: 1 },
    { request_id: 602, requesting_user_id: 4, shift_id: 504, target_user_id: null, reason: null, status: 'approved', requested_at: sqlAgo(4 * 1440), resolved_at: sqlAgo(3.5 * 1440), resolved_by: 1, version: 2 },
  ];

  const fatigueFlags = empty ? [] : [
    { flag_id: 801, user_id: 4, shift_id: 501, hours_worked_7day: 62.5, calculation_basis: 'scheduled_hours', flagged_at: sqlAgo(30), acknowledged_at: null, acknowledged_by: null, acknowledged_by_name: null, shift_patrol_zone: t('Purok 4'), shift_start_at: sqlAgo(60), shift_end_at: sqlAgo(0) },
    { flag_id: 802, user_id: 5, shift_id: 502, hours_worked_7day: 49, calculation_basis: 'scheduled_hours', flagged_at: sqlAgo(2 * 1440), acknowledged_at: sqlAgo(1440), acknowledged_by: 1, acknowledged_by_name: t('Admin Dao'), shift_patrol_zone: t('Purok 2'), shift_start_at: sqlAgo(2 * 1440), shift_end_at: sqlAgo(2 * 1440 - 480) },
  ];

  const sos = empty ? [] : [
    { sos_id: 91, user_id: 5, dispatch_id: 7001, latitude: 12.9175, longitude: 123.6658, triggered_at: sqlAgo(3), received_at: sqlAgo(3), status: 'active', acknowledged_at: null, resolved_at: null },
  ];

  const smsLogs = empty ? [] : [
    { log_id: 1101, report_id: null, incident_id: 902, dispatch_id: 7001, transport: 'semaphore', message_type: 'dispatch', direction: 'outbound', status: 'sent', correlation_id: t('corr-1'), gateway_message_id: 'gw-1', modem_message_id: null, sent_at: sqlAgo(39), received_at: null, created_at: sqlAgo(40), failure_reason: null },
    { log_id: 1102, report_id: 301, incident_id: null, dispatch_id: null, transport: 'gsm_modem', message_type: 'incident', direction: 'inbound', status: 'received', correlation_id: null, gateway_message_id: null, modem_message_id: 'm-7', sent_at: null, received_at: sqlAgo(26), created_at: sqlAgo(26), failure_reason: null },
    { log_id: 1103, report_id: null, incident_id: null, dispatch_id: null, transport: 'semaphore', message_type: 'manual', direction: 'outbound', status: 'failed', correlation_id: null, gateway_message_id: null, modem_message_id: null, sent_at: null, received_at: null, created_at: sqlAgo(500), failure_reason: t('Gateway rejected the sender name') },
  ];

  const conversations = empty ? [] : [
    { phone_number: '09181234567', display_name: t('Resident (Purok 2)'), unread_count: 2, last_message: { log_id: 1102, direction: 'inbound', message_type: 'incident', message_body: t('May sunog po sa Purok 2'), status: 'received', created_at: sqlAgo(26), sent_at: null, received_at: sqlAgo(26) } },
    { phone_number: '09170000004', display_name: tanodName(4), unread_count: 0, last_message: null },
  ];
  const conversationMessages = empty ? [] : [
    { log_id: 1102, direction: 'inbound', message_type: 'incident', message_body: t('May sunog po sa Purok 2'), status: 'received', failure_reason: null, incident_id: null, dispatch_id: null, report_id: 301, created_at: sqlAgo(26), sent_at: null, received_at: sqlAgo(26) },
    { log_id: 1104, direction: 'outbound', message_type: 'manual', message_body: t('Papunta na po ang tanod.'), status: 'sent', failure_reason: null, incident_id: 902, dispatch_id: null, report_id: null, created_at: sqlAgo(20), sent_at: sqlAgo(20), received_at: null },
  ];

  const auditRows = empty ? [] : [
    { audit_id: 44001, actor_user_id: 1, actor_username: t('admin.dao'), action: 'dispatch_created', entity_type: 'dispatch', entity_id: 7001, metadata_json: { incident_id: 902, tanod_id: 5, note: t('priority bump') }, created_at: sqlAgo(40) },
    { audit_id: 44002, actor_user_id: 2, actor_username: 'secretary.dao', action: 'ai_redaction_approved', entity_type: 'incident', entity_id: 903, metadata_json: { draft_version: 2 }, created_at: sqlAgo(2 * 1440) },
    { audit_id: 44003, actor_user_id: null, actor_username: null, action: 'login_failure', entity_type: 'user', entity_id: null, metadata_json: null, created_at: sqlAgo(3000) },
  ];

  const evidence = empty ? [] : [
    { attachment_id: 1, incident_id: 902, type: 'photo', uploaded_by: 5, uploaded_at: sqlAgo(35), sha256: 'a'.repeat(64), byte_size: 245760, mime_type: 'image/jpeg', original_filename: t('scene.jpg') },
    { attachment_id: 2, incident_id: 902, type: 'voice', uploaded_by: 5, uploaded_at: sqlAgo(34), sha256: 'b'.repeat(64), byte_size: 81920, mime_type: 'audio/aac', original_filename: 'note.aac' },
  ];


  const trendDays = empty ? [] : Array.from({ length: 30 }, (_, i) => ({ date: dateAgo(29 - i), count: (i * 7) % 5, resolved: (i * 3) % 3 }));

  const routes = [
    // --- Auth ---
    { method: 'POST', path: '/auth/login', handler: ({ body }) => {
      const user = users.find((u) => u.username === body?.username);
      if (!user || body?.password !== 'Correct-Horse-9') return { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } } };
      return ok({ token: `test-token-${user.role}`, expires_at: new Date(Date.now() + 15 * MIN).toISOString(), user: { user_id: user.user_id, full_name: user.full_name, role: user.role, barangay_id: 1 } });
    } },
    { method: 'POST', path: '/auth/logout', handler: () => ok({ logged_out: true }) },
    { method: 'POST', path: '/auth/change-password', handler: ({ body }) => (body?.current_password === 'Correct-Horse-9' ? ok({ changed: true }) : { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' } } }) },

    // --- Reports ---
    { method: 'GET', path: '/reports/summary', handler: () => ok({
      total_incidents: incidents.length, resolved_count: incidents.filter((i) => i.status === 'resolved').length,
      avg_response_time_minutes: empty ? null : 20.3, active_tanods: empty ? 0 : 2,
      by_incident_type: empty ? {} : { theft: 1, medical_emergency: 1, disturbance: 1, vandalism: 1 },
      by_status: empty ? {} : { pending: 2, dispatched: 1, resolved: 1 },
      trend: trendDays,
      by_hour: Array.from({ length: 24 }, (_, h) => (empty ? 0 : (h * 5) % 4)),
      response_time_trend: empty ? [] : trendDays.map((d, i) => ({ date: d.date, avg_minutes: i % 4 === 0 ? null : 15 + (i % 7) })),
    }) },
    { method: 'GET', path: '/reports/heatmap', handler: () => ok({ items: incidents.filter((i) => i.latitude !== null).map((i) => ({ latitude: i.latitude, longitude: i.longitude, weight: 1, incident_type: i.incident_type, priority: i.priority, status: i.status })) }) },
    { method: 'GET', path: '/reports/nav-counts', handler: () => ok({ pending_incidents: empty ? 0 : 2, unconverted_citizen_reports: empty ? 0 : 2, pending_swap_requests: empty ? 0 : 1, unacknowledged_fatigue_flags: empty ? 0 : 1 }) },
    { method: 'GET', path: '/reports/export', handler: ({ query }) => ok({ file_url: `/reports/export/download?format=${query.format || 'csv'}`, format: query.format || 'csv', generated_at: sqlAgo(0) }) },
    { method: 'GET', path: '/reports/export/download', handler: () => ({ status: 200, raw: 'incident_id,type\r\n901,theft\r\n', headers: { 'Content-Type': 'text/csv' } }) },
    // Periodic PB digest (REMAINING.md section G, DEVLOG (37)) -- no
    // generate fixture on purpose, same as the real API: generation is
    // CLI-only, GET /reports/digest is read-only.
    { method: 'GET', path: '/reports/digest', handler: () => ok(empty
      ? { available: false }
      : { available: true, generated_at: sqlAgo(1), date_from: '2026-09-19', date_to: '2026-09-26' }) },
    { method: 'GET', path: '/reports/digest/download', handler: () => ({ status: 200, raw: '%PDF-1.4 fixture', headers: { 'Content-Type': 'application/pdf' } }) },

    // --- Users ---
    { method: 'GET', path: '/users', handler: ({ query }) => ok(paginate(users.filter((u) => !query.role || u.role === query.role), query)) },
    { method: 'POST', path: '/users', handler: ({ body }) => (users.some((u) => u.username === body.username)
      ? { status: 409, body: { error: { code: 'USERNAME_TAKEN', message: 'That username is already in use.' } } }
      : { status: 201, body: { user_id: 99, username: body.username, full_name: body.full_name, role: body.role, contact_number: body.contact_number, is_active: 1 } }) },
    { method: 'GET', path: '/users/:id', handler: ({ params }) => {
      const user = users.find((u) => u.user_id === Number(params.id));
      return user ? ok(user) : notFound('User not found.');
    } },
    { method: 'PATCH', path: '/users/:id', handler: ({ params, body }) => ok({ user_id: Number(params.id), updated: Object.keys(body || {}), is_active: body?.is_active ?? 1, is_suspended: body?.is_suspended ?? 0 }) },

    // --- Incidents ---
    { method: 'GET', path: '/incidents', handler: ({ query }) => {
      let rows = incidents;
      if (query.status) rows = rows.filter((i) => i.status === query.status);
      if (query.priority) rows = rows.filter((i) => i.priority === query.priority);
      if (query.q) rows = rows.filter((i) => `${i.display_id} ${i.incident_type} ${i.status}`.toLowerCase().includes(String(query.q).toLowerCase()));
      return ok(paginate(rows, query));
    } },
    { method: 'POST', path: '/incidents', handler: ({ body }) => ({ status: 201, body: { incident_id: 905, barangay_id: 1, reported_by: 1, incident_type: body.incident_type, priority: body.priority || 'normal', status: 'pending', source: 'web', latitude: body.latitude ?? null, longitude: body.longitude ?? null, location_description: body.location_description ?? null, display_id: 'INC-2026-905', created_at: sqlAgo(0) } }) },
    { method: 'GET', path: '/incidents/:id', handler: ({ params, headers }) => {
      const inc = allIncidents.find((i) => i.incident_id === Number(params.id));
      return inc ? ok(incidentDetail(inc, roleFromAuth(headers))) : notFound('Incident not found.');
    } },
    { method: 'PATCH', path: '/incidents/:id', handler: ({ params, body }) => ((body && ('raw_narrative' in body || 'redacted_narrative' in body))
      ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Narrative fields cannot be edited here.' } } }
      : ok({ incident_id: Number(params.id), updated: true, fields: Object.keys(body || {}) })) },
    { method: 'GET', path: '/incidents/:id/referrals', handler: ({ params }) => ok({ items: referrals.filter((r) => r.incident_id === Number(params.id)) }) },
    { method: 'POST', path: '/incidents/:id/referrals', handler: ({ params, body }) => ((body && body.referred_to)
      ? { status: 201, body: { referral_id: 9, incident_id: Number(params.id), barangay_id: 1, referred_to: body.referred_to, other_text: body.other_text ?? null, contact_name: body.contact_name ?? null, referred_at: sqlAgo(0), reference_no: body.reference_no ?? null, created_by: 1, created_at: sqlAgo(0) } }
      : { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'referred_to is required.' } } }) },
    { method: 'GET', path: '/referrals', handler: ({ query }) => ok(paginate(referrals
      .filter((r) => !query.referred_to || r.referred_to === query.referred_to)
      .map((r) => {
        const inc = allIncidents.find((i) => i.incident_id === r.incident_id);
        return { referral_id: r.referral_id, incident_id: r.incident_id, display_id: inc?.display_id ?? null, incident_type: inc?.incident_type ?? null, referred_to: r.referred_to, other_text: r.other_text, referred_at: r.referred_at, reference_no: r.reference_no };
      }), query)) },
    { method: 'GET', path: '/schools', handler: ({ query }) => ok({ items: schools.filter((s) => query.active === undefined || String(s.is_active) === String(query.active)) }) },
    { method: 'POST', path: '/schools', handler: ({ body }) => ({ status: 201, body: { school_id: 19, barangay_id: 1, is_active: 1, ...body } }) },
    { method: 'PATCH', path: '/schools/:id', handler: ({ params, body }) => ok({ school_id: Number(params.id), updated: Object.keys(body || {}) }) },
    { method: 'GET', path: '/school-checkins', handler: ({ query }) => ok(paginate(empty ? [] : [
      { checkin_id: 1, school_id: 11, user_id: 4, checked_in_at: sqlAgo(600), checked_out_at: sqlAgo(540) },
    ], query)) },
    { method: 'GET', path: '/reports/school-term', handler: () => ok({ total_tanods: empty ? 0 : 3, total_schools: schools.filter((s) => s.is_active).length, total_deployment_days: empty ? 0 : 12, total_incidents: empty ? 0 : 1, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0, incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: empty ? 0 : 1, other_institutions: empty ? null : 'Ambulance/EMS' }) },
    { method: 'GET', path: '/ssz-term-reports', handler: ({ query }) => ok(paginate(sszTermReports, query)) },
    { method: 'POST', path: '/ssz-term-reports', handler: ({ body }) => ({ status: 201, body: { ...sszTermReports[0], report_id: 89, term_label: body.term_label, term_start: body.term_start, term_end: body.term_end, status: 'draft' } }) },
    { method: 'GET', path: '/ssz-term-reports/:id', handler: ({ params }) => {
      const row = sszTermReports.find((r) => r.report_id === Number(params.id));
      return row ? ok(row) : notFound('Report not found.');
    } },
    { method: 'PATCH', path: '/ssz-term-reports/:id', handler: ({ params }) => ok({ report_id: Number(params.id), updated: true }) },
    { method: 'POST', path: '/ssz-term-reports/:id/prepare', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'prepared' }) },
    { method: 'POST', path: '/ssz-term-reports/:id/approve', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'approved' }) },
    { method: 'POST', path: '/ssz-term-reports/:id/mark-submitted', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'submitted' }) },
    { method: 'GET', path: '/accomplishment-reports', handler: ({ query }) => ok(paginate(accomplishmentReports
      .filter((r) => (!query.status || r.status === query.status) && (!query.month || r.month === query.month) && (!query.user_id || r.user_id === Number(query.user_id))), query)) },
    { method: 'GET', path: '/accomplishment-reports/:id', handler: ({ params }) => {
      const row = accomplishmentReports.find((r) => r.report_id === Number(params.id));
      return row ? ok({ ...row, entries: accomplishmentEntries(row.report_id) }) : notFound('Report not found.');
    } },
    { method: 'POST', path: '/accomplishment-reports/:id/note', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'noted' }) },
    { method: 'POST', path: '/accomplishment-reports/:id/approve', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'approved' }) },
    { method: 'POST', path: '/accomplishment-reports/:id/return', handler: ({ params }) => ok({ report_id: Number(params.id), status: 'returned' }) },
    { method: 'PATCH', path: '/incidents/:id/status', handler: ({ params }) => ok({ incident_id: Number(params.id), status: 'resolved' }) },
    { method: 'GET', path: '/incidents/:id/evidence', handler: ({ params }) => ok({ items: evidence.filter((e) => e.incident_id === Number(params.id)) }) },

    // --- Dispatch / GPS / SOS / duty ---
    { method: 'GET', path: '/dispatch', handler: ({ query }) => {
      let rows = dispatches;
      if (query.incident_id) rows = rows.filter((d) => d.incident_id === Number(query.incident_id));
      if (query.status) rows = rows.filter((d) => d.status === query.status);
      return ok(paginate(rows, query));
    } },
    { method: 'POST', path: '/dispatch', handler: ({ body }) => ({ status: 201, body: { dispatch_id: 7009, status: 'assigned', incident_id: body.incident_id, route_status: 'unavailable' } }) },
    { method: 'PATCH', path: '/dispatch/:id/cancel', handler: ({ params }) => ok({ dispatch_id: Number(params.id), status: 'cancelled', incident_id: 902, incident_status: 'dispatched', cancelled_at: sqlAgo(0) }) },
    { method: 'GET', path: '/gps/live', handler: () => ok({ items: empty ? [] : [
      { user_id: 4, full_name: tanodName(4), dispatch_id: 7002, latitude: 12.9180, longitude: 123.6670, accuracy_m: 9.5, recorded_at: sqlAgo(0.5), received_at: sqlAgo(0.4), age_seconds: 30, is_stale: false },
      { user_id: 5, full_name: tanodName(5), dispatch_id: 7001, latitude: 12.9174, longitude: 123.6657, accuracy_m: 38, recorded_at: sqlAgo(9), received_at: sqlAgo(9), age_seconds: 540, is_stale: true },
    ] }) },
    { method: 'GET', path: '/gps/history', handler: ({ query }) => ok(paginate(empty ? [] : [{ track_id: 1, user_id: 4, dispatch_id: null, latitude: 12.918, longitude: 123.667, accuracy_m: 10, recorded_at: sqlAgo(5), received_at: sqlAgo(5) }], query)) },
    { method: 'GET', path: '/tanod-sos', handler: ({ query }) => ok({ items: sos.filter((s) => !query.status || s.status === query.status) }) },
    { method: 'PATCH', path: '/tanod-sos/:id/acknowledge', handler: ({ params }) => ok({ sos_id: Number(params.id), status: 'acknowledged' }) },
    { method: 'PATCH', path: '/tanod-sos/:id/resolve', handler: ({ params }) => ok({ sos_id: Number(params.id), status: 'resolved' }) },
    { method: 'GET', path: '/duty-status', handler: () => ok({ items: empty ? [] : [
      { user_id: 4, status: 'on_duty', channel: 'app', changed_at: sqlAgo(120) },
      { user_id: 5, status: 'responding', channel: 'sms', changed_at: sqlAgo(40) },
      { user_id: 6, status: 'off_duty', channel: 'app', changed_at: sqlAgo(3000) },
    ] }) },

    // --- Notifications ---
    { method: 'GET', path: '/notifications', handler: () => ok({ items: empty ? [] : [
      { notification_id: 1, notification_type: 'sos', dispatch_id: 7001, sos_id: 91, incident_id: 902, created_at: sqlAgo(3), targeted_at: sqlAgo(3), ack_status: 'pending', acknowledged_at: null, incident_type: 'medical_emergency', incident_priority: 'critical', incident_display_id: 'INC-2026-902', sos_tanod_name: tanodName(5), dispatch_tanod_name: tanodName(5), dispatch_status: 'en_route' },
      { notification_id: 2, notification_type: 'dispatch', dispatch_id: 7002, sos_id: null, incident_id: 902, created_at: sqlAgo(20), targeted_at: sqlAgo(20), ack_status: 'acknowledged', acknowledged_at: sqlAgo(19), incident_type: 'medical_emergency', incident_priority: 'critical', incident_display_id: 'INC-2026-902', sos_tanod_name: null, dispatch_tanod_name: tanodName(4), dispatch_status: 'assigned' },
    ], unread_count: empty ? 0 : 1 }) },
    { method: 'POST', path: '/notifications/ack-all', handler: () => ok({ success: true, acknowledged_count: 1 }) },
    { method: 'POST', path: '/notifications/:id/ack', handler: ({ params }) => ok({ success: true, notification_id: Number(params.id), acknowledged_at: sqlAgo(0) }) },

    // --- Citizen reports ---
    { method: 'GET', path: '/citizen-reports', handler: ({ query }) => ok(paginate(citizenReports.filter((r) => (query.status === 'unconverted' ? r.incident_id === null : true)), query)) },
    { method: 'POST', path: '/citizen-reports/:id/convert', handler: ({ params }) => ({ status: 201, body: { incident_id: 905, citizen_report_id: Number(params.id), converted_at: sqlAgo(0) } }) },

    // --- Scheduling ---
    { method: 'GET', path: '/shifts', handler: ({ query }) => ok(paginate(shifts.filter((s) => !query.approval_status || s.approval_status === query.approval_status), query)) },
    { method: 'POST', path: '/shifts', handler: ({ body }) => ({ status: 201, body: { shift_id: 599, user_id: body.user_id, patrol_zone: body.patrol_zone, start_at: body.start_at, end_at: body.end_at, version: 1, approval_status: 'draft', approved_by: null, approved_at: null, source_availability_id: body.source_availability_id ?? null } }) },
    { method: 'POST', path: '/shifts/publish', handler: ({ body }) => ok({ published: body.shift_ids, already_published: [], warnings: [{ code: 'NO_COVERAGE', date: '2026-10-07' }] }) },
    { method: 'GET', path: '/availability', handler: ({ query }) => ok(paginate(availability.filter((a) => (!query.status || a.status === query.status) && (!query.user_id || a.user_id === Number(query.user_id))), query)) },
    { method: 'PATCH', path: '/availability/:id', handler: ({ params, body }) => {
      const row = availability.find((a) => a.avail_id === Number(params.id));
      return row ? ok({ ...row, status: body.status, review_note: body.review_note ?? null, reviewed_by: 1, reviewed_at: sqlAgo(0) }) : notFound('Availability not found.');
    } },
    { method: 'PATCH', path: '/shifts/:id', handler: ({ params, body }) => ok({ shift_id: Number(params.id), updated_at: sqlAgo(0), version: (body.version || 0) + 1 }) },
    { method: 'GET', path: '/shift-swap-requests', handler: ({ query }) => ok(paginate(swapRequests, query)) },
    { method: 'PATCH', path: '/shift-swap-requests/:id', handler: ({ params, body }) => ok({ request_id: Number(params.id), status: body.status, resolved_at: sqlAgo(0), resolved_by: 1, shift_id: 502, target_user_id: 4 }) },
    { method: 'GET', path: '/shifts/fatigue-flags', handler: ({ query }) => ok(paginate(fatigueFlags, query)) },
    { method: 'PATCH', path: '/fatigue-flags/:id/acknowledge', handler: ({ params }) => ok({ flag_id: Number(params.id), acknowledged_by: 1, acknowledged_at: sqlAgo(0) }) },

    // --- Lookup ---
    { method: 'GET', path: '/barangays', handler: () => ok({ items: [
      { barangay_id: 1, name: 'Dao', municipality: 'Pilar', province: 'Sorsogon' },
      { barangay_id: 2, name: 'Binanuahan', municipality: 'Pilar', province: 'Sorsogon' },
      { barangay_id: 3, name: 'Marifosque', municipality: 'Pilar', province: 'Sorsogon' },
      { barangay_id: 4, name: 'Banuyo', municipality: 'Pilar', province: 'Sorsogon' },
    ] }) },
    { method: 'GET', path: '/search', handler: ({ query }) => ok({ items: incidents
      .filter((i) => `${i.display_id} ${i.incident_type} ${i.status}`.toLowerCase().includes(String(query.q || '').toLowerCase()))
      .map((i) => ({ incident_id: i.incident_id, incident_type: i.incident_type, status: i.status, priority: i.priority, created_at: i.created_at })) }) },

    // --- System ---
    { method: 'GET', path: '/system/health', handler: () => ok({ api: 'healthy', db: 'healthy', ors: 'unhealthy', gsm_ingestion: 'healthy', notification_config: 'healthy', fcm: 'healthy', sms_gsm_gateway: 'not_configured', backup_last_success: empty ? null : sqlAgo(600), restore_test_at: null, notification_delivery_failures_24h: 0 }) },
    { method: 'GET', path: '/system/health/history', handler: () => ok({ sampling: 'Transitions are recorded only when a probe observed a change.', items: empty ? [] : [
      { recorded_at: sqlAgo(60), db: 'healthy', ors: 'not_configured', gsm_ingestion: 'healthy', fcm: 'healthy', sms_gsm_gateway: 'not_configured' },
      { recorded_at: sqlAgo(600), db: 'unhealthy', ors: 'not_configured', gsm_ingestion: 'unhealthy', fcm: 'healthy', sms_gsm_gateway: 'not_configured' },
    ] }) },
    { method: 'GET', path: '/audit-log', handler: ({ query }) => ok(paginate(auditRows.filter((a) => !query.action || a.action === query.action), query)) },
    { method: 'GET', path: '/system-settings', handler: () => ok({ settings: {
      'general.system_name': t('Baranguard'), 'general.municipality': t('Pilar'), 'general.region': t('Region V (Bicol)'),
      'sos_fallback.backup_contact_number': empty ? '' : '09170009999',
    } }) },
    { method: 'PATCH', path: '/system-settings', handler: ({ body }) => ok({ settings: { ...body.settings } }) },

    // --- SMS ---
    { method: 'GET', path: '/sms/logs', handler: ({ query }) => ok(paginate(smsLogs, query)) },
    { method: 'GET', path: '/sms/conversations', handler: () => ok({ items: conversations }) },
    { method: 'GET', path: '/sms/conversations/:phone/messages', handler: () => ok({ items: conversationMessages }) },
    { method: 'PATCH', path: '/sms/conversations/:phone/resolve', handler: ({ params }) => ok({ phone_number: params.phone, resolved_count: 2 }) },
    { method: 'POST', path: '/sms/send', handler: () => ({ status: 201, body: { log_id: 1199, status: 'queued', failure_reason: null } }) },
    { method: 'POST', path: '/sms/broadcast', handler: () => ok({ recipient_count: 4, sent: 4, failed: 0 }) },
    { method: 'GET', path: '/sms/subscribers', handler: () => ok({ active_count: empty ? 0 : 1, total_count: empty ? 0 : 2, items: empty ? [] : [
      { subscriber_id: 1, contact_number: '09181234567', consent_at: sqlAgo(10 * 1440), consent_source: 'barangay_hall', consent_note: t('Signed form #12'), opted_out_at: null, created_at: sqlAgo(10 * 1440) },
      { subscriber_id: 2, contact_number: '09189998888', consent_at: sqlAgo(20 * 1440), consent_source: 'sms_keyword', consent_note: null, opted_out_at: sqlAgo(1440), created_at: sqlAgo(20 * 1440) },
    ] }) },
    { method: 'POST', path: '/sms/subscribers', handler: () => ({ status: 201, body: { subscriber_id: 3 } }) },
    { method: 'PATCH', path: '/sms/subscribers/:id/opt-out', handler: ({ params }) => ok({ subscriber_id: Number(params.id), opted_out_at: sqlAgo(0) }) },

    // --- Map packages ---
    { method: 'GET', path: '/map-packages/:barangayId', handler: () => (empty ? notFound('No published map package yet.') : ok({ version: t('2026.09.1'), checksum_sha256: 'c'.repeat(64), download_url: '/map-packages/1/download', is_published: true })) },
    { method: 'POST', path: '/map-packages', handler: () => ({ status: 201, body: { package_id: 3, version: '2026.09.2', checksum_sha256: 'd'.repeat(64), is_published: true } }) },
  ];

  return routes;
}
