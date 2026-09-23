package io.gladlabs.sanctuary.pulse

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Two small native services the room needs on Android.
//
// The breath pulse: every haptics library files its pulses as touch feedback,
// which the system silently drops when the user has touch feedback switched
// off. A breath is not a button press, so this sends the pulse as media
// vibration, which follows the media vibration setting instead.
//
// The clock: React Native stops delivering JavaScript timers while the
// activity is paused, which includes the screen being locked, and the room
// must keep playing with the screen off. This thread emits a "tick" event on
// a fixed interval regardless of the activity's state; the app schedules
// everything from it.
class PulseModule : Module() {
  private var thread: HandlerThread? = null
  private var handler: Handler? = null

  private fun vibrator(): Vibrator? {
    val ctx = appContext.reactContext ?: return null
    return if (Build.VERSION.SDK_INT >= 31) {
      (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
  }

  private fun stopTicks() {
    handler?.removeCallbacksAndMessages(null)
    thread?.quitSafely()
    thread = null
    handler = null
  }

  override fun definition() = ModuleDefinition {
    Name("Pulse")
    Events("tick")

    AsyncFunction("pulse") { ms: Int, amplitude: Int ->
      val v = vibrator() ?: return@AsyncFunction false
      if (!v.hasVibrator()) return@AsyncFunction false
      val effect = VibrationEffect.createOneShot(ms.toLong().coerceIn(1, 2000), amplitude.coerceIn(1, 255))
      if (Build.VERSION.SDK_INT >= 33) {
        v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA))
      } else {
        v.vibrate(effect)
      }
      true
    }

    Function("startTicks") { intervalMs: Int ->
      stopTicks()
      val interval = intervalMs.toLong().coerceIn(20, 5000)
      val t = HandlerThread("sanctuary-clock")
      t.start()
      val h = Handler(t.looper)
      thread = t
      handler = h
      val runnable = object : Runnable {
        override fun run() {
          sendEvent("tick", mapOf("t" to System.currentTimeMillis().toDouble()))
          handler?.postDelayed(this, interval)
        }
      }
      h.post(runnable)
    }

    Function("stopTicks") { stopTicks() }

    OnDestroy { stopTicks() }
  }
}
