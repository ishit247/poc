# Serves the counter app on the local network (dev mode) and prints the URL to open from phones/tablets.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\lan.ps1 [-OpenFirewall]
# Needs Postgres up first (`pnpm run db:up`). -OpenFirewall must be run from an admin shell.
param([switch]$OpenFirewall)

$root = Split-Path $PSScriptRoot -Parent

# LAN address: IPv4 on the interface that holds the default route (skips WSL/Hyper-V virtual switches).
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex | Select-Object -First 1).IPAddress

if ($OpenFirewall) {
  New-NetFirewallRule -DisplayName 'POS counter dev' -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
  Write-Host 'Firewall: allowed inbound TCP 5173 (Private/Domain networks)'
}

Write-Host "`nCounter on the network:  http://${ip}:5173`n(API is proxied under /api, so port 3000 need not be opened)`n"

Push-Location $root
$api = Start-Process pnpm -ArgumentList '--filter','@pos/api','run','dev' -PassThru -NoNewWindow
try { pnpm --filter '@pos/counter' run dev } finally { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue; Pop-Location }
