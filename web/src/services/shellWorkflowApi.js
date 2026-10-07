/**
 * shellWorkflowApi.js — API wrappers for the 2026-10 tanod-workflow
 * features that the EXISTING pages (Personnel, Dashboard, Incident detail,
 * Incident Management, Dispatch Center) need. Contract:
 * docs/FEATURE_CONTRACT_2026-10.md §2, §3, §5, §7.
 *
 * Why a separate file and not apiClient.js: apiClient.js's `request()` is
 * module-private and its row mappers (getUsers/getShifts/getIncident) drop
 * the new fields, and this build does not edit apiClient.js. This module
 * therefore carries a small request helper of its own, reading the bearer
 * token from the same in-memory session (`getSession()`), and keeps the
 * same snake_case -> camelCase boundary rule: conversion happens here, in
 * hand-written mappers, never in a page.
 *
 * Known limitation (disclosed): apiClient.js's sliding-token renewal
 * (`X-Renewed-Token`) cannot be written back from here because the session
 * setter is private. A renewed token on a response from THIS module is
 * therefore ignored; the AppShell poller's own calls (through apiClient.js)
 * keep the session renewed, so a page that is open never expires.
 */

import { getSession, ApiClientError } from '../api/apiClient.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/api/v1';

function baseUrl() {
  return (typeof window !== 'undefined' && window.BARANGUARD_API_BASE_URL) || DEFAULT_BASE_URL;
}

// Same rule as apiClient.js: a bare `YYYY-MM-DD HH:MM:SS` is UTC.
const BARE_SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function reviveUtcTimestamps(_key, value) {
  if (typeof value === 'string' && BARE_SQL_DATETIME.test(value)) {
    return value.replace(' ', 'T') + 'Z';
  }
  return value;
}

async function request(method, path, { query, body, idempotencyKey } = {}) {
  let url = `${baseUrl()}${path}`;
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
    response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Could not reach the Baranguard server. Check your connection and try again.');
  }

  let json = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text, reviveUtcTimestamps);
    } catch {
      throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
    }
  }
  if (!response.ok) {
    const err = json && json.error ? json.error : {};
    throw new ApiClientError(response.status, err.code || 'UNKNOWN_ERROR', err.message || 'Something went wrong.');
  }
  return json ?? {};
}

/** Contract §2: the five approval authorities (a MariaDB SET, as an array). */
export const APPROVAL_AUTHORITIES = [
  { value: 'note_report', label: 'Note accomplishment reports' },
  { value: 'approve_report', label: 'Approve accomplishment reports' },
  { value: 'approve_roster', label: 'Approve and publish duty roster' },
  { value: 'prepare_annex_d', label: 'Prepare Annex D term report' },
  { value: 'approve_annex_d', label: 'Approve Annex D term report' },
];

/** Roles that may hold an authority (ApprovalAuthority::ELIGIBLE_ROLES). */
export const AUTHORITY_ELIGIBLE_ROLES = ['admin', 'secretary', 'punong_barangay'];

/** Contract §5: referred_to enum, with display labels. */
export const REFERRED_TO_OPTIONS = [
  { value: 'pnp', label: 'PNP (Police)' },
  { value: 'bfp', label: 'BFP (Fire)' },
  { value: 'ambulance_ems', label: 'Ambulance / EMS' },
  { value: 'barangay_official', label: 'Barangay official' },
  { value: 'vaw_desk', label: 'VAW Desk' },
  { value: 'social_welfare', label: 'Social Welfare (MSWDO)' },
  { value: 'higher_lgu', label: 'Higher LGU' },
  { value: 'doh', label: 'DOH' },
  { value: 'dpwh', label: 'DPWH' },
  { value: 'other', label: 'Other' },
];

