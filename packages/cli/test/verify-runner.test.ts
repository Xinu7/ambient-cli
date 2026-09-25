import { describe, expect, it } from "vitest";
import { verifyRunner } from "../src/agent/verify-port.js";

const has =
  (...files: string[]) =>
  (p: string) =>
    files.some((f) => p.endsWith(f));
const bash = () => ({ kind: "bash" as const, path: "C:\\Git\\bin\\bash.exe", label: "bash" });
const pwsh = () => ({ kind: "pwsh" as const, path: "C:\\pwsh\\pwsh.exe", label: "PowerShell" });

describe("verifyRunner", () => {
  it("POSIX: runs an executable script directly (shebang honored), else through /bin/sh", () => {
    expect(verifyRunner("/w", "linux", has(".ambient/verify"), () => true)?.args).toEqual([]);
    expect(verifyRunner("/w", "linux", has(".ambient/verify"), () => false)?.command).toBe(
      "/bin/sh",
    );
    expect(verifyRunner("/w", "linux", has(), () => true)).toBeUndefined();
  });
  it("Windows: prefers verify.ps1, then verify.cmd, then a plain script via Git Bash", () => {
    const ps1 = verifyRunner("C:\\w", "win32", has("verify.ps1"), () => false, pwsh);
    expect(ps1?.command).toBe("C:\\pwsh\\pwsh.exe");
    expect(ps1?.args).toContain("-File");
    const cmd = verifyRunner("C:\\w", "win32", has("verify.cmd"), () => false, pwsh);
    expect(cmd?.args.at(-1)).toMatch(/verify\.cmd$/);
    expect(verifyRunner("C:\\w", "win32", has("verify"), () => false, bash)?.command).toBe(
      "C:\\Git\\bin\\bash.exe",
    );
  });
  it("Windows with only a POSIX script and no Git Bash: verification is OFF, never a fake failure", () => {
    expect(verifyRunner("C:\\w", "win32", has("verify"), () => false, pwsh)).toBeUndefined();
  });
});
