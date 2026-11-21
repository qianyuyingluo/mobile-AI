package app.yingluo.mobile;

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

final class NativeBridge {
    private static final int MAX_REQUEST_BYTES = 18 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    private final Activity activity;
    private final WebView view;
    private final SecretStore secrets;
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(
            4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
    private final ConcurrentHashMap<String, PendingRequest> requests = new ConcurrentHashMap<>();
    private volatile boolean closed;
    private volatile String replySession = "";

    @JavascriptInterface
    public void setReplySession(String session) {
        replySession = session != null && session.length() <= 128 ? session : "";
    }

    @JavascriptInterface
    public boolean supportsReplyLiveUpdate() { return OppoReplyService.supported(); }

    @JavascriptInterface
    public void openReplySettings() {
        activity.runOnUiThread(() -> {
            if (!OppoReplyService.supported()) return;
            new android.app.AlertDialog.Builder(activity).setTitle("OPPO 实况通知")
                    .setMessage("开启「流体云显示实时活动」。再在应用详情 → 耗电管理中选择「完全允许后台行为」，避免 OPPO 回桌面后冻结回复。")
                    .setPositiveButton("流体云显示", (dialog, which) -> activity.startActivity(
                            new android.content.Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                                    .putExtra("android.provider.extra.APP_PACKAGE", activity.getPackageName())))
                    .setNeutralButton("耗电管理", (dialog, which) -> activity.startActivity(
                            new android.content.Intent("android.settings.APPLICATION_DETAILS_SETTINGS",
                                    android.net.Uri.parse("package:" + activity.getPackageName()))))
                    .setNegativeButton("关闭", null).show();
        });
    }

    NativeBridge(Activity activity, WebView view) {
        this.activity = activity;
        this.view = view;
        secrets = new SecretStore(activity);
    }

    @JavascriptInterface
    public void request(String id, String url, String method, String headersJson, String body) {
        if (id == null || !id.matches("[a-zA-Z0-9_-]{1,96}") || closed) return;
        if ((!"GET".equals(method) && !"POST".equals(method) && !"DELETE".equals(method)) || url == null || url.length() > 8192
                || headersJson == null || headersJson.length() > 32 * 1024
                || body == null || body.length() > MAX_REQUEST_BYTES) {
            fail(id, "请求参数无效");
            return;
        }

        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_REQUEST_BYTES || (!"POST".equals(method) && bytes.length != 0)) {
            fail(id, "请求内容过大或请求类型不匹配");
            return;
        }
        PendingRequest request = new PendingRequest(id, url, method, headersJson, bytes);
        if (requests.putIfAbsent(id, request) != null) return;
        activity.runOnUiThread(() -> {
            if (closed || request.cancelled) return;
            if (request.progress != null && OppoReplyService.supported()) {
                ((MainActivity) activity).requestReplyPermission();
                try { OppoReplyService.begin(activity, id, replySession); }
                catch (RuntimeException unavailable) {
                    android.util.Log.w("YingluoReply", "Cannot start foreground reply service", unavailable);
                    android.widget.Toast.makeText(activity, "无法启动后台实况，请保持应用在前台", android.widget.Toast.LENGTH_LONG).show();
                }
            }
            try { workers.execute(request); }
            catch (RejectedExecutionException busy) {
                requests.remove(id, request);
                OppoReplyService.finish(id, false, false);
                fail(id, "同时进行的请求太多，请稍后重试");
            }
        });
    }

    @JavascriptInterface
    public void cancel(String id) {
        if (id == null) return;
        PendingRequest request = requests.remove(id);
        if (request == null) return;
        workers.remove(request);
        request.cancel();
        fail(id, "请求已取消");
    }

    @JavascriptInterface
    public String getSecret(String name) {
        return secrets.get(name);
    }

    @JavascriptInterface
    public boolean setSecret(String name, String value) {
        return secrets.set(name, value);
    }

