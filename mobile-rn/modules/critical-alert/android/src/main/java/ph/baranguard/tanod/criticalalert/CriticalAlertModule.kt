package ph.baranguard.tanod.criticalalert

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord

@OptimizedRecord
class ShowTestResult(
  @Field val shown: Boolean = false,
) : Record

@OptimizedRecord
class PendingAlertResult(
  @Field val pending: Boolean = false,
  @Field val notificationId: String? = null,
  @Field val notificationType: String? = null,
  @Field val title: String? = null,
  @Field val body: String? = null,
) : Record

@OptimizedRecord
class FirebaseAvailableResult(
  @Field val available: Boolean = false,
) : Record

/**
 * CriticalAlertModule — the JS-facing half of M12's full-screen critical
 * alert, port of ../mobile's FullScreenAlertPlugin.java.
 *
 * `showTest`/`getPendingAlert`/`dismiss` are fully functional and don't
 * need Firebase at all — they exercise the exact same
 * notification/full-screen-intent/Activity path a real incoming critical
 * push would use via a future FCM messaging-service hook.
 *
 * `isFirebaseAvailable` always reports false in this rebuild so far: no
 * Firebase Android SDK is on the classpath yet (`@react-native-firebase/app`
 * is not installed — the old app's own equivalent check needed a real
 * `google-services.json`, which still doesn't exist for this project,
 * REMAINING.md A4). This is the honest current-capability answer, not a
 * placeholder pretending push is wired up (§2 Rule 6) — wiring the real FCM
 * hook is follow-up work once that file is provided.
 */
class CriticalAlertModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CriticalAlert")

    AsyncFunction("showTest") { title: String?, body: String? ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      // Sentinel id/type — this path has no real notification row behind
      // it, but criticalAlertStore.ts's parseAlert() still needs both
      // fields present to accept the handoff, so the manual diagnostic
      // exercises the exact same handoff code a real FCM push would use.
      CriticalAlertNotifier.postFullScreenAlert(
        context,
        title ?: "Test Critical Alert",
        body ?: "This is a test of the full-screen emergency alert.",
        "-1",
        "sos",
      )
      ShowTestResult(true)
    }

    AsyncFunction("getPendingAlert") {
      val pending = CriticalAlertActivity.takePendingAlert()
      if (pending == null) {
        PendingAlertResult(pending = false)
      } else {
        PendingAlertResult(
          pending = true,
          notificationId = pending.notificationId,
          notificationType = pending.notificationType,
          title = pending.title,
          body = pending.body,
        )
      }
    }

    AsyncFunction("dismiss") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CriticalAlertNotifier.cancelFullScreenAlert(context)
    }

    AsyncFunction("isFirebaseAvailable") {
      FirebaseAvailableResult(false)
    }
  }
}
