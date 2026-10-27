package cc.codroid;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 把应用私有目录借给别的文件管理器：MT 管理器、系统「文件」这些应用经系统文件访问框架
 * （SAF）主动选一次「cccodroid」，就能浏览、复制、改名、删除 workspace/ 里的东西。
 *
 * 为什么不直接 chmod：安卓上应用私有目录是 0700 加上 SELinux 的 untrusted_app 上下文，
 * 别的应用就算拿到路径也读不了，改权限没用。非 root 的唯一正路就是 DocumentsProvider。
 *
 * 作用域只有 home/workspace（用户的项目和产出）：home/ 底下还有网关令牌、厂密钥、
 * Claude 凭据和 .ssh，授权一次目录就等于把这些交给那个文件管理器，不能整体开放。
 * 也别给这个 provider 加导出之外的口子 —— 授权只经系统选择器一次性给出。
 */
public final class Docs extends DocumentsProvider {
    static final String AUTH = "cc.codroid.docs";
    private static final String ROOT_ID = "workspace";

    private File home;

    @Override
    public boolean onCreate() {
        Tr.init(getContext());
        home = new File(new File(getContext().getFilesDir().getParentFile(), "home"), "workspace");
        return home.isDirectory();
    }

    // ── 文档 ID 就是相对 workspace/ 的路径；空串是根 ──

    private File fileOf(String docId) throws FileNotFoundException {
        if (docId == null || docId.isEmpty() || ROOT_ID.equals(docId)) return home;
        String rel = docId.startsWith(ROOT_ID + "/") ? docId.substring(ROOT_ID.length() + 1) : docId;
        return checked(new File(home, rel));
    }

    /** 拼出来的路径一律过一遍 canonical 检查：父目录可能是软链接，指到作用域外就不认。 */
    private File checked(File f) throws FileNotFoundException {
        try {
            String base = home.getCanonicalPath();
            String path = f.getCanonicalPath();
            if (!path.equals(base) && !path.startsWith(base + File.separator)) {
                throw new FileNotFoundException("越界：" + f.getName());
            }
            return f;
        } catch (java.io.IOException e) {
            throw new FileNotFoundException(f.getName());
        }
    }

    /** 名字是文件管理器直接给的：带 /、\0，或者等于 . / .. 的一律拒绝，
     *  否则 ../ 能写到作用域外面去（改网关代码、覆盖令牌）。 */
    private static String safeName(String displayName) throws FileNotFoundException {
        if (displayName == null || displayName.isEmpty()
            || displayName.equals(".") || displayName.equals("..")
            || displayName.indexOf('/') >= 0 || displayName.indexOf('\0') >= 0
            || displayName.indexOf(File.separatorChar) >= 0) {
            throw new FileNotFoundException("文件名不合法");
        }
        return displayName;
    }

    /** 软链接不跟进去：workspace 里自己建的链接可能指到作用域外，删除不能顺着删出去。 */
    private static boolean isSymlink(File f) {
        try { return java.nio.file.Files.isSymbolicLink(f.toPath()); }
        catch (Exception e) { return false; }
    }

    private String idOf(File f) throws FileNotFoundException {
        try {
            String base = home.getCanonicalPath();
            String path = f.getCanonicalPath();
            return path.equals(base) ? ROOT_ID : ROOT_ID + "/" + path.substring(base.length() + 1);
        } catch (java.io.IOException e) {
            throw new FileNotFoundException(f.getName());
        }
    }

