# Open the counter app from other devices on the Wi-Fi/LAN

The counter's dev server (Vite, port 5173) proxies `/api` to the API on `localhost:3000`, so only port 5173 has to be reachable. The API already listens on `0.0.0.0`.

## Quick way

```powershell
pnpm run db:up                                   # Postgres, once
powershell -ExecutionPolicy Bypass -File scripts\lan.ps1 -OpenFirewall   # -OpenFirewall: admin shell, first time only
```

The script prints `http://<your-LAN-IP>:5173`. Open that on the phone/tablet (same network).

## Manual steps

1. **Find your LAN IP.** `ipconfig` -> IPv4 Address of the active Wi-Fi/Ethernet adapter. Ignore `vEthernet (WSL…)` / `Default Switch` entries; other devices can't reach them.
2. **Bind Vite to all interfaces.** Done in `apps/counter/vite.config.ts` (`server.host: true`, `preview.host: true`). Without it Vite listens on localhost only.
3. **Start the stack.** `pnpm run db:up`, then `pnpm --filter @pos/api run dev` and `pnpm --filter @pos/counter run dev`.
4. **Allow the port in Windows Firewall** (admin PowerShell):
   `New-NetFirewallRule -DisplayName "POS counter dev" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Domain`
   Make sure the Wi-Fi network is set to *Private*.
5. **Browse** to `http://<LAN-IP>:5173` from the other device.

## Docker stack alternative

`pnpm run env:up` serves the counter + API on port **8080**. Open `http://<LAN-IP>:8080` and allow TCP 8080 in the firewall.

## Troubleshooting

- **Page doesn't load:** firewall rule missing, network profile is Public, or the router has client/AP isolation (common on guest Wi-Fi).
- **IP changed:** DHCP reassigns addresses; reserve one in the router or rerun the script.
- **Offline/PWA features:** service workers and some browser APIs need a secure context. `http://<LAN-IP>` is not one (only `localhost` is), so the service worker won't register on other devices. Serve over HTTPS for that (e.g. a mkcert certificate with Vite's `server.https`).
- **Production builds** (`vite preview`, port 4173) are also bound to all interfaces now.
