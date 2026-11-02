package cc.codroid;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** java -cp <output> cc.codroid.RemotePolicyTest; no Android runtime or real device data. */
public final class RemotePolicyTest {
    private static int checks;
    private static void check(boolean ok, String message) {
        checks++;
        if (!ok) throw new AssertionError(message);
    }
    private static void rejects(Runnable fn, String message) {
        boolean rejected = false;
        try { fn.run(); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, message);
    }
    private static RemotePolicy.Binding binding(String device, String session, long grant) {
        return new RemotePolicy.Binding(device, "host-fixture", session, grant);
    }
    private static RemotePolicy.Entry entry(String kind, RemotePolicy.Binding b, String run, String request, String event) {
        return new RemotePolicy.Entry(kind, b, run, request, event, 60000);
    }
    public static void main(String[] args) {
        check(!RemotePolicy.shouldConnect(false, true, true, true, true), "Service is required");
        check(RemotePolicy.shouldConnect(true, true, false, false, false), "Foreground does not require notifications");
        check(!RemotePolicy.shouldConnect(true, false, false, true, true), "Background is opt in");
        check(!RemotePolicy.shouldConnect(true, false, true, false, true), "Revoked system notifications block background");
        check(!RemotePolicy.shouldConnect(true, false, true, true, false), "Disabled ongoing channel blocks background");
        check(RemotePolicy.shouldConnect(true, false, true, true, true), "Explicit background with visible ongoing channel");

        RemotePolicy.Visibility visibility = new RemotePolicy.Visibility();
        Object firstWindow = new Object(), replacementWindow = new Object();
        check(!visibility.isVisible(), "Service-only startup has no visible Activity");
        check(visibility.started(firstWindow), "First STARTED owner enters foreground");
        check(!visibility.started(firstWindow), "Duplicate onStart is idempotent");
        // onPause deliberately has no remote visibility transition: a split-screen window is still STARTED.
        check(RemotePolicy.shouldConnect(true, visibility.isVisible(), false, false, false), "Paused visible split-screen keeps foreground-only connection");
        check(!visibility.started(replacementWindow), "Overlapping replacement does not enter foreground twice");
        check(!visibility.stopped(firstWindow) && visibility.isVisible(), "Old Activity stopping cannot hide its STARTED replacement");
        check(!visibility.stopped(firstWindow), "Duplicate or stale onStop cannot hide another owner");
        check(visibility.stopped(replacementWindow) && !visibility.isVisible(), "Last STOPPED owner enters background");
        check(!RemotePolicy.shouldConnect(true, visibility.isVisible(), false, true, true), "Stopped foreground-only window disconnects");
        check(!RemotePolicy.shouldConnect(true, visibility.isVisible(), true, false, true), "Stopped window cannot bypass denied system notifications");
        check(!RemotePolicy.shouldConnect(true, visibility.isVisible(), true, true, false), "Stopped window cannot bypass denied connection channel");
        check(RemotePolicy.shouldConnect(true, visibility.isVisible(), true, true, true), "Stopped opted-in window can keep permitted background connection");
        check(visibility.started(firstWindow), "Activity restart becomes visible again");
        check(visibility.stopped(firstWindow), "Restarted Activity can stop normally");
        rejects(() -> visibility.started(null), "Null visible owner rejected");
        rejects(() -> visibility.stopped(null), "Null stopped owner rejected");
        rejects(() -> binding("/local/path", "session", 1), "Device ID cannot be path");
        rejects(() -> binding("tablet", "session", 0), "Grant version required");
        rejects(() -> entry("approve", binding("tablet", "remote-a", 1), "run", "request", "event"), "No approval notification kind");
        rejects(() -> entry("request", binding("tablet", "remote-a", 1), null, "request", "event"), "Request binds original run");
        rejects(() -> entry("done", binding("tablet", "remote-a", 1), "run", "request", "event"), "Done cannot carry request");

        RemotePolicy.Binding b = binding("tablet", "remote-a", 1);
        RemotePolicy.Entry a = entry("request", b, "run", "request", "event-1");
        check(a.tag().startsWith("remote:") && a.tag().length() == 71, "Bounded opaque independent tag");
        check(a.tag().equals(entry("request", b, "run", "request", "event-2").tag()), "New transport event does not duplicate request");
        check(!a.tag().equals(entry("request", binding("other-tablet", "remote-a", 1), "run", "request", "event-1").tag()), "Device-scoped request");
        check(!a.tag().equals(entry("request", binding("tablet", "remote-b", 1), "run", "request", "event-1").tag()), "Remote-session-scoped request");
        check(!a.tag().equals(entry("request", b, "other-run", "request", "event-1").tag()), "Run-scoped request");
        check(!a.tag().equals(entry("request", binding("tablet", "remote-a", 2), "run", "request", "event-1").tag()), "Grant-scoped request");

        RemotePolicy.Ledger ledger = new RemotePolicy.Ledger();
        check(ledger.sync(Arrays.asList(a), 1000, true).post.size() == 1, "First request posted");
        check(ledger.sync(Arrays.asList(a), 1000, true).post.isEmpty(), "Replay suppressed");
        check(ledger.sync(Collections.<RemotePolicy.Entry>emptyList(), 1000, true).cancel.contains(a.tag()), "Resolved request canceled");
        check(ledger.sync(Arrays.asList(a), 1000, true).post.isEmpty(), "Old reopened snapshot stays deduplicated");
        RemotePolicy.Entry other = entry("request", binding("tablet", "remote-b", 1), "run", "request", "event-1");
        check(ledger.sync(Arrays.asList(a, other), 1000, true).post.size() == 1, "Same request ID in other session isolated");
        check(ledger.revoke(binding("tablet", "remote-b", 1), 1000).cancel.contains(other.tag()), "Revocation cancels target only");
        RemotePolicy.Delta stale = ledger.sync(Arrays.asList(other), 1000, true);
        check(stale.post.isEmpty() && !stale.keep.contains(other.tag()), "Stale revoked snapshot cannot resurrect notification");
        RemotePolicy.Entry newer = entry("request", binding("tablet", "remote-b", 2), "run", "request", "event-2");
        check(ledger.sync(Arrays.asList(newer), 1000, true).post.size() == 1, "Explicit newer grant not blocked by old revoke");

        RemotePolicy.Ledger restored = new RemotePolicy.Ledger();
        restored.restore(ledger.seenSnapshot(), ledger.revokedSnapshot(), 1000);
        check(restored.sync(Arrays.asList(newer), 1000, true).post.isEmpty(), "Restart retains dedup");
        check(restored.sync(Arrays.asList(other), 1000, true).keep.isEmpty(), "Restart retains revocation tombstone");
        check(new RemotePolicy.Ledger().sync(Arrays.asList(a), 1000, false).post.isEmpty(), "Foreground/permission policy suppresses posting");
        check(new RemotePolicy.Ledger().sync(Arrays.asList(a), 60000, true).post.isEmpty(), "Expired request suppressed");
        RemotePolicy.Entry late = new RemotePolicy.Entry("invite", b, null, null, "late", RemotePolicy.MAX_TTL_MS + 1001);
        rejects(() -> new RemotePolicy.Ledger().sync(Arrays.asList(late), 1000, true), "TTL bounded");
        rejects(() -> new RemotePolicy.Ledger().sync(Arrays.asList(a, a), 1000, true), "Duplicate snapshot rejected atomically");
        Map<String, Long> bad = new HashMap<>(); bad.put("real-path-or-secret", 5000L);
        rejects(() -> new RemotePolicy.Ledger().restore(bad, Collections.<String, RemotePolicy.Revocation>emptyMap(), 1000), "Persistent ledger stores hashes only");
        java.util.List<RemotePolicy.Entry> tooMany = new java.util.ArrayList<>();
        for (int i = 0; i <= RemotePolicy.MAX_NOTIFICATIONS; i++) tooMany.add(entry("invite", b, null, null, "i-" + i));
        rejects(() -> new RemotePolicy.Ledger().sync(tooMany, 1000, true), "Notification snapshot bounded");
        RemotePolicy.Ledger full = new RemotePolicy.Ledger();
        for (int j = 0; j < 4; j++) {
            java.util.List<RemotePolicy.Entry> batch = new java.util.ArrayList<>();
            for (int i = 0; i < RemotePolicy.MAX_NOTIFICATIONS; i++) batch.add(entry("invite", b, null, null, "i-" + j + "-" + i));
            full.sync(batch, 1000, true);
        }
        rejects(() -> full.sync(Arrays.asList(a), 1000, true), "Live replay keys never evicted to admit new alerts");
        check(full.seenSnapshot().size() == RemotePolicy.MAX_SEEN, "Dedup cap maintained");
        visibilityReplay(a, b);
        System.out.println("RemotePolicyTest: " + checks + " checks PASS (pure JVM; not Android notification/lockscreen acceptance)");
    }