    private static String mimeOf(File f) {
        if (f.isDirectory()) return Document.MIME_TYPE_DIR;
        String name = f.getName();
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null) return m;
            switch (ext) {
                case "md": case "markdown": return "text/markdown";
                case "yml": case "yaml": return "text/yaml";
                case "toml": return "text/plain";
                case "mjs": return "text/javascript";
                case "jsonl": return "application/json";
            }
        }
        return "application/octet-stream";
    }

    private void row(MatrixCursor.RowBuilder r, File f) throws FileNotFoundException {
        r.add(Document.COLUMN_DOCUMENT_ID, idOf(f));
        r.add(Document.COLUMN_DISPLAY_NAME, f.getName().isEmpty() ? ROOT_ID : f.getName());
        r.add(Document.COLUMN_MIME_TYPE, mimeOf(f));
        r.add(Document.COLUMN_SIZE, f.isDirectory() ? 0 : f.length());
        r.add(Document.COLUMN_LAST_MODIFIED, f.lastModified());
        int flags = Document.FLAG_SUPPORTS_RENAME | Document.FLAG_SUPPORTS_DELETE;
        flags |= f.isDirectory() ? Document.FLAG_DIR_SUPPORTS_CREATE : Document.FLAG_SUPPORTS_WRITE;
        r.add(Document.COLUMN_FLAGS, flags);
    }

    @Override
    public Cursor queryRoots(String[] projection) throws FileNotFoundException {
        String[] cols = projection != null ? projection : new String[] {
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY,
            Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_AVAILABLE_BYTES };
        MatrixCursor c = new MatrixCursor(cols, 1);
        MatrixCursor.RowBuilder r = c.newRow();
        r.add(Root.COLUMN_ROOT_ID, ROOT_ID);
        r.add(Root.COLUMN_DOCUMENT_ID, ROOT_ID);
        r.add(Root.COLUMN_TITLE, Tr.f("内部文件"));
        r.add(Root.COLUMN_SUMMARY, "workspace/ · " + Tr.f("读写"));
        r.add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY | Root.FLAG_SUPPORTS_CREATE
            | Root.FLAG_SUPPORTS_SEARCH | Root.FLAG_SUPPORTS_IS_CHILD);
        r.add(Root.COLUMN_ICON, getContext().getApplicationInfo().icon);
        r.add(Root.COLUMN_AVAILABLE_BYTES, home.getUsableSpace());
        return c;
    }

    @Override
    public Cursor queryDocument(String docId, String[] projection) throws FileNotFoundException {
        File f = fileOf(docId);
        if (!f.exists()) throw new FileNotFoundException(docId);
        String[] cols = projection != null ? projection : new String[] {
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
        MatrixCursor c = new MatrixCursor(cols, 1);
        row(c.newRow(), f);
        return c;
    }

    @Override
    public Cursor queryChildDocuments(String parentId, String[] projection, String sortOrder) throws FileNotFoundException {
        File dir = fileOf(parentId);
        String[] cols = projection != null ? projection : new String[] {
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
        MatrixCursor c = new MatrixCursor(cols, 64);
        File[] list = dir.listFiles();
        if (list == null) return c;
        // 目录在前、同类按名字；文件管理器的排序还能再覆盖
        Arrays.sort(list, (a, b) -> a.isDirectory() != b.isDirectory()
            ? (a.isDirectory() ? -1 : 1)
            : a.getName().compareToIgnoreCase(b.getName()));
        for (File f : list) {
            try { row(c.newRow(), f); } catch (FileNotFoundException ignored) {}
        }
        return c;
    }

    @Override
    public Cursor querySearchDocuments(String rootId, String query, String[] projection) throws FileNotFoundException {
        String[] cols = projection != null ? projection : new String[] {
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
        MatrixCursor c = new MatrixCursor(cols, 16);
        String q = query == null ? "" : query.toLowerCase(Locale.ROOT);
        List<File> queue = new ArrayList<>();
        queue.add(home);
        int found = 0, visited = 0;
        // 家目录里有 node_modules、工具包这类深树：只翻四层、最多两千个目录，够用也不至于卡死
        for (int i = 0; i < queue.size() && found < 100 && visited < 2000; i++) {
            File f = queue.get(i);
            File[] list = f.listFiles();
            if (list == null) continue;
            visited++;
            for (File k : list) {
                if (k.getName().startsWith(".git")) continue;
                if (k.isDirectory()) { if (depthOf(k) < 4) queue.add(k); }
                if (k.getName().toLowerCase(Locale.ROOT).contains(q)) {
                    try { row(c.newRow(), k); found++; } catch (FileNotFoundException ignored) {}
                    if (found >= 100) break;
                }
            }
        }
        return c;
    }

    private int depthOf(File f) {
        int n = 0;
        File p = f;
        while (p != null && !p.equals(home)) { p = p.getParentFile(); n++; }
        return n;
    }

    @Override
    public String getDocumentType(String docId) throws FileNotFoundException {
        return mimeOf(fileOf(docId));
    }

    @Override
    public ParcelFileDescriptor openDocument(String docId, String mode, CancellationSignal signal) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fileOf(docId), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public String createDocument(String parentId, String mimeType, String displayName) throws FileNotFoundException {
        File parent = fileOf(parentId);
        if (!parent.isDirectory()) parent = parent.getParentFile();
        String name = safeName(displayName == null || displayName.isEmpty() ? "未命名" : displayName);
        File f = checked(new File(parent, name));
        try {
            if (Document.MIME_TYPE_DIR.equals(mimeType)) {
                if (!f.mkdirs() && !f.isDirectory()) throw new java.io.IOException("建目录失败");
            } else if (!f.createNewFile() && !f.isFile()) {
                throw new java.io.IOException("建文件失败");
            }
            return idOf(f);
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("创建失败：" + f.getName());
        }
    }

    @Override
    public void deleteDocument(String docId) throws FileNotFoundException {
        File f = fileOf(docId);
        if (f.equals(home)) throw new FileNotFoundException("不能删根");
        // 链接只删它本身，别顺着删到链接指向的地方（可能在作用域外）
        if (isSymlink(f)) { f.delete(); return; }
        deleteTree(f);
    }

    private static void deleteTree(File f) {
        if (!isSymlink(f) && f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    @Override
    public String renameDocument(String docId, String displayName) throws FileNotFoundException {
        File f = fileOf(docId);
        File to = checked(new File(f.getParentFile(), safeName(displayName)));
        if (f.equals(home) || !f.renameTo(to)) throw new FileNotFoundException("改名失败");
        return idOf(to);
    }

    @Override
    public boolean isChildDocument(String parentId, String docId) {
        try {
            String p = fileOf(parentId).getCanonicalPath();
            String c = fileOf(docId).getCanonicalPath();
            return c.equals(p) || c.startsWith(p + File.separator);
        } catch (Exception e) {
            return false;
        }
    }
}
