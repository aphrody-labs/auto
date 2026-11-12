param([string]$Destination = "$PSScriptRoot/../.cache/video-outils")
$ErrorActionPreference = 'Stop'
$videoTools = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $videoTools | Out-Null
$videoArchive = Join-Path $videoTools 'ffmpeg.zip'
$videoChecksum = Join-Path $videoTools 'ffmpeg.sha256'
Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $videoArchive
Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' -OutFile $videoChecksum
$videoActual = (Get-FileHash -LiteralPath $videoArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$videoExpected = (Get-Content -LiteralPath $videoChecksum -Raw).Trim().Split(' ')[0].ToLowerInvariant()
if ($videoActual -ne $videoExpected) { throw 'Empreinte SHA-256 FFmpeg incorrecte' }
Expand-Archive -LiteralPath $videoArchive -DestinationPath $videoTools -Force
Write-Output "FFmpeg téléchargé et vérifié : $videoActual"
Get-ChildItem -LiteralPath $videoTools -Recurse -Filter 'ffmpeg.exe' | Select-Object -ExpandProperty FullName
