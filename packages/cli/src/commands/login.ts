import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { KEYS_URL } from "@amb/ambient-api";
import { bold, cyan, dim } from "../render/color.js";
import { resolveApiKey, saveApiKey } from "../secrets.js";
import { readSecret } from "../terminal/read-secret.js";

/** Best-effort open the URL in the user's default browser. Returns false if it couldn't launch. */
function openBrowser(url: string): boolean {
  try {
    if (process.platform === "darwin") execFileSync("open", [url], { stdio: "ignore" });
    else if (process.platform === "win32")
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort copy text to the clipboard (macOS pbcopy). Returns false if unavailable. */
function copyToClipboard(text: string): boolean {
  try {
    if (process.platform !== "darwin") return false;
    execFileSync("pbcopy", [], { input: text });
    return true;
  } catch {
    return false;
  }
}

/** Read a visible line. */
async function readLine(promptText: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

/**
 * `ambient login` — connect your Ambient account. Opens the keys page in the browser (with a copy-the-link
 * fallback), reads your key WITHOUT echoing it, and saves it to the macOS keychain. Never prints the key.
 */
export async function runLogin(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "ambient login needs an interactive terminal. Or set AMBIENT_API_KEY in your environment.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${bold("Connect your Ambient account")}\n\n`);
  if (resolveApiKey()) {
    process.stdout.write(dim("You're already signed in — this will replace your saved key.\n\n"));
  }

  const opened = openBrowser(KEYS_URL);
  process.stdout.write(
    opened
      ? `Opened ${cyan(KEYS_URL)} in your browser.\n`
      : `Open this in your browser: ${cyan(KEYS_URL)}\n`,
  );

  const choice = await readLine(
    `${dim("Create a key there, then press Enter — or type ")}c${dim(" to copy the link: ")}`,
  );
  if (choice.toLowerCase() === "c") {
    const copied = copyToClipboard(KEYS_URL);
    process.stdout.write(
      copied ? dim("Link copied to your clipboard.\n") : `Copy this link: ${KEYS_URL}\n`,
    );
    await readLine(dim("Press Enter when your key is ready: "));
  }

  const key = await readSecret(`${cyan("Paste your API key")}${dim(" (hidden): ")}`);
  if (!key) {
    process.stderr.write("No key entered — nothing was saved.\n");
    process.exitCode = 1;
    return;
  }

  try {
    saveApiKey(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Could not save the key to your keychain: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${cyan("✓")} Signed in. You're ready — run ${bold("ambient")}.\n\n`);
}
