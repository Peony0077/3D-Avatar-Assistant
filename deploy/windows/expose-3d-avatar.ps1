#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Publishes the 3D Avatar Assistant (running inside WSL2) on this PC's TCP ports 80 and 443.

.DESCRIPTION
  WSL2 in NAT mode sits behind Windows on a private 172.x address that changes on every restart,
  so the public ports must be forwarded into it. This script:
    1. finds the WSL distro that holds the project (or pass -Distro),
    2. enables systemd lingering for the Linux user, so the web + TTS services start with WSL,
    3. opens Windows Firewall for inbound TCP 80 and 443,
    4. forwards 0.0.0.0:80 -> WSL:8080 and 0.0.0.0:443 -> WSL:8443 (netsh portproxy),
    5. registers the scheduled task "3D Avatar - WSL", which at every boot starts WSL, points the
       forwarding at WSL's new address and keeps WSL running (restarting it if it stops).
  Safe to re-run. -Remove undoes steps 3-5.

.EXAMPLE
  # In an elevated (Run as administrator) PowerShell on the Windows PC:
  powershell -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu\home\peony\projects\3D-Avatar-Assistant\deploy\windows\expose-3d-avatar.ps1"

.EXAMPLE
  ...\expose-3d-avatar.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$Distro,
    [string]$LinuxUser = "peony",
    [string]$ProjectDir = "/home/peony/projects/3D-Avatar-Assistant",
    [switch]$Remove,
    [switch]$Refresh  # used by the scheduled task
)

$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"  # make wsl.exe print UTF-8 instead of UTF-16

$TaskName   = "3D Avatar - WSL"
$RuleName   = "3D Avatar (HTTP/HTTPS)"
$InstallDir = Join-Path $env:ProgramData "3d-avatar"
$LogFile    = Join-Path $InstallDir "wsl-forward.log"
# Public port -> Caddy port inside WSL. (Plain hashtable on purpose: an [ordered] one would read
# $Ports[80] as "the 80th entry".)
$Ports      = @{ 80 = 8080; 443 = 8443 }

function Write-Log([string]$Message) {
    $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message
    Write-Host $line
    if (Test-Path $InstallDir) { Add-Content -Path $LogFile -Value $line }
}

# Runs wsl.exe without letting stderr abort the script (Windows PowerShell 5.1 quirk).
function Invoke-Wsl([string[]]$WslArgs) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & wsl.exe @WslArgs 2>$null } finally { $ErrorActionPreference = $saved }
}

function Find-Distro {
    if ($Distro) { return $Distro }
    $names = Invoke-Wsl @("--list", "--quiet") | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ }
    foreach ($name in $names) {
        Invoke-Wsl @("-d", $name, "-u", $LinuxUser, "-e", "test", "-d", $ProjectDir) | Out-Null
        if ($LASTEXITCODE -eq 0) { return $name }
    }
    throw "No WSL distro has $ProjectDir for user '$LinuxUser'. Run 'wsl -l -v' and pass -Distro <name>."
}

function Get-WslIp([string]$Name) {
    for ($i = 0; $i -lt 30; $i++) {
        $out = Invoke-Wsl @("-d", $Name, "-u", $LinuxUser, "-e", "ip", "-4", "-o", "addr", "show", "dev", "eth0")
        if ("$out" -match "inet (\d+\.\d+\.\d+\.\d+)/") { return $Matches[1] }
        Start-Sleep -Seconds 2
    }
    throw "Could not read the eth0 address of WSL distro '$Name'."
}

function Set-Forwarding([string]$Ip) {
    foreach ($p in $Ports.Keys) {
        netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$($Ports[$p]) connectaddress=$Ip | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "netsh portproxy failed for port $p." }
    }
    Write-Log ("Forwarding " + (($Ports.Keys | Sort-Object | ForEach-Object { "${_}->${Ip}:$($Ports[$_])" }) -join ", "))
}

function Remove-Forwarding {
    foreach ($p in $Ports.Keys) {
        netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
    }
}

# --- Scheduled-task mode: runs at boot, keeps WSL up and the forwarding current -------------------
if ($Refresh) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    while ($true) {
        try { Set-Forwarding (Get-WslIp $Distro) } catch { Write-Log "Refresh failed: $_" }
        Write-Log "Keeping WSL distro '$Distro' running"
        Invoke-Wsl @("-d", $Distro, "-u", $LinuxUser, "-e", "sleep", "infinity") | Out-Null
        Write-Log "WSL stopped (exit $LASTEXITCODE); starting it again in 30 s"
        Start-Sleep -Seconds 30
    }
}

# --- Uninstall ------------------------------------------------------------------------------------
if ($Remove) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Remove-Forwarding
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    Write-Host "Removed the task, firewall rule and port forwarding. (Linux lingering was left on.)"
    return
}

# --- Install --------------------------------------------------------------------------------------
$Distro = Find-Distro
Write-Host "WSL distro: $Distro"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Something else on Windows already listening on 80/443 (IIS, another web server) would win.
$proxyPid = (Get-CimInstance Win32_Service -Filter "Name='iphlpsvc'").ProcessId
foreach ($p in $Ports.Keys) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -ne $proxyPid } | Select-Object -First 1
    if ($busy) {
        $proc = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Write-Warning "Port $p is already used by PID $($busy.OwningProcess) ($proc). Stop that service or forwarding won't work."
    }
}

# 2. Linux services start with WSL, without anyone logged in to Linux.
Invoke-Wsl @("-d", $Distro, "-u", "root", "-e", "loginctl", "enable-linger", $LinuxUser) | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "Could not enable lingering for '$LinuxUser' (is systemd enabled?)." }

# 3. Firewall
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort ([string[]]@($Ports.Keys)) -Profile Any | Out-Null

# 4. Port forwarding (needs the IP Helper service)
Set-Service -Name iphlpsvc -StartupType Automatic
Start-Service -Name iphlpsvc
Set-Forwarding (Get-WslIp $Distro)

# 5. Boot task. WSL distros belong to a Windows account, so the task runs as this account; storing
#    its password lets the task run at boot even when nobody is signed in.
$self = Join-Path $InstallDir "expose-3d-avatar.ps1"
Copy-Item -LiteralPath $PSCommandPath -Destination $self -Force
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Refresh -Distro `"$Distro`" -LinuxUser `"$LinuxUser`""
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArgs
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$user = "$env:USERDOMAIN\$env:USERNAME"
$cred = $null
try {
    $cred = Get-Credential -UserName $user -Message "Windows password for $user. Task Scheduler stores it so WSL can start at boot before anyone signs in. Cancel = only while signed in."
} catch { }
if ($cred) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
        -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Highest | Out-Null
} else {
    Write-Warning "No password given: the site will only be up while $user is signed in to Windows."
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null
}
Start-ScheduledTask -TaskName $TaskName

# Summary
$lan = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } | Select-Object -First 1
Write-Host ""
Write-Host "Done. Windows side is ready."
if ($lan) {
    Write-Host ("Router: forward TCP 80 and 443 to {0} (this PC; give it a DHCP reservation). Router admin is usually http://{1}" -f `
        $lan.IPv4Address[0].IPAddress, $lan.IPv4DefaultGateway[0].NextHop)
}
Write-Host "Log: $LogFile"
