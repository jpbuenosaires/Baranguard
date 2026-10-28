# Baranguard FAQ and Troubleshooting (Tanod app)

Purpose: answers to common Tanod app problems.
Status/Last updated: 2026-10-28. Items marked "(not yet device-verified)" were written from code.

Simple answers to common problems. For full steps, see `TANOD_MANUAL.md`. Items marked "(not yet device-verified)" were written from the app code and not yet tested on a phone.

In an **emergency**: raise **SOS**, then **call** the barangay desk, backup contact, 911 or 160.

---

## The app says I am offline (CACHE badge, offline notice)

**Meaning:** the phone cannot reach the barangay workstation. The app still works from what is saved on the phone.

**Still works offline:** report incidents, raise SOS, change dispatch stages, add availability, accomplishments and school check-ins, go off duty. All are saved on the phone and sent later.

**Needs a connection:** signing in, going **on** duty, accepting a night call, submitting the monthly report, swap requests, live routes.

**Try:**
1. Turn mobile data on, or connect to Wi-Fi.
2. Move to where there is signal.
3. Pull down to refresh, or tap **Retry**.
4. In **Profile**, tap **Check connection**.

## "N waiting" or "Sync pending"

Records are saved on the phone but the desk has not received them yet.

1. Tap the badge at the top, or go to **Profile** > **Sync and storage**.
2. Tap **Sync records now**.
3. Wait a few minutes with good signal. The phone also retries by itself.
4. Do not uninstall the app or clear its data while records are waiting. You may lose them.

Special messages:
- **Session expired**: sign in again. Saved items stay and send after.
- **This phone is registered to a different account**: saved items cannot be sent from your account. Nothing is lost. Ask the Chief Tanod to reset the phone.
- **Needs attention** (red): the desk refused the item. Show it to the Chief Tanod before you **Discard** it. Discard cannot be undone.

## SOS says "saved on this phone"

There was no connection. The SOS is kept and sent when you are online, and the app tries to text the gateway and the backup contact. **Call the desk anyway.** If you see **SMS failed**, check your SIM load and that the app is allowed to send SMS. (not yet device-verified)

## No GPS / "GPS: no signal"

1. Turn **Location** on in the phone settings.
2. Allow location for Baranguard. If the phone offers "Allow all the time", choose it so patrol tracking works with the screen locked.
3. Go outside or near a window. Wait a minute.
4. Turn off battery saving for the app if your phone has it.

An SOS waits at most 2 seconds for GPS and then goes out anyway. A report can also be sent without GPS. The desk will see "no location" or your last known place.

## The route does not load

A live route needs a connection. Offline, the app shows the last route (may be out of date) or none. Use your own judgment and phone the desk if unsure.

## I cannot go on duty

Going on duty needs a connection to the workstation. Get signal and try again. If it still fails, tell the Chief Tanod.

## I cannot go off duty

- You still have an active dispatch. Complete it first.
- With no signal it is saved and sent later. That is normal.

## I cannot sign in

- Check your username and password. Use the eye icon to see what you typed.
- **5 wrong tries lock the account for 15 minutes.** Wait, then try once, carefully.
- "Cannot reach the Baranguard server": check your signal.
- "This app is for Tanods and the Chief Tanod": your account is for the web dashboard. Ask the Chief Tanod.

## I forgot my password or want to change it

The Tanod app has **no** forgot-password or change-password screen. Ask the Chief Tanod to reset it. Never tell your password to another person. After a password change you are signed out everywhere and must sign in again.

## My account is suspended or turned off

The app does not say "suspended". It only shows "Unable to sign in with those credentials", or you are signed out. Suspended or inactive accounts cannot sign in and cannot be dispatched. Ask the Chief Tanod.

## I was signed out suddenly

A password change or a suspension signs you out. Signing out yourself stops patrol tracking and clears the previous user's lists from the phone. A phone session also ends after a long time: it lasts up to 24 hours of use and 7 days in total. Sign in again with signal. Saved items stay on the phone.

## I do not receive dispatch alerts

1. Allow **notifications** for Baranguard in phone settings.
2. Turn off battery saving for the app.
3. Open the app once after every restart of the phone.
4. Pull down on **Dispatches** to refresh.
5. Night offers need a connection to accept.

## Camera or microphone does not work

Open phone **Settings** > Apps > Baranguard > Permissions, and allow Camera and Microphone. Files over 25 MB are not accepted.

## I do not see my shifts

Only **published** shifts show in **Profile** > **My duty shifts**. Offline, the last saved copy is shown with the time it was saved. If the list is empty, the desk has not published the roster yet. Ask the Chief Tanod.

## The monthly report will not submit

- It needs a connection.
- Wait until your entries have reached the desk (small chips show each entry's state).
- If **Returned for changes**, read the reason, fix, then **Resubmit month**.
- After you submit, print and sign it at the barangay hall. The app does not record the signature.

## No schools in School check-in

Tap **Download school list** (needs a connection). If still empty, ask the desk to add your school.

## Power cut or the workstation is down

- **Keep using the app.** Records stay on the phone and are sent later.
- An **SOS** still goes out by SMS if a gateway and backup number are set. Call the desk or backup contact too.
- The Chief Tanod will call or text you. Follow their instructions and use the paper logbook if told to.
- When power comes back, wait a few minutes. The phone sends saved records by itself. Open the app and check that "waiting" goes down to zero.

## Who do I ask?

The Chief Tanod or the barangay desk. Write the desk number on your quick card.
