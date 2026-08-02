# Watchdog runtime binaries

Populated by `node scripts/fetch-watchdog-runtime.js` (also run before `npm run package:win`):

- `node.exe` — portable Node used by the Windows service to run `watchdog-runner.js`
- `winsw.exe` — WinSW.NET461, renamed to `pixlwatchdog.exe` at install time
- `winsw.exe.config` — .NET 4 startup config

These files are gitignored; cafe PCs get them via the NSIS `resources/watchdog/runtime/` payload.