    private static void visibilityReplay(RemotePolicy.Entry a, RemotePolicy.Binding b) {
        RemotePolicy.Ledger replay = new RemotePolicy.Ledger();
        java.util.List<RemotePolicy.Entry> incoming = new java.util.ArrayList<>(Arrays.asList(a));
        check(replay.sync(incoming, 1000, false).post.isEmpty(), "Foreground sync stores metadata without alerting");
        check(replay.seenSnapshot().isEmpty(), "Unalerted foreground request does not consume dedup");
        incoming.clear();
        check(replay.latestSnapshot().size() == 1, "Replay owns a copy of the bounded metadata snapshot");
        check(replay.replay(2000, true).post.size() == 1, "Visibility-only background transition posts pending request without another event");
        check(replay.latestSnapshot().get(0).expiresAt == a.expiresAt, "Native replay never renews metadata expiry");
        check(replay.replay(2001, true).post.isEmpty(), "Repeated background transition does not duplicate alert");
        replay.hide();
        check(replay.latestSnapshot().size() == 1 && replay.seenSnapshot().containsKey(a.tag()), "Foreground hide preserves metadata and dedup");
        check(replay.replay(3000, true).post.isEmpty(), "Returning to background does not resurrect a dismissed or hidden alert");

        RemotePolicy.Entry next = entry("request", b, "run", "request-next", "event-next");
        replay.sync(Arrays.asList(a, next), 4000, false);
        RemotePolicy.Delta nextDelta = replay.replay(5000, true);
        check(nextDelta.post.size() == 1 && nextDelta.post.get(0).tag().equals(next.tag()), "Only newly received unalerted foreground request posts on next stop");
        replay.sync(Collections.<RemotePolicy.Entry>emptyList(), 5001, false);
        check(replay.latestSnapshot().isEmpty() && replay.replay(5002, true).keep.isEmpty(), "Resolved empty snapshot replaces metadata before background replay");

        replay.sync(Arrays.asList(a), 6000, false);
        Map<String, Long> seenBeforeClear = replay.seenSnapshot();
        replay.clear();
        check(replay.latestSnapshot().isEmpty() && replay.replay(6001, true).post.isEmpty(), "Gateway exit or explicit clear removes cached metadata");
        check(replay.seenSnapshot().equals(seenBeforeClear), "Explicit clear does not reset replay protection");
        replay.sync(Arrays.asList(a), 6002, false);
        check(replay.replay(6003, true).post.isEmpty(), "Late old snapshot after clear remains deduplicated");

        RemotePolicy.Ledger expired = new RemotePolicy.Ledger();
        expired.sync(Arrays.asList(a), 1000, false);
        check(expired.replay(a.expiresAt, true).post.isEmpty() && expired.latestSnapshot().isEmpty(), "Request expiring while visible cannot alert on stop");
        RemotePolicy.Ledger resolved = new RemotePolicy.Ledger();
        resolved.sync(Arrays.asList(a), 1000, false);
        resolved.sync(Collections.<RemotePolicy.Entry>emptyList(), 1100, false);
        check(resolved.replay(1200, true).post.isEmpty(), "Unalerted request resolved before stop never alerts");

        RemotePolicy.Ledger blocked = new RemotePolicy.Ledger();
        blocked.sync(Arrays.asList(a), 1000, false);
        check(blocked.replay(1100, false).post.isEmpty() && blocked.seenSnapshot().isEmpty(), "Denied permission or disabled background cannot post or consume dedup");
        check(blocked.replay(1200, true).post.size() == 1, "Still-current unalerted metadata remains eligible after explicit allowed transition");
        RemotePolicy.Ledger restarted = new RemotePolicy.Ledger();
        restarted.restore(blocked.seenSnapshot(), blocked.revokedSnapshot(), 1300);
        check(restarted.latestSnapshot().isEmpty() && restarted.replay(1400, true).keep.isEmpty(), "Restart restores only replay protection, never old cached metadata");
        check(restarted.sync(Arrays.asList(a), 1500, true).post.isEmpty(), "Authenticated refresh after restart remains deduplicated");

        RemotePolicy.Ledger revoked = new RemotePolicy.Ledger();
        revoked.sync(Arrays.asList(a), 1000, false);
        revoked.revoke(b, 1100);
        check(revoked.latestSnapshot().isEmpty() && revoked.replay(1200, true).post.isEmpty(), "Revocation removes unalerted foreground metadata before replay");
        revoked.sync(Arrays.asList(a), 1300, false);
        check(revoked.latestSnapshot().isEmpty(), "Old revoked snapshot cannot refill native cache");
        RemotePolicy.Entry newer = entry("request", binding("tablet", "remote-a", 2), "run", "request", "event-new-grant");
        revoked.sync(Arrays.asList(newer), 1400, false);
        revoked.revoke(b, 1500);
        check(revoked.replay(1600, true).post.size() == 1, "Old-grant revoke cannot suppress explicit newer-grant metadata");
        check(!revoked.revokedSnapshot().isEmpty(), "Replay retains revocation tombstones");

        RemotePolicy.Ledger bounded = new RemotePolicy.Ledger();
        bounded.sync(Arrays.asList(a), 1000, false);
        rejects(() -> bounded.sync(Arrays.asList(a, a), 1100, false), "Duplicate replacement rejected before altering retained snapshot");
        check(bounded.latestSnapshot().size() == 1 && bounded.latestSnapshot().get(0) == a, "Rejected duplicate preserves last valid snapshot");
        java.util.List<RemotePolicy.Entry> tooMany = new java.util.ArrayList<>();
        for (int i = 0; i <= RemotePolicy.MAX_NOTIFICATIONS; i++) tooMany.add(entry("invite", b, null, null, "cached-" + i));
        rejects(() -> bounded.sync(tooMany, 1200, false), "Retained metadata cap also enforced with posting disabled");
        RemotePolicy.Entry tooLate = new RemotePolicy.Entry("invite", b, null, null, "ttl", RemotePolicy.MAX_TTL_MS + 1301);
        rejects(() -> bounded.sync(Arrays.asList(tooLate), 1300, false), "Retained metadata TTL validated with posting disabled");
        check(bounded.replay(1400, true).post.size() == 1, "Invalid replacement cannot replace valid replay candidate");
        bounded.clear(); bounded.revoke(b, 1500);
        check(bounded.replay(1600, true).post.isEmpty(), "Clear then revoke safely handles an empty retained snapshot");
    }
}
