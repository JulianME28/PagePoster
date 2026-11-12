$ErrorActionPreference = 'Stop'
$ppApp = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\PagePoster Desktop\PagePoster.exe'))
try {
  if (-not (Test-Path -LiteralPath $ppApp -PathType Leaf)) {
    throw "PagePoster Desktop is missing. From $PSScriptRoot run Node.js 24 with scripts\build-desktop.cjs, then launch PagePoster again. Expected application: $ppApp"
  }
  Start-Process -FilePath $ppApp -WorkingDirectory (Split-Path -Parent $ppApp) -WindowStyle Normal
} catch {
  $ppMessage = $_.Exception.Message
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($ppMessage, 'PagePoster Desktop', 'OK', 'Error')
  } catch {
    [Console]::Error.WriteLine($ppMessage)
  }
  exit 1
}
