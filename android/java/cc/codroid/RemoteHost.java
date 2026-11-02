package cc.codroid;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.PowerManager;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import org.json.JSONObject;

/**
 * GatewayService-owned private host. No JavascriptInterface and no public HTTP listener.
 * The actual relay/WSS connection is owned by the Node gateway, never by a WebView.
 */
public final class RemoteHost {
    public static final String BOOTSTRAP_ENV = "CCAPP_REMOTE_HOST_BOOTSTRAP";
    private static final int MAX_LINE = 64 * 1024;
    private static final int FRAME_TIMEOUT_MS = 2000, STOP_JOIN_MS = 500;
    private static volatile RemoteHost instance;
    public static RemoteHost get(Context c) {
        if (instance == null) synchronized (RemoteHost.class) {
            if (instance == null) instance = new RemoteHost(c.getApplicationContext());
        }
        return instance;
    }
    private final Context ctx;
    private final SharedPreferences prefs;
    private final RemoteNotifications notifications;
    private final RemoteKeyStore vault = new RemoteKeyStore();
    private final RemotePolicy.Visibility visibility = new RemotePolicy.Visibility();
    private volatile boolean running, foreground;
    private volatile java.lang.Process gateway;
    private volatile int gatewayPid;
    private volatile String capability;
    private volatile String hostError;
    private volatile String connectionState = "offline";
    private volatile long lastEventAt;
    private LocalSocket boundSocket, acceptedSocket;
    private volatile LocalServerSocket server;
    private volatile long serverEpoch;
    private Thread acceptThread, monitorThread;

