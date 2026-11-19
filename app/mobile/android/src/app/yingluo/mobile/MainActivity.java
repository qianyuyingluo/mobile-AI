package app.yingluo.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 1;
    private static final int CAMERA_PERMISSION = 2;
    private static final String ORIGIN_HOST = "app.yingluo.invalid";
    private static final String HOME = "https://" + ORIGIN_HOST + "/index.html";
    private static final Map<String, String> HTML_HEADERS = Collections.singletonMap(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' data: blob: https:; font-src 'self' data:; frame-src 'none'; "
            + "connect-src 'none'; form-action 'none'; base-uri 'none'");

    private WebView view;
    private NativeBridge bridge;
    private boolean ready;
    private Uri pendingPair;
    private ValueCallback<Uri[]> fileChooser;
    private PermissionRequest cameraRequest;
    private String pendingReply;

    void requestReplyPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
                && !getPreferences(MODE_PRIVATE).getBoolean("replyPermissionAsked", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("replyPermissionAsked", true).apply();
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 3);
        } else if (OppoReplyService.supported() && !getPreferences(MODE_PRIVATE).getBoolean("replyBackgroundAsked", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("replyBackgroundAsked", true).apply();
            requestReplyBackground();
        }
    }

    void requestReplyBackground() {
        android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
        if (power.isIgnoringBatteryOptimizations(getPackageName())) {
            android.widget.Toast.makeText(this, "已允许后台运行", android.widget.Toast.LENGTH_SHORT).show();
            return;
        }
        startActivity(new Intent("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", Uri.parse("package:" + getPackageName())));
    }

    @Override protected void onResume() { super.onResume(); OppoReplyService.visibility(true); }
    @Override protected void onPause() { OppoReplyService.visibility(false); super.onPause(); }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        // Bundled assets must update immediately after an APK replacement.
        view.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        view.getSettings().setSupportMultipleWindows(false);
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                if (!ready || !trustedOrigin(request.getOrigin()) || resources.length != 1
                        || !PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0]) || cameraRequest != null) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(resources);
                } else {
                    cameraRequest = request;
                    requestPermissions(new String[] { android.Manifest.permission.CAMERA }, CAMERA_PERMISSION);
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (cameraRequest == request) cameraRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView sender, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!ready || !trustedPage(Uri.parse(sender.getUrl()))) return false;
                if (fileChooser != null) {
                    callback.onReceiveValue(null);
                    return true;
                }
                fileChooser = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (android.content.ActivityNotFoundException unavailable) {
                    finishFileChooser(null);
                }
                return true;
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView sender, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (request.isForMainFrame() && request.hasGesture() && !trustedOrigin(target)
                        && ("https".equals(target.getScheme()) || "http".equals(target.getScheme()))
                        && target.getUserInfo() == null) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, target).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (android.content.ActivityNotFoundException missingBrowser) {
                        android.widget.Toast.makeText(MainActivity.this, "未找到可打开网址的浏览器", android.widget.Toast.LENGTH_SHORT).show();
                    }
                    return true;
                }
                return !request.isForMainFrame() || !trustedPage(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView sender, WebResourceRequest request) {
                return serveAsset(request);
            }

            @Override
            public void onPageStarted(WebView sender, String url, android.graphics.Bitmap icon) {
                ready = false;
            }

            @Override
            public void onPageFinished(WebView sender, String url) {
                ready = trustedPage(Uri.parse(url));
                forwardPairLink();
                forwardReply();
            }
        });
        bridge = new NativeBridge(this, view);
        view.addJavascriptInterface(bridge, "YingluoNative");
        setContentView(view);
        acceptPairLink(getIntent());
        view.loadUrl(HOME);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        acceptPairLink(intent);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code == 3 && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) { requestReplyPermission(); return; }
        if (code != CAMERA_PERMISSION || cameraRequest == null) return;
        PermissionRequest request = cameraRequest;
        cameraRequest = null;
        if (ready && grants.length == 1 && grants[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        } else {
            request.deny();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER) return;
        ClipData clip = resultCode == RESULT_OK && data != null ? data.getClipData() : null;
        Uri[] picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        if (clip != null && clip.getItemCount() > 0) {
            picked = new Uri[clip.getItemCount()];
            for (int index = 0; index < picked.length; index++) picked[index] = clip.getItemAt(index).getUri();
        }
        if (picked != null) {
            for (Uri uri : picked) {
                if (uri == null || !"content".equals(uri.getScheme())) {
                    picked = null;
                    break;
                }
            }
        }
        finishFileChooser(picked);
    }

    private void finishFileChooser(Uri[] picked) {
        ValueCallback<Uri[]> callback = fileChooser;
        fileChooser = null;
        if (callback != null) callback.onReceiveValue(picked);
    }

    private void acceptPairLink(Intent intent) {
        String reply = intent.getStringExtra("reply_session");
        if (reply != null && reply.length() <= 128) { pendingReply = reply; forwardReply(); }
        Uri link = intent.getData();
        if (link != null && "yingluo".equals(link.getScheme()) && "pair".equals(link.getHost())) {
            pendingPair = link;
            forwardPairLink();
        }
        setIntent(new Intent(this, MainActivity.class));
    }

    private void forwardReply() {
        if (!ready || pendingReply == null) return;
        view.evaluateJavascript("window.yingluoOpenReply?.(" + JSONObject.quote(pendingReply) + ")", null);
        pendingReply = null;
    }

    private void forwardPairLink() {
        if (!ready || pendingPair == null) return;
        String url = pendingPair.getQueryParameter("url");
        String code = pendingPair.getQueryParameter("code");
        pendingPair = null;
        if (url == null || url.length() > 2048 || code == null || !code.matches("[A-Za-z0-9-]{4,32}")) return;
        try {
            NativeBridge.validatedHttpUri(url);
        } catch (IllegalArgumentException invalid) {
            return;
        }
        view.evaluateJavascript(
                "if (typeof window.yingluoPairLink === 'function') window.yingluoPairLink("
                + JSONObject.quote(url) + "," + JSONObject.quote(code) + ")", null);
    }

    private static boolean trustedOrigin(Uri url) {
        return "https".equals(url.getScheme()) && ORIGIN_HOST.equals(url.getHost())
                && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
    }

    private static boolean trustedPage(Uri url) {
        return trustedOrigin(url) && ("/index.html".equals(url.getPath()) || "/".equals(url.getPath()));
    }

    private WebResourceResponse serveAsset(WebResourceRequest request) {
        Uri url = request.getUrl();
        // CSP permits remote HTTPS site icons, while scripts and frames remain local-only.
        if (!trustedOrigin(url) && !request.isForMainFrame() && "GET".equals(request.getMethod())
                && "https".equals(url.getScheme()) && url.getUserInfo() == null) return null;
        if (!trustedOrigin(url) || !"GET".equals(request.getMethod())) return blocked(403, "Forbidden");
        String path = "/".equals(url.getPath()) ? "index.html" : url.getPath();
        if (path == null || !path.matches("/?[a-zA-Z0-9_./-]+") || path.contains("..")) {
            return blocked(403, "Forbidden");
        }
        if (path.startsWith("/")) path = path.substring(1);
        String type = mimeType(path);
        if (type == null) return blocked(404, "Not found");
        try {
            Map<String, String> headers = "text/html".equals(type) ? HTML_HEADERS : Collections.emptyMap();
            return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, getAssets().open("web/" + path));
        } catch (IOException missing) {
            return blocked(404, "Not found");
        }
    }

    private static WebResourceResponse blocked(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, Collections.emptyMap(),
                new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private static String mimeType(String path) {
        String name = path.toLowerCase(Locale.ROOT);
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".woff2")) return "font/woff2";
        return null;
    }

    @Override
    public void onBackPressed() {
        if (!ready) { super.onBackPressed(); return; }
        view.evaluateJavascript("Boolean(window.yingluoBack && window.yingluoBack())", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (cameraRequest != null) cameraRequest.deny();
        finishFileChooser(null);
        bridge.close();
        view.removeJavascriptInterface("YingluoNative");
        view.stopLoading();
        view.destroy();
        super.onDestroy();
    }
}
