// Watchdog loop. Runs as a Windows service via WinSW (pixlwatchdog.exe) under
// portable Node from %ProgramData%\Pixl\watchdog\node.exe. Every few seconds it
// checks whether the Pixl kiosk process is alive and relaunches it if not.
// Kept intentionally tiny and dependency-free so it is robust.
//
// IMPORTANT: This service runs as SYSTEM in Session 0. Plain spawn(EXE) would
// start Pixl as SYSTEM in Session 0 (black screen on the cafe desktop). Relaunch
// must target the active console session via CreateProcessAsUser (or schtasks /IT).

const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CHECK_INTERVAL_MS = Number(process.env.PIXL_WATCHDOG_INTERVAL || 5000)
const RELAUNCH_COOLDOWN_MS = 1500
// Path to the installed Pixl executable. Set at service-install time.
const EXE_PATH = process.env.PIXL_EXE || ''
const EXE_NAME = EXE_PATH ? path.basename(EXE_PATH) : 'Pixl.exe'
const PUBLIC_DIR =
  process.env.PUBLIC || path.join(process.env.SystemDrive || 'C:', 'Users', 'Public')
const MAINTENANCE_FLAG = path.join(PUBLIC_DIR, 'Pixl', 'maintenance.stop')
// Persistent master-disable (survives reboot). Presence alone is enough.
const DISABLED_FLAG = path.join(PUBLIC_DIR, 'Pixl', 'disabled.flag')
// Allow a few seconds of clock/uptime skew between app and service.
const BOOT_STAMP_TOLERANCE_SEC = 5

/** @type {number} 0 = no pending relaunch; else earliest Date.now() to relaunch */
let pendingRelaunchAt = 0

function log(msg) {
  console.log(`[watchdog ${new Date().toISOString()}] ${msg}`)
}

function getBootStamp() {
  return Math.floor((Date.now() - os.uptime() * 1000) / 1000)
}

/** @returns {boolean} true if relaunch should be skipped (admin master-disable). */
function isAppDisabled() {
  return fs.existsSync(DISABLED_FLAG)
}

/** @returns {boolean} true if relaunch should be skipped (active maintenance). */
function isMaintenanceActive() {
  if (!fs.existsSync(MAINTENANCE_FLAG)) return false
  let flagStamp = NaN
  try {
    flagStamp = Number(fs.readFileSync(MAINTENANCE_FLAG, 'utf8').trim())
  } catch {
    try {
      fs.unlinkSync(MAINTENANCE_FLAG)
    } catch {
      /* ignore */
    }
    return false
  }
  if (!Number.isFinite(flagStamp)) {
    try {
      fs.unlinkSync(MAINTENANCE_FLAG)
    } catch {
      /* ignore */
    }
    return false
  }
  const boot = getBootStamp()
  if (Math.abs(flagStamp - boot) <= BOOT_STAMP_TOLERANCE_SEC) {
    return true
  }
  // Stale flag from a previous boot — clear and protect.
  try {
    fs.unlinkSync(MAINTENANCE_FLAG)
    log(`Cleared stale maintenance flag (flag=${flagStamp}, boot=${boot})`)
  } catch {
    /* ignore */
  }
  return false
}

/**
 * List Pixl processes: { pid, sessionId, commandLine }[].
 * @param {(rows: Array<{pid:number,sessionId:number,commandLine:string}>) => void} cb
 */
function listPixlProcesses(cb) {
  const name = EXE_NAME.replace(/'/g, "''")
  const ps =
    `$ErrorActionPreference='SilentlyContinue';` +
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" |` +
    ` Select-Object ProcessId,SessionId,CommandLine | ConvertTo-Json -Compress`
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
    (err, stdout) => {
      if (err || !stdout || !String(stdout).trim()) return cb([])
      try {
        const parsed = JSON.parse(String(stdout).trim())
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        cb(
          arr
            .map((r) => ({
              pid: Number(r.ProcessId),
              sessionId: Number(r.SessionId),
              commandLine: String(r.CommandLine || '')
            }))
            .filter((r) => Number.isFinite(r.pid) && r.pid > 0)
        )
      } catch {
        cb([])
      }
    }
  )
}

function isMainProcess(commandLine) {
  // Electron helpers always include --type=; the browser/main process does not.
  // Empty/unknown command lines are not treated as a healthy main (avoid false
  // "alive" when CIM omits CommandLine on orphans).
  if (!commandLine || !String(commandLine).trim()) return false
  return !/--type=/i.test(commandLine)
}

