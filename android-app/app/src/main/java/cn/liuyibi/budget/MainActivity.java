package cn.liuyibi.budget;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public final class MainActivity extends Activity {
    private static final String APP_ORIGIN = "https://budget-pocket.local";
    private static final String APP_HOST = "budget-pocket.local";
    private static final int REQUEST_IMPORT = 4101;
    private static final int REQUEST_EXPORT = 4102;
    private static final int MAX_LEDGER_BYTES = 32 * 1024 * 1024;
    private static final int PAGE_BACKGROUND = Color.rgb(246, 248, 252);
    private static final Set<String> WEB_ASSETS = new HashSet<>();

    static {
        WEB_ASSETS.add("index.html");
        WEB_ASSETS.add("app.js");
        WEB_ASSETS.add("styles.css");
        WEB_ASSETS.add("icon.svg");
        WEB_ASSETS.add("manifest.json");
        WEB_ASSETS.add("android-runtime.js");
    }

    private final Object ledgerLock = new Object();
    private final Object setupDraftLock = new Object();
    private AtomicFile ledgerFile;
    private AtomicFile setupDraftFile;
    private WebView webView;
    private String pendingExportJson;
    private boolean pendingJavascriptImport;
    private boolean pendingRequestIsWebFile;
    private android.webkit.ValueCallback<Uri[]> pendingFileChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(234, 241, 251));
        getWindow().setNavigationBarColor(Color.rgb(246, 248, 252));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        ledgerFile = new AtomicFile(new File(getFilesDir(), "budget-pocket-ledger.json"));
        setupDraftFile = new AtomicFile(new File(getFilesDir(), "budget-pocket-setup-draft.json"));
        FrameLayout shell = new FrameLayout(this);
        shell.setBackgroundColor(PAGE_BACKGROUND);
        webView = new WebView(this);
        webView.setBackgroundColor(PAGE_BACKGROUND);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        shell.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        installInsets(shell);
        setContentView(shell);
        configureWebView();
        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    private void installInsets(FrameLayout shell) {
        shell.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                int systemType = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
                android.graphics.Insets bars = insets.getInsets(systemType);
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        shell.requestApplyInsets();
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);

        webView.addJavascriptInterface(new AndroidLedgerBridge(), "AndroidLedger");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAllowedAppUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isAllowedAppUrl(Uri.parse(url));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveRequest(request.getUrl(), request.getMethod());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return serveRequest(Uri.parse(url), "GET");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                    android.webkit.ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                cancelPendingFileChooser();
                pendingFileChooser = filePathCallback;
                pendingRequestIsWebFile = true;
                openJsonPicker(REQUEST_IMPORT);
                return true;
            }
        });
    }

    private boolean isAllowedAppUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
                || !APP_HOST.equalsIgnoreCase(uri.getHost()) || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) return true;
        return WEB_ASSETS.contains(path.startsWith("/") ? path.substring(1) : path);
    }

    private WebResourceResponse serveRequest(Uri uri, String method) {
        if (!"GET".equalsIgnoreCase(method) || !isAllowedAppUrl(uri)) return blockedResponse();
        String path = uri.getPath();
        String asset = path == null || path.isEmpty() || "/".equals(path)
                ? "index.html" : path.substring(1);
        if (!WEB_ASSETS.contains(asset)) return blockedResponse();
        try {
            InputStream content = getAssets().open("web/" + asset);
            return new WebResourceResponse(mimeType(asset), "UTF-8", 200, "OK",
                    responseHeaders(), content);
        } catch (IOException error) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                    responseHeaders(), new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private static java.util.Map<String, String> responseHeaders() {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        return headers;
    }

    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                responseHeaders(), new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static String mimeType(String asset) {
        if (asset.endsWith(".html")) return "text/html";
        if (asset.endsWith(".js")) return "application/javascript";
        if (asset.endsWith(".css")) return "text/css";
        if (asset.endsWith(".svg")) return "image/svg+xml";
        if (asset.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            finish();
            return;
        }
        webView.evaluateJavascript("typeof window.handleNativeBack==='function'"
                + "?Boolean(window.handleNativeBack()):false", result -> {
            if (!"true".equals(result) && !isFinishing()) finish();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_EXPORT) {
            finishExport(resultCode == RESULT_OK && data != null ? data.getData() : null);
        } else if (requestCode == REQUEST_IMPORT) {
            finishImport(resultCode == RESULT_OK && data != null ? data.getData() : null);
        }
    }

    private void openJsonPicker(int requestCode) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/json"});
            startActivityForResult(intent, requestCode);
        } catch (ActivityNotFoundException | SecurityException error) {
            if (requestCode == REQUEST_IMPORT) finishImport(null);
        }
    }

    private void finishImport(Uri uri) {
        boolean fromWebFile = pendingRequestIsWebFile;
        pendingRequestIsWebFile = false;
        android.webkit.ValueCallback<Uri[]> chooser = pendingFileChooser;
        pendingFileChooser = null;
        if (fromWebFile && chooser != null) {
            chooser.onReceiveValue(uri == null ? null : new Uri[]{uri});
            return;
        }
        if (!pendingJavascriptImport) return;
        pendingJavascriptImport = false;
        if (uri == null) {
            notifyImportResult("", "");
            return;
        }
        try {
            String json = readSelectedJson(uri);
            notifyImportResult(json, "");
        } catch (Exception error) {
            notifyImportResult("", safeMessage(error, "无法读取所选备份"));
        }
    }

    private String readSelectedJson(Uri uri) throws IOException, JSONException {
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("系统无法读取所选文件");
            byte[] bytes = readLimited(input, MAX_LEDGER_BYTES);
            String json = new String(bytes, StandardCharsets.UTF_8);
            new JSONObject(json);
            return json;
        }
    }

    private void finishExport(Uri uri) {
        String json = pendingExportJson;
        pendingExportJson = null;
        if (uri == null || json == null) {
            notifyExportResult(false, "已取消导出");
            return;
        }
        try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("系统无法写入所选位置");
            output.write(json.getBytes(StandardCharsets.UTF_8));
            output.flush();
        } catch (Exception error) {
            notifyExportResult(false, safeMessage(error, "备份导出失败"));
            return;
        }
        notifyExportResult(true, "备份已导出");
    }

    private void cancelPendingFileChooser() {
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
    }

    private void notifyImportResult(String json, String error) {
        evaluateJavascript("if(typeof window.onNativeImportResult==='function')"
                + "window.onNativeImportResult(" + JSONObject.quote(json) + ","
                + JSONObject.quote(error) + ");");
    }

    private void notifyExportResult(boolean success, String message) {
        evaluateJavascript("if(typeof window.onNativeExportResult==='function')"
                + "window.onNativeExportResult(" + success + ","
                + JSONObject.quote(message) + ");");
    }

    private void evaluateJavascript(String script) {
        WebView current = webView;
        if (current != null) current.post(() -> current.evaluateJavascript(script, null));
    }

    private static byte[] readLimited(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > limit) throw new IOException("备份文件超过 32 MB，无法导入");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String safeMessage(Exception error, String fallback) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? fallback : message;
    }

    private final class AndroidLedgerBridge {
        @JavascriptInterface
        public String readLedger() {
            return readAtomicJson(ledgerFile, ledgerLock, "无法读取本机账本");
        }

        @JavascriptInterface
        public boolean saveLedger(String json) {
            return writeAtomicJson(ledgerFile, ledgerLock, json);
        }

        @JavascriptInterface
        public void exportLedger(String json, String filename) {
            if (!isValidJson(json)) {
                notifyExportResult(false, "账本数据无效，未导出备份");
                return;
            }
            runOnUiThread(() -> {
                if (pendingExportJson != null || pendingJavascriptImport || pendingRequestIsWebFile) {
                    notifyExportResult(false, "文件选择器正在使用，请稍后重试");
                    return;
                }
                pendingExportJson = json;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, safeFilename(filename));
                try {
                    startActivityForResult(intent, REQUEST_EXPORT);
                } catch (ActivityNotFoundException | SecurityException error) {
                    pendingExportJson = null;
                    notifyExportResult(false, "无法打开系统文件保存器");
                }
            });
        }

        @JavascriptInterface
        public void requestImport() {
            runOnUiThread(() -> {
                if (pendingExportJson != null || pendingJavascriptImport || pendingRequestIsWebFile) {
                    notifyImportResult("", "文件选择器正在使用，请稍后重试");
                    return;
                }
                pendingJavascriptImport = true;
                openJsonPicker(REQUEST_IMPORT);
            });
        }

        @JavascriptInterface
        public String readLegacyLedger() {
            File databaseFile = getDatabasePath("liuyibi.db");
            if (!databaseFile.isFile()) return "";
            SQLiteDatabase database = null;
            try {
                database = SQLiteDatabase.openDatabase(databaseFile.getAbsolutePath(), null,
                        SQLiteDatabase.OPEN_READONLY);
                JSONArray funds = new JSONArray();
                JSONArray entries = new JSONArray();
                double budgetSum = 0;
                try (Cursor cursor = database.rawQuery(
                        "SELECT id,name,budget,color FROM wallets ORDER BY id", null)) {
                    while (cursor.moveToNext()) {
                        JSONObject fund = new JSONObject();
                        fund.put("id", Long.toString(cursor.getLong(0)));
                        fund.put("name", cursor.getString(1));
                        double budget = cursor.getDouble(2);
                        fund.put("budget", budget);
                        fund.put("color", cursor.getString(3));
                        funds.put(fund);
                        budgetSum += budget;
                    }
                }
                try (Cursor cursor = database.rawQuery(
                        "SELECT id,wallet_id,wallet_name,date,note,amount,created_at FROM entries ORDER BY date,created_at,id",
                        null)) {
                    while (cursor.moveToNext()) {
                        JSONObject entry = new JSONObject();
                        entry.put("id", Long.toString(cursor.getLong(0)));
                        entry.put("fundId", cursor.isNull(1) ? "" : Long.toString(cursor.getLong(1)));
                        entry.put("fundName", cursor.isNull(2) ? "" : cursor.getString(2));
                        entry.put("date", cursor.isNull(3) ? "" : cursor.getString(3));
                        entry.put("note", cursor.isNull(4) ? "" : cursor.getString(4));
                        entry.put("amount", cursor.getDouble(5));
                        entry.put("createdAt", cursor.getLong(6));
                        entries.put(entry);
                    }
                }

                SharedPreferences prefs = getSharedPreferences("budget", MODE_PRIVATE);
                double totalBudget = budgetSum;
                try {
                    if (prefs.contains("total")) totalBudget = prefs.getFloat("total", (float) budgetSum);
                } catch (ClassCastException ignored) {
                    Object value = prefs.getAll().get("total");
                    if (value instanceof Number) totalBudget = ((Number) value).doubleValue();
                }
                String cycleMode = prefs.getString("cycleMode", "auto");
                long manualStart = 0;
                try { manualStart = prefs.getLong("manualStart", 0); }
                catch (ClassCastException ignored) { }

                JSONObject result = new JSONObject();
                result.put("funds", funds);
                result.put("entries", entries);
                result.put("payday", prefs.getInt("payday", 20));
                result.put("totalBudget", Math.max(0, totalBudget));
                result.put("cycleMode", cycleMode);
                result.put("manualCycleStart", manualStart > 0 ? formatDate(manualStart) : "");
                result.put("manualCycleStartedAt", manualStart);
                return result.toString();
            } catch (Exception error) {
                return legacyReadError();
            } finally {
                if (database != null) database.close();
            }
        }

        @JavascriptInterface
        public String readSetupDraft() {
            return readAtomicJson(setupDraftFile, setupDraftLock, "无法读取首次设置草稿");
        }

        @JavascriptInterface
        public boolean saveSetupDraft(String json) {
            return writeAtomicJson(setupDraftFile, setupDraftLock, json);
        }

        @JavascriptInterface
        public boolean clearSetupDraft() {
            synchronized (setupDraftLock) {
                try {
                    setupDraftFile.delete();
                    File base = setupDraftFile.getBaseFile();
                    return !base.exists() && !new File(base.getPath() + ".bak").exists()
                            && !new File(base.getPath() + ".new").exists();
                } catch (Exception error) {
                    return false;
                }
            }
        }
    }

    private static String readAtomicJson(AtomicFile file, Object lock, String errorMessage) {
        synchronized (lock) {
            File base = file.getBaseFile();
            if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return "";
            try (FileInputStream input = file.openRead()) {
                String json = new String(readLimited(input, MAX_LEDGER_BYTES), StandardCharsets.UTF_8);
                new JSONObject(json);
                return json;
            } catch (Exception error) {
                return nativeReadError(errorMessage);
            }
        }
    }

    private static boolean writeAtomicJson(AtomicFile file, Object lock, String json) {
        if (!isValidJson(json)) return false;
        byte[] contents = json.getBytes(StandardCharsets.UTF_8);
        synchronized (lock) {
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(contents);
                output.getFD().sync();
                file.finishWrite(output);
                return json.equals(readAtomicJson(file, lock, "无法读取刚写入的数据"));
            } catch (Exception error) {
                if (output != null) file.failWrite(output);
                return false;
            }
        }
    }

    private static String nativeReadError(String message) {
        try {
            return new JSONObject().put("_nativeReadError", message).toString();
        } catch (JSONException impossible) {
            return "{\"_nativeReadError\":\"读取本机数据失败\"}";
        }
    }

    private static String legacyReadError() {
        return nativeReadError("旧账本读取失败");
    }

    private static boolean isValidJson(String json) {
        if (json == null || json.isEmpty()
                || json.getBytes(StandardCharsets.UTF_8).length > MAX_LEDGER_BYTES) return false;
        try {
            new JSONObject(json);
            return true;
        } catch (JSONException error) {
            return false;
        }
    }

    private static String safeFilename(String filename) {
        String value = filename == null ? "liuyibi-backup.json" : filename;
        value = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (value.startsWith(".")) value = value.substring(1);
        if (value.isEmpty()) value = "liuyibi-backup";
        if (!value.toLowerCase(Locale.ROOT).endsWith(".json")) value += ".json";
        if (value.length() > 120) value = value.substring(0, 115) + ".json";
        return value;
    }

    private static String formatDate(long timestamp) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date(timestamp));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null);
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelPendingFileChooser();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidLedger");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
