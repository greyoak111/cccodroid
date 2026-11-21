package cc.codroid;

import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

/** Local Xiaomi Super Island renderer. Never supplies a default application or scenario identity. */
final class XiaomiWorkIsland {
    private static final String AVATAR = "miui.focus.pic_work_badge";
    private static final String STATUS = "miui.focus.pic_work_status";
    private static final String COLOR = "#4EAB96";
    private final Context ctx;
    private final String business;
    private final Bitmap[] statusIcons = new Bitmap[4];

    XiaomiWorkIsland(Context ctx) {
        this.ctx = ctx;
        business = readBusiness(ctx);
    }

    private static String readBusiness(Context ctx) {
        try {
            Bundle meta = ctx.getPackageManager().getApplicationInfo(ctx.getPackageName(),
                PackageManager.GET_META_DATA).metaData;
            if (meta == null || !meta.containsKey("com.xiaomi.xms.BUILD_TYPE_DEBUG")) return null;
            Object id = meta.get("com.xiaomi.xms.APP_ID");
            String business = meta.getString("cc.codroid.xiaomi.WORK_ISLAND_BUSINESS");
            return id != null && !id.toString().trim().isEmpty() && business != null
                && !business.trim().isEmpty() ? business.trim() : null;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return null;
        }
    }

    private boolean allowed() {
        if (business == null) return false;
        try {
            if (Settings.System.getInt(ctx.getContentResolver(), "notification_focus_protocol", 0) < 3
                || !Boolean.TRUE.equals(Class.forName("android.os.SystemProperties")
                    .getMethod("getBoolean", String.class, boolean.class)
                    .invoke(null, "persist.sys.feature.island", false))) return false;
            Bundle input = new Bundle();
            input.putString("package", ctx.getPackageName());
            Bundle result = ctx.getContentResolver().call(Uri.parse("content://miui.statusbar.notification.public"),
                "canShowFocus", null, input);
            return result != null && result.getBoolean("canShowFocus", false);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return false;
        }
    }

    Bundle extras(String state, String title, String text, String chip, String publicChip,
                  int done, int total, long remaining, boolean unlocked, Bitmap avatar) {
        if (!allowed()) return null;
        try {
            Icon appIcon = Icon.createWithResource(ctx, WorkIslandNotifications.icon(ctx));
            Bundle pics = new Bundle();
            pics.putParcelable(AVATAR, unlocked && avatar != null ? Icon.createWithBitmap(avatar) : appIcon);
            boolean progress = unlocked && total > 0 && done >= 0 && done <= total;
            pics.putParcelable(STATUS, unlocked ? Icon.createWithBitmap(statusIcon(state, progress)) : appIcon);
            Bundle extras = new Bundle();
            extras.putBundle("miui.focus.pics", pics);
            extras.putString("miui.focus.param", payload(business, title, text, chip, publicChip,
                done, total, remaining, unlocked).toString());
            return extras;
        } catch (JSONException | RuntimeException e) {
            return null;
        }
    }

    // Summary and expanded artwork have different keys and different picInfo types.
    static JSONObject payload(String business, String title, String text, String chip, String publicChip,
                              int done, int total, long remaining, boolean unlocked) throws JSONException {
        boolean progress = unlocked && total > 0 && done >= 0 && done <= total;
        JSONObject summary = picture(1, AVATAR);
        JSONObject left = new JSONObject().put("type", 1).put("picInfo", summary)
            .put("textInfo", new JSONObject().put("title", unlocked ? chip : publicChip));
        JSONObject island = new JSONObject().put("islandProperty", 1)
            .put("islandTimeout", Math.max(1, (remaining + 999) / 1000))
            .put("bigIslandArea", new JSONObject().put("imageTextInfoLeft", left))
            .put("smallIslandArea", new JSONObject().put("picInfo", summary));
        JSONObject params = new JSONObject().put("protocol", 1).put("business", business)
            .put("updatable", true).put("reopen", "reopen")
            .put("enableFloat", false).put("islandFirstFloat", false)
            .put("aodTitle", publicChip)
            .put("baseInfo", new JSONObject().put("type", progress ? 1 : 2)
                .put("title", unlocked ? title : Tr.t("工作岛")).put("content", unlocked ? text : publicChip))
            .put("picInfo", picture(2, STATUS)).put("param_island", island);
        if (progress) params.put("progressInfo", new JSONObject()
            .put("progress", (int) (100L * done / total)).put("colorProgress", COLOR).put("colorProgressEnd", COLOR));
        return new JSONObject().put("param_v2", params);
    }

    private static JSONObject picture(int type, String key) throws JSONException {
        return new JSONObject().put("type", type).put("pic", key);
    }

    private Bitmap statusIcon(String state, boolean progress) {
        int kind = "waiting".equals(state) ? 1 : "error".equals(state) ? 2 : progress ? 3 : 0;
        if (statusIcons[kind] != null) return statusIcons[kind];
        Bitmap image = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(image);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(new int[]{0xff224553, 0xff754719, 0xff782f44, 0xff20544e}[kind]);
        c.drawRoundRect(0, 0, 128, 128, 32, 32, p);
        p.setColor(0xfff5fffc);
        p.setStrokeWidth(7);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        if (kind == 3) {
            for (int y = 42; y <= 86; y += 22) {
                Path tick = new Path();
                tick.moveTo(30, y); tick.lineTo(36, y + 6); tick.lineTo(46, y - 5);
                p.setStyle(Paint.Style.STROKE);
                c.drawPath(tick, p);
                c.drawLine(60, y, 96, y, p);
            }
        } else if (kind == 1 || kind == 2) {
            c.drawLine(64, 33, 64, 68, p);
            c.drawCircle(64, 88, 5, p);
        } else {
            c.drawLine(32, 64, 47, 64, p);
            Path pulse = new Path();
            pulse.moveTo(47, 64); pulse.lineTo(55, 43); pulse.lineTo(68, 85);
            pulse.lineTo(79, 64); pulse.lineTo(96, 64);
            p.setStyle(Paint.Style.STROKE);
            c.drawPath(pulse, p);
        }
        statusIcons[kind] = image;
        return image;
    }
}