function killPids(pids, cb) {
  if (!pids.length) return cb()
  let left = pids.length
  for (const pid of pids) {
    log(`Killing non-interactive/orphan pid=${pid}`)
    execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, () => {
      if (--left === 0) cb()
    })
  }
}

/**
 * Alive only if a main Pixl process exists in an interactive session (SessionId > 0).
 * Session 0 / orphan --type= helpers are killed so relaunch can proceed.
 * @param {(alive: boolean) => void} cb
 */
function isRunning(cb) {
  listPixlProcesses((rows) => {
    if (!rows.length) return cb(false)

    const interactiveMain = rows.filter(
      (r) => r.sessionId > 0 && isMainProcess(r.commandLine)
    )
    if (interactiveMain.length > 0) {
      return cb(true)
    }

    // Only Session 0 and/or orphan renderer/GPU helpers — not a healthy kiosk.
    const killIds = rows.map((r) => r.pid)
    log(
      `No interactive main ${EXE_NAME}; cleaning ${killIds.length} Session0/orphan process(es)`
    )
    killPids(killIds, () => cb(false))
  })
}

function runPowershellFile(scriptBody, args, cb) {
  const hash = crypto.createHash('sha1').update(scriptBody).digest('hex').slice(0, 12)
  const tmp = path.join(os.tmpdir(), `pixl-watchdog-${hash}.ps1`)
  try {
    fs.writeFileSync(tmp, scriptBody, 'utf8')
  } catch (err) {
    return cb(new Error(`write ps1 failed: ${err}`), '')
  }
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tmp,
      ...args
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      cb(err, String(stdout || '').trim(), String(stderr || '').trim())
    }
  )
}

/** Launch EXE into the active console session as the logged-on user. */
function launchCreateProcessAsUser(cb) {
  const script = `
param([Parameter(Mandatory=$true)][string]$ExePath)
$ErrorActionPreference = 'Stop'
$cls = 'PixlWtsLaunch_' + [guid]::NewGuid().ToString('N')
$launchType = Add-Type -PassThru -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class $cls {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError = true)]
  public static extern bool WTSQueryUserToken(uint SessionId, out IntPtr phToken);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool DuplicateTokenEx(
    IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes,
    int ImpersonationLevel, int TokenType, out IntPtr phNewToken);
  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(
    IntPtr hToken, string lpApplicationName, string lpCommandLine,
    IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
    uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  public static string Launch(string exePath) {
    uint sessionId = WTSGetActiveConsoleSessionId();
    if (sessionId == 0xFFFFFFFFu) return "FAIL session=invalid";
    IntPtr userToken = IntPtr.Zero;
    if (!WTSQueryUserToken(sessionId, out userToken)) {
      return "FAIL WTSQueryUserToken session=" + sessionId + " err=" + Marshal.GetLastWin32Error();
    }
    IntPtr primary = IntPtr.Zero;
    // MAXIMUM_ALLOWED; SecurityImpersonation=2, TokenPrimary=1
    if (!DuplicateTokenEx(userToken, 0x02000000u, IntPtr.Zero, 2, 1, out primary)) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(userToken);
      return "FAIL DuplicateTokenEx session=" + sessionId + " err=" + err;
    }
    IntPtr env = IntPtr.Zero;
    if (!CreateEnvironmentBlock(out env, primary, false)) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(primary);
      CloseHandle(userToken);
      return "FAIL CreateEnvironmentBlock session=" + sessionId + " err=" + err;
    }
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = "winsta0\\\\default";
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    // CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS
    const uint flags = 0x00000400u | 0x00000008u;
    string workDir = System.IO.Path.GetDirectoryName(exePath);
    bool ok = CreateProcessAsUser(
      primary, exePath, null, IntPtr.Zero, IntPtr.Zero, false,
      flags, env, workDir, ref si, out pi);
    int last = Marshal.GetLastWin32Error();
    if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
    CloseHandle(primary);
    CloseHandle(userToken);
    if (!ok) return "FAIL CreateProcessAsUser session=" + sessionId + " err=" + last;
    return "OK session=" + sessionId + " pid=" + pi.dwProcessId;
  }
}
"@
if ($launchType -is [array]) { $launchType = $launchType[0] }
$launchType::Launch($ExePath)
`.trim()

  runPowershellFile(script, ['-ExePath', EXE_PATH], (err, stdout, stderr) => {
    const line = stdout || stderr || (err ? String(err.message || err) : '')
    if (line.startsWith('OK ')) {
      log(`CreateProcessAsUser ${line}`)
      return cb(true, line)
    }
    log(`CreateProcessAsUser failed: ${line || 'unknown'}`)
    cb(false, line)
  })
}

