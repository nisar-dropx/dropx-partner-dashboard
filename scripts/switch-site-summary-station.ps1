param(
  [Parameter(Mandatory = $true)][string]$Station,
  [int]$TabIndex = 0,
  [ValidateSet("Tab", "Menu", "Dropdown", "Off")][string]$Mode = "Dropdown",
  [int]$MenuX = 0,
  [int]$MenuY = 0,
  # Physical fractions @ 50% zoom for .header-row site chip.
  [double]$DropX = 0.935,
  [double]$DropY = 0.195,
  [int]$WaitMs = 2800,
  [string]$WindowTitle = "Amazon WorkSpaces",
  [switch]$SkipTabEnsure,
  # Brief focus for clicks, then restore the user's previous window (less interruptive).
  [switch]$Background
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
  public static void Key(byte vk, bool up = false) {
    const uint KEYEVENTF_KEYUP = 0x0002;
    keybd_event(vk, 0, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
  }
  public static void Chord(byte modifierVk, byte keyVk) {
    Key(modifierVk, false);
    Key(keyVk, false);
    Key(keyVk, true);
    Key(modifierVk, true);
  }
}
"@

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  public static void Click() { mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0); }
}
"@

try { [WsFocus]::SetProcessDPIAware() | Out-Null } catch { }

if ($Mode -eq "Off") {
  Write-Output "switch-off:$Station"
  exit 0
}

$raw = $Station.Trim()
if ($raw -match '(?i)^amazonnow\s+(.+)$') {
  $code = $Matches[1].ToUpperInvariant().Trim()
  $filters = @($code)
  $chipAmazon = "AmazonNow $code"
  $chipSs = "${code}_SS"
} elseif ($raw -match '(?i)^(.+)_SS$') {
  $code = $Matches[1].ToUpperInvariant().Trim()
  $filters = @("${code}_SS")
  $chipAmazon = "AmazonNow $code"
  $chipSs = "${code}_SS"
} else {
  $code = $raw.ToUpperInvariant().TrimEnd('_').Trim()
  $chipAmazon = "AmazonNow $code"
  $chipSs = "${code}_SS"
  $filters = @($code)
}

$hwnd = [WsFocus]::FindLargest($WindowTitle)
if ($hwnd -eq [IntPtr]::Zero) { throw "Amazon WorkSpaces window was not found." }

$prevHwnd = [WsFocus]::GetForegroundWindow()
if ([WsFocus]::IsIconic($hwnd)) {
  # Restore only if minimized — never force Maximize (ShowWindow 3) in background mode.
  [WsFocus]::ShowWindow($hwnd, 9) | Out-Null
} elseif (-not $Background) {
  [WsFocus]::ShowWindow($hwnd, 9) | Out-Null
}
[WsFocus]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds $(if ($Background) { 220 } else { 350 })

$rect = New-Object WsFocus+RECT
[void][WsFocus]::GetWindowRect($hwnd, [ref]$rect)
$width = [Math]::Max($rect.Right - $rect.Left, 1)
$height = [Math]::Max($rect.Bottom - $rect.Top, 1)
if ($width -lt 400 -or $height -lt 300) {
  throw "Amazon WorkSpaces window is too small ($width x $height)."
}

function Click-At([int]$x, [int]$y) {
  [WsFocus]::SetCursorPos($x, $y) | Out-Null
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 80
  [Mouse]::Click()
  Start-Sleep -Milliseconds 120
}

function Press-Esc() {
  [WsFocus]::Key(0x1B, $false)
  [WsFocus]::Key(0x1B, $true)
}

function Press-Space() {
  [WsFocus]::Key(0x20, $false)
  [WsFocus]::Key(0x20, $true)
}

function Type-Text([string]$text) {
  [System.Windows.Forms.SendKeys]::SendWait($text)
}

function Clear-FilterText() {
  # Never Ctrl+A on the page.
  [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE 20}")
}

function Clear-PageSelection() {
  Press-Esc
  Start-Sleep -Milliseconds 40
  Click-At ([int]($rect.Left + ($width * 0.06))) ([int]($rect.Top + ($height * 0.38)))
  Start-Sleep -Milliseconds 40
  Press-Esc
}

function Ensure-SiteSummaryTab() {
  Click-At ([int]($rect.Left + ($width * 0.30))) ([int]($rect.Top + ($height * 0.105)))
  Start-Sleep -Milliseconds 250
}

function Open-SiteDropdown([int]$x, [int]$y) {
  [WsFocus]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 100
  Click-At $x $y
  Start-Sleep -Milliseconds 180
  Press-Space
  Start-Sleep -Milliseconds 550
}

function Select-Filtered([string]$filter) {
  Clear-FilterText
  Start-Sleep -Milliseconds 80
  Type-Text $filter
  Start-Sleep -Milliseconds 1100
  [System.Windows.Forms.SendKeys]::SendWait("{DOWN}")
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Milliseconds 450
}

if ($Mode -eq "Tab") {
  Clear-PageSelection
  $index = if ($TabIndex -ge 1 -and $TabIndex -le 8) { $TabIndex } else { 1 }
  [WsFocus]::Chord(0x11, [byte](0x30 + $index))
  Start-Sleep -Milliseconds ([Math]::Max(800, $WaitMs))
  Clear-PageSelection
  Write-Output ("switched-tab:{0}:{1}" -f $chipAmazon, $index)
  exit 0
}

# Always re-focus Site Summary tab — fast path still needs this or filter types into the wrong page.
Ensure-SiteSummaryTab
Clear-PageSelection

$clickX = if ($MenuX -gt 0) { $MenuX } else { [int]($rect.Left + ($width * $DropX)) }
$clickY = if ($MenuY -gt 0) { $MenuY } else { [int]($rect.Top + ($height * $DropY)) }

$usedFilter = $filters[0]
Open-SiteDropdown $clickX $clickY
Select-Filtered $usedFilter
Clear-PageSelection

# Return the user's cursor/window FIRST, then wait for Site Summary reload in the background.
# Slow stations (TFB7_SS etc.) need a long WaitMs — that must not hold focus the whole time.
if ($Background -and $prevHwnd -ne [IntPtr]::Zero -and $prevHwnd -ne $hwnd) {
  [WsFocus]::SetForegroundWindow($prevHwnd) | Out-Null
}

Start-Sleep -Milliseconds ([Math]::Max(1800, $WaitMs))

Write-Output ("switched-dropdown:{0}|alt:{1}|filter:{2}|click:{3},{4}|size:{5}x{6}|bg:{7}" -f $chipAmazon, $chipSs, $usedFilter, $clickX, $clickY, $width, $height, [int]$Background.IsPresent)
