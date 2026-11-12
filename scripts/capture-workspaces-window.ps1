param(
  [string]$OutFile = "$env:TEMP\dropx-workspaces-capture.png",
  [string]$WindowTitle = "Amazon WorkSpaces"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class WorkSpacesCapture {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static IntPtr FindWindowByTitle(string titlePart) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Capture(string titlePart, string outFile) {
    IntPtr hwnd = FindWindowByTitle(titlePart);
    if (hwnd == IntPtr.Zero) throw new Exception("Amazon WorkSpaces window was not found. Open the WorkSpaces desktop app and leave Site Summary visible.");
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) throw new Exception("Could not read WorkSpaces window size.");
    int width = Math.Max(rect.Right - rect.Left, 1);
    int height = Math.Max(rect.Bottom - rect.Top, 1);
    if (width < 400 || height < 300) {
      throw new Exception("Amazon WorkSpaces window is too small (" + width + "x" + height + "). Restore/open the window (do not minimize).");
    }
    using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      // PW_RENDERFULLCONTENT = 2 captures even when another app is in front
      bool ok = PrintWindow(hwnd, hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) throw new Exception("PrintWindow failed for Amazon WorkSpaces.");
      bmp.Save(outFile, ImageFormat.Png);
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

[WorkSpacesCapture]::Capture($WindowTitle, $OutFile)
Write-Output $OutFile
