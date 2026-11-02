import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const privateModule = /^private-.*\.mjs$/i;
// Conservative literal-reference check, not an evaluator or a JavaScript sandbox.
const privateReference = /\bprivate-[^/\s"'`\\?#]*\.mjs\b/i;
const codeFile = /\.(?:mjs|cjs|js|html)$/i;
const excludedWeb = new Set(["web/remote-view.css", "web/remote-settings.css",
  "web/app/13r-remote-transport.js", "web/app/13s-remote-view.js", "web/app/13t-remote-settings.js"]);
const fail = (code, rel) => { throw Object.assign(new Error(`${code}: ${rel}`), { code }); };

// Read-only: never imports gateway modules, follows source links, reads signing material or writes assets.
// Inspect only the server/modules and source directories that build.sh copies, not tests or gw/remote/.
export function checkPublicBuildSource(source) {
  if (typeof source !== "string" || !source) fail("BUILD_SOURCE_INVALID", "expected a gateway source directory");
  const root = path.resolve(source), files = [];
  const inspect = (rel) => {
    if (privateModule.test(path.basename(rel))) fail("BUILD_SOURCE_PRIVATE_MODULE", rel);
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isSymbolicLink()) fail("BUILD_SOURCE_SYMLINK", rel || ".");
    return st;
  };
  if (!inspect("").isDirectory()) fail("BUILD_SOURCE_INVALID", ".");
  if (!inspect("server.mjs").isFile()) fail("BUILD_SOURCE_INVALID", "server.mjs");
  files.push("server.mjs");
  const scan = (rel, recursive = false) => {
    if (!inspect(rel).isDirectory()) fail("BUILD_SOURCE_INVALID", rel);
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      // Top-level shell globs omit dotfiles; cp -R includes dotfiles inside web subdirectories.
      if (name.startsWith(".") && (rel === "web" || !recursive)) continue;
      const child = rel + "/" + name;
      if (excludedWeb.has(child) || (rel === "web" && name.includes(".bak"))) continue;
      // gw/*.mjs is deliberately non-recursive. Remote business modules are not host assets.
      if (rel === "gw" && !name.endsWith(".mjs")) continue;
      const st = inspect(child);
      if (st.isDirectory()) { if (recursive) scan(child, true); }
      else if (!st.isFile()) fail("BUILD_SOURCE_INVALID", child);
      else if (codeFile.test(name)) files.push(child);
    }
  };
  scan("gw");
  scan("archive");
  scan("guard");
  scan("web", true);
  // Finish the filename/type pass first: a rejected private policy file is never opened.
  for (const rel of files) if (privateReference.test(fs.readFileSync(path.join(root, rel), "utf8")))
    fail("BUILD_SOURCE_PRIVATE_REFERENCE", rel);
  return { files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { checkPublicBuildSource(process.argv[2]); }
  catch (e) {
    // No source text or policy contents in build logs.
    console.error(e.code?.startsWith("BUILD_SOURCE_") ? e.message : "BUILD_SOURCE_INVALID: cannot inspect gateway sources");
    process.exitCode = 1;
  }
}
