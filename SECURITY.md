# Security Policy

Baranguard handles incident reports, tanod locations and personal data for
four barangays in Pilar, Sorsogon, so security reports are taken seriously.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security problem.

- Contact: **TODO: the project owner must fill in a monitored email address
  or private reporting channel here** (placeholder, not yet decided).
- Include: what you found, where (URL, endpoint or screen), steps to
  reproduce, and the impact you believe it has. Do not include real
  citizen data in your report.
- Do not test against the live system with real accounts or data, and do
  not access, change or keep personal data beyond what is needed to show the
  problem.

No response time is promised yet: **TODO: owner to state one** (for
example an acknowledgement window) once a maintainer is named.

## Supported versions

No version has been tagged yet (see `CHANGELOG.md`). Only the current
`main` branch is supported; there are no maintained older releases.

## Scope

In scope: the PHP API (`backend/`), the web dashboard (`web/`), the Tanod
Android app (`mobile/`) and the SMS gateway app (`sms-gateway/`).

Out of scope: third-party services (Cloudflare, OpenStreetMap tiles,
OpenRouteService, Firebase), denial-of-service by volume, social
engineering, and physical access to the workstation.

Note: the public hostnames `baranguardph.win` / `api.baranguardph.win`
currently serve the demo database, not real records
(`docs/REFERENCE.md` §1).

## If personal data may have been exposed

Follow `docs/BREACH_RESPONSE_RUNBOOK.md`. It is a draft that the barangay
council and a Data Protection Officer have not yet adopted.
