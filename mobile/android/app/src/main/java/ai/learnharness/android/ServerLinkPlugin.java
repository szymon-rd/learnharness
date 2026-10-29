package ai.learnharness.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the paired LearnHarness server inside the app and sends every other
 * link (research sources, docs, provider consoles) to the phone's browser.
 *
 * The connect screen calls setServer({ url }) with the server origin before
 * navigating to it. Capacitor asks shouldOverrideLoad for each top-level
 * navigation: returning false loads it in the WebView; null falls back to
 * Capacitor's default (the app's own pages load, other hosts open externally).
 */
@CapacitorPlugin(name = "ServerLink")
public class ServerLinkPlugin extends Plugin {

    private static final String PREFS = "learnharness";
    private static final String KEY_SERVER = "server";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || uri.getHost() == null || !("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))) {
            call.reject("Invalid server URL");
            return;
        }
        prefs().edit().putString(KEY_SERVER, url).apply();
        call.resolve();
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String saved = prefs().getString(KEY_SERVER, null);
        if (saved == null || url == null) {
            return null;
        }
        Uri server = Uri.parse(saved);
        // Same host, any scheme or port: the server may redirect http → https
        // (Caddy does), and that must stay inside the app.
        boolean web = "http".equalsIgnoreCase(url.getScheme()) || "https".equalsIgnoreCase(url.getScheme());
        boolean sameHost = web && equalsIgnoreCase(server.getHost(), url.getHost());
        return sameHost ? Boolean.FALSE : null;
    }

    private static boolean equalsIgnoreCase(String a, String b) {
        return a != null && a.equalsIgnoreCase(b);
    }
}
