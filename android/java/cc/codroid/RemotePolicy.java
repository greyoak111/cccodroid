package cc.codroid;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Pure policy shared by the Android host and its JVM tests. No local session IDs. */
public final class RemotePolicy {
    public static final int MAX_NOTIFICATIONS = 128;
    public static final int MAX_SEEN = 512;
    public static final int MAX_REVOKED = 256;
    public static final long MAX_TTL_MS = 24L * 60 * 60 * 1000;
    private RemotePolicy() {}

    public static String id(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"))
            throw new IllegalArgumentException("INVALID_REMOTE_ID");
        return value;
    }

    public static boolean shouldConnect(boolean serviceRunning, boolean foreground,
            boolean backgroundRequested, boolean systemNotifications, boolean connectionChannel) {
        return serviceRunning && (foreground || backgroundRequested && systemNotifications && connectionChannel);
    }

    /** STARTED owners remain visible while paused in split-screen. Independent of resume/focus policy. */
    public static final class Visibility {
        private final Set<Object> owners = Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
        public synchronized boolean started(Object owner) {
            if (owner == null) throw new IllegalArgumentException("INVALID_VISIBLE_OWNER");
            return owners.add(owner) && owners.size() == 1;
        }
        public synchronized boolean stopped(Object owner) {
            if (owner == null) throw new IllegalArgumentException("INVALID_VISIBLE_OWNER");
            return owners.remove(owner) && owners.isEmpty();
        }
        public synchronized boolean isVisible() { return !owners.isEmpty(); }
    }

    public static final class Binding {
        public final String fromDeviceId, hostInstanceId, remoteSessionId;
        public final long grantVersion;
        public Binding(String fromDeviceId, String hostInstanceId, String remoteSessionId, long grantVersion) {
            this.fromDeviceId = id(fromDeviceId);
            this.hostInstanceId = id(hostInstanceId);
            this.remoteSessionId = id(remoteSessionId);
            if (grantVersion < 1 || grantVersion > 9007199254740991L)
                throw new IllegalArgumentException("INVALID_GRANT_VERSION");
            this.grantVersion = grantVersion;
        }
        String scope() { return digest(fromDeviceId, hostInstanceId, remoteSessionId); }
        public String routeKey() { return digest(fromDeviceId, hostInstanceId, remoteSessionId, String.valueOf(grantVersion)); }
    }

    public static final class Entry {
        public final Binding binding;
        public final String kind, runId, requestId, eventId;
        public final long expiresAt;
        public Entry(String kind, Binding binding, String runId, String requestId, String eventId, long expiresAt) {
            if (!"invite".equals(kind) && !"request".equals(kind) && !"done".equals(kind))
                throw new IllegalArgumentException("INVALID_NOTIFICATION_KIND");
            if (binding == null) throw new IllegalArgumentException("INVALID_BINDING");
            this.kind = kind;
            this.binding = binding;
            this.runId = runId == null ? null : id(runId);
            this.requestId = requestId == null ? null : id(requestId);
            this.eventId = id(eventId);
            if (!"invite".equals(kind) && runId == null || "request".equals(kind) && requestId == null
                    || !"request".equals(kind) && requestId != null)
                throw new IllegalArgumentException("INVALID_NOTIFICATION_BINDING");
            if (expiresAt < 1 || expiresAt > 9007199254740991L)
                throw new IllegalArgumentException("INVALID_EXPIRY");
            this.expiresAt = expiresAt;
        }
        public String tag() {
            // Request replays get one tag even if the transport assigns a new eventId.
            String item = "request".equals(kind) ? requestId : "done".equals(kind) ? runId : eventId;
            return "remote:" + digest(kind, binding.routeKey(), runId == null ? "" : runId, item);
        }
    }

    public static final class Delta {
        public final List<Entry> post = new ArrayList<>();
        public final List<String> cancel = new ArrayList<>();
        public final java.util.Set<String> keep = new java.util.HashSet<>();
    }

    /** Hashes only, not remote titles, paths, request details, or credentials. */
    public static final class Revocation {
        public final long version, until;
        public Revocation(long version, long until) { this.version = version; this.until = until; }
    }

    public static final class Ledger {
        private final Map<String, Entry> shown = new LinkedHashMap<>();
        private final Map<String, Long> seen = new LinkedHashMap<>();
        private final Map<String, Revocation> revoked = new LinkedHashMap<>();
        // Bounded metadata only, held in memory for a foreground -> background replay.
        // Never persist this snapshot or infer a new grant from it after a restart.
        private List<Entry> latest = Collections.emptyList();