export function referredToLabel(value) {
  return REFERRED_TO_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

// --- Users: official title + approval authority (§2) ------------------------

function parseAuthority(raw) {
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string');
  if (typeof raw === 'string' && raw !== '') return raw.split(',').filter(Boolean);
  return [];
}

function mapUser(row) {
  return {
    userId: row.user_id,
    fullName: row.full_name,
    username: row.username,
    role: row.role,
    contactNumber: row.contact_number,
    isActive: row.is_active,
    isSuspended: row.is_suspended,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    officialTitle: row.official_title ?? null,
    approvalAuthority: parseAuthority(row.approval_authority),
  };
}

/** GET /users — same list as apiClient.getUsers, plus the two §2 fields. */
export async function getUsersDetailed({ role, page, limit } = {}) {
  const json = await request('GET', '/users', { query: { role, page, limit } });
  return { items: json.items.map(mapUser), page: json.page, limit: json.limit, total: json.total };
}

/** GET /users/:id — used to learn the signed-in user's own authorities. */
export async function getUserById(userId) {
  return mapUser(await request('GET', `/users/${userId}`));
}

/**
 * PATCH /users/:id with `official_title` and/or `approval_authority`
 * (Admin only; target role must be eligible — the server 400s otherwise).
 */
export async function updateUserApproval(userId, { officialTitle, approvalAuthority, idempotencyKey } = {}) {
  const body = {};
  if (officialTitle !== undefined) body.official_title = officialTitle;
  if (approvalAuthority !== undefined) body.approval_authority = approvalAuthority;
  const json = await request('PATCH', `/users/${userId}`, { body, idempotencyKey });
  return { userId: json.user_id, updated: json.updated };
}

// --- Roster: availability + draft/published shifts (§3) ---------------------

function mapShiftDetailed(row) {
  return {
    shiftId: row.shift_id,
    userId: row.user_id,
    patrolZone: row.patrol_zone,
    startAt: row.start_at,
    endAt: row.end_at,
    version: row.version,
    approvalStatus: row.approval_status ?? 'published',
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    sourceAvailabilityId: row.source_availability_id ?? null,
    // An approved swap on a published shift returns it to draft AND flags it for re-approval.
    pendingReapproval: Boolean(row.pending_reapproval),
  };
}

/** GET /shifts with the §3 approval fields; `approvalStatus` filters server-side. */
export async function getShiftsDetailed({ page, limit, approvalStatus } = {}) {
  const json = await request('GET', '/shifts', { query: { page, limit, approval_status: approvalStatus } });
  return { items: json.items.map(mapShiftDetailed), page: json.page, limit: json.limit, total: json.total };
}

/**
 * POST /shifts/publish — requires the approve_roster authority (the server
 * 403s otherwise and the page shows that message as-is).
 * @returns {Promise<{published:number[], alreadyPublished:number[], warnings:Array<{code:string,date:string}>}>}
 */
export async function publishShifts(shiftIds, idempotencyKey) {
  const json = await request('POST', '/shifts/publish', { body: { shift_ids: shiftIds }, idempotencyKey });
  return {
    published: json.published ?? [],
    alreadyPublished: json.already_published ?? [],
    warnings: (json.warnings ?? []).map((w) => ({ code: w.code, date: w.date })),
  };
}

function mapAvailability(row) {
  let windows = row.windows_json ?? row.windows ?? [];
  if (typeof windows === 'string') {
    try { windows = JSON.parse(windows); } catch { windows = []; }
  }
  return {
    availId: row.avail_id,
    userId: row.user_id,
    userName: row.full_name ?? row.user_name ?? null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    windows: Array.isArray(windows) ? windows : [],
    status: row.status,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewNote: row.review_note ?? null,
    version: row.version,
  };
}

/** GET /availability (admin/secretary/PB: whole barangay). */
export async function getAvailability({ status, userId, periodStart, page, limit } = {}) {
  const json = await request('GET', '/availability', {
    query: { status, user_id: userId, period_start: periodStart, page, limit },
  });
  const rows = json.items ?? [];
  return { items: rows.map(mapAvailability), total: json.total ?? rows.length };
}

/** PATCH /availability/:id — Admin or Secretary; `status` is accepted|revised. */
export async function reviewAvailability(availId, { status, reviewNote, idempotencyKey }) {
  const body = { status };
  if (reviewNote) body.review_note = reviewNote;
  return mapAvailability(await request('PATCH', `/availability/${availId}`, { body, idempotencyKey }));
}

// --- Schools + C-1 fields on incidents (§7) ---------------------------------

/** GET /schools (all roles, own barangay). Pass `active: true` for pickers. */
export async function getSchools({ active } = {}) {
  const json = await request('GET', '/schools', { query: { active: active === undefined ? undefined : (active ? 1 : 0) } });
  const rows = json.items ?? [];
  return rows.map((s) => ({ schoolId: s.school_id, name: s.name, isActive: s.is_active === undefined ? true : !!Number(s.is_active) }));
}

/**
 * GET /incidents/:id — only the §7 school/C-1 fields. apiClient.getIncident
 * does not map them, so the pages that edit them read them here. Note this
 * is the same single-incident endpoint the page already loads; the extra
 * call is deliberate (no apiClient.js edits in this build).
 */
export async function getIncidentSchoolFields(incidentId) {
  const row = await request('GET', `/incidents/${incidentId}`);
  return {
    schoolId: row.school_id ?? null,
    c1Summary: row.c1_summary ?? null,
    c1ActionTaken: row.c1_action_taken ?? null,
    c1StatusNotes: row.c1_status_notes ?? null,
  };
}

/**
 * PATCH /incidents/:id with the §7 fields (Admin + Secretary). Only the
 * keys present in `fields` are sent. Never carries a narrative.
 */
export async function updateIncidentSchoolFields(incidentId, fields, idempotencyKey) {
  const body = {};
  if (fields.schoolId !== undefined) body.school_id = fields.schoolId;
  if (fields.c1Summary !== undefined) body.c1_summary = fields.c1Summary;
  if (fields.c1ActionTaken !== undefined) body.c1_action_taken = fields.c1ActionTaken;
  if (fields.c1StatusNotes !== undefined) body.c1_status_notes = fields.c1StatusNotes;
  const json = await request('PATCH', `/incidents/${incidentId}`, { body, idempotencyKey });
  return { incidentId: json.incident_id, updated: json.updated, fields: json.fields };
}

// --- Referrals (§5) ---------------------------------------------------------

function mapReferral(row) {
  return {
    referralId: row.referral_id,
    incidentId: row.incident_id,
    referredTo: row.referred_to,
    otherText: row.other_text ?? null,
    contactName: row.contact_name ?? null,
    referredAt: row.referred_at,
    referenceNo: row.reference_no ?? null,
    createdBy: row.created_by ?? null,
  };
}

/** GET /incidents/:id/referrals (admin, secretary, PB). */
export async function getIncidentReferrals(incidentId) {
  const json = await request('GET', `/incidents/${incidentId}/referrals`);
  return (json.items ?? []).map(mapReferral);
}

/**
 * POST /incidents/:id/referrals (web writes use the Idempotency-Key header,
 * not client_event_id). Does NOT change dispatch or incident status.
 */
export async function createIncidentReferral(incidentId, { referredTo, otherText, contactName, referredAt, referenceNo }, idempotencyKey) {
  const body = { referred_to: referredTo };
  if (otherText) body.other_text = otherText;
  if (contactName) body.contact_name = contactName;
  if (referredAt) {
    // <input type="datetime-local"> has no zone and the backend reads a
    // zoneless value as UTC. The user means Asia/Manila (+08:00) wall time.
    const wall = referredAt.length === 16 ? `${referredAt}:00` : referredAt;
    const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(wall) ? wall : `${wall}+08:00`);
    body.referred_at = Number.isNaN(parsed.getTime()) ? referredAt : parsed.toISOString();
  }
  if (referenceNo) body.reference_no = referenceNo;
  return mapReferral(await request('POST', `/incidents/${incidentId}/referrals`, { body, idempotencyKey }));
}

