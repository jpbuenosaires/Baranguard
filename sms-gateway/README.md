# sms-gateway

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

Look for `RESULT correlation_id=manual-test-1 status=sent`.

## Why a separate project, not a new Capacitor plugin in `mobile/`

This phone is a dedicated gateway sitting at the barangay HQ, not a
Tanod's duty phone — it needs to work independent of anyone being logged
into the Tanod app or on patrol. Keeping it a tiny, single-purpose app
(no Capacitor/Ionic/WebView overhead) also keeps its footprint minimal on
hardware that may be an old spare phone.