        public synchronized Delta sync(List<Entry> entries, long now, boolean allowPosts) {
            if (entries == null || entries.size() > MAX_NOTIFICATIONS) throw new IllegalArgumentException("NOTIFICATION_LIMIT");
            Map<String, Entry> desired = new LinkedHashMap<>();
            // Validate the whole snapshot before altering notification state.
            for (Entry e : entries) {
                if (e == null || e.expiresAt > now + MAX_TTL_MS) throw new IllegalArgumentException("INVALID_NOTIFICATION_TTL");
                String tag = e.tag();
                if (desired.put(tag, e) != null) throw new IllegalArgumentException("DUPLICATE_NOTIFICATION");
            }
            purge(now);
            for (Iterator<Entry> it = desired.values().iterator(); it.hasNext();) {
                Entry e = it.next();
                Revocation r = revoked.get(e.binding.scope());
                if (e.expiresAt <= now || r != null && e.binding.grantVersion <= r.version) it.remove();
            }
            int fresh = 0;
            if (allowPosts) for (String tag : desired.keySet()) if (!seen.containsKey(tag)) fresh++;
            // Never evict a live dedup key just to admit more notifications.
            if (seen.size() + fresh > MAX_SEEN) throw new IllegalArgumentException("NOTIFICATION_LEDGER_FULL");
            latest = new ArrayList<>(desired.values());
            Delta d = new Delta();
            for (Iterator<Map.Entry<String, Entry>> it = shown.entrySet().iterator(); it.hasNext();) {
                Map.Entry<String, Entry> old = it.next();
                if (!allowPosts || !desired.containsKey(old.getKey())) { d.cancel.add(old.getKey()); it.remove(); }
            }
            if (allowPosts) d.keep.addAll(desired.keySet());
            if (allowPosts) for (Map.Entry<String, Entry> item : desired.entrySet()) {
                String tag = item.getKey();
                Entry e = item.getValue();
                if (!seen.containsKey(tag)) {
                    seen.put(tag, e.expiresAt);
                    shown.put(tag, e);
                    d.post.add(e);
                } else {
                    // Keep replay suppression for as long as an authenticated pending snapshot remains live.
                    seen.put(tag, Math.max(seen.get(tag), e.expiresAt));
                }
            }
            return d;
        }

        /** Recheck TTL, revocation and dedup before using the most recent validated metadata. */
        public synchronized Delta replay(long now, boolean allowPosts) { return sync(latest, now, allowPosts); }
        public synchronized List<Entry> latestSnapshot() { return Collections.unmodifiableList(new ArrayList<>(latest)); }

        public synchronized Delta revoke(Binding binding, long now) {
            purge(now);
            String scope = binding.scope();
            Revocation old = revoked.get(scope);
            if (old == null && revoked.size() >= MAX_REVOKED) throw new IllegalArgumentException("REVOCATION_LEDGER_FULL");
            revoked.put(scope, new Revocation(old == null ? binding.grantVersion : Math.max(old.version, binding.grantVersion), now + MAX_TTL_MS));
            for (Iterator<Entry> it = latest.iterator(); it.hasNext();) {
                Entry e = it.next();
                if (e.binding.scope().equals(scope) && e.binding.grantVersion <= binding.grantVersion) it.remove();
            }
            Delta d = new Delta();
            for (Iterator<Map.Entry<String, Entry>> it = shown.entrySet().iterator(); it.hasNext();) {
                Map.Entry<String, Entry> item = it.next();
                Entry e = item.getValue();
                if (e.binding.scope().equals(scope) && e.binding.grantVersion <= binding.grantVersion) {
                    d.cancel.add(item.getKey()); it.remove();
                }
            }
            return d;
        }

        /** Hide displayed notes without forgetting unalerted foreground metadata or replay protection. */
        public synchronized Delta hide() {
            Delta d = new Delta(); d.cancel.addAll(shown.keySet()); shown.clear(); return d;
        }
        public synchronized Delta clear() {
            latest = Collections.emptyList();
            return hide();
        }
        private void purge(long now) {
            for (Iterator<Long> it = seen.values().iterator(); it.hasNext();) if (it.next() <= now) it.remove();
            for (Iterator<Revocation> it = revoked.values().iterator(); it.hasNext();) if (it.next().until <= now) it.remove();
        }
        public synchronized Map<String, Long> seenSnapshot() { return Collections.unmodifiableMap(new LinkedHashMap<>(seen)); }
        public synchronized Map<String, Revocation> revokedSnapshot() { return Collections.unmodifiableMap(new LinkedHashMap<>(revoked)); }
        public synchronized void restore(Map<String, Long> savedSeen, Map<String, Revocation> savedRevoked, long now) {
            if (savedSeen.size() > MAX_SEEN || savedRevoked.size() > MAX_REVOKED) throw new IllegalArgumentException("INVALID_LEDGER");
            for (Map.Entry<String, Long> e : savedSeen.entrySet())
                if (!e.getKey().matches("remote:[0-9a-f]{64}") || e.getValue() <= 0 || e.getValue() > now + MAX_TTL_MS)
                    throw new IllegalArgumentException("INVALID_LEDGER");
            for (Map.Entry<String, Revocation> e : savedRevoked.entrySet())
                if (!e.getKey().matches("[0-9a-f]{64}") || e.getValue().version < 1 || e.getValue().version > 9007199254740991L
                        || e.getValue().until <= 0 || e.getValue().until > now + MAX_TTL_MS)
                    throw new IllegalArgumentException("INVALID_LEDGER");
            shown.clear(); latest = Collections.emptyList();
            seen.clear(); seen.putAll(savedSeen); revoked.clear(); revoked.putAll(savedRevoked); purge(now);
        }
    }

    static String digest(String... values) {
        try {
            MessageDigest h = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                byte[] b = value.getBytes(StandardCharsets.UTF_8);
                h.update(new byte[] { (byte) (b.length >>> 24), (byte) (b.length >>> 16), (byte) (b.length >>> 8), (byte) b.length });
                h.update(b);
            }
            StringBuilder out = new StringBuilder();
            for (byte b : h.digest()) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return out.toString();
        } catch (Exception e) { throw new IllegalStateException("SHA256_UNAVAILABLE"); }
    }
}
