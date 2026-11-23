param([int]$X, [int]$Y, [string]$Action = "move")
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System.Runtime.InteropServices;
public class U32b {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
"@
[U32b]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
$c = [System.Windows.Forms.Cursor]::Position
"CURSOR X=$($c.X) Y=$($c.Y)"
if ($Action -eq "click") {
  [U32b]::mouse_event(0x0002, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 80
  [U32b]::mouse_event(0x0004, 0, 0, 0, 0)
  "CLICKED"
}
