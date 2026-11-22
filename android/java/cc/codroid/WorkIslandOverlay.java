package cc.codroid;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.hardware.input.InputManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

/**
 * 通用悬浮胶囊兜底（无系统灵动岛或 Android 12–15 设备可选开启）：
 *   - 触摸完全穿透（FLAG_NOT_TOUCHABLE + alpha 限制在系统最大遮挡透明度以内），不挡下方任何操作；
 *   - 应用在前台、锁屏或息屏时自动隐藏；
 *   - 底部按 TodoWrite 清单绘分段进度条，右侧显示实时计时。
 */
final class WorkIslandOverlay {
    private static final String TAG = "cccodroid";

    private final Context ctx;
    private final WindowManager wm;
    private final PowerManager power;
    private final KeyguardManager keyguard;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CapsuleView view;

    private WindowManager.LayoutParams params;
    private boolean attached;
    private boolean screenListening;
    private boolean hasContent;
    private boolean foreground;
    private float yRatio = 0.02f;
    private float opacity = 0.78f;

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!shouldShow() || view.done) return;
            view.invalidate();
            main.postDelayed(this, 1000L);
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            main.post(WorkIslandOverlay.this::syncVisibility);
        }
    };

    WorkIslandOverlay(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.wm = this.ctx.getSystemService(WindowManager.class);
        this.power = this.ctx.getSystemService(PowerManager.class);
        this.keyguard = this.ctx.getSystemService(KeyguardManager.class);
        this.view = new CapsuleView(this.ctx);
    }

    void setStyle(float yRatio, float opacity) {
        main.post(() -> {
            this.yRatio = Math.max(0f, Math.min(0.8f, yRatio));
            this.opacity = Math.max(0.4f, Math.min(0.8f, opacity));
            if (attached) applyLayout();
        });
    }

    void setForeground(boolean fg) {
        main.post(() -> {
            if (this.foreground == fg) return;
            this.foreground = fg;
            syncVisibility();
        });
    }

    void update(String title, String text, long since, boolean done, String state, int accent, int todoDone, int todoTotal) {
        main.post(() -> {
            if (!canDraw()) { detach(); return; }
            view.setContent(title, text, since, done, state, accent, todoDone, todoTotal);
            hasContent = true;
            if (!attached) attach();
            syncVisibility();
        });
    }

    void hide() {
        main.post(() -> {
            hasContent = false;
            main.removeCallbacks(ticker);
            detach();
        });
    }

    private boolean canDraw() {
        try { return Settings.canDrawOverlays(ctx); } catch (RuntimeException e) { return false; }
    }

    private boolean shouldShow() {
        if (!attached || !hasContent || foreground) return false;
        if (power != null && !power.isInteractive()) return false;
        if (keyguard != null && keyguard.isKeyguardLocked()) return false;
        return true;
    }

    private void syncVisibility() {
        main.removeCallbacks(ticker);
        if (shouldShow()) {
            if (view.getVisibility() != View.VISIBLE) {
                view.setAlpha(0f);
                view.setVisibility(View.VISIBLE);
                view.animate().alpha(1f).setDuration(180).start();
            }
            view.invalidate();
            if (!view.done) main.postDelayed(ticker, 1000L);
        } else if (attached && view.getVisibility() == View.VISIBLE) {
            view.animate().cancel();
            view.setVisibility(View.GONE);
        }
    }

    private float maxTouchThroughAlpha() {
        float max = 0.8f;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                InputManager im = ctx.getSystemService(InputManager.class);
                if (im != null) max = im.getMaximumObscuringOpacityForTouch();
            } catch (RuntimeException ignored) {}
        }
        return Math.min(0.8f, max);
    }

    private void attach() {
        if (attached || wm == null) return;
        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int width = Math.min(dp(248), Math.max(dp(160), dm.widthPixels - dp(32)));
        int height = dp(40);
        params = new WindowManager.LayoutParams(
            width, height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.setTitle("cccodroid-work-island");
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        computeLayout(params, dm);
        view.setVisibility(View.GONE);
        try {
            wm.addView(view, params);
            attached = true;
            if (!screenListening) {
                IntentFilter f = new IntentFilter();
                f.addAction(Intent.ACTION_SCREEN_ON);
                f.addAction(Intent.ACTION_SCREEN_OFF);
                f.addAction(Intent.ACTION_USER_PRESENT);
                if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED);
                else ctx.registerReceiver(screenReceiver, f);
                screenListening = true;
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "悬浮胶囊挂载失败", e);
            params = null;
        }
    }

    private void applyLayout() {
        if (!attached || params == null || wm == null) return;
        computeLayout(params, ctx.getResources().getDisplayMetrics());
        try { wm.updateViewLayout(view, params); } catch (RuntimeException ignored) {}
    }

    private void computeLayout(WindowManager.LayoutParams p, DisplayMetrics dm) {
        int topInset = statusBarHeight();
        int avail = Math.max(0, dm.heightPixels - topInset - p.height - dp(16));
        p.y = topInset + dp(4) + Math.round(avail * yRatio);
        p.alpha = Math.max(0.4f, Math.min(opacity, maxTouchThroughAlpha()));
    }

    private int statusBarHeight() {
        int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? ctx.getResources().getDimensionPixelSize(id) : dp(28);
    }

    private void detach() {
        if (screenListening) {
            try { ctx.unregisterReceiver(screenReceiver); } catch (RuntimeException ignored) {}
            screenListening = false;
        }
        if (attached && wm != null) {
            try { wm.removeViewImmediate(view); } catch (RuntimeException ignored) {}
            attached = false;
            params = null;
        }
    }

    private int dp(float v) {
        return Math.round(v * ctx.getResources().getDisplayMetrics().density);
    }

    private static final class CapsuleView extends View {
        private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint seg = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint titleP = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint textP = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint timeP = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final RectF pill = new RectF();
        private final RectF bar = new RectF();

        String title = "";
        String text = "";
        long since;
        boolean done;
        int accent = WorkIsland.COLOR_WORKING;
        int todoDone;
        int todoTotal;

        CapsuleView(Context c) {
            super(c);
            setClickable(false);
            setFocusable(false);
            bg.setColor(0xEB18181A);
            border.setStyle(Paint.Style.STROKE);
            border.setStrokeWidth(dp(1f));
            border.setColor(0x33FFFFFF);
            titleP.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            titleP.setColor(0xFFFAF9F5);
            titleP.setTextSize(sp(11f));
            textP.setColor(0xB8FAF9F5);
            textP.setTextSize(sp(9.5f));
            timeP.setColor(0x99FAF9F5);
            timeP.setTextSize(sp(9.5f));
            timeP.setTextAlign(Paint.Align.RIGHT);
        }

        void setContent(String title, String text, long since, boolean done, String state, int accent, int todoDone, int todoTotal) {
            this.title = title == null ? "" : title;
            this.text = text == null ? "" : text;
            this.since = since;
            this.done = done;
            this.accent = accent;
            this.todoDone = todoDone;
            this.todoTotal = todoTotal;
            invalidate();
        }

        @Override protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            float pad = dp(1f), r = (h - pad * 2) / 2f;
            pill.set(pad, pad, w - pad, h - pad);
            c.drawRoundRect(pill, r, r, bg);
            c.drawRoundRect(pill, r, r, border);

            float dotR = dp(4f);
            float dotX = dp(14f);
            float cy = h / 2f - (todoTotal > 0 ? dp(1.5f) : 0f);
            dot.setColor(accent);
            c.drawCircle(dotX, cy, dotR, dot);

            String elapsed = formatElapsed();
            float rightX = w - dp(12f);
            float timeW = elapsed.isEmpty() ? 0f : timeP.measureText(elapsed) + dp(8f);
            float textLeft = dotX + dotR + dp(8f);
            float textMax = Math.max(dp(40f), rightX - timeW - textLeft);

            CharSequence t1 = TextUtils.ellipsize(title, titleP, textMax, TextUtils.TruncateAt.END);
            boolean twoLines = !text.isEmpty() && !text.equals(title);
            if (twoLines) {
                CharSequence t2 = TextUtils.ellipsize(text, textP, textMax, TextUtils.TruncateAt.END);
                c.drawText(t1, 0, t1.length(), textLeft, cy - dp(1.5f), titleP);
                c.drawText(t2, 0, t2.length(), textLeft, cy + dp(10.5f), textP);
            } else {
                Paint.FontMetrics fm = titleP.getFontMetrics();
                c.drawText(t1, 0, t1.length(), textLeft, cy - (fm.ascent + fm.descent) / 2f, titleP);
            }
            if (!elapsed.isEmpty()) {
                Paint.FontMetrics fm = timeP.getFontMetrics();
                c.drawText(elapsed, rightX, cy - (fm.ascent + fm.descent) / 2f, timeP);
            }

            if (todoTotal > 0) {
                int segs = Math.min(8, todoTotal);
                int filled = todoTotal <= 8 ? todoDone : Math.round((float) todoDone * segs / todoTotal);
                float bx0 = dp(16f), bx1 = w - dp(16f);
                float gap = dp(3f), bw = (bx1 - bx0 - gap * (segs - 1)) / segs;
                float by1 = h - dp(4f), by0 = by1 - dp(2.2f);
                for (int i = 0; i < segs; i++) {
                    seg.setColor(i < filled ? accent : 0x33FFFFFF);
                    float sx = bx0 + i * (bw + gap);
                    bar.set(sx, by0, sx + bw, by1);
                    c.drawRoundRect(bar, dp(1f), dp(1f), seg);
                }
            }
        }

        private String formatElapsed() {
            if (done || since <= 0) return "";
            long sec = Math.max(0, (System.currentTimeMillis() - since) / 1000L);
            return (sec / 60) + ":" + ((sec % 60) < 10 ? "0" : "") + (sec % 60);
        }

        private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
        private float sp(float v) { return v * getResources().getDisplayMetrics().scaledDensity; }
    }
}
