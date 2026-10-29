package ai.learnharness.android;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

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
