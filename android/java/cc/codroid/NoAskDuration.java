package cc.codroid;

import java.util.Arrays;

/** Fixed durations shared by the settings page and the renewal dialog. */
final class NoAskDuration {
    private static final boolean INCLUDE_TEST_DURATION = false;
    static final int DEFAULT = 24 * 60;
    private static final int[] DURATIONS = { 60, 240, 1440, 4320, 10080 };

    static int[] options() {
        if (!INCLUDE_TEST_DURATION) return DURATIONS.clone();
        int[] result = Arrays.copyOf(DURATIONS, DURATIONS.length + 1);
        result[DURATIONS.length] = 2;
        return result;
    }

    static boolean supports(int minutes) {
        if (INCLUDE_TEST_DURATION && minutes == 2) return true;
        for (int option : DURATIONS) if (option == minutes) return true;
        return false;
    }

    static String value(int minutes, long now) { return (now + minutes * 60000L) + ":" + minutes; }

    static long until(String value) {
        if (value == null) return 0;
        int split = value.indexOf(':');
        try { return Long.parseLong(split < 0 ? value : value.substring(0, split)); }
        catch (NumberFormatException e) { return 0; }
    }

    static int minutes(String value) {
        int split = value == null ? -1 : value.indexOf(':');
        if (split < 0) return 0;   // Legacy signed values contain only the deadline.
        try {
            int minutes = Integer.parseInt(value.substring(split + 1));
            return supports(minutes) ? minutes : 0;
        } catch (NumberFormatException e) { return 0; }
    }
}
