// Shared process/port helpers for dev-all.mjs: find whatever holds a port, tell "our own stale
// process" apart from, and kill trees. Adapted from the reference port's
// (LAN/browser helpers dropped, not needed here).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const COLORS = { 'server': 36, vite: 33, postgres: 34, status: 90, sup: 90 };
export const color = (name, s) => `\x1b[${COLORS[name] ?? 37}m${s}\x1b[0m`;

/** parses `netstat -ano`, returns pid listening on `port` (IPv4 or IPv6, TCP) or null */
export function pidOnPort(port) {
  let text;
  try { text = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); } catch { return null; }
  const re = new RegExp(`^\\s*TCP6?\\s+\\S*[.:]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'im');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

export function commandLineOf(pid) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ], { encoding: 'utf8' });
    return out.trim();
  } catch { return ''; }
}

// Win32 command lines for `npm --prefix x start`-spawned processes are just "node  src/main.ts"
// (npm sets cwd via CreateProcess, not via argv), so command line alone can't identify the repo.
// Read the process's actual current directory out of its PEB instead (x64 offsets).
const PEB_CWD_SCRIPT = `
param([int]$ProcId)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PbWebProcCwd {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0;
        public IntPtr Reserved2_1; public IntPtr UniquePid; public IntPtr InheritedFromUniqueProcessId;
    }
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr h, int pic, ref PROCESS_BASIC_INFORMATION pbi, int size, out int ret);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr addr, byte[] buffer, int size, out IntPtr read);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
}
"@
try {
  $h = [PbWebProcCwd]::OpenProcess(0x0400 -bor 0x0010, $false, $ProcId)
  if ($h -eq [IntPtr]::Zero) { exit 1 }
  $pbi = New-Object PbWebProcCwd+PROCESS_BASIC_INFORMATION
  $ret = 0
  $status = [PbWebProcCwd]::NtQueryInformationProcess($h, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$ret)
  if ($status -ne 0) { exit 1 }
  $buf = New-Object byte[] 8
  $read = [IntPtr]::Zero
  [PbWebProcCwd]::ReadProcessMemory($h, [IntPtr]::Add($pbi.PebBaseAddress, 0x20), $buf, 8, [ref]$read) | Out-Null
  $paramsAddr = [BitConverter]::ToInt64($buf, 0)
  $ucBuf = New-Object byte[] 16
  [PbWebProcCwd]::ReadProcessMemory($h, [IntPtr]$paramsAddr + 0x38, $ucBuf, 16, [ref]$read) | Out-Null
  $len = [BitConverter]::ToUInt16($ucBuf, 0)
  $bufPtr = [BitConverter]::ToInt64($ucBuf, 8)
  $strBuf = New-Object byte[] $len
  [PbWebProcCwd]::ReadProcessMemory($h, [IntPtr]$bufPtr, $strBuf, $len, [ref]$read) | Out-Null
  Write-Output ([System.Text.Encoding]::Unicode.GetString($strBuf))
  [PbWebProcCwd]::CloseHandle($h) | Out-Null
} catch { exit 1 }
`;

let pebScriptPath = null;
function pebScript() {
  if (!pebScriptPath) {
    pebScriptPath = join(mkdtempSync(join(tmpdir(), 'pbwebport-proc-cwd-')), 'peb-cwd.ps1');
    writeFileSync(pebScriptPath, PEB_CWD_SCRIPT);
  }
  return pebScriptPath;
}

export function cwdOf(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', pebScript(), '-ProcId', String(pid)], { encoding: 'utf8' });
    return out.trim();
  } catch { return ''; }
}

/** true if pid's cwd, or its command line, points into repoKey (a lowercased, forward-slashed repo root) */
export function belongsToRepo(pid, repoKey) {
  const cwd = cwdOf(pid).replace(/\\/g, '/').toLowerCase();
  if (cwd.includes(repoKey)) return true;
  const cmd = commandLineOf(pid).replace(/\\/g, '/').toLowerCase();
  return cmd.includes(repoKey);
}

export function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

export async function waitPortFree(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pidOnPort(port) === null) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pidOnPort(port) === null;
}

/** Frees a port if the process holding it belongs to repoKey; aborts the process otherwise. */
export async function ensurePortFree(name, port, repoKey) {
  const pid = pidOnPort(port);
  if (pid === null) return;
  if (!belongsToRepo(pid, repoKey)) {
    console.error(color('sup', `[sup] port ${port} (${name}) is held by pid ${pid}, which is NOT part of this repo:`));
    console.error(color('sup', `[sup]   cwd: ${cwdOf(pid) || '?'}  cmd: ${commandLineOf(pid) || '?'}`));
    console.error(color('sup', '[sup] refusing to kill it. Free the port manually and re-run.'));
    process.exit(1);
  }
  console.log(color('sup', `[sup] port ${port} (${name}) held by stale dev process pid ${pid}, killing its tree...`));
  killTree(pid);
  const free = await waitPortFree(port);
  if (!free) {
    console.error(color('sup', `[sup] port ${port} did not free up after killing pid ${pid}.`));
    process.exit(1);
  }
}

export function prefixedPipe(stream, name, out) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) out.write(`${color(name, `[${name}]`)} ${line}\n`);
  });
}
