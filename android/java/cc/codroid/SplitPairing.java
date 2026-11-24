package cc.codroid;

/** User-requested adjacent Settings launch. One public Intent API has different version semantics. */
final class SplitPairing {
    static final int MIN_SDK = 24;
    static final int FULLSCREEN_SDK = 32;
    static final int CHECK_MS = 250;
    static final int CHECKS = 10;
    interface Host {
        int sdk();
        boolean foreground();
        boolean visibleInMultiWindow();
        void openAdjacent() throws Exception;
        void later(Runnable work, int delayMs);
        void showManualHint();
    }
    static final class Result {
        final String phase, path;
        Result(String phase, String path) { this.phase=phase; this.path=path; }
        boolean ok() { return !"unsupported".equals(phase)&&!"foreground".equals(phase); }
        String message() {
            switch (phase) {
                case "opening": return "正在分屏打开设置…";
                case "multiwindow": return "已进入分屏：请在另一侧打开「无线调试 → 使用配对码配对」，再回此处填写配对码与端口。";
                case "manual": return "未进入分屏：请在最近任务中将本应用与系统设置并排分屏，再打开配对码弹窗。";
                case "foreground": return "请先回到 cccodroid 前台，再尝试分屏打开设置。";
                case "unsupported": return "此 Android 版本不支持分屏。";
                default: return "";
            }
        }
    }
    private volatile Result result = new Result("idle", "");
    private long generation;
    static boolean supported(int sdk) { return sdk>=MIN_SDK; }
    Result snapshot() { return result; }
    void reset() {
        generation++;
        result = new Result("idle", "");
    }
    // A late framework confirmation supersedes the timeout observation and any queued notice.
    boolean multiWindowDetected() {
        if (!"opening".equals(result.phase) && !"manual".equals(result.phase)) return false;
        generation++;
        result = new Result("multiwindow", result.path);
        return true;
    }
    // Called on the UI thread. Querying this result never launches an Activity.
    Result start(Host host) {
        if(!supported(host.sdk()))return new Result("unsupported","");
        if(!host.foreground())return new Result("foreground","");
        if("opening".equals(result.phase))return result;
        String path=host.sdk()>=FULLSCREEN_SDK&&!host.visibleInMultiWindow()?"fullscreen":"adjacent";
        long request=++generation;
        result=new Result("opening",path);
        try { host.openAdjacent(); }
        catch(Exception e) { return manual(host,path); }
        host.later(()->check(host,request,path,CHECKS),CHECK_MS);
        return result;
    }
    private void check(Host host,long request,String path,int remaining) {
        if(request!=generation)return;
        if(host.visibleInMultiWindow()) { result=new Result("multiwindow",path);return; }
        if(remaining<=1) { manual(host,path);return; }
        host.later(()->check(host,request,path,remaining-1),CHECK_MS);
    }
    private Result manual(Host host,String path) {
        result=new Result("manual",path);
        host.showManualHint();
        return result;
    }
}
