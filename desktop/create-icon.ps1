$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$ppBitmap=New-Object Drawing.Bitmap 256,256
$ppGraphics=[Drawing.Graphics]::FromImage($ppBitmap)
$ppGraphics.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
$ppGraphics.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$ppGraphics.Clear([Drawing.Color]::Transparent)
$ppPath=New-Object Drawing.Drawing2D.GraphicsPath
$ppPath.AddArc(0,0,72,72,180,90)
$ppPath.AddArc(184,0,72,72,270,90)
$ppPath.AddArc(184,184,72,72,0,90)
$ppPath.AddArc(0,184,72,72,90,90)
$ppPath.CloseFigure()
$ppBrush=New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(39,94,237))
$ppGraphics.FillPath($ppBrush,$ppPath)
$ppFont=New-Object Drawing.Font 'Segoe UI',145,([Drawing.FontStyle]::Bold),([Drawing.GraphicsUnit]::Pixel)
$ppGraphics.DrawString('P',$ppFont,[Drawing.Brushes]::White,48,30)
$ppPen=New-Object Drawing.Pen ([Drawing.Color]::White),9
$ppPen.StartCap=[Drawing.Drawing2D.LineCap]::Round
$ppPen.EndCap=[Drawing.Drawing2D.LineCap]::Round
$ppGraphics.DrawLine($ppPen,170,80,206,44)
$ppGraphics.DrawLine($ppPen,177,44,206,44)
$ppGraphics.DrawLine($ppPen,206,44,206,73)
$ppMemory=New-Object IO.MemoryStream
$ppBitmap.Save($ppMemory,[Drawing.Imaging.ImageFormat]::Png)
$ppPng=$ppMemory.ToArray()
$ppOutput=Join-Path $PSScriptRoot 'icon.ico'
$ppStream=[IO.File]::Create($ppOutput)
$ppWriter=New-Object IO.BinaryWriter $ppStream
$ppWriter.Write([uint16]0);$ppWriter.Write([uint16]1);$ppWriter.Write([uint16]1)
$ppWriter.Write([byte]0);$ppWriter.Write([byte]0);$ppWriter.Write([byte]0);$ppWriter.Write([byte]0)
$ppWriter.Write([uint16]1);$ppWriter.Write([uint16]32);$ppWriter.Write([uint32]$ppPng.Length);$ppWriter.Write([uint32]22)
$ppWriter.Write($ppPng)
$ppWriter.Dispose();$ppMemory.Dispose();$ppPen.Dispose();$ppFont.Dispose();$ppBrush.Dispose();$ppPath.Dispose();$ppGraphics.Dispose();$ppBitmap.Dispose()
Write-Output $ppOutput
