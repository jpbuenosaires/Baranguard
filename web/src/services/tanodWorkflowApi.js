/**
 * tanodWorkflowApi.js — API wrappers for the 2026-10 tanod-workflow build
 * (approvals, accomplishment reports, referral log, Safer School Zones).
 * Every route/field here comes from docs/FEATURE_CONTRACT_2026-10.md §2-§7;
 * nothing is invented.
 *
 * Why this is a separate file and not more of apiClient.js: the feature
 * plan assigns apiClient.js to no agent in this build, and its private
 * `request()` helper is not exported. This file therefore carries its own
 * small `request()` that follows the same rules as apiClient's — Bearer
 * token from the SAME in-memory session (`getSession()`), `ApiClientError`
 * for every failure (the one error class pages already catch), the same
 * base-URL global, the same bare-SQL-datetime -> UTC reviver, and an
 * `Idempotency-Key` header on every write (REFERENCE.md §2 Rule 3, web
 * flavour).
 *
 * Boundary rule (apiClient.js header): snake_case <-> camelCase happens in
 * exactly one place per platform. Here that place is `camelize()`, applied
 * to every response. It converts KEYS only and never values, so enum values
 * (`ambulance_ems`, `under_investigation`, ...) pass through untouched. The
 * contract's response bodies contain no objects keyed by enum value, which
 * is the one case the apiClient header warns a blind converter would break.
 *
 * Known limitation, not hidden: a `X-Renewed-Token` sliding renewal header
 * is ignored here (apiClient's `writeSession` is private). That is safe —
 * the AppShell poller keeps the session alive through apiClient itself, and
 * the previous token stays valid until its own expiry.
 */

import { getSession, ApiClientError } from '../api/apiClient.js';

export { ApiClientError };

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/api/v1';
const BASE_URL = (typeof window !== 'undefined' && window.BARANGUARD_API_BASE_URL) || DEFAULT_BASE_URL;

const BARE_SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Same rule as apiClient.js: bare `YYYY-MM-DD HH:MM:SS` is UTC, tag it so `new Date()` agrees. */
function reviveUtcTimestamps(_key, value) {
  if (typeof value === 'string' && BARE_SQL_DATETIME.test(value)) {
    return value.replace(' ', 'T') + 'Z';
  }
  return value;
}

function camelKey(key) {
  return key.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase());
}

/** Deep key-only snake_case -> camelCase. Values (incl. enum strings) are never touched. */
export function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[camelKey(key)] = camelize(inner);
    return out;
  }
  return value;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

