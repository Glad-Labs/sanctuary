package io.gladlabs.sanctuary.pulse

import android.content.Context
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The breath pulse. Every haptics library on Android files its pulses as
// touch feedback, which the system silently drops when the user has touch
// feedback switched off. A breath is not a button press: this sends the
// pulse as media vibration, which follows the media vibration setting instead.
class PulseModule : Module() {
  private fun vibrator(): Vibrator? {
    val ctx = appContext.reactContext ?: return null
    return if (Build.VERSION.SDK_INT >= 31) {
      (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
  }

  override fun definition() = ModuleDefinition {
    Name("Pulse")
    Function("pulse") { ms: Int, amplitude: Int ->
      val v = vibrator() ?: return@Function false
      if (!v.hasVibrator()) return@Function false
      val effect = VibrationEffect.createOneShot(ms.toLong().coerceIn(1, 2000), amplitude.coerceIn(1, 255))
      if (Build.VERSION.SDK_INT >= 33) {
        v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA))
      } else {
        v.vibrate(effect)
      }
      true
    }
  }
}
