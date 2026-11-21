# DropX WorkSpaces Keep-Alive
# Runs every 3 minutes via Windows Task Scheduler.
# Finds the Amazon WorkSpaces window, taps F15 (no-op key), nudges the mouse,
# then restores the previously active window so the user's work is undisturbed.
#
# Task Scheduler action:
#   powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\DropX\keepalive\keepalive.ps1"

param(
  [string]$WindowTitle = "Amazon WorkSpaces"
)

$logFile = Join-Path $PSScriptRoot "keepalive.log"

function Write-Log([string]$msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8
}

# Keep log at most 500 lines
try {
  if (Test-Path $logFile) {
    $lines = Get-Content $logFile
    if ($lines.Count -gt 500) {
      $lines | Select-Object -Last 400 | Set-Content $logFile -Encoding UTF8
    }
  }
} catch {}

# ── Win32 helpers ────────────────────────────────────────────────────────────
$typeDef = @'
using System;
using System.Runtime.InteropServices;
public class WsKeepAlive {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT  { public int Left, Top, Right, Bottom; }
    public static void TapKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(50);
        keybd_event(vk, 0, 2, UIntPtr.Zero);  // KEYEVENTF_KEYUP = 2
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'WsKeepAlive').Type) {
  Add-Type -TypeDefinition $typeDef
}

# ── Find WorkSpaces window ───────────────────────────────────────────────────
$wsProcs = Get-Process | Where-Object {
  $_.MainWindowTitle -like "*$WindowTitle*" -or $_.ProcessName -like "*workspaces*"
} | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }

if (-not $wsProcs) {
  Write-Log "WorkSpaces window not found — skipping"
  exit 0
}

# Pick the process with the largest window
$best = $wsProcs | Sort-Object {
  $r = New-Object WsKeepAlive+RECT
  [WsKeepAlive]::GetWindowRect($_.MainWindowHandle, [ref]$r) | Out-Null
  ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
} | Select-Object -Last 1

$wsHwnd = $best.MainWindowHandle

# ── Remember current foreground window ──────────────────────────────────────
$prevHwnd = [WsKeepAlive]::GetForegroundWindow()

# ── Activate WorkSpaces + tap F15 (VK 0x7E) + nudge cursor ─────────────────
try {
  [WsKeepAlive]::ShowWindow($wsHwnd, 9) | Out-Null   # SW_RESTORE = 9
  Start-Sleep -Milliseconds 200
  [WsKeepAlive]::SetForegroundWindow($wsHwnd) | Out-Null
  Start-Sleep -Milliseconds 300

  [WsKeepAlive]::TapKey(0x7E)   # F15 — no-op in most apps

  Write-Log "OK — tapped F15 on WorkSpaces ($($best.ProcessName))"
} catch {
  Write-Log "ERROR during nudge: $_"
}

# ── Restore previous foreground window ──────────────────────────────────────
try {
  if ($prevHwnd -ne [IntPtr]::Zero -and $prevHwnd -ne $wsHwnd) {
    Start-Sleep -Milliseconds 200
    [WsKeepAlive]::SetForegroundWindow($prevHwnd) | Out-Null
  }
} catch {}
