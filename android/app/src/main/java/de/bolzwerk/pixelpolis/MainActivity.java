package de.bolzwerk.pixelpolis;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Hülle für das Web-Spiel: Vollbild-WebView, Speichern in App-Dateien, Zurück-Taste. */
public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        web = new WebView(this);
        web.setBackgroundColor(0xff0d1a2b);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        hideSystemUi();
        // Wurde die App vom System neu erstellt, direkt den automatischen Spielstand fortsetzen.
        String url = "file:///android_asset/www/index.html" + (state != null ? "?resume=1" : "");
        web.loadUrl(url);
    }

    private void hideSystemUi() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.onAndroidBack && window.onAndroidBack()) ? 'yes' : 'no'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value == null || !value.contains("yes")) finish();
            }
        });
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.onAndroidPause && window.onAndroidPause()", null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemUi();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean("resume", true);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private File fileFor(String key) {
        return new File(getFilesDir(), key.replaceAll("[^A-Za-z0-9_]", "_") + ".dat");
    }

    private class Bridge {
        @JavascriptInterface
        public boolean save(String key, String data) {
            File f = fileFor(key);
            File tmp = new File(f.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                return false;
            }
            return tmp.renameTo(f);
        }

        @JavascriptInterface
        public String load(String key) {
            File f = fileFor(key);
            if (!f.exists()) return null;
            byte[] buf = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
            } catch (IOException e) {
                return null;
            }
            return new String(buf, StandardCharsets.UTF_8);
        }

        @JavascriptInterface
        public void remove(String key) {
            //noinspection ResultOfMethodCallIgnored
            fileFor(key).delete();
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }
}
