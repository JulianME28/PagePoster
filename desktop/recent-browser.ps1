$ErrorActionPreference='Stop'
# Inspect only visible top-level window identities, in desktop Z order.
# Do not read browser profiles, arguments, URLs, tabs, or authentication data.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PagePosterBrowserWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$ppBrowserNames=@{chrome='Chrome';msedge='Edge';firefox='Firefox';brave='Brave';opera='Opera';vivaldi='Vivaldi'}
$ppWindow=[PagePosterBrowserWindow]::GetTopWindow([IntPtr]::Zero)
$ppSeen=[System.Collections.Generic.HashSet[IntPtr]]::new()
while($ppWindow -ne [IntPtr]::Zero -and $ppSeen.Count -lt 400 -and $ppSeen.Add($ppWindow)){
 if([PagePosterBrowserWindow]::IsWindowVisible($ppWindow) -and -not [PagePosterBrowserWindow]::IsIconic($ppWindow)){
  [uint32]$ppBrowserProcessId=0
  [void][PagePosterBrowserWindow]::GetWindowThreadProcessId($ppWindow,[ref]$ppBrowserProcessId)
  try{
   $ppBrowserProcess=Get-Process -Id $ppBrowserProcessId -ErrorAction Stop
   if($ppBrowserNames.ContainsKey($ppBrowserProcess.ProcessName) -and $ppBrowserProcess.Path){
    @{executable=$ppBrowserProcess.Path;name=$ppBrowserNames[$ppBrowserProcess.ProcessName]} | ConvertTo-Json -Compress
    exit 0
   }
  }catch{}
 }
 $ppWindow=[PagePosterBrowserWindow]::GetWindow($ppWindow,2)
}
