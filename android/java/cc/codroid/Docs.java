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
        home = new File(new File(getContext().getFilesDir(), "home"), "workspace");   // 和 Env.home 同一处：files/home/workspace
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

    /** ID 用名字本身的路径（不解开软链接），越界检查照旧按真实路径（checked）。
     *  以前 ID 用真实路径：工作区里 alias.txt → target.txt，列出来名字是 alias.txt、ID 却是 target.txt，
     *  在文件管理器里删「别名」实际删掉了原文件（审查 v0.5.20 06-002） */
    private String idOf(File f) throws FileNotFoundException {
        // 指到作用域外的软链接：不给 ID（列目录时跳过这一条）
        checked(f);
        String base = home.getAbsoluteFile().toPath().normalize().toString();
        String path = f.getAbsoluteFile().toPath().normalize().toString();
        if (path.equals(base)) return ROOT_ID;
        if (!path.startsWith(base + File.separator)) throw new FileNotFoundException("越界：" + f.getName());
        return ROOT_ID + "/" + path.substring(base.length() + 1);
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

    /** 先算 ID 再建行：ID 算不出来（越界的链接）就整条不加，不留空行 */
    private void row(MatrixCursor c, File f) throws FileNotFoundException {
        String id = idOf(f);
        MatrixCursor.RowBuilder r = c.newRow();
        r.add(Document.COLUMN_DOCUMENT_ID, id);
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
        row(c, f);
        return c;
    }

    @Override
    public Cursor queryChildDocuments(String parentId, String[] projection, String sortOrder) throws FileNotFoundException {
        File dir = fileOf(parentId);
        String[] cols = projection != null ? projection : new String[] {
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
        MatrixCursor c = new MatrixCursor(cols, 64);
        // 登记这一层的通知地址：新建、改名、删除后 changed() 一喊，文件管理器自己刷新（不然新建完列表里看不到）
        c.setNotificationUri(getContext().getContentResolver(), DocumentsContract.buildChildDocumentsUri(AUTH, idOf(dir)));
        File[] list = dir.listFiles();
        if (list == null) return c;
        // 目录在前、同类按名字；文件管理器的排序还能再覆盖
        Arrays.sort(list, (a, b) -> a.isDirectory() != b.isDirectory()
            ? (a.isDirectory() ? -1 : 1)
            : a.getName().compareToIgnoreCase(b.getName()));
        for (File f : list) {
            try { row(c, f); } catch (FileNotFoundException ignored) {}
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
                if (k.isDirectory() && !isSymlink(k)) { if (depthOf(k) < 4) queue.add(k); }   // 不顺着链接翻到作用域外
                if (k.getName().toLowerCase(Locale.ROOT).contains(q)) {
                    try { row(c, k); found++; } catch (FileNotFoundException ignored) {}
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
        File target = fileOf(docId);
        // 写模式会在 open 时截断：硬链接文件有多个名字，截断前先拒绝（以前的检查在 open 之后，已经清空了）
        if (mode != null && mode.contains("w") && !mode.contains("a")) {
            try {
                android.system.StructStat st = android.system.Os.stat(target.getPath());
                if (android.system.OsConstants.S_ISREG(st.st_mode) && st.st_nlink > 1) throw new FileNotFoundException("硬链接文件不能写");
            } catch (FileNotFoundException e) { throw e; }
            catch (Exception ignore) {}
        }
        ParcelFileDescriptor pfd = ParcelFileDescriptor.open(target, ParcelFileDescriptor.parseMode(mode));
        // fileOf 查过真实路径，但查完到打开之间文件可能被换成指向作用域外的软链（审查 v0.5.7 L8）：
        // 打开以后按 fd 反查它实际是哪个文件，不在作用域里就关掉不给。根目录也按 fd 取，两边写法一致
        try {
            String real = android.system.Os.readlink("/proc/self/fd/" + pfd.getFd()), base = realHome();
            // 硬链接不改真实路径：工作区里一个硬链接就能指到凭据文件上，和 Share 一样，普通文件有多个名字就不给（11-04 报告 A9）
            android.system.StructStat st = android.system.Os.fstat(pfd.getFileDescriptor());
            boolean linked = android.system.OsConstants.S_ISREG(st.st_mode) && st.st_nlink > 1;
            if (!linked && (real.equals(base) || real.startsWith(base + "/"))) return pfd;
        } catch (Exception e) { /* 落到下面：查不了也不给 */ }
        try { pfd.close(); } catch (java.io.IOException ignored) {}
        throw new FileNotFoundException("越界：" + docId);
    }

    private String realHomeCache;
    private String realHome() throws Exception {
        if (realHomeCache != null) return realHomeCache;
        try (ParcelFileDescriptor d = ParcelFileDescriptor.open(home, ParcelFileDescriptor.MODE_READ_ONLY)) {
            return realHomeCache = android.system.Os.readlink("/proc/self/fd/" + d.getFd());
        }
    }

    @Override
    public String createDocument(String parentId, String mimeType, String displayName) throws FileNotFoundException {
        File parent = fileOf(parentId);
        if (!parent.isDirectory()) parent = parent.getParentFile();
        String name = safeName(displayName == null || displayName.isEmpty() ? "未命名" : displayName);
        File f = checked(new File(parent, name));
        // 同名已存在就另起名「名字 (1).扩展名」：直接把已有文件交出去，对方一写就把用户的文件冲掉了
        for (int n = 1; f.exists() && n < 1000; n++) {
            int dot = Document.MIME_TYPE_DIR.equals(mimeType) ? -1 : name.lastIndexOf('.');
            String alt = dot > 0 ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")";
            f = checked(new File(parent, alt));
        }
        try {
            if (Document.MIME_TYPE_DIR.equals(mimeType)) {
                if (!f.mkdirs()) throw new java.io.IOException("建目录失败");
            } else if (!f.createNewFile()) {
                throw new java.io.IOException("建文件失败");
            }
            changed(parent);
            return idOf(f);
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("创建失败：" + f.getName());
        }
    }

    @Override
    public void deleteDocument(String docId) throws FileNotFoundException {
        File f = fileOf(docId);
        // 用规范路径判根：docId 里的 "."/".." 会让未规范化的 File 不等于 home，从而递归删掉整个工作区
        try { if (f.getCanonicalFile().equals(home.getCanonicalFile())) throw new FileNotFoundException("不能删根"); }
        catch (java.io.IOException e) { throw new FileNotFoundException("不能删根"); }
        // 链接只删它本身，别顺着删到链接指向的地方（可能在作用域外）
        // 删不掉要报出去（审查 #105 06-003）：以前不看返回值，删失败也当成功。删了一半的照样通知刷新，让文件管理器看到剩下的
        boolean ok = isSymlink(f) ? f.delete() || !exists(f) : deleteTree(f);
        changed(f.getParentFile());
        if (!ok) throw new FileNotFoundException("删除失败：" + f.getName());
    }

    /** 连悬空链接也算在（File.exists 跟着链接走，悬空的会说不在） */
    private static boolean exists(File f) {
        return java.nio.file.Files.exists(f.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS);
    }

    /** 这个目录的内容变了：通知正在看它的文件管理器刷新 */
    private void changed(File dir) {
        try { getContext().getContentResolver().notifyChange(DocumentsContract.buildChildDocumentsUri(AUTH, idOf(dir)), null); }
        catch (FileNotFoundException ignored) {}
    }

    /** 全删掉了返回 true；有一项删不掉（或本来就不在之外的失败）返回 false，其余能删的照删 */
    private static boolean deleteTree(File f) {
        boolean ok = true;
        if (!isSymlink(f) && f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids == null) ok = false;
            else for (File k : kids) ok &= deleteTree(k);
        }
        return (f.delete() || !exists(f)) && ok;
    }

    @Override
    public String renameDocument(String docId, String displayName) throws FileNotFoundException {
        File f = fileOf(docId);
        File to = checked(new File(f.getParentFile(), safeName(displayName)));
        try { if (f.getCanonicalFile().equals(home.getCanonicalFile())) throw new FileNotFoundException("改名失败"); }
        catch (java.io.IOException e) { throw new FileNotFoundException("改名失败"); }
        if (to.equals(f)) return idOf(f);
        // 不覆盖同名：以前直接 renameTo，改成已有文件的名字就把那个文件顶掉了（审查 v0.5.20 06-001）。
        // Files.move 不带 REPLACE_EXISTING：目标在就报错；链接按链接本身挪
        if (exists(to)) throw new FileNotFoundException("已经有叫这个名字的文件了");
        try { java.nio.file.Files.move(f.toPath(), to.toPath()); }
        catch (Exception e) { throw new FileNotFoundException("改名失败"); }
        changed(to.getParentFile());
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
