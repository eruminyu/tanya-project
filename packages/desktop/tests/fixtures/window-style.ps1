param([Parameter(Mandatory=$true)][UInt64]$Handle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KirianTestWindowStyle {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
}
'@
$style = [KirianTestWindowStyle]::GetWindowLongPtr([IntPtr]::new([Int64]$Handle), -20).ToInt64()
Write-Output (($style -band 0x20) -ne 0)
