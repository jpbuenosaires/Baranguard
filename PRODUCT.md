# Product

<!-- impeccable:product-schema 1 -->

Scope: this record covers the **Tanod mobile app** (`mobile/`, Ionic React +
Capacitor, package `ph.baranguard.tanod`). The web dashboard (`web/`) has its
own look and is not governed by this file.

## Platform

android

## Users

- **Primary: barangay tanods** of Dao, Binanuahan, Marifosque and Banuyo
  (Pilar, Sorsogon). They use their own budget Android phones (reference
  device: Infinix X6840, Android 16, 720 x 1576), on foot or on a motorbike,
  in day and night shifts, often in bright sun or darkness, and have only
  seconds to glance at the phone during a call. Honorarium-only volunteers,
  not office staff.
- **Secondary: the Chief Tanod (Admin)** uses the same app as a 4-tab phone
  console (SOS acknowledge/resolve, dispatch assign/cancel/offers, read-only
  incidents).

## Product Purpose

Offline-first field capture and dispatch for barangay peacekeepers: receive
dispatches and night offers, navigate to the scene, update dispatch status,
log incidents with evidence, raise an SOS (with an SMS fallback when there is
no data), share GPS while on duty, and keep the tanod paperwork (availability,
shifts, accomplishment entries, school check-ins, referrals). Success is a
tanod who can act on a call in seconds and never loses a report to a bad
signal.

## Positioning

A dispatch, GPS, SOS and offline field-capture tool for four barangays, run
from one barangay workstation over a LAN or tunnel, with no cloud. It is not
integrated with DILG BIMS and keeps no case registry or blotter (barangays
keep those in binders). Writes are saved to an encrypted phone database first
and never shown as sent until the server confirms.

## Operating Context

- Phones lose signal often; every capture must survive offline and sync later.
- Critical alerts (SOS, dispatch, night offers) arrive as full-screen alerts
  and must be acknowledged.
- Large matters are referred (PNP, BFP, EMS, officials), never handled by the
  tanod.
- Reports are printed and signed on paper; the app does not track signatures.
- The app was evaluated in UAT and ISO/IEC 25010 on its 2026-10 look; a
  redesign after that must be noted as a post-UAT change in the thesis.

## Capabilities and Constraints

- Routes and behaviour are fixed by `docs/REFERENCE.md` and
  `docs/WORKFLOWS_AND_RULES.md`; a visual redesign never adds or removes a
  field, route, role or state transition.
- Raw incident narratives never leave the system; the Admin's phone session
  never receives them.
- No fabricated numbers, confidence scores or controls that do nothing.
- SOS: confirm sheet with Silent SOS (default on), hold-to-open control on
  every non-Home tab; emergency numbers 911 (Police) and 160 (MDRRMO) plus a
  backup contact.
- **Language: a toggle between English and Filipino (Tagalog) is required.**
  Not built as of 2026-11-05; Filipino strings need review by a native
  speaker before the defense.

## Brand Commitments

- Name: Baranguard. Subtitle on login: "Field Responder Console".
- Shield mark used as the app icon and header mark.

## Evidence on Hand

- Real-device screenshots of every Tanod screen before the redesign:
  `docs/ui-review-2026-11-05/before/`.
- Demo database `baranguard_uiseed` (Barangay Dao, simulated data). No real
  incident data may be shown in screenshots or mockups.

## Product Principles

1. Seconds matter: the next action on any screen is obvious and reachable
   with one thumb.
2. Honest state: offline, queued, sent and failed are always distinguishable;
   nothing claims "sent" early.
3. Safety first: the SOS is always reachable but never covers other controls,
   and no tap can place a phone call by accident.
4. Works in sun and dark: legible at arm's length on a cheap screen.
5. Plain words: short, concrete labels a volunteer understands, in English or
   Filipino.

## Accessibility & Inclusion

Large touch targets (48 dp minimum), high contrast for outdoor use, TalkBack
labels on icon-only controls, and support for Android font scaling.
