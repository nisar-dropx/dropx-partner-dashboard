param(
  [Parameter(Mandatory = $true)][string]$Station,
  [int]$MenuX = 0,
  [int]$MenuY = 0,
  [string]$WindowTitle = "Amazon WorkSpaces"
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WsFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr Find(string titlePart) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

Add-Type -AssemblyName System.Windows.Forms

$hwnd = [WsFocus]::Find($WindowTitle)
if ($hwnd -eq [IntPtr]::Zero) { throw "Amazon WorkSpaces window was not found." }

[WsFocus]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
[WsFocus]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400

$rect = New-Object WsFocus+RECT
[void][WsFocus]::GetWindowRect($hwnd, [ref]$rect)
$width = [Math]::Max($rect.Right - $rect.Left, 1)
$height = [Math]::Max($rect.Bottom - $rect.Top, 1)
if ($width -lt 400 -or $height -lt 300) {
  throw "Amazon WorkSpaces window is too small ($width x $height). Unlock/restore the screen."
}

$clickX = if ($MenuX -gt 0) { $MenuX } else { [int]($rect.Left + ($width * 0.18)) }
$clickY = if ($MenuY -gt 0) { $MenuY } else { [int]($rect.Top + [Math]::Min(70, $height * 0.08)) }

[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($clickX, $clickY)
Start-Sleep -Milliseconds 120
# left click
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  public static void Click() { mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0); }
}
"@
[Mouse]::Click()
Start-Sleep -Milliseconds 450
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait($Station)
Start-Sleep -Milliseconds 350
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 1200
Write-Output "switched:$Station"
