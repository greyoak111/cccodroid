package cc.codroid;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Strict private-host JSON, not a public HTTP or JavascriptInterface API. */
final class RemoteWire {
    static void exact(JSONObject o, String... fields) {
        if (o == null) throw new IllegalArgumentException("INVALID_SCHEMA");
        Set<String> allowed = new HashSet<>();
        java.util.Collections.addAll(allowed, fields);
        if (o.length() != allowed.size()) throw new IllegalArgumentException("INVALID_SCHEMA");
        for (Iterator<String> it = o.keys(); it.hasNext();) if (!allowed.contains(it.next())) throw new IllegalArgumentException("UNKNOWN_FIELD");
    }
    static String string(JSONObject o, String key) {
        Object v = o.opt(key);
        if (!(v instanceof String)) throw new IllegalArgumentException("INVALID_SCHEMA");
        return (String) v;
    }
    static String nullableId(JSONObject o, String key) {
        Object v = o.opt(key);
        if (v == JSONObject.NULL) return null;
        return RemotePolicy.id(string(o, key));
    }
    static long integer(JSONObject o, String key, long min, long max) {
        Object v = o.opt(key);
        if (!(v instanceof Number)) throw new IllegalArgumentException("INVALID_SCHEMA");
        double n = ((Number) v).doubleValue();
        long i = ((Number) v).longValue();
        if (n != i || i < min || i > max) throw new IllegalArgumentException("INVALID_SCHEMA");
        return i;
    }
    static boolean bool(JSONObject o, String key) {
        Object v = o.opt(key);
        if (!(v instanceof Boolean)) throw new IllegalArgumentException("INVALID_SCHEMA");
        return (Boolean) v;
    }
    static RemotePolicy.Binding binding(JSONObject o) {
        exact(o, "fromDeviceId", "hostInstanceId", "remoteSessionId", "grantVersion");
        return new RemotePolicy.Binding(string(o, "fromDeviceId"), string(o, "hostInstanceId"), string(o, "remoteSessionId"),
            integer(o, "grantVersion", 1, 9007199254740991L));
    }
    static JSONObject binding(RemotePolicy.Binding b) throws Exception {
        return new JSONObject().put("fromDeviceId", b.fromDeviceId).put("hostInstanceId", b.hostInstanceId)
            .put("remoteSessionId", b.remoteSessionId).put("grantVersion", b.grantVersion);
    }
    static RemotePolicy.Entry entry(JSONObject o) {
        exact(o, "kind", "binding", "runId", "requestId", "eventId", "expiresAt");
        return new RemotePolicy.Entry(string(o, "kind"), binding(o.optJSONObject("binding")), nullableId(o, "runId"), nullableId(o, "requestId"),
            string(o, "eventId"), integer(o, "expiresAt", 1, 9007199254740991L));
    }
    static java.util.List<RemotePolicy.Entry> entries(JSONObject o) {
        exact(o, "entries");
        JSONArray a = o.optJSONArray("entries");
        if (a == null || a.length() > RemotePolicy.MAX_NOTIFICATIONS) throw new IllegalArgumentException("NOTIFICATION_LIMIT");
        java.util.List<RemotePolicy.Entry> entries = new java.util.ArrayList<>();
        for (int i = 0; i < a.length(); i++) entries.add(entry(a.optJSONObject(i)));
        return entries;
    }
}
