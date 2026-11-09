# sms-gateway

Purpose: the standalone Android app that sends Baranguard's SMS over its own SIM.
Status / Last updated: 2026-10-28.

A small, standalone Android app — **not** part of the Capacitor Tanod app
in `mobile/`, its own Gradle project — that turns a dedicated phone into
Baranguard's outbound SMS gateway. Replaces Semaphore (removed
2026-09-23, explicit user decision: a paid per-SMS aggregator cost too
much for this project's actual volume — see `backend/DEVLOG.md`).

## What it does

Runs on the SAME tethered phone `backend/scripts/gsm-ingest-daemon.php`
already reads INBOUND SMS off (A5) — now genuinely bidirectional, no
separate hardware. One `BroadcastReceiver`
(`SendSmsReceiver.java`) calls `SmsManager.sendTextMessage()`/
`sendMultipartTextMessage()` using the phone's own SIM, triggered by
`backend/services/notifications/LocalGsmOutboundClient.php` via `adb
shell am broadcast`. No server, no polling, no network call this phone
has to make — `adb` access to a physically-controlled device already IS
the authorization, the same trust boundary the inbound side already
established.

## Setup (once per gateway phone)

```bash
cd sms-gateway
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# SEND_SMS is a dangerous permission — grant it headlessly, no UI needed:
adb shell pm grant ph.baranguard.smsgateway android.permission.SEND_SMS

# A freshly-installed app is in Android's "stopped" state and won't
# receive ANY broadcast, even an explicit one, until launched once:
adb shell monkey -p ph.baranguard.smsgateway -c android.intent.category.LAUNCHER 1
```

Then in `backend/.env`:

```
GSM_GATEWAY_ENABLED=true
```

(`GSM_GATEWAY_ADB_PATH`/`GSM_GATEWAY_DEVICE_SERIAL` are optional —
defaults match `gsm-ingest-daemon.php`'s own.)

## Manual test

```bash
adb shell am broadcast -a ph.baranguard.smsgateway.SEND \
  -n ph.baranguard.smsgateway/.SendSmsReceiver \
  --es to "+63XXXXXXXXXX" --es body "test" --es correlation_id "manual-test-1"
adb logcat -d -t 100 | grep BaranguardSmsGateway
```

The broadcast prints `Broadcast completed: result=1, data="RESULT correlation_id=manual-test-1 status=sent parts=1"`
(`result=2` and `status=failed` on failure). The same line is also logged, but the Infinix on Android 16 drops
this app's Info log lines, so read the broadcast output, not logcat.

## Known behaviour on the Infinix gateway phone (checked 2026-11-07)

- **It must be woken before each send.** HiOS puts a background app in a broadcast-restricted queue: a send
  broadcast 15 s after the app left the foreground was silently not delivered. `LocalGsmOutboundClient` runs
  `am start -n ph.baranguard.smsgateway/.MainActivity` right before every broadcast, which fixes it. If you
  send by hand, do the same first.
- **The carrier result takes about 60 s** (Globe). The backend therefore records the send as `pending` at
  once and the notification worker settles it to `sent` or `failed` on a later pass (needs
  `GSM_GATEWAY_ENABLED=true` in `backend/.env`).
- **Results are kept in a file**, `/sdcard/Android/data/ph.baranguard.smsgateway/files/results.log`
  (`adb shell cat` it), because the phone's logcat loses the line within about two minutes.

## Who can send through it

`SendSmsReceiver` is exported but guarded by `android:permission="android.permission.DUMP"` (2026-11-07):
adb's shell user holds it, so the workstation can send; an ordinary installed app cannot. Checked on the
gateway phone: a broadcast from `adb shell` ran the receiver, the same broadcast as the Tanod app's uid
(`run-as ph.baranguard.tanod`) did not. If sending ever stops after a reinstall, re-run the `pm grant`
and `monkey` lines above.

## Why a separate project, not a new Capacitor plugin in `mobile/`

This phone is a dedicated gateway sitting at the barangay HQ, not a
Tanod's duty phone — it needs to work independent of anyone being logged
into the Tanod app or on patrol. Keeping it a tiny, single-purpose app
(no Capacitor/Ionic/WebView overhead) also keeps its footprint minimal on
hardware that may be an old spare phone.
