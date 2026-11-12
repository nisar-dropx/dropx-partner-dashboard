param(
  [string]$OutFile = "$env:TEMP\dropx-workspaces-capture.png",
  [string]$WindowTitle = "Amazon WorkSpaces",
  # Quiet = PrintWindow only (no focus). Prepare = restore window then capture (keeps 50% zoom — never Ctrl+0).
  [switch]$Quiet = $true,
  [switch]$Prepare
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WorkSpacesCaptureHQ {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static IntPtr FindWindowByTitle(string titlePart) {
    IntPtr found = IntPtr.Zero;
    int bestArea = 0;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0) return true;
      if (title.IndexOf("Helper", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; found = hWnd; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Capture(string titlePart, string outFile, bool prepare) {
    try { SetProcessDPIAware(); } catch { }

    IntPtr hwnd = FindWindowByTitle(titlePart);
    if (hwnd == IntPtr.Zero) {
      throw new Exception("Amazon WorkSpaces window was not found. Open WorkSpaces with Firefox Site Summary visible.");
    }
    // Always restore if minimized (switch script can leave WS iconic briefly).
    if (IsIconic(hwnd) || prepare) {
      ShowWindow(hwnd, 9);
      ShowWindow(hwnd, 3);
      SetForegroundWindow(hwnd);
      Thread.Sleep(400);
      // Intentionally do NOT change Firefox zoom — keep 50%.
    }
    if (IsIconic(hwnd)) {
      throw new Exception("Amazon WorkSpaces is minimized. Restore it so capture can read Site Summary.");
    }

    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) throw new Exception("Could not read WorkSpaces window size.");
    int width = Math.Max(rect.Right - rect.Left, 1);
    int height = Math.Max(rect.Bottom - rect.Top, 1);
    if (width < 400 || height < 300) {
      throw new Exception("Amazon WorkSpaces window is too small (" + width + "x" + height + "). Keep it open (not minimized).");
    }

    // Drop text selection (blue "select all" highlight) before snapshot — never Ctrl+A.
    // Click left margin only so we do not open Assigned Associate / site dropdown.
    const uint KEYUP = 0x0002;
    for (int i = 0; i < 3; i++) {
      keybd_event(0x1B, 0, 0, UIntPtr.Zero);
      keybd_event(0x1B, 0, KEYUP, UIntPtr.Zero);
      Thread.Sleep(60);
    }
    SetCursorPos(rect.Left + (int)(width * 0.06), rect.Top + (int)(height * 0.38));
    mouse_event(0x0002, 0, 0, 0, 0);
    mouse_event(0x0004, 0, 0, 0, 0);
    Thread.Sleep(120);
    keybd_event(0x1B, 0, 0, UIntPtr.Zero);
    keybd_event(0x1B, 0, KEYUP, UIntPtr.Zero);
    Thread.Sleep(200);

    using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      g.CompositingMode = CompositingMode.SourceCopy;
      g.CompositingQuality = CompositingQuality.HighQuality;
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) throw new Exception("PrintWindow failed for Amazon WorkSpaces.");

      // Light crop: title/tabs top + taskbar bottom only (keep Site Summary readable at 50% zoom).
      int topCrop = Math.Min((int)(height * 0.09), 100);
      int bottomCrop = Math.Min((int)(height * 0.06), 64);
      int cropW = width;
      int cropH = Math.Max(height - topCrop - bottomCrop, 300);
      var cropRect = new Rectangle(0, topCrop, cropW, cropH);
      using (var cropped = bmp.Clone(cropRect, PixelFormat.Format32bppArgb)) {
        cropped.Save(outFile, ImageFormat.Png);
      }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

[WorkSpacesCaptureHQ]::Capture($WindowTitle, $OutFile, $Prepare.IsPresent)
Write-Output $OutFile
