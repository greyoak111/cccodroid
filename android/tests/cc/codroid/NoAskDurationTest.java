package cc.codroid;

import java.util.Arrays;

public final class NoAskDurationTest {
    private static void check(boolean ok) {
        if (!ok) throw new AssertionError();
    }

    public static void main(String[] args) {
        check(Arrays.equals(NoAskDuration.options(), new int[]{60, 240, 1440, 4320, 10080}));
        check(!NoAskDuration.supports(2));
        check(!NoAskDuration.supports(10081));
        long now = 1_780_000_000_000L;
        String selected = NoAskDuration.value(4320, now);
        check(NoAskDuration.until(selected) == now + 4320L * 60000);
        check(NoAskDuration.minutes(selected) == 4320);
        check(NoAskDuration.until(String.valueOf(now)) == now);
        check(NoAskDuration.minutes(String.valueOf(now)) == 0);
        check(NoAskDuration.until("invalid:60") == 0);
        check(NoAskDuration.minutes(now + ":2") == 0);
        System.out.println("NoAskDurationTest passed");
    }
}
