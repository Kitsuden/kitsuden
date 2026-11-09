# Kitsuden on your Windows machine, with one command. It only needs Docker.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1             create .env, build, start and print the URLs
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun     only create .env and say what it would use
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Rebuild    build again (after updating the code)
#
# For a server with a domain and TLS: scripts/deploy.sh (docs/install/server.md).
#
# It overwrites nothing. If this machine already has another install, it picks
# another prefix (kitsuden2, ...) and other ports: docker-compose.yml names its
# volumes after KITSUDEN_INSTANCE, so without this it would share the first one's
# database. Set $env:KITSUDEN_INSTANCE yourself to choose the prefix.
# Keep in step with install.sh. ASCII only: Windows PowerShell 5.1 reads a file
# without a BOM in the system code page.

param([switch]$DryRun, [switch]$Rebuild)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

$Marker = '# Created by install.sh'

function Stop-Install([string]$Text) {
  [Console]::Error.WriteLine("`nInstall stopped: $Text")
  exit 1
}

function Test-Succeeds([scriptblock]$Command) {
  & $Command *> $null
  return $LASTEXITCODE -eq 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-Install 'Docker is not installed. Get it at https://docs.docker.com/get-docker/ and run this again.'
}
if (-not (Test-Succeeds { docker compose version })) { Stop-Install "this needs the Docker Compose v2 plugin ('docker compose')." }
if (-not (Test-Succeeds { docker info })) { Stop-Install 'Docker is installed but not running. Start it and run this again.' }

# A checkout with an override is a custom deployment: this is not for it.
if (Test-Path docker-compose.override.yml) {
  Stop-Install 'this folder has a docker-compose.override.yml, so it is a custom deployment. Use your own deploy process.'
}

function New-Secret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-EnvValue([string]$Key) {
  $line = Get-Content .env | Where-Object { $_ -like "$Key=*" } | Select-Object -Last 1
  if ($line) { return $line.Substring($Key.Length + 1).Trim() }
  return ''
}

function Test-PortInUse([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    return ($attempt.AsyncWaitHandle.WaitOne(300) -and $client.Connected)
  } catch { return $false } finally { $client.Close() }
}

function Get-FreePort([int]$From) {
  $p = $From
  while (Test-PortInUse $p) { $p++ }
  return $p
}

function Test-InstanceInUse([string]$Name) {
  $containers = docker ps -a --format '{{.Names}}'
  if ($containers -contains "${Name}_db_prod") { return $true }
  return (Test-Succeeds { docker volume inspect "${Name}_postgres_prod" })
}

function Select-Instance {
  if ($env:KITSUDEN_INSTANCE) {
    $name = $env:KITSUDEN_INSTANCE
    if ($name -cnotmatch '^[a-z0-9][a-z0-9_-]*$') {
      Stop-Install "KITSUDEN_INSTANCE can only have lowercase letters, digits, '-' and '_', and must start with a letter or a digit."
    }
    if (Test-InstanceInUse $name) { Stop-Install "the instance '$name' already exists on this machine. Choose another KITSUDEN_INSTANCE." }
    return $name
  }
  $name = 'kitsuden'
  $n = 2
  while (Test-InstanceInUse $name) { $name = "kitsuden$n"; $n++ }
  return $name
}

