package cc.codroid;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.LocalSocket;
import android.os.ParcelFileDescriptor;
import java.io.FileDescriptor;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * USB 设备中转：让终端里的 adb / fastboot 用上 OTG 线连着的另一台设备。
 *
 * 普通进程打不开 /dev/bus/usb（属 root:usb 0660），安卓只认 UsbManager：
 * 申请授权（弹系统对话框）→ openDevice → 拿到 fd。所以由本进程开设备，
 * 再经 priv 套接字用 SCM_RIGHTS 把 fd 递给终端里的 usb-adb，
 * 它带着 TERMUX_USB_FD=<fd> 启动 adb 服务（Termux 版 adb 用 libusb_wrap_sys_device 接管这个 fd）。
 */
final class Usb {
    static final String ACTION = "cc.codroid.USB_PERMISSION";

    private static UsbManager mgr(Context c) { return (UsbManager) c.getSystemService(Context.USB_SERVICE); }

    /** 带 adb 接口（类 255 / 子类 66 / 协议 1）的就是开了 USB 调试的安卓设备 */
    private static boolean hasAdb(UsbDevice d) {
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_VENDOR_SPEC && f.getInterfaceSubclass() == 66 && f.getInterfaceProtocol() == 1) return true;
        }
        return false;
    }

    private static JSONObject describe(UsbManager m, UsbDevice d) throws Exception {
        String serial = null;
        try { if (m.hasPermission(d)) serial = d.getSerialNumber(); } catch (SecurityException ignored) {}
        return new JSONObject()
            .put("name", d.getDeviceName())
            .put("vendorId", d.getVendorId()).put("productId", d.getProductId())
            .put("manufacturer", d.getManufacturerName()).put("product", d.getProductName())
            .put("serial", serial)
            .put("adb", hasAdb(d))
            .put("permission", m.hasPermission(d));
    }

    static JSONObject list(Context c) throws Exception {
        UsbManager m = mgr(c);
        JSONArray a = new JSONArray();
        for (UsbDevice d : m.getDeviceList().values()) a.put(describe(m, d));
        return new JSONObject().put("ok", true).put("devices", a);
    }

    /** 选设备：给了 name（/dev/bus/usb/…）就按名字，否则取唯一一台带 adb 接口的 */
    private static UsbDevice pick(UsbManager m, String name) {
        UsbDevice only = null;
        int n = 0;
        for (UsbDevice d : m.getDeviceList().values()) {
            if (name != null && !name.isEmpty()) { if (d.getDeviceName().equals(name)) return d; continue; }
            if (hasAdb(d)) { only = d; n++; }
        }
        return n == 1 ? only : null;
    }

    private static boolean ask(Context c, UsbManager m, UsbDevice d, long timeoutSec) throws InterruptedException {
        if (m.hasPermission(d)) return true;
        CountDownLatch done = new CountDownLatch(1);
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context x, Intent i) {
                // 只认这台设备的结果（审查 #107 09-005）：同时在问两台时，A 的回复以前会让还在等确认的 B 提前收工、报「被拒绝」
                UsbDevice got = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (got == null || d.getDeviceName().equals(got.getDeviceName())) done.countDown();
            }
        };
        if (android.os.Build.VERSION.SDK_INT >= 33) c.registerReceiver(r, new IntentFilter(ACTION), 4 /* RECEIVER_NOT_EXPORTED */);
        else c.registerReceiver(r, new IntentFilter(ACTION));
        try {
            Intent i = new Intent(ACTION).setPackage(c.getPackageName());
            // 系统要往这个 Intent 里填 EXTRA_DEVICE / EXTRA_PERMISSION_GRANTED，所以必须可变
            int flags = android.os.Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0;
            // 每台设备一个请求码：同一个 PendingIntent 被两次请求共用时，系统填进去的结果会互相覆盖
            m.requestPermission(d, PendingIntent.getBroadcast(c, d.getDeviceId(), i, flags));
            done.await(timeoutSec, TimeUnit.SECONDS);
        } finally {
            c.unregisterReceiver(r);
        }
        // 只认系统记的授权，不信广播里带的结果：安卓 13 以下这个接收器是导出的，别的应用能伪造（审查 低11）
        return m.hasPermission(d);
    }

    /** op=usb_open：授权、打开，把 fd 随回复一起递过去（回复是一行 JSON，fd 走辅助数据） */
    static void open(Context c, JSONObject req, LocalSocket sock) throws Exception {
        UsbManager m = mgr(c);
        OutputStream out = sock.getOutputStream();
        UsbDevice d = pick(m, req.optString("name", null));
        if (d == null) { reply(out, new JSONObject().put("ok", false).put("message", Tr.t("没找到唯一一台开了 USB 调试的设备；用 usb-adb list 看看，再用 --name 指定"))); return; }
        if (!ask(c, m, d, req.optLong("timeout", 60))) { reply(out, new JSONObject().put("ok", false).put("message", Tr.t("USB 授权被拒绝或超时（请在弹出的系统对话框里点「确定」）"))); return; }
        UsbDeviceConnection conn = m.openDevice(d);
        if (conn == null) { reply(out, new JSONObject().put("ok", false).put("message", Tr.t("openDevice 失败（设备被别的应用占着？）"))); return; }
        try (ParcelFileDescriptor pfd = ParcelFileDescriptor.fromFd(conn.getFileDescriptor())) {
            sock.setFileDescriptorsForSend(new FileDescriptor[] { pfd.getFileDescriptor() });
            reply(out, describe(m, d).put("ok", true));
        } finally {
            // 对端已经拿到自己的那份 fd（内核里是同一个打开的文件），这边关掉不影响它
            conn.close();
        }
    }

    private static void reply(OutputStream out, JSONObject o) throws Exception {
        out.write((o.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
}
