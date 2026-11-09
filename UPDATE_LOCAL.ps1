param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'git\kalshi-pro-astra'),
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$remote = 'https://github.com/lotuswill/kalshi-pro-astra.git'
$target = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
if ((Split-Path -Leaf $target) -ne 'kalshi-pro-astra') {
  throw 'The destination must be named kalshi-pro-astra. The Claude folder is never a destination.'
}
foreach ($command in @('git', 'node', 'npm.cmd')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Install $command before running this updater. Node.js 24.15+ (24.x) is recommended."
  }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Node.js version.' }
$node = [version]$nodeVersion.Trim().TrimStart('v')
$supported = ($node.Major -eq 22 -and $node -ge [version]'22.22.2') -or
             ($node.Major -eq 24 -and $node -ge [version]'24.15.0') -or
             ($node.Major -ge 26)
if (-not $supported) { throw 'Use Node.js 24.15+ (24.x), 22.22.2+ (22.x), or 26+ for the test tools.' }
if (-not $NoStart) {
  $listener = Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw 'Port 5174 is in use. Stop the existing Astra server with Ctrl+C, then run this updater again.' }
}
if (Test-Path -LiteralPath $target) {
  if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Destination is a link or junction; update its real repository explicitly.'
  }
}
if (Test-Path -LiteralPath (Join-Path $target '.git') -PathType Leaf) {
  throw 'Destination is a linked Git worktree. Update it through its owning repository; no files were moved.'
}
if (Test-Path -LiteralPath (Join-Path $target '.git')) {
  $oldRemote = & git -C $target remote get-url origin
  if ($LASTEXITCODE -ne 0) { throw 'Existing repository has no readable origin. Review it before updating.' }
  if ($oldRemote -notin @($remote, 'https://github.com/lotuswill/kalshi-pro-astra', 'git@github.com:lotuswill/kalshi-pro-astra.git')) {
    throw "Existing origin is not the Astra repository: $oldRemote. No files were moved."
  }
}
$parent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$staging = Join-Path $parent ('.kalshi-astra-update-' + $suffix)
$backup = Join-Path $parent ('kalshi-pro-astra-backup-' + $suffix)
$oldMoved = $false
$newInstalled = $false
try {
  Write-Host 'Downloading the Astra repository into a separate staging folder...'
  & git clone --branch main --single-branch -- $remote $staging
  if ($LASTEXITCODE -ne 0) { throw 'Clone failed. Existing files were not changed.' }
  Push-Location -LiteralPath $staging
  try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Existing files were not changed.' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Existing files were not changed.' }
    & npm.cmd run test:ui
    if ($LASTEXITCODE -ne 0) { throw 'Interface tests failed. Existing files were not changed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Existing files were not changed.' }
  } finally { Pop-Location }
  # Move outside the target even when this script was launched from inside it.
  Set-Location -LiteralPath $parent
  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup
    $oldMoved = $true
  }
  try {
    Move-Item -LiteralPath $staging -Destination $target
    $newInstalled = $true
  } catch {
    if ($oldMoved -and -not (Test-Path -LiteralPath $target)) {
      Move-Item -LiteralPath $backup -Destination $target
      $oldMoved = $false
    }
    throw
  }
  Write-Host "Updated: $target"
  if ($oldMoved) {
    Write-Host "Previous folder preserved: $backup"
    Write-Host 'Unpublished changes and local-only files remain in that backup; they were not merged or discarded.'
  }
  & git -C $target log -1 --format='%h %s'
  if (-not $NoStart) {
    $quotedTarget = $target.Replace("'", "''")
    $startCommand = "Set-Location -LiteralPath '$quotedTarget'; npm.cmd run dev"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startCommand))
    Start-Process powershell.exe -ArgumentList @('-NoExit', '-EncodedCommand', $encoded)
    Write-Host 'Open http://127.0.0.1:5174 after the server reports ready. Keep its terminal open.'
  } else {
    Write-Host "Run START.bat in $target when ready."
  }
} catch {
  if (-not $newInstalled) { Write-Host "Update did not finish. Staging files, if any, remain at: $staging" }
  throw
}