/** Fallback: schtasks /Create + /Run with /IT for the console user. */
function launchSchtasks(cb) {
  // Resolve DOMAIN\user for /RU; explorer owner is a good hint when CIM user is empty.
  const resolveScript = `
$ErrorActionPreference = 'SilentlyContinue'
$u = (Get-CimInstance Win32_ComputerSystem).UserName
if ($u) { Write-Output $u; exit 0 }
$typeName = 'PixlWtsSess_' + [guid]::NewGuid().ToString('N')
$sessType = Add-Type -PassThru -Namespace PixlWts -Name $typeName -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
"@
if ($sessType -is [array]) { $sessType = $sessType[0] }
$sid = $sessType::WTSGetActiveConsoleSessionId()
$proc = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
  Where-Object { $_.SessionId -eq $sid } |
  Select-Object -First 1
if (-not $proc) { exit 1 }
$owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
if ($owner.User) {
  if ($owner.Domain) { Write-Output ("{0}\{1}" -f $owner.Domain, $owner.User) }
  else { Write-Output $owner.User }
  exit 0
}
exit 1
`.trim()

  runPowershellFile(resolveScript, [], (err, user) => {
    if (err || !user) {
      log(`schtasks fallback: could not resolve console user (${err || 'empty'})`)
      return cb(false)
    }
    const taskName = 'PixlWatchdogRelaunch'
    const tr = `"${EXE_PATH}"`
    // /IT = interactive only when that user is logged on; /F overwrite.
    execFile(
      'schtasks.exe',
      [
        '/Create',
        '/TN',
        taskName,
        '/TR',
        tr,
        '/SC',
        'ONCE',
        '/ST',
        '00:00',
        '/RU',
        user,
        '/NP',
        '/IT',
        '/F'
      ],
      { windowsHide: true },
      (createErr, createOut, createErrOut) => {
        if (createErr) {
          log(
            `schtasks /Create failed for user=${user}: ${createErrOut || createErr.message || createErr}`
          )
          return cb(false)
        }
        log(`schtasks /Create ok user=${user} ${String(createOut || '').trim()}`)
        execFile(
          'schtasks.exe',
          ['/Run', '/TN', taskName],
          { windowsHide: true },
          (runErr, runOut, runErrOut) => {
            if (runErr) {
              log(`schtasks /Run failed: ${runErrOut || runErr.message || runErr}`)
              return cb(false)
            }
            log(`schtasks /Run ok ${String(runOut || '').trim()}`)
            cb(true)
          }
        )
      }
    )
  })
}

function relaunch() {
  if (!EXE_PATH) {
    log('PIXL_EXE not configured; cannot relaunch.')
    return
  }
  if (!fs.existsSync(EXE_PATH)) {
    log(`PIXL_EXE missing on disk: ${EXE_PATH}`)
    return
  }
  log(`Relaunching into active console session: ${EXE_PATH}`)
  launchCreateProcessAsUser((ok) => {
    if (ok) return
    log('CreateProcessAsUser failed; trying schtasks /IT fallback')
    launchSchtasks((ok2) => {
      if (ok2) return
      // Prefer NEVER falling back to Session 0 spawn — cafe would get a black screen.
      log(
        'CRITICAL: could not relaunch into interactive session ' +
          '(CreateProcessAsUser + schtasks /IT both failed). ' +
          'NOT spawning in Session 0. Check that a cafe user is logged on.'
      )
    })
  })
}

function tick() {
  isRunning((alive) => {
    if (alive) {
      pendingRelaunchAt = 0
      return
    }
    log(`${EXE_NAME} not running (no interactive main process).`)
    if (isAppDisabled()) {
      pendingRelaunchAt = 0
      log('Disabled flag present; skipping relaunch (master disable).')
      return
    }
    if (isMaintenanceActive()) {
      pendingRelaunchAt = 0
      log('Maintenance flag matches current boot; skipping relaunch.')
      return
    }
    const now = Date.now()
    if (!pendingRelaunchAt) {
      pendingRelaunchAt = now + RELAUNCH_COOLDOWN_MS
      log(`Death detected; cooldown ${RELAUNCH_COOLDOWN_MS}ms before relaunch`)
      return
    }
    if (now < pendingRelaunchAt) return
    pendingRelaunchAt = 0
    relaunch()
  })
}

log(`Watchdog started. Watching ${EXE_NAME} every ${CHECK_INTERVAL_MS}ms.`)
setInterval(tick, CHECK_INTERVAL_MS)
tick()