    static URI validatedHttpUri(String input) {
        URI uri = URI.create(input);
        String scheme = uri.getScheme();
        if ((!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))
                || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || uri.getPort() > 65535 || uri.getPort() == 0) {
            throw new IllegalArgumentException("Invalid HTTP URL");
        }
        return uri;
    }

    void close() {
        closed = true;
        for (PendingRequest request : requests.values()) request.cancel();
        requests.clear();
        workers.shutdownNow();
    }

    private void fail(String id, String message) {
        result(id, 0, failureBody(message), "");
    }

    private static String failureBody(String message) {
        return "{\"error\":{\"message\":" + JSONObject.quote(message) + "}}";
    }

    private void result(String id, int status, String body, String sessionId) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!closed) {
                    view.evaluateJavascript(
                            "if (typeof window.yingluoHttpResult === 'function') window.yingluoHttpResult("
                            + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(body) + "," + JSONObject.quote(sessionId) + ")", null);
                }
            }
        });
    }

    private static final class ResponseTooLarge extends IOException {}

    private void chunk(String id, String text) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!closed) view.evaluateJavascript(
                    "window.yingluoHttpChunk && window.yingluoHttpChunk(" + JSONObject.quote(id)
                    + "," + JSONObject.quote(text) + ")", null);
            }
        });
    }

    private static String readBody(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (output.size() + count > MAX_RESPONSE_BYTES) throw new ResponseTooLarge();
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static boolean allowedHeader(String header) {
        switch (header.toLowerCase(Locale.ROOT)) {
            case "mcp-session-id":
            case "mcp-protocol-version":
            case "accept":
            case "authorization":
            case "content-type":
            case "x-api-key":
            case "anthropic-version":
            case "anthropic-dangerous-direct-browser-access":
            case "x-goog-api-key":
                return true;
            default:
                return false;
        }
    }

    private final class PendingRequest implements Runnable {
        private final String id;
        private final String url;
        private final String method;
        private final String headersJson;
        private final byte[] body;
        private volatile HttpURLConnection connection;
        private volatile boolean cancelled;
        private final ReplyProgress progress;

        PendingRequest(String id, String url, String method, String headersJson, byte[] body) {
            this.id = id;
            this.url = url;
            this.method = method;
            this.headersJson = headersJson;
            this.body = body;
            ReplyProgress observer = null;
            try {
                if ("text/event-stream".equals(new JSONObject(headersJson).optString("Accept"))) observer = new ReplyProgress();
            } catch (org.json.JSONException invalid) { /* Request validation reports this from run(). */ }
            this.progress = observer;
        }

        void cancel() {
            cancelled = true;
            if (progress != null) activity.runOnUiThread(() -> OppoReplyService.finish(id, false, true));
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
        }

        @Override
        public void run() {
            int status = 0;
            String reply = "";
            String sessionId = "";
            try {
                connection = (HttpURLConnection) validatedHttpUri(url).toURL().openConnection();
                if (cancelled) return;
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(12_000);
                connection.setReadTimeout(240_000);
                connection.setUseCaches(false);
                connection.setRequestMethod(method);
                JSONObject headers = new JSONObject(headersJson);
                for (Iterator<String> names = headers.keys(); names.hasNext();) {
                    String name = names.next();
                    String value = headers.getString(name);
                    if (!allowedHeader(name) || value.contains("\r") || value.contains("\n")) {
                        throw new IllegalArgumentException("Invalid HTTP header");
                    }
                    connection.setRequestProperty(name, value);
                }
                if ("POST".equals(method)) {
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(body.length);
                    try (OutputStream stream = connection.getOutputStream()) {
                        stream.write(body);
                    }
                }
                status = connection.getResponseCode();
                String responseSession = connection.getHeaderField("Mcp-Session-Id");
                if (responseSession != null) sessionId = responseSession;
                if (status >= 200 && status < 300 && "text/event-stream".equals(headers.optString("Accept"))) {
                    String contentType = connection.getContentType();
                    if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                        throw new IOException("Expected event stream");
                    }
                    try (InputStreamReader reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                        char[] buffer = new char[2048];
                        int count, total = 0;
                        while (!cancelled && (count = reader.read(buffer)) != -1) {
                            total += count;
                            if (total > MAX_RESPONSE_BYTES) throw new ResponseTooLarge();
                            String piece = new String(buffer, 0, count);
                            if (progress != null) {
                                progress.push(piece);
                                String stage = progress.stage;
                                int characters = progress.characters;
                                activity.runOnUiThread(() -> OppoReplyService.progress(id, stage, characters));
                            }
                            chunk(id, piece);
                        }
                    }
                } else {
                    reply = readBody(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
                }
            } catch (ResponseTooLarge tooLarge) {
                status = 0;
                reply = failureBody("服务器返回内容过大");
            } catch (Exception failed) {
                status = 0;
                reply = failureBody("连接失败，请检查地址和网络");
            } finally {
                if (connection != null) connection.disconnect();
                if (progress != null) {
                    boolean success = status >= 200 && status < 300 && !cancelled && progress.successful();
                    activity.runOnUiThread(() -> OppoReplyService.finish(id, success, cancelled));
                }
                if (requests.remove(id, this) && !cancelled) result(id, status, reply, sessionId);
            }
        }
    }
}