// --- Approvals summary (dashboard widget, §10) -------------------------------

async function countOf(path, query) {
  const json = await request('GET', path, { query: { ...query, limit: 100 } });
  if (typeof json.total === 'number') return json.total;
  return (json.items ?? []).length;
}

/**
 * Live counts of work waiting on the signed-in user, each gated by the
 * authority that would let them act on it. There is no dedicated approvals
 * endpoint in the contract, so this composes the existing list endpoints;
 * nothing is invented or estimated.
 *
 * @param {string[]} authorities the viewer's own approval_authority
 * @returns {Promise<Array<{key:string,label:string,count:number}>>}
 */
export async function getPendingApprovalCounts(authorities) {
  const has = (a) => authorities.includes(a);
  const jobs = [];
  if (has('approve_roster')) {
    jobs.push(countOf('/shifts', { approval_status: 'draft' }).then((count) => ({ key: 'roster', label: 'Draft shifts to publish', count })));
  }
  if (has('note_report')) {
    jobs.push(countOf('/accomplishment-reports', { status: 'prepared' }).then((count) => ({ key: 'notes', label: 'Accomplishment reports to note', count })));
  }
  if (has('approve_report')) {
    jobs.push(countOf('/accomplishment-reports', { status: 'noted' }).then((count) => ({ key: 'approve-reports', label: 'Accomplishment reports to approve', count })));
  }
  if (has('prepare_annex_d') || has('approve_annex_d')) {
    jobs.push(request('GET', '/ssz-term-reports', { query: { limit: 100 } }).then((json) => {
      const rows = json.items ?? [];
      const out = [];
      if (has('prepare_annex_d')) out.push({ key: 'annex-prepare', label: 'Annex D drafts to prepare', count: rows.filter((r) => r.status === 'draft').length });
      if (has('approve_annex_d')) out.push({ key: 'annex-approve', label: 'Annex D reports to approve', count: rows.filter((r) => r.status === 'prepared').length });
      return out;
    }));
  }
  const results = await Promise.all(jobs);
  return results.flat();
}

/**
 * The signed-in user's own approval authorities. `GET /users/:id` is the
 * contract's source (§2/§10). An Admin who cannot read it falls back to the
 * Admin-only user list, which carries the same field; any other role has no
 * second source and the error is surfaced to the caller (shown as an error
 * state with Retry, never guessed).
 */
export async function getOwnApprovalAuthority(userId, role) {
  try {
    return (await getUserById(userId)).approvalAuthority;
  } catch (err) {
    const missing = err instanceof ApiClientError && [403, 404, 405].includes(err.status);
    if (!(missing && role === 'admin')) throw err;
    const list = await getUsersDetailed({ limit: 100 });
    const self = list.items.find((u) => u.userId === userId);
    if (!self) throw err;
    return self.approvalAuthority;
  }
}
