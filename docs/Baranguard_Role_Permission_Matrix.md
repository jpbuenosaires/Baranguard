# Baranguard — Role & Permission Matrix

Six roles per your `user.role` enum and Appendix B use case diagram actors.
This is the single source of truth for access control — every RBAC check in
Sprint 7 should trace back to this table.

**Legend:** ✓ Full access · R = Read-only / redacted view only · ✗ No access

| Action | Admin | Dispatcher | Secretary | Tanod | Punong Barangay | Lupon |
|---|---|---|---|---|---|---|
| **Incidents** |
| Log new incident (mobile) | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| View incident list | ✓ | ✓ | ✓ | own only | R | R |
| View raw (unredacted) narrative | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| View redacted narrative | ✓ | ✓ | ✓ | own only | ✓ | ✓ |
| Approve AI redaction draft | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Update incident status | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Dispatch** |
| Create dispatch order | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Update own dispatch status | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| View dispatch queue | ✓ | ✓ | ✗ | ✗ | R | ✗ |
| **GIS / Map** |
| View live tracking map | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| View historical heatmap | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| Broadcast own GPS (mobile) | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| **Duty Status** |
| Toggle own duty status | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| View all duty statuses | ✓ | ✓ | ✗ | ✗ | R | ✗ |
| **Reports & Analytics** |
| Generate statistical reports | ✓ | ✓ | ✗ | ✗ | R | ✗ |
| **User Management** |
| Create/edit/deactivate users | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Shift Scheduling** |
| Create/edit shift schedule | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View own shift schedule | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Submit shift swap request | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Approve/deny swap request | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View fatigue flags | ✓ | ✗ | ✗ | ✗ | R | ✗ |
| **SMS Logs** |
| View SMS activity log | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **System Settings** |
| Own account settings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Role Definitions (for onboarding/context, and Appendix B alignment)

| Role | Who they are | Primary responsibility in system |
|---|---|---|
| **Admin** | IT/system administrator | Full system oversight, user management, scheduling |
| **Dispatcher** | Assigns and tracks field response | Live dispatch, GPS tracking, incident status |
| **Secretary** | Barangay Secretary | Blotter management, PII redaction approval (RA 10173 gate) |
| **Tanod** | Field responder | Incident capture, GPS broadcast, receiving dispatch |
| **Punong Barangay** | Executive official | Oversight dashboards, reports — mostly read-only |
| **Lupon** | Dispute resolution officials | Redacted incident narratives only, for peacekeeping cases |

## Implementation Note

Enforce every row of this matrix **server-side** in API middleware (per the
Security Design Rationale in the API contract) — never rely on hiding UI
elements client-side as the actual security boundary. Client-side hiding is
for UX only; the API must independently reject unauthorized requests.
