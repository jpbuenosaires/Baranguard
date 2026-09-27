package ph.baranguard.tanod.sossms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern

@OptimizedRecord
class SosSmsSendResult(
  @Field val sent: Boolean = false,
) : Record

/**
 * SosSmsModule — Kotlin Expo Module port of ../mobile's SosSmsPlugin.java,
 * G1's third SOS fallback tier (§2 Rule 27): a plain SMS sent directly from
 * the device's own SIM via `SmsManager`, no gateway, no workstation, no LAN
 * required. See the Java original's own header comment for the full
 * reasoning (SEND_SMS as a sideloaded-app runtime permission, why a silent
 * native send instead of opening the SMS composer, and the 2026-09-24 fix
 * making a carrier-level rejection surface as a real failure instead of a
 * false "sent").
 *
 * Ported behavior, unchanged from the Java original:
 * - PH mobile number format checked BEFORE ever touching SmsManager (kept
 *   in sync by hand with `SettingsController::PH_MOBILE_NUMBER_PATTERN`).
 * - A `sentIntent` PendingIntent per message part (multipart messages need
 *   every part to report before the call resolves) carries the REAL
 *   carrier-level result back through a locally-registered
 *   BroadcastReceiver — this is what makes a genuine `sms_failed` (vs. a
 *   false `sent`) possible.
 * - Permission handling differs only in mechanism: the Expo Modules API's
 *   shared `PermissionsService` (`appContext.permissions`) replaces
 *   Capacitor's `@Permission` annotation/`requestPermissionForAlias`.
 */
class SosSmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SosSms")

    AsyncFunction("sendDirect") { number: String, message: String, promise: Promise ->
      val trimmedNumber = number.trim()
      if (trimmedNumber.isEmpty() || message.trim().isEmpty()) {
        promise.reject("ERR_SOS_SMS_INVALID_ARGS", "number and message are both required.", null)
        return@AsyncFunction
      }
      if (!PH_MOBILE_NUMBER.matcher(trimmedNumber).matches()) {
        promise.reject("ERR_SOS_SMS_INVALID_NUMBER", "Invalid phone number format: $trimmedNumber", null)
        return@AsyncFunction
      }

      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val alreadyGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
        PackageManager.PERMISSION_GRANTED
      if (alreadyGranted) {
        doSend(context, trimmedNumber, message, promise)
        return@AsyncFunction
      }

      val manager = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      manager.askForPermissions(
        PermissionsResponseListener { result ->
          val granted = result[Manifest.permission.SEND_SMS]?.status == PermissionsStatus.GRANTED
          if (granted) {
            doSend(context, trimmedNumber, message, promise)
          } else {
            promise.reject("ERR_SOS_SMS_PERMISSION_DENIED", "SEND_SMS permission was not granted.", null)
          }
        },
        Manifest.permission.SEND_SMS,
      )
    }
  }

  /**
   * `sentIntent` PendingIntents carry the ACTUAL carrier-level submission
   * result back through a locally-registered BroadcastReceiver. One
   * PendingIntent per message part; the receiver unregisters itself once
   * the last part's result has arrived.
   */
  private fun doSend(context: Context, number: String, message: String, promise: Promise) {
    try {
      val smsManager = SmsManager.getDefault()
      // A GPS-coordinate-bearing SOS text can exceed one 160-char SMS
      // segment — divideMessage()/sendMultipartTextMessage() handles that
      // split, rather than silently truncating a coordinate off the end.
      val parts = smsManager.divideMessage(message)
      val partCount = maxOf(parts.size, 1)
      val action = "ph.baranguard.tanod.SOS_SMS_SENT_${sendRequestCounter++}_${System.nanoTime()}"

      val remaining = AtomicInteger(partCount)
      val failureCode = AtomicInteger(Activity.RESULT_OK)

      val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
          val result = resultCode
          if (result != Activity.RESULT_OK) {
            failureCode.compareAndSet(Activity.RESULT_OK, result)
          }
          if (remaining.decrementAndGet() == 0) {
            try {
              context.unregisterReceiver(this)
            } catch (ignored: IllegalArgumentException) {
              // Already unregistered — harmless.
            }
            if (failureCode.get() == Activity.RESULT_OK) {
              promise.resolve(SosSmsSendResult(true))
            } else {
              promise.reject("ERR_SOS_SMS_SEND_FAILED", "SMS send failed: ${describeResult(failureCode.get())}", null)
            }
          }
        }
      }

      val filter = IntentFilter(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }

      val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0)
      val sentIntents = ArrayList<PendingIntent>()
      for (i in 0 until partCount) {
        sentIntents.add(PendingIntent.getBroadcast(context, i, Intent(action), piFlags))
      }

      if (parts.size > 1) {
        smsManager.sendMultipartTextMessage(number, null, parts, sentIntents, null)
      } else {
        smsManager.sendTextMessage(number, null, message, sentIntents[0], null)
      }
    } catch (e: Exception) {
      // No airplane-mode/no-SIM/radio-off check beforehand — letting
      // SmsManager itself fail and reporting that failure honestly is
      // simpler than predicting every reason a real send can fail. This
      // catch only fires for synchronous errors; the async sentIntent
      // result above is what catches everything else.
      promise.reject("ERR_SOS_SMS_SEND_FAILED", "SMS send failed: ${e.message}", e)
    }
  }

  private fun describeResult(resultCode: Int): String = when (resultCode) {
    SmsManager.RESULT_ERROR_NO_SERVICE -> "no cellular service"
    SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off (airplane mode?)"
    SmsManager.RESULT_ERROR_NULL_PDU -> "null PDU"
    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "generic failure"
    else -> "result code $resultCode"
  }

  companion object {
    // Kept in sync by hand with SettingsController::PH_MOBILE_NUMBER_PATTERN
    // (PHP) — same shape, two languages, no shared code between them.
    private val PH_MOBILE_NUMBER: Pattern = Pattern.compile("^(\\+63|0)9\\d{9}$")
    private var sendRequestCounter = 0
  }
}
