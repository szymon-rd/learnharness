package ai.learnharness.android;

import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * The LearnHarness Android app: a WebView that shows the connect screen
 * (assets/public/index.html) and then the LearnHarness server's own pages.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(ServerLinkPlugin.class);
        super.onCreate(savedInstanceState);

        // If the page's renderer process dies (out of memory, or a crash),
        // Android closes the whole app unless this is handled. Start the screen
        // over with a fresh WebView instead: the connect screen then reconnects
        // to the saved server.
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    Log.w("LearnHarness", "WebView renderer gone; restarting the screen");
                    // Android requires a WebView whose renderer is gone to be
                    // taken off the screen and destroyed before anything else
                    // touches it.
                    ViewGroup parent = (ViewGroup) webView.getParent();
                    if (parent != null) parent.removeView(webView);
                    webView.destroy();
                    recreate();
                    return true;
                }
            });
        }

        // Android back = browser back while there is history (session → home →
        // connect screen); at the start of history it leaves the app as usual.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
