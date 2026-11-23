package cc.codroid;
import java.util.ArrayDeque;
final class SplitPairingTest {
    static int checks;
    static void check(boolean value){if(!value)throw new AssertionError("check "+checks);checks++;}
    static final class Fake implements SplitPairing.Host {
        int sdk=32,opens,hints;
        boolean front=true,multi,visible=true,fail;
        ArrayDeque<Runnable> pending=new ArrayDeque<>();
        public int sdk(){return sdk;}
        public boolean foreground(){return front;}
        public boolean visibleInMultiWindow(){return multi&&visible;}
        public void openAdjacent()throws Exception {opens++;if(fail)throw new Exception("blocked");}
        public void later(Runnable task,int delay){check(delay==250);pending.add(task);}
        public void showManualHint(){hints++;}
        void tick(){pending.remove().run();}
        void finish(){while(!pending.isEmpty())tick();}
    }
    public static void main(String[] args){
        SplitPairing p=new SplitPairing();Fake h=new Fake();h.sdk=23;
        check(!SplitPairing.supported(23));check(SplitPairing.supported(24));
        check(!p.start(h).ok());check(h.opens==0&&h.pending.isEmpty());
        h.sdk=24;check(p.start(h).path.equals("adjacent"));h.multi=true;h.finish();
        check(p.snapshot().phase.equals("multiwindow"));check(h.opens==1&&h.hints==0);
        p=new SplitPairing();h=new Fake();h.sdk=31;p.start(h);h.finish();
        check(h.opens==1&&h.hints==1);check(p.snapshot().phase.equals("manual"));
        p=new SplitPairing();h=new Fake();check(p.start(h).path.equals("fullscreen"));
        check(p.start(h).phase.equals("opening"));check(h.opens==1);
        h.tick();h.multi=true;h.finish();check(p.snapshot().phase.equals("multiwindow"));
        check(h.hints==0);
        p=new SplitPairing();h=new Fake();h.multi=true;check(p.start(h).path.equals("adjacent"));h.finish();
        check(h.opens==1&&p.snapshot().phase.equals("multiwindow"));
        p=new SplitPairing();h=new Fake();h.front=false;check(p.start(h).phase.equals("foreground"));check(h.opens==0);
        p=new SplitPairing();h=new Fake();h.fail=true;p.start(h);check(p.snapshot().phase.equals("manual"));check(h.opens==1&&h.hints==1&&h.pending.isEmpty());
        p=new SplitPairing();h=new Fake();p.start(h);h.multi=true;h.visible=false;h.finish();
        check(p.snapshot().phase.equals("manual"));check(h.hints==1);
        p=new SplitPairing();h=new Fake();p.start(h);for(int i=0;i<9;i++)h.tick();
        check(p.snapshot().phase.equals("opening"));h.multi=true;h.tick();
        check(p.snapshot().phase.equals("multiwindow"));check(h.hints==0);
        p=new SplitPairing();h=new Fake();p.start(h);h.finish();check(p.snapshot().phase.equals("manual"));
        h.multi=true;p.start(h);h.finish();check(p.snapshot().phase.equals("multiwindow"));check(h.opens==2&&h.hints==1);
        p=new SplitPairing();h=new Fake();check(!p.multiWindowDetected());
        p.start(h);check(p.multiWindowDetected());h.finish();
        check(p.snapshot().phase.equals("multiwindow")&&h.hints==0);
        p=new SplitPairing();h=new Fake();p.start(h);h.finish();
        SplitPairing.Result timedOut=p.snapshot();check(timedOut.phase.equals("manual")&&h.hints==1);
        check(p.multiWindowDetected());check(p.snapshot()!=timedOut&&p.snapshot().phase.equals("multiwindow"));
        check(!p.multiWindowDetected());
        System.out.println("PASS SplitPairing "+checks+" checks: version routing, actual window, duplicate, denial, timeout, retry");
    }
}
