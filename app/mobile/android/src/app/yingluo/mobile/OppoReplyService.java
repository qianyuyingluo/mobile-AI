package app.yingluo.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import android.graphics.drawable.Icon;
import java.util.Locale;

/** OPPO's native Live Update surface; no overlay window or notification listener. */
public final class OppoReplyService extends Service {
    private static final String CHANNEL = "oppo_reply_progress";
    private static final int ID = 201;
    private static OppoReplyService current;
    private static String pendingId = "", pendingStage = "等待回复";
    private static int pendingCharacters;
    private static boolean pendingFinished, pendingSuccess, pendingCancelled;
    static boolean visible;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private NotificationManager manager;
    private PowerManager.WakeLock wake;
    private String requestId = "", sessionId = "", stage = "等待回复";
    private int characters;
    private long started;
    private boolean finished, success;

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 36 && "oppo".equalsIgnoreCase(Build.MANUFACTURER);
    }

    static void begin(Context context, String id, String session) {
        if (!supported()) return;
        pendingId = id; pendingStage = "等待回复"; pendingCharacters = 0;
        pendingFinished = pendingSuccess = pendingCancelled = false;
        context.startForegroundService(new Intent(context, OppoReplyService.class)
                .putExtra("request", id).putExtra("session", session));
    }

    static void progress(String id, String stage, int characters) {
        if (pendingId.equals(id)) { pendingStage = stage; pendingCharacters = characters; }
        OppoReplyService service = current;
        if (service == null || !service.requestId.equals(id) || service.finished) return;
        service.stage = stage;
        service.characters = characters;
    }

    static void finish(String id, boolean success, boolean cancelled) {
        if (pendingId.equals(id)) { pendingFinished = true; pendingSuccess = success; pendingCancelled = cancelled; }
        OppoReplyService service = current;
        if (service == null || !service.requestId.equals(id) || service.finished) return;
        service.finished = true;
        service.success = success;
        service.stage = success ? "回复完成" : cancelled ? "已停止回复" : "回复中断";
        service.releaseWake();
        service.handler.removeCallbacksAndMessages(null);
        if (visible) { service.stopSelf(); return; }
        service.publish();
        service.handler.postDelayed(service::stopSelf, 15_000);
    }

    static void visibility(boolean active) {
        visible = active;
        if (current == null) return;
        if (active && current.finished) current.stopSelf();
        else current.publish();
    }

    @Override public void onCreate() {
        super.onCreate();
        current = this;
        manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "OPPO 回复实况", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("显示回复阶段和回复完成状态");
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yingluo:reply");
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !supported()) { stopSelf(); return START_NOT_STICKY; }
        handler.removeCallbacksAndMessages(null);
        requestId = intent.getStringExtra("request");
        sessionId = intent.getStringExtra("session");
        stage = "等待回复"; characters = 0; finished = success = false;
        started = SystemClock.elapsedRealtime();
        releaseWake();
        wake.acquire(300_000);
        startForeground(ID, notification());
        if (requestId.equals(pendingId)) {
            stage = pendingStage; characters = pendingCharacters;
            if (pendingFinished) { finish(requestId, pendingSuccess, pendingCancelled); return START_NOT_STICKY; }
        }
        handler.postDelayed(tick, 1000);
        return START_NOT_STICKY;
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (finished) return;
            if (SystemClock.elapsedRealtime() - started >= 300_000) { finish(requestId, false, false); return; }
            publish();
            handler.postDelayed(this, 1000);
        }
    };

    private Notification notification() {
        boolean companion = getResources().getBoolean(getResources().getIdentifier("companion_enabled", "bool", getPackageName()));
        String animation = companion ? (finished && success ? "reply_waving" : "reply_running") : "reply_status";
        // Supply the original animation, but let SystemUI decide playback. On the tested
        // ColorOS 17 it renders a still; per-frame notify() hides the critical text.
        int icon = getResources().getIdentifier(animation, "drawable", getPackageName());
        Intent open = new Intent(this, MainActivity.class).setAction(getPackageName() + ".OPEN_REPLY")
                .putExtra("reply_session", sessionId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long seconds = (SystemClock.elapsedRealtime() - started) / 1000;
        String detail = finished ? "点击查看对话" : String.format(Locale.ROOT, "已用 %d:%02d%s", seconds / 60, seconds % 60,
                characters > 0 ? " · 已回复 " + characters + " 字" : "");
        Bundle extras = new Bundle();
        extras.putBoolean("android.requestPromotedOngoing", !visible);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(Icon.createWithResource(this, icon))
                .setLargeIcon(Icon.createWithResource(this, icon))
                .setContentTitle(stage).setContentText(detail).setContentIntent(tap)
                .setCategory(Notification.CATEGORY_STATUS).setOngoing(true)
                .setOnlyAlertOnce(true).setShowWhen(false).setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShortCriticalText(stage).addExtras(extras);
        return builder.build();
    }

    private void publish() { manager.notify(ID, notification()); }
    private void releaseWake() { if (wake != null && wake.isHeld()) wake.release(); }
    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        releaseWake();
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (current == this) current = null;
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
