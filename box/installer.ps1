# Installation de l'Aphrody Box sous Windows (Docker Desktop) : même déroulé que installer.sh.
#   powershell -c "irm https://raw.githubusercontent.com/aphrody-labs/auto/main/box/installer.ps1 | iex"
# Options : $env:BOX_DOSSIER (défaut ~\aphrody-box), $env:BOX_EMAIL, $env:BOX_DOMAINE.
$ErrorActionPreference = 'Stop'

function Dire($t) { Write-Host $t -ForegroundColor Cyan }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker Desktop est requis : https://www.docker.com/products/docker-desktop/" }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker ne répond pas : lancez Docker Desktop puis relancez ce script." }

$dossier = if ($env:BOX_DOSSIER) { $env:BOX_DOSSIER } else { Join-Path $HOME 'aphrody-box' }
if ((Test-Path .\compose.yaml) -and (Select-String -Quiet -Path .\compose.yaml -Pattern 'name: aphrody-box')) { $dossier = (Get-Location).Path }
New-Item -ItemType Directory -Force $dossier | Out-Null
Set-Location $dossier

if (-not (Test-Path compose.yaml) -or $env:BOX_MAJ -eq '1') {
  Dire "Téléchargement de la boîte dans $dossier…"
  $archive = Join-Path $env:TEMP 'aphrody-box.tar.gz'
  Invoke-WebRequest https://codeload.github.com/aphrody-labs/auto/tar.gz/refs/heads/main -OutFile $archive
  tar -xzf $archive --strip-components=2 auto-main/box
  Remove-Item $archive
}

$image = if ($env:BOX_IMAGE_CONSOLE) { $env:BOX_IMAGE_CONSOLE } else { 'ghcr.io/aphrody-labs/aphrody-box:latest' }
docker pull -q $image *> $null
if ($LASTEXITCODE -ne 0) {
  Dire "Image de la console introuvable en ligne : construction sur cette machine (quelques minutes)…"
  docker build -q -t $image console | Out-Null
}

$gpu = '--sans-gpu'
if ((Get-Command nvidia-smi -ErrorAction SilentlyContinue) -and ((docker info 2>$null) -match 'nvidia')) { $gpu = '--gpu' }
$hote = if ($env:BOX_HOTE) { $env:BOX_HOTE } else {
  (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.254*' } |
    Select-Object -First 1).IPAddress
}
if (-not $hote) { $hote = 'localhost' }

$args_ = @('preparer', '/box', $gpu, '--hote', $hote)
if ($env:BOX_EMAIL) { $args_ += @('--email', $env:BOX_EMAIL) }
if ($env:BOX_DOMAINE) { $args_ += @('--domaine', $env:BOX_DOMAINE) }
docker run --rm -v "${dossier}:/box" $image @args_
if ($LASTEXITCODE -ne 0) { throw "préparation impossible" }

Dire "Démarrage des services (le premier lancement télécharge les images et un modèle d'IA de 2,5 Go)…"
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { throw "démarrage impossible : docker compose logs" }

$mdp = (Select-String -Path .env -Pattern "^BOX_ADMIN_MOT_DE_PASSE='(.*)'$").Matches[0].Groups[1].Value
$url = if ($env:BOX_DOMAINE) { "https://console.$($env:BOX_DOMAINE)" } else { "http://${hote}:8080" }
Write-Host ""
Dire "L'Aphrody Box est lancée."
Write-Host "  Console : $url"
Write-Host "  Identifiant : admin"
Write-Host "  Mot de passe : $mdp"
Write-Host "Les accès d'Auto, n8n, Hermes et Obsidian sont dans la console, section « Accès »."