async function request(method, path, { query, body, idempotencyKey } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const session = getSession();
  if (!session) throw new ApiClientError(401, 'UNAUTHORIZED', 'Not signed in.');

  const headers = { Accept: 'application/json', Authorization: `Bearer ${session.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Could not reach the Baranguard server. Check your connection and try again.');
  }

  let json = null;
  const textBody = await response.text();
  if (textBody) {
    try {
      json = JSON.parse(textBody, reviveUtcTimestamps);
    } catch {
      throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
    }
  }

  if (!response.ok) {
    const errBody = json && json.error ? json.error : {};
    throw new ApiClientError(response.status, errBody.code || 'UNKNOWN_ERROR', errBody.message || 'Something went wrong.');
  }
  return json ?? {};
}

/** A write: always carries a fresh Idempotency-Key unless the caller reuses one for a deliberate retry. */
function write(method, path, body, idempotencyKey) {
  return request(method, path, { body: body ?? {}, idempotencyKey: idempotencyKey || newIdempotencyKey() });
}

/** Normalises the `{items,page,limit,total}` list envelope (REFERENCE.md §5). */
function listOf(json) {
  const raw = Array.isArray(json) ? json : (json.items ?? []);
  const items = camelize(raw);
  return {
    items,
    page: json.page ?? 1,
    limit: json.limit ?? items.length,
    total: typeof json.total === 'number' ? json.total : items.length,
  };
}

// --- Enums (contract §2, §5, §7) --------------------------------------------

export const AUTHORITY_LABELS = {
  note_report: 'Note accomplishment reports',
  approve_report: 'Approve accomplishment reports',
  approve_roster: 'Approve and publish rosters',
  prepare_annex_d: 'Prepare Annex D term report',
  approve_annex_d: 'Approve Annex D term report',
};

export const REFERRED_TO_LABELS = {
  pnp: 'PNP',
  bfp: 'BFP',
  ambulance_ems: 'Ambulance / EMS',
  barangay_official: 'Barangay official',
  vaw_desk: 'VAW Desk',
  social_welfare: 'Social Welfare',
  higher_lgu: 'Higher LGU (City/Municipality)',
  doh: 'DOH',
  dpwh: 'DPWH',
  other: 'Other',
};

export const SCHOOL_LEVEL_LABELS = {
  preschool_daycare_eccd: 'Preschool / Daycare / ECCD',
  primary_elementary: 'Primary / Elementary',
  secondary_high_school: 'Secondary / High School',
  integrated: 'Integrated',
  higher_education_tertiary: 'Higher Education (HEI) / Tertiary',
  all_through: 'All-through School',
  tvet: 'TVET',
  sned: 'SNED (Special Needs Education)',
};

export const SCHOOL_TYPE_LABELS = { public: 'Public', private: 'Private' };

export const REPORT_STATUS_LABELS = {
  open: 'Open',
  prepared: 'Prepared',
  noted: 'Noted',
  approved: 'Approved',
  returned: 'Returned',
};

export const TERM_STATUS_LABELS = {
  draft: 'Draft',
  prepared: 'Prepared',
  approved: 'Approved',
  submitted: 'Submitted',
};

// --- Users / authority (§2) -------------------------------------------------

/**
 * GET /users/:id — used for the viewer's OWN record so the UI knows which
 * approval actions to offer. `approvalAuthority` is always an array here.
 * The server re-checks every action, so this is UX gating only (Rule 2).
 */
export async function getUserById(userId) {
  const json = camelize(await request('GET', `/users/${userId}`));
  return {
    userId: json.userId,
    fullName: json.fullName,
    role: json.role,
    officialTitle: json.officialTitle ?? null,
    approvalAuthority: Array.isArray(json.approvalAuthority) ? json.approvalAuthority : [],
  };
}

/** GET /barangays (public, always the four seeded rows) — letterhead source for printed forms. */
export async function getBarangayLetterhead(barangayId) {
  const json = await request('GET', '/barangays');
  const rows = camelize(json.items ?? []);
  const row = rows.find((b) => b.barangayId === barangayId);
  return row
    ? { barangayName: row.name ?? '', municipality: row.municipality ?? '', province: row.province ?? '' }
    : { barangayName: '', municipality: '', province: '' };
}

/** Name lookup for report/availability rows that only carry a user_id. */
export async function getUserNames() {
  const json = await request('GET', '/users', { query: { limit: 100 } });
  const names = new Map();
  for (const row of camelize(json.items ?? [])) names.set(row.userId, row.fullName);
  return names;
}

// --- Roster approvals (§3) --------------------------------------------------

/** GET /availability?status=&user_id=&period_start= */
export async function getAvailability({ status, userId, periodStart, page, limit } = {}) {
  return listOf(await request('GET', '/availability', {
    query: { status, user_id: userId, period_start: periodStart, page, limit },
  }));
}

/** GET /shifts?approval_status= — own mapping because apiClient's `mapShift` drops approval fields. */
export async function getShiftsByApproval({ approvalStatus, page, limit } = {}) {
  return listOf(await request('GET', '/shifts', {
    query: { approval_status: approvalStatus, page, limit },
  }));
}

/** POST /shifts/publish — needs the approve_roster authority. */
export async function publishShifts(shiftIds, idempotencyKey) {
  return camelize(await write('POST', '/shifts/publish', { shift_ids: shiftIds }, idempotencyKey));
}

// --- Accomplishment reports (§4) --------------------------------------------

export async function getAccomplishmentReports({ month, userId, status, page, limit } = {}) {
  return listOf(await request('GET', '/accomplishment-reports', {
    query: { month, user_id: userId, status, page, limit },
  }));
}

export async function getAccomplishmentReport(reportId) {
  return camelize(await request('GET', `/accomplishment-reports/${reportId}`));
}

export async function noteAccomplishmentReport(reportId, idempotencyKey) {
  return camelize(await write('POST', `/accomplishment-reports/${reportId}/note`, {}, idempotencyKey));
}

export async function approveAccomplishmentReport(reportId, idempotencyKey) {
  return camelize(await write('POST', `/accomplishment-reports/${reportId}/approve`, {}, idempotencyKey));
}

export async function returnAccomplishmentReport(reportId, reason, idempotencyKey) {
  return camelize(await write('POST', `/accomplishment-reports/${reportId}/return`, { reason }, idempotencyKey));
}

// --- Referrals (§5) ---------------------------------------------------------

/** GET /referrals — aggregate rows only; the server never returns narrative/names/contacts here. */
export async function getReferrals({ from, to, referredTo, page, limit } = {}) {
  return listOf(await request('GET', '/referrals', {
    query: { from, to, referred_to: referredTo, page, limit },
  }));
}

export async function getIncidentReferrals(incidentId) {
  return listOf(await request('GET', `/incidents/${incidentId}/referrals`));
}

// --- Schools (§7) -----------------------------------------------------------

export async function getSchools({ active } = {}) {
  const query = { limit: 100 };
  if (active === true) query.active = 'true';
  if (active === false) query.active = 'false';
  return listOf(await request('GET', '/schools', { query }));
}

/** POST /schools — admin+secretary. Keys are snake_case in the body per the contract. */
export async function createSchool(fields, idempotencyKey) {
  return camelize(await write('POST', '/schools', schoolBody(fields), idempotencyKey));
}

export async function updateSchool(schoolId, fields, idempotencyKey) {
  return camelize(await write('PATCH', `/schools/${schoolId}`, schoolBody(fields), idempotencyKey));
}

function schoolBody(fields) {
  const body = {};
  const map = {
    name: 'name', schoolType: 'school_type', level: 'level', address: 'address',
    focalPerson: 'focal_person', focalContact: 'focal_contact', remarks: 'remarks',
    isActive: 'is_active',
  };
  for (const [from, to] of Object.entries(map)) {
    if (fields[from] !== undefined) body[to] = fields[from];
  }
  return body;
}

/**
 * Incidents that carry a `school_id` (Annex C-1 view). The contract adds
 * `school_id` and the `c1_*` columns to GET /incidents rows but defines NO
 * server-side school filter, so this pages through the normal list and
 * filters here. Capped so a huge history cannot loop forever; `truncated`
 * tells the page when the cap was hit so it can say so honestly.
 */
export async function getSchoolIncidents({ maxPages = 10 } = {}) {
  const items = [];
  let total = 0;
  let page = 1;
  let truncated = false;
  for (;;) {
    const res = listOf(await request('GET', '/incidents', { query: { page, limit: 100 } }));
    total = res.total;
    for (const row of res.items) if (row.schoolId !== null && row.schoolId !== undefined) items.push(row);
    if (page * 100 >= total || res.items.length === 0) break;
    if (page >= maxPages) { truncated = true; break; }
    page += 1;
  }
  return { items, truncated };
}

// --- School check-ins / term reports (§7) -----------------------------------

/** GET /reports/school-term — live computed counts, nothing persisted. */
export async function getSchoolTermLive({ termStart, termEnd }) {
  return camelize(await request('GET', '/reports/school-term', {
    query: { term_start: termStart, term_end: termEnd },
  }));
}

export async function getTermReports({ status, page, limit = 100 } = {}) {
  return listOf(await request('GET', '/ssz-term-reports', { query: { status, page, limit } }));
}

export async function getTermReport(reportId) {
  return camelize(await request('GET', `/ssz-term-reports/${reportId}`));
}

export async function createTermReport({ termLabel, termStart, termEnd, remarks }, idempotencyKey) {
  const body = { term_label: termLabel, term_start: termStart, term_end: termEnd };
  if (remarks) body.remarks = remarks;
  return camelize(await write('POST', '/ssz-term-reports', body, idempotencyKey));
}

/** PATCH — remarks / other_institutions, only while the report is a draft. */
export async function updateTermReport(reportId, { remarks, otherInstitutions }, idempotencyKey) {
  const body = {};
  if (remarks !== undefined) body.remarks = remarks;
  if (otherInstitutions !== undefined) body.other_institutions = otherInstitutions;
  return camelize(await write('PATCH', `/ssz-term-reports/${reportId}`, body, idempotencyKey));
}

export async function prepareTermReport(reportId, idempotencyKey) {
  return camelize(await write('POST', `/ssz-term-reports/${reportId}/prepare`, {}, idempotencyKey));
}

export async function approveTermReport(reportId, idempotencyKey) {
  return camelize(await write('POST', `/ssz-term-reports/${reportId}/approve`, {}, idempotencyKey));
}

export async function markTermReportSubmitted(reportId, fields, idempotencyKey) {
  const body = {
    mayor_office_received_by: fields.mayorOfficeReceivedBy,
    mayor_office_received_at: fields.mayorOfficeReceivedAt,
  };
  if (fields.dilgReceivedBy) body.dilg_received_by = fields.dilgReceivedBy;
  if (fields.dilgDateReceived) body.dilg_date_received = fields.dilgDateReceived;
  return camelize(await write('POST', `/ssz-term-reports/${reportId}/mark-submitted`, body, idempotencyKey));
}
