package com.cctvcameranative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class CCTVForegroundService : Service() {

  companion object {
    const val CHANNEL_ID = "cctv_camera_stream"
    const val NOTIFICATION_ID = 1108
    const val EXTRA_MESSAGE = "message"

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    var lastMessage: String = "Preparing secure WebRTC camera"
      private set

    fun buildNotification(
      context: Context,
      message: String,
    ): Notification {
      val openAppIntent = Intent(
        context,
        MainActivity::class.java,
      ).apply {
        flags =
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_CLEAR_TOP
      }

      val pendingIntentFlags =
        PendingIntent.FLAG_UPDATE_CURRENT or
          PendingIntent.FLAG_IMMUTABLE

      val openAppPendingIntent = PendingIntent.getActivity(
        context,
        1108,
        openAppIntent,
        pendingIntentFlags,
      )

      val builder = if (
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      ) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }

      return builder
        .setSmallIcon(android.R.drawable.presence_video_online)
        .setContentTitle("CCTV WebRTC camera active")
        .setContentText(message)
        .setContentIntent(openAppPendingIntent)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .build()
    }

    fun updateNotification(
      context: Context,
      message: String,
    ): Boolean {
      if (!isRunning) {
        return false
      }

      lastMessage = message

      val notificationManager =
        context.getSystemService(
          Context.NOTIFICATION_SERVICE,
        ) as NotificationManager

      notificationManager.notify(
        NOTIFICATION_ID,
        buildNotification(context, message),
      )

      return true
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    acquireWakeLock()
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    val message =
      intent?.getStringExtra(EXTRA_MESSAGE)
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: lastMessage

    lastMessage = message

    val notification = buildNotification(
      this,
      message,
    )

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
      )
    } else {
      startForeground(
        NOTIFICATION_ID,
        notification,
      )
    }

    isRunning = true

    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    releaseWakeLock()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }

    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val channel = NotificationChannel(
      CHANNEL_ID,
      "CCTV camera streaming",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description =
        "Shows when the smartphone camera is streaming through WebRTC"
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }

    val notificationManager =
      getSystemService(
        Context.NOTIFICATION_SERVICE,
      ) as NotificationManager

    notificationManager.createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) {
      return
    }

    val powerManager =
      getSystemService(Context.POWER_SERVICE) as PowerManager

    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "CCTVCameraNative:WebRTCStream",
    ).apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { lock ->
      if (lock.isHeld) {
        lock.release()
      }
    }

    wakeLock = null
  }
}
