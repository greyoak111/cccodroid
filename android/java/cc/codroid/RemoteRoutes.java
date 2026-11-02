package cc.codroid;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Separate namespace: never calls MainActivity.openSession or carries a local session ID. */
public final class RemoteRoutes {
    public static final String ACTION_OPEN = "cc.codroid.OPEN_REMOTE_SESSION";
    public static final String PAGE_EVENT = "cc:remote-open";
    private static final String EXTRA = "cc.remote.route.v1";
    private RemoteRoutes() {}

    static PendingIntent open(Context ctx, RemotePolicy.Entry e) throws Exception {
        JSONObject route = RemoteWire.binding(e.binding);
        Intent i = MainActivity.internal(ctx, ACTION_OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA, route.toString())
            .setData(new Uri.Builder().scheme("cccodroid-remote").authority("session").appendPath(e.binding.routeKey()).build());
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Call only after MainActivity's fromUs check; verifies it again to make misuse fail closed. */
    public static JSONObject consume(Context ctx, Intent i) {
        try {
            if (i == null || !ACTION_OPEN.equals(i.getAction())) return null;
            String key = i.getStringExtra(MainActivity.IK);
            if (key == null || !MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8), MainActivity.intentKey(ctx).getBytes(StandardCharsets.UTF_8))) return null;
            String json = i.getStringExtra(EXTRA);
            if (json == null || json.length() > 1024) return null;
            RemotePolicy.Binding b = RemoteWire.binding(new JSONObject(json));
            Uri want = new Uri.Builder().scheme("cccodroid-remote").authority("session").appendPath(b.routeKey()).build();
            if (!want.equals(i.getData())) return null;
            i.removeExtra(EXTRA); // Do not re-open on unrelated Activity recreation.
            return RemoteWire.binding(b);
        } catch (Exception ignored) { return null; }
    }

    /** Inject only into a proved local gateway page; the frontend must revalidate its current grant. */
    public static String pageScript(JSONObject route) {
        RemotePolicy.Binding b = RemoteWire.binding(route);
        try {
            String value = RemoteWire.binding(b).toString();
            return "(function f(n){if(window.remoteView&&typeof window.remoteView.open==='function'){window.dispatchEvent(new CustomEvent("
                + JSONObject.quote(PAGE_EVENT) + ",{detail:" + value + "}));}else if(n<150)setTimeout(function(){f(n+1)},200);})(0)";
        } catch (Exception e) { throw new IllegalArgumentException("INVALID_REMOTE_ROUTE"); }
    }
}
