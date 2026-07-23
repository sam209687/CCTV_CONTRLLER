package com.cctvcameranative

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CCTVForegroundServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CCTVForegroundService"

  @ReactMethod
  fun start(
    message: String,
    promise: Promise,
  ) {
    try {
      if (
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
        reactContext.checkSelfPermission(
          Manifest.permission.CAMERA,
        ) != PackageManager.PERMISSION_GRANTED
      ) {
        promise.reject(
          "CAMERA_PERMISSION_REQUIRED",
          "Camera permission must be granted before starting the foreground service",
        )

        return
      }

      val intent = Intent(
        reactContext,
        CCTVForegroundService::class.java,
      ).apply {
        putExtra(
          CCTVForegroundService.EXTRA_MESSAGE,
          message,
        )
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }

      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject(
        "FOREGROUND_SERVICE_START_FAILED",
        error.message,
        error,
      )
    }
  }

  @ReactMethod
  fun update(
    message: String,
    promise: Promise,
  ) {
    try {
      promise.resolve(
        CCTVForegroundService.updateNotification(
          reactContext,
          message,
        ),
      )
    } catch (error: Throwable) {
      promise.reject(
        "FOREGROUND_SERVICE_UPDATE_FAILED",
        error.message,
        error,
      )
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val stopped = reactContext.stopService(
        Intent(
          reactContext,
          CCTVForegroundService::class.java,
        ),
      )

      promise.resolve(
        stopped || !CCTVForegroundService.isRunning,
      )
    } catch (error: Throwable) {
      promise.reject(
        "FOREGROUND_SERVICE_STOP_FAILED",
        error.message,
        error,
      )
    }
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(CCTVForegroundService.isRunning)
  }

  @ReactMethod
  fun isBatteryOptimizationIgnored(promise: Promise) {
    try {
      val powerManager =
        reactContext.getSystemService(
          Context.POWER_SERVICE,
        ) as PowerManager

      promise.resolve(
        powerManager.isIgnoringBatteryOptimizations(
          reactContext.packageName,
        ),
      )
    } catch (error: Throwable) {
      promise.reject(
        "BATTERY_STATUS_FAILED",
        error.message,
        error,
      )
    }
  }

  @ReactMethod
  fun openBatterySettings(promise: Promise) {
    try {
      val intent = Intent(
        Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
      ).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (primaryError: Throwable) {
      try {
        val fallbackIntent = Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.parse(
            "package:${reactContext.packageName}",
          ),
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        reactContext.startActivity(fallbackIntent)
        promise.resolve(true)
      } catch (fallbackError: Throwable) {
        promise.reject(
          "BATTERY_SETTINGS_FAILED",
          fallbackError.message,
          fallbackError,
        )
      }
    }
  }
}
