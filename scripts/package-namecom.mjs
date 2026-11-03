/**
 * Build the Name.com package: static HTML/JS/CSS + the PHP proxy + .htaccess.
 *
 *   npm run package:namecom
 *
 * Output: C:\POLARITO.COM\out\
 * Upload the CONTENTS of /out into public_html (or into each addon domain root).
 * Do NOT upload polarito-secrets.php into this folder.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");

const env = {
  ...process.env,
  NAMECOM_EXPORT: "1",
  NEXT_PUBLIC_HIDE_DEV_TOOLS: process.env.NEXT_PUBLIC_HIDE_DEV_TOOLS ?? "1",
};

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["next", "build"], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (!existsSync(outDir)) {
  console.error("next build did not produce /out");
  process.exit(1);
}

mkdirSync(join(outDir, "api"), { recursive: true });
cpSync(join(root, "hosting", ".htaccess"), join(outDir, ".htaccess"));
cpSync(join(root, "hosting", "api", "bars.php"), join(outDir, "api", "bars.php"));

writeFileSync(
  join(outDir, "DO-NOT-UPLOAD-SECRETS.txt"),
  [
    "Alpaca keys do NOT go in this folder.",
    "Copy hosting/polarito-secrets.php.example to /home/YOUR_USER/polarito-secrets.php",
    "(one level ABOVE public_html), paste the keys, set permissions 0600.",
    "",
  ].join("\n"),
);

console.log("Name.com package ready:", outDir);
console.log("Upload the contents of /out into public_html.");
console.log("Keep polarito-secrets.php ABOVE public_html.");