    private RemoteHost(Context c) {
        ctx = c;
        prefs = c.getSharedPreferences("remote-host-v1", Context.MODE_PRIVATE);
        notifications = new RemoteNotifications(c);
        // Only onStarted/onStopped own remote visibility; MainActivity.visible retains its resume semantics.
    }
    public synchronized void start() {
        if (running) return;
        running = true;
        hostError = null;
        try {
            File socketFile = socketFile();
            if (socketFile.exists() && !socketFile.delete()) throw new IOException("SOCKET_UNAVAILABLE");
            boundSocket = new LocalSocket();
            boundSocket.bind(new LocalSocketAddress(socketFile.getPath(), LocalSocketAddress.Namespace.FILESYSTEM));
            server = new LocalServerSocket(boundSocket.getFileDescriptor());
            android.system.Os.chmod(socketFile.getPath(), 0600);
            final LocalServerSocket ownedServer = server;
            final long epoch = ++serverEpoch;
            acceptThread = new Thread(() -> serve(ownedServer, epoch), "remote-host");
            acceptThread.setDaemon(true); acceptThread.start();
            monitorThread = new Thread(() -> {
                while (currentServer(ownedServer, epoch)) {
                    synchronized (RemoteHost.this) {
                        if (!currentServer(ownedServer, epoch)) break;
                        notifications.connection(backgroundEffective());
                    }
                    try { Thread.sleep(2000); } catch (InterruptedException ignored) { break; }
                }
            }, "remote-host-policy");
            monitorThread.setDaemon(true); monitorThread.start();
        } catch (Exception ignored) {
            hostError = "HOST_SOCKET_UNAVAILABLE";
            stopLocked();
        }
    }
    public void stop() {
        final Thread[] retired;
        synchronized (this) { retired = stopLocked(); }
        // Never join while holding the lock needed by serve/monitor cleanup.
        final long deadline = android.os.SystemClock.elapsedRealtime() + STOP_JOIN_MS;
        for (Thread thread : retired) {
            if (thread == null || thread == Thread.currentThread()) continue;
            long remaining = deadline - android.os.SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            try { thread.join(remaining); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); break; }
        }
    }
    /** Called only with this lock held. Epoch invalidation precedes socket closure. */
    private Thread[] stopLocked() {
        running = false; serverEpoch++;
        gateway = null; gatewayPid = 0; capability = null;
        connectionState = "offline";
        try { if (acceptedSocket != null) acceptedSocket.close(); } catch (IOException ignored) {}
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        try { if (boundSocket != null) boundSocket.close(); } catch (IOException ignored) {}
        final Thread[] retired = { acceptThread, monitorThread };
        for (Thread thread : retired) if (thread != null) thread.interrupt();
        server = null; boundSocket = null; acceptedSocket = null;
        acceptThread = null; monitorThread = null;
        notifications.connection(false);
        try { notifications.clear(); } catch (Exception ignored) {}
        socketFile().delete();
        return retired;
    }
    private boolean currentServer(LocalServerSocket ownedServer, long epoch) {
        return running && server == ownedServer && serverEpoch == epoch;
    }
    private File socketFile() { return new File(ctx.getFilesDir(), ".remote-host-v1.sock"); }

    /** Only called immediately before GatewayService spawns Node. Not a secret. */
    public void applyGatewayEnvironment(Map<String, String> env) {
        env.remove(BOOTSTRAP_ENV);
        if (running) env.put(BOOTSTRAP_ENV, "stdin-v1");
    }
    /** The one-line capability travels in this child's stdin pipe, not env/files/logs. */
    public synchronized void bindGateway(java.lang.Process process) {
        gateway = null; gatewayPid = 0; capability = null;
        connectionState = "offline";
        try { notifications.clear(); } catch (Exception ignored) {}
        if (!running || process == null || !process.isAlive()) { hostError = "HOST_GATEWAY_UNAVAILABLE"; return; }
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
        StringBuilder token = new StringBuilder();
        for (byte b : random) token.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        try {
            capability = token.toString(); gateway = process;
            JSONObject bootstrap = new JSONObject().put("v", 1).put("type", "cc.remote.host.bootstrap")
                .put("socketPath", socketFile().getPath()).put("capability", capability);
            OutputStream out = process.getOutputStream();
            out.write((bootstrap.toString() + "\n").getBytes(StandardCharsets.UTF_8)); out.flush();
            hostError = null;
        } catch (Exception ignored) {
            gateway = null; capability = null; hostError = "HOST_BOOTSTRAP_UNAVAILABLE";
        }
    }
    public synchronized void gatewayExited(java.lang.Process process) {
        // An old Service supervisor may resume after a replacement has bound Node.
        if (process == null || gateway != process) return;
        gateway = null; gatewayPid = 0; capability = null; connectionState = "offline";
        notifications.connection(false);
        try { notifications.clear(); } catch (Exception ignored) {}
    }
    /** A proved HTTP gateway cannot be adopted into the one-shot stdin capability. */
    public synchronized void gatewayAdopted() {
        if (!running || gateway != null && gateway.isAlive()) return;
        if (gateway == null && capability == null && "HOST_GATEWAY_UNAVAILABLE".equals(hostError)) return;
        gateway = null; gatewayPid = 0; capability = null; connectionState = "offline";
        hostError = "HOST_GATEWAY_UNAVAILABLE";
        notifications.connection(false);
        try { notifications.clear(); } catch (Exception ignored) {}
    }
    /** A paused split-screen Activity is still visible. Track STARTED owners separately from focus/resume. */
    public synchronized void onStarted(Object owner) {
        if (visibility.started(owner)) onVisibilityChanged(true);
    }
    public synchronized void onStopped(Object owner) {
        if (visibility.stopped(owner)) onVisibilityChanged(false);
    }
    private void onVisibilityChanged(boolean visible) {
        foreground = visible;
        // Hide UI-visible notes, but retain the latest unalerted metadata and all dedup/revocation keys.
        // Both this transition and socket dispatch hold the host lock, so a newer empty snapshot wins.
        try { if (visible) notifications.hide(); else notifications.replay(backgroundEffective()); }
        catch (Exception ignored) {}
        notifications.connection(backgroundEffective());
    }
    private boolean backgroundRequested() { return prefs.getBoolean("backgroundEnabled", false); }
    private boolean backgroundEffective() {
        java.lang.Process p = gateway;
        return running && p != null && p.isAlive() && backgroundRequested()
            && notifications.systemAllowed() && notifications.channelAllowed(RemoteNotifications.CH_CONNECTION);
    }
    public synchronized JSONObject status() throws Exception {
        boolean effective = backgroundEffective();
        java.lang.Process p = gateway;
        boolean gatewayAlive = p != null && p.isAlive();
        PowerManager pm = ctx.getSystemService(PowerManager.class);
        SharedPreferences bg = ctx.getSharedPreferences("bg", Context.MODE_PRIVATE);
        return notifications.status().put("v", 1).put("hostAvailable", running && gatewayAlive)
            .put("serviceRunning", running).put("foreground", foreground).put("backgroundEnabled", backgroundRequested())
            .put("backgroundEffective", effective)
            .put("shouldConnect", RemotePolicy.shouldConnect(running && gatewayAlive, foreground, backgroundRequested(), notifications.systemAllowed(),
                notifications.channelAllowed(RemoteNotifications.CH_CONNECTION)))
            .put("deliveryMode", effective ? "gateway-background" : "foreground-only")
            .put("connectionState", connectionState).put("lastEventAt", lastEventAt)
            .put("batteryOptimizationExempt", pm.isIgnoringBatteryOptimizations(ctx.getPackageName()))
            .put("frozenAt", bg.getLong("frozenAt", 0)).put("frozenMs", bg.getLong("frozenMs", 0))
            .put("error", hostError == null ? JSONObject.NULL : hostError)
            .put("realDeviceBackgroundVerified", false).put("keystoreMasterExportable", false)
            .put("softwareKeyInTrustedNode", true);
    }

    private void serve(final LocalServerSocket ownedServer, final long epoch) {
        while (currentServer(ownedServer, epoch)) {
            LocalSocket socket = null;
            try {
                if (ownedServer == null) break;
                socket = ownedServer.accept();
                final long deadline = android.os.SystemClock.elapsedRealtime() + FRAME_TIMEOUT_MS;
                final java.lang.Process ownedGateway;
                synchronized (this) {
                    if (!currentServer(ownedServer, epoch)) continue;
                    acceptedSocket = socket;
                    ownedGateway = gateway;
                }
                int peerUid = socket.getPeerCredentials().getUid(), peerPid = socket.getPeerCredentials().getPid();
                if (peerUid != android.os.Process.myUid() || !directGatewayChild(peerPid)) continue;
                // One serialized request, with an absolute monotonic frame deadline.
                String line = readLine(socket, deadline);
                JSONObject request = new JSONObject(line);
                RemoteWire.exact(request, "v", "id", "capability", "op", "args");
                String requestId = RemotePolicy.id(RemoteWire.string(request, "id"));
                RemoteWire.integer(request, "v", 1, 1);
                String supplied = RemoteWire.string(request, "capability");
                JSONObject result;
                synchronized (this) {
                    if (!currentServer(ownedServer, epoch) || gateway != ownedGateway || !authorized(peerPid, supplied)) continue;
                    try {
                        result = new JSONObject().put("v", 1).put("id", requestId).put("ok", true)
                            .put("result", dispatch(RemoteWire.string(request, "op"), request.optJSONObject("args")));
                    } catch (Exception error) {
                        // Do not include exception text or a stack trace: it may contain key material.
                        String code = error instanceof IllegalArgumentException ? "INVALID_HOST_REQUEST"
                            : error instanceof java.security.GeneralSecurityException ? "VAULT_UNAVAILABLE" : "HOST_OPERATION_FAILED";
                        result = new JSONObject().put("v", 1).put("id", requestId).put("ok", false).put("error", code);
                    }
                }
                byte[] response = (result.toString() + "\n").getBytes(StandardCharsets.UTF_8);
                if (response.length > MAX_LINE) throw new IOException("HOST_RESPONSE_LIMIT");
                socket.getOutputStream().write(response); socket.getOutputStream().flush();
            } catch (Exception ignored) {
                // Malformed/private input is intentionally not logged.
            } finally {
                try { if (socket != null) socket.close(); } catch (IOException ignored) {}
                synchronized (this) { if (acceptedSocket == socket) acceptedSocket = null; }
            }
        }
    }
    private boolean authorized(int pid, String supplied) {
        java.lang.Process p = gateway;
        String secret = capability;
        if (!running || p == null || !p.isAlive() || secret == null || supplied.length() != 64
                || !MessageDigest.isEqual(supplied.getBytes(StandardCharsets.US_ASCII), secret.getBytes(StandardCharsets.US_ASCII))
                || !directGatewayChild(pid)) return false;
        if (gatewayPid != 0 && gatewayPid != pid) return false;
        gatewayPid = pid;
        return true;
    }
    private boolean directGatewayChild(int pid) {
        java.lang.Process p = gateway;
        if (!running || p == null || !p.isAlive() || pid <= 0 || gatewayPid != 0 && gatewayPid != pid) return false;
        try {
            String stat = new String(java.nio.file.Files.readAllBytes(new File("/proc/" + pid + "/stat").toPath()), StandardCharsets.US_ASCII);
            int end = stat.lastIndexOf(')');
            String[] fields = stat.substring(end + 2).split(" ");
            return fields.length >= 2 && Integer.parseInt(fields[1]) == android.os.Process.myPid();
        } catch (Exception ignored) { return false; }
    }
    private JSONObject dispatch(String op, JSONObject args) throws Exception {
        if ("status".equals(op)) { RemoteWire.exact(args); return status(); }
        if ("background.set".equals(op)) {
            RemoteWire.exact(args, "enabled", "userInitiated");
            if (!RemoteWire.bool(args, "userInitiated")) throw new IllegalArgumentException("USER_ACTION_REQUIRED");
            boolean enabled = RemoteWire.bool(args, "enabled");
            if (!prefs.edit().putBoolean("backgroundEnabled", enabled).commit()) throw new IOException("POLICY_STORAGE_UNAVAILABLE");
            notifications.connection(backgroundEffective());
            if (!enabled) notifications.clear();
            return status();
        }
        if ("connection.state".equals(op)) {
            RemoteWire.exact(args, "state", "lastEventAt");
            String state = RemoteWire.string(args, "state");
            if (!java.util.Arrays.asList("offline", "connecting", "online", "resyncing", "error").contains(state)) throw new IllegalArgumentException("INVALID_CONNECTION_STATE");
            connectionState = state; lastEventAt = RemoteWire.integer(args, "lastEventAt", 0, System.currentTimeMillis() + 5000);
            return new JSONObject().put("ok", true);
        }
        if ("notifications.sync".equals(op)) {
            notifications.sync(RemoteWire.entries(args), !foreground && backgroundEffective());
            return new JSONObject().put("ok", true);
        }
        if ("notifications.revoke".equals(op)) {
            notifications.revoke(RemoteWire.binding(args)); return new JSONObject().put("ok", true);
        }
        if ("notifications.clear".equals(op)) { RemoteWire.exact(args); notifications.clear(); return new JSONObject().put("ok", true); }
        if ("vault.seal".equals(op)) {
            RemoteWire.exact(args, "purpose", "recordId", "plaintext");
            return vault.seal(RemoteWire.string(args, "purpose"), RemoteWire.string(args, "recordId"), RemoteWire.string(args, "plaintext"));
        }
        if ("vault.open".equals(op)) {
            RemoteWire.exact(args, "purpose", "recordId", "envelope");
            return new JSONObject().put("plaintext", vault.open(RemoteWire.string(args, "purpose"), RemoteWire.string(args, "recordId"), args.optJSONObject("envelope")));
        }
        throw new IllegalArgumentException("UNKNOWN_HOST_OPERATION");
    }
    private static String readLine(LocalSocket socket, long deadline) throws IOException {
        InputStream in = socket.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            long remaining = deadline - android.os.SystemClock.elapsedRealtime();
            if (remaining <= 0) throw new java.net.SocketTimeoutException("HOST_REQUEST_TIMEOUT");
            socket.setSoTimeout((int) Math.min(FRAME_TIMEOUT_MS, remaining));
            int b = in.read();
            if (android.os.SystemClock.elapsedRealtime() >= deadline) throw new java.net.SocketTimeoutException("HOST_REQUEST_TIMEOUT");
            if (b == -1) throw new IOException("HOST_REQUEST_INCOMPLETE");
            if (b == '\n') return new String(out.toByteArray(), StandardCharsets.UTF_8);
            if (out.size() >= MAX_LINE) throw new IOException("HOST_REQUEST_LIMIT");
            out.write(b);
        }
    }
}