function New-EnvFile {
  $instance = Select-Instance
  $api = Get-FreePort 3000
  $admin = Get-FreePort 3001
  if ($admin -eq $api) { $admin = Get-FreePort ($api + 1) }
  $db = Get-FreePort 5432
  $valkey = Get-FreePort 6379

  $out = New-Object Collections.Generic.List[string]
  $out.Add("$Marker. Secrets are in here: never commit it, and keep a copy.")
  foreach ($line in Get-Content -Encoding UTF8 .env.production.example) {
    if ($line -like '*=<openssl rand -hex 32>') { $line = $line.Substring(0, $line.IndexOf('=') + 1) + (New-Secret) }
    elseif ($line -match '^(SITE_DOMAIN|ACME_EMAIL|MAIL_FROM)=') { $line = $line.Substring(0, $line.IndexOf('=') + 1) }
    elseif ($line -like 'COMPOSE_PROJECT_NAME=*') { $line = "COMPOSE_PROJECT_NAME=$instance" }
    $out.Add($line)
  }
  $out.Add('')
  $out.Add('# --- This machine (install.ps1) ---')
  $out.Add("KITSUDEN_INSTANCE=$instance")
  $out.Add("KITSUDEN_API_IMAGE=$instance/api:latest")
  $out.Add("KITSUDEN_ADMIN_IMAGE=$instance/admin:latest")
  $out.Add("API_PORT=$api")
  $out.Add("ADMIN_PORT=$admin")
  $out.Add("DB_PORT=$db")
  $out.Add("VALKEY_PORT=$valkey")
  $out.Add("BETTER_AUTH_URL=http://localhost:$api")
  $out.Add("ADMIN_URL=http://localhost:$admin")
  $out.Add("APP_URL=http://localhost:$admin")
  $out.Add("ALLOWED_ORIGINS=http://localhost:$admin,http://127.0.0.1:$admin,http://localhost:$api,http://127.0.0.1:$api")

  if ($out | Where-Object { $_ -match '^[A-Z_]+=<' }) {
    Stop-Install '.env.production.example has a placeholder this script does not know.'
  }
  # No BOM and LF: docker compose would read a BOM as part of the first key.
  [IO.File]::WriteAllText((Join-Path $PWD '.env'), (($out -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}

if (Test-Path .env) {
  # An .env that is not ours may be a real install: it is not touched.
  if (-not (Select-String -Path .env -SimpleMatch $Marker -Quiet)) {
    Stop-Install 'this folder already has a .env that this script did not create. Use scripts/deploy.sh, or move that file away.'
  }
  Write-Host 'Using the existing .env.'
} else {
  if (-not (Test-Path .env.production.example)) { Stop-Install '.env.production.example is missing. Run this from a full copy of the repository.' }
  New-EnvFile
  Write-Host 'Created .env with new random secrets.'
}

$Instance = Get-EnvValue 'KITSUDEN_INSTANCE'
$ApiPort = Get-EnvValue 'API_PORT'
$AdminPort = Get-EnvValue 'ADMIN_PORT'
if ($Instance -ne 'kitsuden') {
  Write-Host "This install is '$Instance': its containers, volumes and ports are its own, and it shares nothing with another Kitsuden."
}

if ($DryRun) {
  Write-Host "Dry run: would start '$Instance' with the API on port $ApiPort and the panel on port $AdminPort."
  exit 0
}

# Nothing is published to a registry yet, so the images are built here.
# One at a time: building them in parallel has brought Docker Desktop down.
function Test-ImageMissing([string]$Image) { return -not (Test-Succeeds { docker image inspect $Image }) }

if ($Rebuild -or (Test-ImageMissing (Get-EnvValue 'KITSUDEN_API_IMAGE'))) {
  Write-Host 'Building the API image. The first time takes 5 to 15 minutes...'
  docker compose -f docker-compose.yml build kitsuden_api
  if ($LASTEXITCODE -ne 0) { Stop-Install 'the API image did not build.' }
}
if ($Rebuild -or (Test-ImageMissing (Get-EnvValue 'KITSUDEN_ADMIN_IMAGE'))) {
  Write-Host 'Building the panel image...'
  docker compose -f docker-compose.yml build kitsuden_admin
  if ($LASTEXITCODE -ne 0) { Stop-Install 'the panel image did not build.' }
}

# Building takes a while: the chosen ports may have been taken since, or since the
# last start. Nobody uses the database and Valkey ports by hand, so those just move;
# the API and panel ports are in the URLs, so stop and say so.
function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = Get-Content .env | ForEach-Object { if ($_ -like "$Key=*") { "$Key=$Value" } else { $_ } }
  [IO.File]::WriteAllText((Join-Path $PWD '.env'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}
if (-not (docker compose -f docker-compose.yml ps -q --status running kitsuden_api 2>$null)) {
  foreach ($key in 'DB_PORT', 'VALKEY_PORT') {
    $current = [int](Get-EnvValue $key)
    if (Test-PortInUse $current) {
      $next = Get-FreePort $current
      Write-Host "Port $current is now in use, so $key moves to $next."
      Set-EnvValue $key $next
    }
  }
  foreach ($port in $ApiPort, $AdminPort) {
    if (Test-PortInUse ([int]$port)) { Stop-Install "port $port is in use by another program. Close it and run this again." }
  }
}

Write-Host 'Starting...'
docker compose -f docker-compose.yml up -d
if ($LASTEXITCODE -ne 0) { Stop-Install "the containers did not start. Docker's reason is just above." }

function Test-Responds([string]$Url) {
  try {
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $Url).StatusCode -eq 200
  } catch { return $false }
}

$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  if ((Test-Responds "http://127.0.0.1:$AdminPort/") -and (Test-Responds "http://127.0.0.1:$ApiPort/live")) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Stop-Install 'it did not become ready in 3 minutes. See: docker compose -f docker-compose.yml logs kitsuden_api' }

# The API prints the token in its log, and only there. The last one is the valid one:
# each restart makes a new one.
$TokenNote = 'Your administrator already exists: sign in.'
$needsAdmin = $false
try {
  $needsAdmin = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$ApiPort/api/system/init-check").Content -match '"initialized":false'
} catch { $needsAdmin = $false }
if ($needsAdmin) {
  $log = @(docker compose -f docker-compose.yml logs --no-log-prefix kitsuden_api 2>$null)
  $token = ''
  for ($i = 0; $i -lt $log.Count - 2; $i++) {
    if ($log[$i] -like '*one-time setup token in the panel*') { $token = $log[$i + 2].Trim() }
  }
  if (-not $token) { $token = '(not found: use the command below)' }
  $TokenNote = @"
It asks for this one-time setup token, which only the API log has:
       $token
     A restart of the API replaces it. To read it again:
       docker compose -f docker-compose.yml logs kitsuden_api | Select-String -Context 0,4 "No administrator"
"@
}

Write-Host @"

Kitsuden is running.

  1. Open the panel and create your administrator:
       http://localhost:$AdminPort
     $TokenNote
     Everything listens on this machine only.

  2. In the panel, go to Agents, create one and copy its key.

  3. Point your MCP client at:
       http://localhost:$ApiPort/api/mcp

  API: http://localhost:$ApiPort    Guide for agents: http://localhost:$ApiPort/llms.txt

  Stop:    docker compose -f docker-compose.yml stop
  Start:   powershell -ExecutionPolicy Bypass -File install.ps1
  Logs:    docker compose -f docker-compose.yml logs -f kitsuden_api
  Delete everything, data included:
           docker compose -f docker-compose.yml down -v
"@
