param(
  [string]$WindowTitle = "Amazon WorkSpaces",
  # Brief focus + harmless key, then restore the user's previous window.
  [switch]$Background
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WsKeepAlive {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr FindLargest(string titlePart) {
    IntPtr found = IntPtr.Zero;
    int best = 0;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0) return true;
      if (title.IndexOf("Helper", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
      if (area > best) { best = area; found = h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Tap(byte vk) {
    const uint KEYEVENTF_KEYUP = 0x0002;
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

try { [WsKeepAlive]::SetProcessDPIAware() | Out-Null } catch { }

$hwnd = [WsKeepAlive]::FindLargest($WindowTitle)
if ($hwnd -eq [IntPtr]::Zero) { throw "Amazon WorkSpaces window not found." }

$prev = [WsKeepAlive]::GetForegroundWindow()
if ([WsKeepAlive]::IsIconic($hwnd)) {
  [WsKeepAlive]::ShowWindow($hwnd, 9) | Out-Null
}

[WsKeepAlive]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds $(if ($Background) { 180 } else { 280 })

# F15 is almost never bound in apps; resets remote idle without typing characters.
[WsKeepAlive]::Tap(0x7E) # VK_F15
Start-Sleep -Milliseconds 40
# Tiny cursor nudge inside the client area so the WorkSpaces stream also sees activity.
$rect = New-Object WsKeepAlive+RECT
[void][WsKeepAlive]::GetWindowRect($hwnd, [ref]$rect)
$nx = [int](($rect.Left + $rect.Right) / 2)
$ny = [int](($rect.Top + $rect.Bottom) / 2)
[WsKeepAlive]::SetCursorPos($nx, $ny) | Out-Null

if ($Background -and $prev -ne [IntPtr]::Zero -and $prev -ne $hwnd) {
  [WsKeepAlive]::SetForegroundWindow($prev) | Out-Null
}

Write-Output ("keepalive:ok|bg:{0}|hwnd:{1}" -f [int]$Background.IsPresent, $hwnd.ToInt64())
