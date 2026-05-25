const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require('electron');
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const WebSocket = require('ws');
const { extractWAD } = require('@lol-archiver/lol-wad-extract');
const { applyPatches, patchHtml } = require('./scripts/fe-patcher');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const cfg = require('./path-config');
const DEBUG = process.env.DEBUG_LEAGUE_ELECTRON === '1';
const LEAGUE_UA = 'Mozilla/5.0 LeagueOfLegendsClient/16.10.777.2413 (CEF 108)';
const FRONTEND_PREFIX = 'rcp-fe-';
const STATIC_PLUGIN = 'rcp-fe-lol-static-assets';
const PATCHES_DIR = path.join(__dirname, 'patches');
const LEAGUE_START_TIMEOUT_MS = 120000;
const LEAGUE_START_POLL_MS = 1000;
const LEAGUE_READY_TIMEOUT_MS = 120000;
const LOCAL_REQUEST_TIMEOUT_MS = 8000;
const WINDOW_SIZES = [
  { width: 1024, height: 576, scale: 0.8 },
  { width: 1280, height: 720, scale: 1 },
  { width: 1600, height: 900, scale: 1.25 }
];
let shuttingDownLeaguePromise = null;
let allowingWindowClose = false;

process.on('uncaughtException', (error) => {
  console.error(`[main:uncaught] ${error.stack || error.message}`);
});

process.on('unhandledRejection', (error) => {
  console.error(`[main:unhandled] ${error && (error.stack || error.message) || error}`);
});

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

ipcMain.handle('riot-invoke', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return undefined;
  return handleRiotInvoke(win, payload);
});

ipcMain.on('riot-invoke', (event, request) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  handleRiotInvoke(win, { request }).catch((error) => {
    console.error(`[riotInvoke] ${error.message}`);
  });
});

const windowDragState = new WeakMap();

ipcMain.on('league-window-drag-start', (event, point) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !point) return;

  windowDragState.set(win, {
    bounds: win.getBounds(),
    screenX: Number(point.screenX),
    screenY: Number(point.screenY)
  });
});

ipcMain.on('league-window-drag-move', (event, point) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = win && windowDragState.get(win);
  if (!win || !state || !point) return;

  const x = Math.round(state.bounds.x + Number(point.screenX) - state.screenX);
  const y = Math.round(state.bounds.y + Number(point.screenY) - state.screenY);
  win.setPosition(x, y, false);
});

ipcMain.on('league-window-drag-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) windowDragState.delete(win);
});

function readLeagueUxArgs() {
  const leagueProcess = readLeagueUxProcess();
  if (!leagueProcess || !leagueProcess.commandLine) {
    throw new Error('LeagueClientUx.exe is not running.');
  }

  const { commandLine } = leagueProcess;
  const value = (name) => {
    const match = commandLine.match(new RegExp(`--${name}=([^"\\s]+|"[^"]+")`));
    return match ? match[1].replace(/^"|"$/g, '') : null;
  };

  const port = value('app-port');
  const token = value('remoting-auth-token');
  const riotPort = value('riotclient-app-port');
  const riotToken = value('riotclient-auth-token');

  if (!port || !token) {
    throw new Error('Could not find --app-port and --remoting-auth-token in LeagueClientUx.exe command line.');
  }

  return { pid: leagueProcess.pid, port, token, riotPort, riotToken };
}

function readLeagueUxProcess() {
  const ps = [
    '-NoProfile',
    '-Command',
    "$process = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'LeagueClientUx.exe' } | Select-Object -First 1 ProcessId, CommandLine; if ($process) { $process | ConvertTo-Json -Compress }"
  ];
  const output = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  if (!output) return null;
  const parsed = JSON.parse(output);
  return {
    pid: Number(parsed.ProcessId),
    commandLine: parsed.CommandLine || ''
  };
}

function readLeagueClientProcess() {
  const ps = [
    '-NoProfile',
    '-Command',
    "$process = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'LeagueClient.exe' } | Select-Object -First 1 ProcessId, CommandLine; if ($process) { $process | ConvertTo-Json -Compress }"
  ];
  const output = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  if (!output) return null;
  const parsed = JSON.parse(output);
  return {
    pid: Number(parsed.ProcessId),
    commandLine: parsed.CommandLine || ''
  };
}

function readRiotClientProcess() {
  const ps = [
    '-NoProfile',
    '-Command',
    "$process = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Riot Client.exe' } | Select-Object -First 1 ProcessId, CommandLine; if ($process) { $process | ConvertTo-Json -Compress }"
  ];
  const output = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  if (!output) return null;
  const parsed = JSON.parse(output);
  return {
    pid: Number(parsed.ProcessId),
    commandLine: parsed.CommandLine || ''
  };
}

function readRiotClientArgs() {
  const riotProcess = readRiotClientProcess();
  if (!riotProcess || !riotProcess.commandLine) {
    throw new Error('Riot Client.exe is not running.');
  }

  const { commandLine } = riotProcess;
  const value = (name) => {
    const match = commandLine.match(new RegExp(`--${name}=([^"\\s]+|"[^"]+")`));
    return match ? match[1].replace(/^"|"$/g, '') : null;
  };

  const port = value('app-port');
  const token = value('remoting-auth-token');
  if (!port || !token) {
    throw new Error('Could not find --app-port and --remoting-auth-token in Riot Client.exe command line.');
  }

  return { pid: riotProcess.pid, port, token };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestLocalClient({ path, port, token, method = 'GET', body = null, accept }) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      rejectUnauthorized: false,
      auth: `riot:${token}`,
      headers: {
        Accept: accept,
        'User-Agent': LEAGUE_UA,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length
        } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => finish({ path, statusCode: res.statusCode, body: responseBody }));
    });

    req.setTimeout(LOCAL_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out requesting ${path} after ${LOCAL_REQUEST_TIMEOUT_MS}ms.`));
    });
    req.on('error', (error) => finish({ path, error }));
    if (payload) req.write(payload);
    req.end();
  });
}

function quotePowerShellSingle(value) {
  return String(value).replace(/'/g, "''");
}

function startLeagueClient() {
  // Use RiotClientServices with args to start Riot Client hidden
  if (cfg.riotClientServicesExe && fs.existsSync(cfg.riotClientServicesExe)) {
    execFile('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Start-Process -FilePath '.\\RiotClientServices.exe' -ArgumentList '--launch-product=league_of_legends','--launch-patchline=live' -WindowStyle Hidden"
    ], { encoding: 'utf8', cwd: cfg.riotDir }, (error) => {
      if (error && DEBUG) console.error(`[league:start] RiotClientServices error: ${error.message}`);
    });
    return;
  }

  throw new Error(`RiotClientServices.exe not found at ${cfg.riotClientServicesExe}`);
}

function requestRiotClient(path, port, token, method = 'GET', body = null) {
  return requestLocalClient({
    path,
    port,
    token,
    method,
    body,
    accept: 'application/json, text/plain, */*'
  });
}

function parseJsonString(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (_error) {
    return null;
  }
}

function startLeagueFromLaunchConfiguration(launchConfiguration) {
  if (!launchConfiguration || !launchConfiguration.executable || !launchConfiguration.workingDirectory) {
    throw new Error('Missing Riot launch configuration for League.');
  }

  const executable = quotePowerShellSingle(launchConfiguration.executable);
  const workingDirectory = quotePowerShellSingle(launchConfiguration.workingDirectory);
  const arguments = Array.isArray(launchConfiguration.arguments)
    ? launchConfiguration.arguments.map((value) => `'${quotePowerShellSingle(value)}'`).join(', ')
    : '';

  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$argList = @(${arguments}); Start-Process -FilePath '${executable}' -WorkingDirectory '${workingDirectory}' -ArgumentList $argList -WindowStyle Hidden`
  ], { encoding: 'utf8' });
}

async function relaunchLeagueProductFromRiotClient(riot) {
  const path = '/product-launcher/v1/products/league_of_legends/patchlines/live';
  await requestRiotClient(path, riot.port, riot.token, 'DELETE');
  const launchResponse = await requestRiotClient(path, riot.port, riot.token, 'POST');
  return !launchResponse.error && launchResponse.statusCode && launchResponse.statusCode < 400;
}

async function forceLeagueUxLaunchFromRiotClient() {
  const riot = readRiotClientArgs();
  const headlessLeague = !!readLeagueClientProcess();
  if (headlessLeague) {
    const relaunched = await relaunchLeagueProductFromRiotClient(riot);
    if (relaunched) return true;
  }

  const launchResponse = await requestRiotClient('/product-launcher/v1/products/league_of_legends/patchlines/live', riot.port, riot.token, 'POST');
  if (!launchResponse.error && launchResponse.statusCode && launchResponse.statusCode < 400) {
    return true;
  }

  const alreadyLaunched = launchResponse.statusCode === 423 && /already_launched/i.test(launchResponse.body || '');
  if (alreadyLaunched) {
    const relaunched = await relaunchLeagueProductFromRiotClient(riot);
    if (relaunched) return true;
  }

  const sessionsResponse = await requestRiotClient('/product-session/v1/external-sessions', riot.port, riot.token);
  const sessions = parseJsonString(sessionsResponse.body);
  const leagueSession = sessions && Object.values(sessions).find((session) => session && session.productId === 'league_of_legends');
  if (!leagueSession || !leagueSession.launchConfiguration) {
    return false;
  }

  startLeagueFromLaunchConfiguration(leagueSession.launchConfiguration);
  return true;
}

async function ensureLeagueIsRunning() {
  const existingProcess = readLeagueUxProcess();
  if (existingProcess) {
    return {
      league: readLeagueUxArgs(),
      startedByApp: false,
      startedUxPid: null
    };
  }

  const existingHeadlessLeague = readLeagueClientProcess();
  if (!existingHeadlessLeague) {
    startLeagueClient();
  }
  const startedAt = Date.now();
  let forcedLaunchAttempted = false;
  let headlessLeagueSince = existingHeadlessLeague ? Date.now() : null;

  while (Date.now() - startedAt < LEAGUE_START_TIMEOUT_MS) {
    const leagueProcess = readLeagueUxProcess();
    if (leagueProcess) {
      try {
        return {
          league: readLeagueUxArgs(),
          startedByApp: true,
          startedUxPid: leagueProcess.pid
        };
      } catch (_error) {
        // The UX process exists before its remoting args are ready; keep polling.
      }
    }

    const headlessLeague = !!readLeagueClientProcess();
    if (headlessLeague) {
      if (!headlessLeagueSince) headlessLeagueSince = Date.now();
    } else {
      headlessLeagueSince = null;
    }

    if (!forcedLaunchAttempted) {
      try {
        const riot = readRiotClientArgs();
        const phaseResponse = await requestRiotClient('/riot-client-lifecycle/v1/product-context-phase', riot.port, riot.token);
        const phase = parseJsonString(phaseResponse.body);
        const stuckHeadlessLeague = headlessLeague && headlessLeagueSince && (Date.now() - headlessLeagueSince >= 5000);
        if (
          phase === 'WaitForLaunch' ||
          phase === 'WaitForSessionExit' ||
          (phase === 'AppRepairAndUpdate' && stuckHeadlessLeague)
        ) {
          forcedLaunchAttempted = await forceLeagueUxLaunchFromRiotClient();
        }
      } catch (_error) {
        // Riot Client may still be starting up; keep polling.
      }
    }
    await delay(LEAGUE_START_POLL_MS);
  }

  throw new Error(`League client did not become ready within ${LEAGUE_START_TIMEOUT_MS / 1000} seconds.`);
}

async function requestLeagueUxShutdown(league) {
  if (!league) return;
  const result = await requestLeague('/riotclient/kill-ux', league.port, league.token, 'POST');
  if (result.error) {
    throw result.error;
  }
  if (result.statusCode && result.statusCode >= 400) {
    throw new Error(`LCU refused UX shutdown with status ${result.statusCode}.`);
  }
}

async function dismissStockLeagueUx(league, options = {}) {
  const attempts = options.attempts || 8;
  const delayMs = options.delayMs || 750;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await requestLeagueUxShutdown(league);
      return true;
    } catch (error) {
      lastError = error;
      await delay(delayMs);
    }
  }

  if (lastError) throw lastError;
  return false;
}

async function suppressStockLeagueUxAfterLoad(league, options = {}) {
  const pollMs = options.pollMs || 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (readLeagueUxProcess()) {
      try {
        await dismissStockLeagueUx(league, { attempts: 2, delayMs: 500 });
        console.log('[league:kill-ux] dismissed stock League UX window');
      } catch (error) {
        console.error(`[league:kill-ux] ${error.message}`);
      }
    }
    await delay(pollMs);
  }
}


let riotTrayMinimizerProcess = null;

function startRiotClientTrayMinimizer() {
  // Writes the C#/PowerShell blocker script to a temp file and spawns it.
  // SetWinEventHook catches Riot Client windows at creation
  // (EVENT_OBJECT_CREATE), makes them 100% transparent (WS_EX_LAYERED
  // with 0 opacity), then hides them when shown (EVENT_OBJECT_SHOW) —
  // the window is never visible to the user.
  const os = require('node:os');
  const tmpFile = path.join(os.tmpdir(), 'rcb-' + process.pid + '.ps1');
  const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Linq;
public class RiotBlocker {
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eMin, uint eMax, IntPtr hmod, WinEventDelegate d, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hhk);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int MsgWaitForMultipleObjects(int n, IntPtr p, bool fWait, int ms, uint mask);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint f);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern bool DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint c, byte a, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public delegate void WinEventDelegate(IntPtr hHook, uint e, IntPtr hwnd, int idObj, int idChild, uint eThread, uint eTime);
  const uint EVENT_OBJECT_CREATE = 0x8000;
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const uint QS_ALLINPUT = 0xFF;
  const uint WM_SYSCOMMAND = 0x0112;
  const uint SC_MINIMIZE = 0xF020;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_LAYERED = 0x80000;
  const uint LWA_ALPHA = 0x2;

  private static WinEventDelegate _del;
  private static IntPtr _hook;
  private static uint[] _pids = new uint[0];

  public static void RunForever() {
    _del = OnEvent;
    _hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, IntPtr.Zero, _del, 0, 0, WINEVENT_OUTOFCONTEXT);
    int lastPidScan = 0;
    MSG msg;
    while (true) {
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {
        if (msg.message == 0x12) { UnhookWinEvent(_hook); return; }
        TranslateMessage(ref msg);
        DispatchMessage(ref msg);
      }
      int now = Environment.TickCount;
      if (now - lastPidScan > 500) {
        lastPidScan = now;
        try {
          _pids = Process.GetProcessesByName("Riot Client").Select(p => (uint)p.Id).ToArray();
          if (_pids.Length > 0) HideExisting(_pids);
        } catch { _pids = new uint[0]; }
      }
      MsgWaitForMultipleObjects(0, IntPtr.Zero, false, 500, QS_ALLINPUT);
    }
  }

  private static void OnEvent(IntPtr hHook, uint e, IntPtr hwnd, int idObj, int idChild, uint eThread, uint eTime) {
    if (idObj != 0 || hwnd == IntPtr.Zero || _pids.Length == 0) return;
    uint pid = 0;
    GetWindowThreadProcessId(hwnd, out pid);
    foreach (uint tp in _pids) {
      if (pid == tp) {
        if (e == EVENT_OBJECT_CREATE) {
          int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
          SetWindowLong(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
          SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
        } else if (e == EVENT_OBJECT_SHOW) {
          ShowWindow(hwnd, 6);
          PostMessage(hwnd, WM_SYSCOMMAND, (IntPtr)SC_MINIMIZE, IntPtr.Zero);
          ShowWindow(hwnd, 0);
        }
        break;
      }
    }
  }

  private static void HideExisting(uint[] pids) {
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      foreach (uint rp in pids) {
        if (pid == rp) {
          RECT r; GetWindowRect(h, out r);
          if ((r.R - r.L) > 100 && (r.B - r.T) > 100) {
            ShowWindow(h, 6); PostMessage(h, WM_SYSCOMMAND, (IntPtr)SC_MINIMIZE, IntPtr.Zero); ShowWindow(h, 0);
          }
          break;
        }
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
[RiotBlocker]::RunForever()
`;
  try {
    fs.writeFileSync(tmpFile, script, 'utf8');
    riotTrayMinimizerProcess = require('node:child_process').spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile
    ], { stdio: 'ignore' });
    riotTrayMinimizerProcess.on('exit', () => {
      try { fs.unlinkSync(tmpFile); } catch (_error) {}
    });
    if (DEBUG) console.log('[riot:tray] blocker started');
  } catch (error) {
    if (DEBUG) console.error(`[riot:tray] failed to start: ${error.message}`);
    try { fs.unlinkSync(tmpFile); } catch (_error) {}
  }
}

function stopRiotClientTrayMinimizer() {
  if (riotTrayMinimizerProcess) {
    try {
      riotTrayMinimizerProcess.kill();
    } catch (_error) {
      // Already exited
    }
    riotTrayMinimizerProcess = null;
  }
}

async function requestLeagueServerShutdown(league) {
  if (!league) return;

  const shutdownPath = '/product-launcher/v1/products/league_of_legends/patchlines/live';
  if (league.riotPort && league.riotToken) {
    const riotResult = await requestRiotClient(shutdownPath, league.riotPort, league.riotToken, 'DELETE');
    if (!riotResult.error && riotResult.statusCode && riotResult.statusCode < 500) {
      return;
    }
  }

  const leagueResult = await requestLeague('/process-control/v1/process/quit', league.port, league.token, 'POST');
  if (leagueResult.error) throw leagueResult.error;
  if (leagueResult.statusCode && leagueResult.statusCode >= 400) {
    throw new Error(`League shutdown refused with status ${leagueResult.statusCode}.`);
  }
}

function shutdownLeagueAndQuit(win) {
  if (shuttingDownLeaguePromise) return shuttingDownLeaguePromise;

  shuttingDownLeaguePromise = (async () => {
    if (win && win.league) {
      try {
        await requestLeagueServerShutdown(win.league);
      } catch (error) {
        console.error(`[league:shutdown] ${error.message}`);
      }
    }
    allowingWindowClose = true;
    if (win && !win.isDestroyed()) win.close();
    app.quit();
  })();

  return shuttingDownLeaguePromise;
}

async function waitForLeagueReady(league) {
  const startedAt = Date.now();
  let lastError = 'League client HTTP interface did not become ready.';

  while (Date.now() - startedAt < LEAGUE_READY_TIMEOUT_MS) {
    const status = await requestLeague('/plugin-manager/v1/status', league.port, league.token);
    if (!status.error && status.statusCode && status.statusCode < 500) {
      return;
    }

    lastError = status.error
      ? status.error.message
      : `HTTP ${status.statusCode || 'unknown'}`;
    await delay(LEAGUE_START_POLL_MS);
  }

  throw new Error(`League client did not become ready within ${LEAGUE_READY_TIMEOUT_MS / 1000} seconds. Last error: ${lastError}`);
}

function buildLoadingHtml() {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Starting Electron League Client</title>
      <style>
        :root {
          color-scheme: dark;
          --bg-1: #070b14;
          --bg-2: #101c2b;
          --panel: rgba(10, 18, 31, 0.82);
          --gold: #c8aa6e;
          --text: #f0e6d2;
          --muted: rgba(240, 230, 210, 0.72);
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          overflow: hidden;
          font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
          color: var(--text);
          background:
            radial-gradient(circle at top, rgba(200, 170, 110, 0.18), transparent 32%),
            linear-gradient(145deg, var(--bg-1), var(--bg-2));
        }

        body::before,
        body::after {
          content: "";
          position: fixed;
          inset: auto;
          width: 42vmax;
          height: 42vmax;
          border-radius: 50%;
          filter: blur(60px);
          opacity: 0.22;
          pointer-events: none;
        }

        body::before {
          top: -12vmax;
          right: -10vmax;
          background: rgba(200, 170, 110, 0.35);
        }

        body::after {
          left: -16vmax;
          bottom: -16vmax;
          background: rgba(12, 90, 148, 0.32);
        }

        .panel {
          width: min(440px, calc(100vw - 48px));
          padding: 34px 30px;
          border: 1px solid rgba(200, 170, 110, 0.28);
          background: var(--panel);
          box-shadow: 0 28px 80px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(16px);
        }

        .crest {
          width: 54px;
          height: 54px;
          margin-bottom: 22px;
          border: 2px solid rgba(200, 170, 110, 0.72);
          transform: rotate(45deg);
          position: relative;
        }

        .crest::before,
        .crest::after {
          content: "";
          position: absolute;
          inset: 9px;
          border: 1px solid rgba(200, 170, 110, 0.42);
        }

        h1 {
          margin: 0 0 10px;
          font-size: 28px;
          font-weight: 600;
          letter-spacing: 0.04em;
        }

        p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.55;
        }

        .bar {
          margin-top: 24px;
          height: 3px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
          position: relative;
        }

        .bar::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, var(--gold), transparent);
          transform: translateX(-100%);
          animation: sweep 1.35s ease-in-out infinite;
        }

        @keyframes sweep {
          to { transform: translateX(100%); }
        }
      </style>
    </head>
    <body>
      <main class="panel">
        <div class="crest" aria-hidden="true"></div>
        <h1>Starting Electron League Client</h1>
        <div class="bar" aria-hidden="true"></div>
      </main>
    </body>
  </html>`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getPlugins() {
  const manifest = readJson(path.join(cfg.pluginsDir, 'plugin-manifest.json'));
  return manifest.plugins
    .map((plugin) => {
      const descriptionPath = path.join(cfg.pluginsDir, plugin.name, 'description.json');
      if (!fs.existsSync(descriptionPath)) return null;
      return { ...plugin, description: readJson(descriptionPath) };
    })
    .filter(Boolean);
}

function frontendPlugins() {
  return getPlugins().filter(({ name, description }) => (
    name.startsWith(FRONTEND_PREFIX) &&
    description.riotMeta &&
    description.riotMeta.type === 'frontend' &&
    description.riotMeta.hasBundledAssets
  ));
}

function buildDependencyGraph(plugins) {
  const dependencies = {};
  const implementations = {};
  const lazy = [];
  const shims = {};

  for (const plugin of plugins) {
    dependencies[plugin.name] = plugin.description.pluginDependencies || [];
    if (plugin.lazy) lazy.push(plugin.name);
    for (const contractName of plugin.as || []) {
      implementations[contractName] = plugin.name;
    }
  }

  return {
    dependencies,
    implementations,
    lazy,
    sequence: plugins.map((plugin) => plugin.name),
    shims
  };
}

function urlSegmentForPlugin(pluginName) {
  return pluginName.startsWith(FRONTEND_PREFIX)
    ? pluginName.slice(FRONTEND_PREFIX.length)
    : pluginName;
}

function buildIndexHtml(league, bridgePort) {
  const plugins = frontendPlugins();
  const cssLinks = [];
  const scriptTags = [];
  const timestamp = Date.now();

  for (const plugin of plugins) {
    if (plugin.name === 'rcp-fe-plugin-runner') continue;
    const segment = urlSegmentForPlugin(plugin.name);
    const cssName = plugin.name === 'rcp-fe-lol-uikit' ? 'main.css' : `${plugin.name}.css`;
    const wadPath = path.join(cfg.pluginsDir, plugin.name, 'assets.wad');
    cssLinks.push({ plugin, href: `/fe/${segment}/${cssName}`, wadPath, fileInpack: `plugins/${plugin.name}/global/default/${cssName}` });
    scriptTags.push(`<script src='/fe/${segment}/${plugin.name}.js?t=${timestamp}'></script>`);
  }

  const cssHtml = cssLinks
    .map(({ plugin, href }) => plugin.name === 'rcp-fe-lol-uikit'
      ? `<link rel='stylesheet' href='${href}'>`
      : `<link href='${href}' rel='stylesheet' data-plugin-name='${plugin.name}'>`)
    .join('');

  return patchHtml(`<!doctype html><html><head>  <base href='/'>  <meta charset='utf-8'>  <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0' />  <link rel='riot:plugins:dependency-graph' href='/graph.json' />  <link rel='riot:plugins:websocket' href='ws://127.0.0.1:${bridgePort}/ws' />  ${cssHtml}  <style>${electronDragCss()}</style>  <script>${electronDragScript()}</script>  <script>window.getPluginAnnounceEventName = (pluginName) => \`riotPlugin.announce:\${pluginName}\`;</script>${scriptTags.join('')}</head><body data-env='public' data-loading-div-id='index_loading_div_20210908'>  <div id='index_loading_div_20210908' style='position: fixed;display: flex;align-items: center;justify-content: center;flex-direction: column;pointer-events: all;top: 0;left: 0;width: 100%;height: 100%;direction: ltr;'>    <img src='/lol-game-data/assets/ASSETS/SplashScreens/lol_icon.png'>  </div>  <script src='/fe/plugin-runner/rcp-fe-plugin-runner.js?t=${timestamp}'></script></body></html>`, PATCHES_DIR);
}

function currentWindowScale(win) {
  if (win.currentLeagueWindowSize) return win.currentLeagueWindowSize.scale;
  const [width, height] = win.getContentSize();
  const match = WINDOW_SIZES.find((size) => size.width === width && size.height === height);
  return match ? match.scale : 1;
}

function windowSizeForScale(scale) {
  const numericScale = Number(scale);
  return WINDOW_SIZES.find((size) => Math.abs(size.scale - numericScale) < 0.001) || WINDOW_SIZES[1];
}

function windowSizeForDimensions(width, height) {
  return WINDOW_SIZES.find((size) => size.width === width && size.height === height) || WINDOW_SIZES[1];
}

function riotResult(value) {
  return JSON.stringify({ result: JSON.stringify(value) });
}

function applyWindowSize(win, size, center = false) {
  win.setResizable(true);
  win.setMinimumSize(0, 0);
  win.setMaximumSize(9999, 9999);
  win.webContents.setZoomFactor(size.scale);
  win.setContentSize(size.width, size.height);
  win.currentLeagueWindowSize = size;
  win.webContents.executeJavaScript(
    `if (window.__setLeagueElectronSize) {
      window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale});
      setTimeout(() => window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale}), 50);
      setTimeout(() => window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale}), 250);
    }`,
    true
  ).catch(() => {});
  win.setResizable(false);
  if (center) win.center();
}

async function applySavedWindowSize(win, league) {
  const responses = await Promise.all([
    requestLeague('/lol-settings/v1/local/video', league.port, league.token),
    requestLeague('/lol-settings/v2/local/LCUPreferences/video', league.port, league.token)
  ]);
  const response = responses.find((candidate) => candidate.statusCode && candidate.statusCode < 400 && candidate.body) || responses[0];
  const parsed = parseJsonBody(Buffer.from(response.body || ''));
  const scale = parsed && (parsed.ZoomScale ?? parsed.data?.ZoomScale);
  if (scale !== undefined) applyWindowSize(win, windowSizeForScale(scale), true);
}

function electronDragCss() {
  return `
    body,
    body *,
    button,
    input,
    select,
    textarea,
    a,
    [role='button'],
    [tabindex],
    [onclick] {
      -webkit-app-region: no-drag;
    }

    body,
    body *:not(input):not(textarea) {
      -webkit-user-drag: none;
      -webkit-user-select: none;
      user-select: none;
    }

    img,
    svg,
    canvas,
    video {
      -webkit-user-drag: none;
      user-drag: none;
    }

    html,
    body {
      background: #010a13 !important;
      height: 100% !important;
      margin: 0 !important;
      overflow: hidden !important;
      transform: none !important;
      width: 100% !important;
    }

    input,
    textarea {
      user-select: text;
    }

    rcp-fe-lol-navigation,
    lol-uikit-navigation,
    lol-navigation,
    .rcp-fe-lol-navigation,
    .lol-navigation,
    .navigation,
    .navigation-bar,
    .nav-bar,
    .top-nav,
    .topbar,
    .titlebar,
    .title-bar,
    .window-chrome,
    .chrome,
    header {
      -webkit-app-region: no-drag;
    }

    [data-electron-no-drag],
    [data-electron-no-drag] *,
    .app-controls,
    .app-controls *,
    .app-controls-button,
    .app-controls-button *,
    .app-controls-support,
    .app-controls-hide,
    .app-controls-settings,
    .app-controls-close,
    .summoner,
    .summoner *,
    .currency,
    .currency *,
    .social,
    .social *,
    .parties,
    .parties *,
    .navigation-item,
    .navigation-item *,
    .nav-item,
    .nav-item *,
    .nav-button,
    .nav-button * {
      -webkit-app-region: no-drag;
    }
  `.replace(/\s+/g, ' ').trim();
}

function electronDragScript() {
  return `
    (() => {
      window.alert = () => {};
      window.confirm = () => false;
      window.onerror = () => true;
      window.onunhandledrejection = (event) => {
        event.preventDefault();
        return true;
      };
      window.addEventListener('error', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      window.addEventListener('unhandledrejection', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      document.addEventListener('dragstart', (event) => {
        event.preventDefault();
      }, true);
      document.addEventListener('selectstart', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
      }, true);
      window.__setLeagueElectronSize = (width, height) => {
        if (!document.body) return;
        document.documentElement.style.setProperty('width', '100%', 'important');
        document.documentElement.style.setProperty('height', '100%', 'important');
        document.documentElement.style.setProperty('overflow', 'hidden', 'important');
        document.body.style.setProperty('width', '100%', 'important');
        document.body.style.setProperty('height', '100%', 'important');
        document.body.style.setProperty('transform', 'none', 'important');
        document.body.style.setProperty('transform-origin', 'top left', 'important');
        document.body.style.setProperty('overflow', 'hidden', 'important');
        window.dispatchEvent(new Event('resize'));
      };
      const allElements = (root = document) => {
        const result = [];
        const visit = (node) => {
          if (!node) return;
          if (node.nodeType === Node.ELEMENT_NODE) {
            result.push(node);
            if (node.shadowRoot) visit(node.shadowRoot);
          }
          for (const child of node.children || []) visit(child);
        };
        visit(root);
        return result;
      };
      const hideOpenPartyTooltip = () => {
        const textMatches = [];
        for (const element of allElements()) {
          const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().toUpperCase();
          if (/PARTY\\s+IS\\s+OPEN/.test(text) || /YOUR\\s+PARTY/.test(text)) textMatches.push(element);
        }

        for (const element of textMatches.reverse()) {
          let node = element;
          for (let i = 0; i < 10 && node && node !== document.body && node !== document.documentElement; i += 1) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (
              rect.width >= 120 &&
              rect.width <= 560 &&
              rect.height >= 40 &&
              rect.height <= 260 &&
              style.position !== 'static'
            ) {
              node.style.display = 'none';
              node.dataset.electronHiddenOpenPartyTooltip = 'true';
              break;
            }
            node = node.parentElement || node.host;
          }
        }
      };
      if (document.body) window.__setLeagueElectronSize(window.innerWidth, window.innerHeight);
      const dragSelectors = [
        'rcp-fe-lol-navigation',
        'lol-uikit-navigation',
        'lol-navigation',
        '.rcp-fe-lol-navigation',
        '.lol-navigation',
        '.navigation-bar',
        '.nav-bar',
        '.top-nav',
        '.topbar',
        '.titlebar',
        '.title-bar',
        '.window-chrome'
      ];
      const interactiveSelectors = [
        'button',
        'a',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[tabindex]',
        '[onclick]',
        '[action]',
        '.app-controls',
        '.app-controls-button',
        '.app-controls-support',
        '.app-controls-hide',
        '.app-controls-settings',
        '.app-controls-close',
        '.summoner',
        '.currency',
        '.social',
        '.parties',
        '.navigation-item',
        '.nav-item',
        '.nav-button'
      ];
      const parentOf = (node) => node && (node.parentElement || (node.getRootNode && node.getRootNode().host));
      const interactiveSelector = interactiveSelectors.join(',');
      const isInteractiveTarget = (target) => {
        let node = target;
        for (let i = 0; i < 12 && node && node !== document.body && node !== document.documentElement; i += 1) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            node = parentOf(node);
            continue;
          }
          if (node.dataset && node.dataset.electronNoDrag === 'true') return true;
          if (node.matches && node.matches(interactiveSelector)) return true;
          const style = getComputedStyle(node);
          if (style.cursor === 'pointer') return true;
          node = parentOf(node);
        }
        return false;
      };
      const canStartWindowDrag = (clientX, clientY, target) => {
        if (clientY < 0 || clientY > 45) return false;
        if (clientX < 0 || clientX > window.innerWidth - 420) return false;
        if (isInteractiveTarget(target)) return false;
        return true;
      };
      window.__leagueElectronCanDragPoint = (clientX, clientY) => {
        return canStartWindowDrag(clientX, clientY, document.elementFromPoint(clientX, clientY));
      };
      let draggingWindow = false;
      let activePointerId = null;
      const endWindowDrag = () => {
        if (!draggingWindow) return;
        draggingWindow = false;
        activePointerId = null;
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.end();
      };
      document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !canStartWindowDrag(event.clientX, event.clientY, event.target)) return;
        draggingWindow = true;
        activePointerId = event.pointerId;
        if (event.target && event.target.setPointerCapture) {
          try { event.target.setPointerCapture(event.pointerId); } catch (_error) {}
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.start(event.screenX, event.screenY);
      }, true);
      window.addEventListener('pointermove', (event) => {
        if (!draggingWindow || (activePointerId !== null && event.pointerId !== activePointerId)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.move(event.screenX, event.screenY);
      }, true);
      window.addEventListener('pointerup', endWindowDrag, true);
      window.addEventListener('pointercancel', endWindowDrag, true);
      window.addEventListener('blur', endWindowDrag, true);
      let queued = false;
      const markChrome = () => {
        queued = false;
        for (const selector of dragSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            for (const child of element.querySelectorAll(interactiveSelector)) {
              child.dataset.electronNoDrag = 'true';
            }
            for (const child of element.querySelectorAll('*')) {
              const style = getComputedStyle(child);
              if (style.cursor === 'pointer') child.dataset.electronNoDrag = 'true';
            }
          }
        }
      };
      const scheduleMarkChrome = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(markChrome);
      };
      window.addEventListener('DOMContentLoaded', () => {
        window.__setLeagueElectronSize(window.innerWidth, window.innerHeight);
        hideOpenPartyTooltip();
        scheduleMarkChrome();
        new MutationObserver(() => {
          hideOpenPartyTooltip();
          scheduleMarkChrome();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    })();
  `.replace(/\s+/g, ' ').trim();
}

const assetCache = new Map();
const wadFilesCache = new Map();

function pluginNameForSegment(segment) {
  return segment === 'plugin-runner' ? 'rcp-fe-plugin-runner' : `${FRONTEND_PREFIX}${segment}`;
}

function wadFilesForPlugin(pluginName) {
  if (wadFilesCache.has(pluginName)) return wadFilesCache.get(pluginName);

  const pluginDir = path.join(cfg.pluginsDir, pluginName);
  if (!fs.existsSync(pluginDir)) return [];

  const wadFiles = fs.readdirSync(pluginDir)
    .filter((file) => file.endsWith('.wad'))
    .map((file) => path.join(pluginDir, file));
  wadFilesCache.set(pluginName, wadFiles);
  return wadFiles;
}

function assetCandidateForPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const feMatch = decodedPath.match(/^fe\/([^/]+)\/(.+)$/);
  if (feMatch) {
    const [, segment, relativePath] = feMatch;
    return {
      pluginName: pluginNameForSegment(segment),
      relativePath
    };
  }

  if (/^(images|sounds|videos|fonts)\//.test(decodedPath)) {
    return {
      pluginName: STATIC_PLUGIN,
      relativePath: decodedPath
    };
  }

  return null;
}

async function extractAsset(urlPath) {
  const candidate = assetCandidateForPath(urlPath);
  if (!candidate) return null;

  const { pluginName, relativePath } = candidate;
  const cacheKey = `${pluginName}:${relativePath}`;
  if (assetCache.has(cacheKey)) return assetCache.get(cacheKey);

  const fileInpack = `plugins/${pluginName}/global/default/${relativePath}`;
  let extracted = [];
  for (const candidateWad of wadFilesForPlugin(pluginName)) {
    extracted = await extractWAD(candidateWad, [{ fileInpack }]);
    if (extracted.length) break;
  }
  if (!extracted.length) {
    if (relativePath.endsWith('.css')) return { buffer: Buffer.from(''), fileName: path.basename(relativePath) };
    assetCache.set(cacheKey, null);
    return null;
  }

  let buffer = extracted[0].buffer;
  // Apply on-the-fly patches from patches/ folder
  buffer = applyPatches(pluginName, relativePath, buffer, PATCHES_DIR);

  const asset = { buffer, fileName: path.basename(relativePath) };
  assetCache.set(cacheKey, asset);
  return asset;
}

function contentType(fileName) {
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.svg')) return 'image/svg+xml';
  if (fileName.endsWith('.webm')) return 'video/webm';
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  if (fileName.endsWith('.ogg')) return 'audio/ogg';
  if (fileName.endsWith('.wav')) return 'audio/wav';
  if (fileName.endsWith('.ttf')) return 'font/ttf';
  if (fileName.endsWith('.otf')) return 'font/otf';
  if (fileName.endsWith('.woff')) return 'font/woff';
  if (fileName.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function handleRiotInvoke(win, payload) {
  let request = payload && payload.request;
  if (typeof request === 'string') request = JSON.parse(request);
  if (!request || typeof request.name !== 'string') return undefined;

  const params = Array.isArray(request.params) ? request.params : [];
  switch (request.name) {
    case 'Window.Close':
    case 'Window.Exit':
    case 'Window.Quit':
    case 'Client.Exit':
    case 'Client.Quit':
    case 'RiotClient.Exit':
    case 'RiotClient.Quit':
      win.close();
      return undefined;
    case 'Window.Minimize':
      win.minimize();
      return undefined;
    case 'Window.Restore':
    case 'Window.Activate':
      win.restore();
      win.focus();
      return undefined;
    case 'Window.Show':
      win.show();
      return undefined;
    case 'Window.Hide':
      win.hide();
      return undefined;
    case 'Window.ResizeTo':
      if (params.length >= 2) applyWindowSize(win, windowSizeForDimensions(Number(params[0]), Number(params[1])));
      return undefined;
    case 'Window.MoveTo':
      if (params.length >= 2) win.setPosition(Number(params[0]), Number(params[1]));
      return undefined;
    case 'Window.GetValidWindowSizes':
      return riotResult(WINDOW_SIZES.map((size) => ({
        ...size,
        selected: size.scale === currentWindowScale(win)
      })));
    case 'Window.ScreenData': {
      const bounds = win.getBounds();
      const display = require('electron').screen.getDisplayMatching(bounds);
      return riotResult({
        screenX: bounds.x,
        screenY: bounds.y,
        screenWidth: display.bounds.width,
        screenHeight: display.bounds.height,
        screenAvailWidth: display.workArea.width,
        screenAvailHeight: display.workArea.height,
        screenAvailLeft: display.workArea.x,
        screenAvailTop: display.workArea.y,
        windowWidth: bounds.width,
        windowHeight: bounds.height,
        windowActivated: win.isFocused(),
        windowMinimized: win.isMinimized(),
        zoomScale: currentWindowScale(win)
      });
    }
    case 'Window.CenterToScreen':
    case 'Window.CenterWithinMainWindow':
    case 'Window.CenterWithinParent':
      win.center();
      return undefined;
    case 'Window.SetTitle':
      if (typeof params[0] === 'string') win.setTitle(params[0]);
      return undefined;
    case 'Window.Flash':
      win.flashFrame(true);
      return undefined;
    case 'Mouse.SetDragBarHeight':
      return undefined;
    case 'Client.Logout':
    case 'Client.SignOut':
    case 'Auth.Logout':
    case 'Auth.SignOut':
    case 'RiotClient.SignOut':
    case 'RiotClient.Logout':
      await requestLeague('/lol-login/v1/session', win.league.port, win.league.token, 'DELETE');
      await shutdownLeagueAndQuit(win);
      return undefined;
    case 'Browser.OpenExternal':
    case 'Window.OpenExternal':
      if (typeof params[0] === 'string') await shell.openExternal(params[0]);
      return undefined;
    default:
      if (DEBUG) console.log(`[riotInvoke:unhandled] ${request.name} ${JSON.stringify(params).slice(0, 500)}`);
      return undefined;
  }
}

function sendBuffer(req, res, asset) {
  const type = contentType(asset.fileName);
  const total = asset.buffer.length;
  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start <= end && end < total) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache'
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(asset.buffer.subarray(start, end + 1));
      }
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache'
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(asset.buffer);
}

function proxyLeague(req, res, league) {
  const bodyChunks = [];
  req.on('data', (chunk) => bodyChunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    const handled = handleLocalBridgeRoute(req, res, league, body);
    if (handled) return;

    forwardLeagueRequest(req, res, league, body);
  });
}

function handleLocalBridgeRoute(req, res, league, body) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');

  if (requestUrl.pathname === '/lol-platform-config/v1/namespaces/LcuUxSettings') {
    return sendJson(res, {
      WindowSizeDefault: 1,
      WindowSizeOptions: WINDOW_SIZES.map(({ width, height, scale }) => ({ width, height, scale }))
    });
  }

  if (/^\/lol-settings\/v\d+\/(?:account|local)\/(?:LCUPreferences\/)?lol-parties$/.test(requestUrl.pathname)) {
    return sendJson(res, {
      data: {
        hasSeenOpenPartyFirstExperience: true,
        hasSeenOpenPartyTooltip: true,
        hasSeenPartyOpenTooltip: true,
        showOpenPartyTooltip: false
      },
      schemaVersion: 1
    });
  }

  if (/^\/lol-lobby\/v2\/notifications\/[^/]+$/.test(requestUrl.pathname) && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (/^\/lol-settings\/v\d+\/local\/(?:LCUPreferences\/)?video$/.test(requestUrl.pathname) && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const parsed = parseJsonBody(body);
    const scale = parsed && (parsed.ZoomScale ?? parsed.data?.ZoomScale);
    if (scale !== undefined && BrowserWindow.getAllWindows()[0]) {
      applyWindowSize(BrowserWindow.getAllWindows()[0], windowSizeForScale(scale), true);
    }
  }

  return false;
}

function sendJson(res, value, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(value));
  return true;
}

function parseJsonBody(body) {
  if (!body || !body.length) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function forwardLeagueRequest(req, res, league, body) {
  const proxyReq = https.request({
    hostname: '127.0.0.1',
    port: league.port,
    path: req.url,
    method: req.method,
    rejectUnauthorized: false,
    auth: `riot:${league.token}`,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${league.port}`,
      authorization: `Basic ${Buffer.from(`riot:${league.token}`).toString('base64')}`,
      ...(body.length ? { 'content-length': body.length } : {})
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });

  if (body.length) proxyReq.write(body);
  proxyReq.end();
}

function startBridgeServer(league) {
  const plugins = frontendPlugins();
  const graph = buildDependencyGraph(plugins.filter((plugin) => plugin.name !== 'rcp-fe-plugin-runner'));
  let indexHtml = '';

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/bootstrap.html' || requestUrl.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(indexHtml);
        return;
      }

      if (requestUrl.pathname === '/graph.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(graph));
        return;
      }

      if (requestUrl.pathname === '/fe/lol-l10n/moment-locale.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end('');
        return;
      }

      const asset = await extractAsset(requestUrl.pathname);
      if (asset) {
        sendBuffer(req, res, asset);
        return;
      }

      proxyLeague(req, res, league);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  const wsServer = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (clientSocket) => {
      const upstream = new WebSocket(`wss://riot:${league.token}@127.0.0.1:${league.port}/`, ['wamp'], {
        rejectUnauthorized: false,
        headers: { Origin: `https://127.0.0.1:${league.port}` }
      });

      upstream.on('open', () => {
        console.log('[bridge] websocket open');
      });
      upstream.on('message', (message, isBinary) => {
        if (DEBUG) console.log(`[bridge] websocket <= ${message.toString().slice(0, 200)}`);
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(message, { binary: isBinary });
      });
      clientSocket.on('message', (message, isBinary) => {
        if (DEBUG) console.log(`[bridge] websocket => ${message.toString().slice(0, 200)}`);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message, { binary: isBinary });
      });
      upstream.on('close', (code, reason) => clientSocket.close(code, reason));
      clientSocket.on('close', () => upstream.close());
      upstream.on('error', (error) => {
        console.log(`[bridge] websocket upstream error ${error.message}`);
        clientSocket.close();
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      indexHtml = buildIndexHtml(league, port);
      console.log(`[bridge] http://127.0.0.1:${port}/index.html`);
      resolve({ server, port });
    });
  });
}

function requestLeague(path, port, token, method = 'GET', body = null) {
  return requestLocalClient({
    path,
    port,
    token,
    method,
    body,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  });
}

function createShellWindow() {
  const win = new BrowserWindow({
    width: WINDOW_SIZES[1].width,
    height: WINDOW_SIZES[1].height,
    title: 'League Electron Client',
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    frame: false,
    thickFrame: false,
    resizable: false,
    useContentSize: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  applyWindowSize(win, WINDOW_SIZES[1], true);
  return win;
}

async function showLoadingScreen(win) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml())}`);
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  const win = createShellWindow();
  await showLoadingScreen(win);

  session.defaultSession.setUserAgent(LEAGUE_UA);
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (win.league) {
      details.requestHeaders.Authorization = `Basic ${Buffer.from(`riot:${win.league.token}`).toString('base64')}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400 && (DEBUG || details.url.includes('/fe/'))) {
      console.log(`[request:${details.statusCode}] ${details.method} ${details.url}`);
    }
  });
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const normalMediaCancel = details.error === 'net::ERR_ABORTED' || details.error === 'net::ERR_CACHE_MISS';
    if (DEBUG || (!normalMediaCancel && details.url.includes('/fe/'))) {
      console.log(`[request:error] ${details.error} ${details.method} ${details.url}`);
    }
  });

  win.webContents.on('certificate-error', (event, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[electron] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (DEBUG || level >= 3) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[electron] render-process-gone ${details.reason}`);
  });

  win.webContents.on('unresponsive', () => {
    console.error('[electron] renderer unresponsive');
  });

  win.on('close', (event) => {
    if (allowingWindowClose) return;
    event.preventDefault();
    shutdownLeagueAndQuit(win).catch((error) => {
      console.error(`[league:shutdown] ${error.message}`);
      allowingWindowClose = true;
      if (!win.isDestroyed()) win.close();
    });
  });

  win.webContents.on('did-finish-load', async () => {
    const location = await win.webContents.executeJavaScript('location.href').catch(() => '');
    console.log(`[electron] loaded ${location}`);
    if (!win.league) return;
    await applySavedWindowSize(win, win.league).catch((error) => {
      if (DEBUG) console.log(`[settings] could not reapply saved window size: ${error.message}`);
    });
    if (!DEBUG) return;

    const captureDebugState = async (label) => {
      const image = await win.capturePage().catch(() => null);
      if (image) {
        const screenshotPath = path.join(__dirname, `league-electron-screenshot-${label}.png`);
        fs.writeFileSync(screenshotPath, image.toPNG());
        console.log(`[electron] screenshot ${screenshotPath}`);
      }
      const state = await win.webContents.executeJavaScript(`({
        href: location.href,
        title: document.title,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyWidth: document.body && document.body.getBoundingClientRect().width,
        bodyHeight: document.body && document.body.getBoundingClientRect().height,
        bodyTransform: document.body && getComputedStyle(document.body).transform,
        manualDragAt100x10: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(100, 10),
        manualDragAt500x10: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(500, 10),
        manualDragAtRightControls: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(window.innerWidth - 80, 10),
        dragElementTag: document.elementFromPoint(100, 10) && document.elementFromPoint(100, 10).tagName,
        dragElementRegion: document.elementFromPoint(100, 10) && getComputedStyle(document.elementFromPoint(100, 10)).webkitAppRegion,
        partyTooltipTextPresent: document.body.innerText.toUpperCase().includes('PARTY IS OPEN'),
        scripts: document.scripts.length,
        loadingExists: !!document.getElementById('index_loading_div_20210908'),
        bodyText: document.body.innerText.slice(0, 500),
        riotPluginLoadTimes: window._riotPluginLoadTimes,
        keys: Object.keys(window).filter(k => k.startsWith('riot') || k.startsWith('Riot')).slice(0, 50)
      })`).catch((error) => ({ error: error.message }));
      console.log(`[electron] state:${label} ${JSON.stringify({
        ...state,
        contentSize: win.getContentSize(),
        bounds: win.getBounds(),
        zoomFactor: win.webContents.getZoomFactor()
      }).slice(0, 2000)}`);
    };
    setTimeout(() => captureDebugState('10s'), 10000);
    setTimeout(() => captureDebugState('25s'), 25000);
  });

  await showLoadingScreen(win);
  startRiotClientTrayMinimizer();
  const startup = await ensureLeagueIsRunning();
  const league = startup.league;
  win.league = league;
  const baseUrl = `https://127.0.0.1:${league.port}`;

  await waitForLeagueReady(league);
  const bridge = await startBridgeServer(league);

  const checks = await Promise.all([
    requestLeague('/bootstrap.html', league.port, league.token),
    requestLeague('/index.html', league.port, league.token),
    requestLeague('/plugin-manager/v1/status', league.port, league.token)
  ]);

  for (const check of checks) {
    const preview = check.error ? check.error.message : check.body.slice(0, 120).replace(/\s+/g, ' ');
    console.log(`[league] ${check.path}: ${check.statusCode || 'ERR'} ${preview}`);
  }

  await applySavedWindowSize(win, league).catch((error) => {
    if (DEBUG) console.log(`[settings] could not apply saved window size: ${error.message}`);
  });

  console.log(`[league] Loading bridge for ${baseUrl}/bootstrap.html`);
  await win.loadURL(`http://127.0.0.1:${bridge.port}/index.html`);
  suppressStockLeagueUxAfterLoad(league).catch((error) => {
    console.error(`[league:kill-ux] ${error.message}`);
  });
}

if (cfg.configError) {
  dialog.showErrorBox('League Client Path Error', cfg.configError);
}

app.whenReady().then(async () => {
  if (cfg.configError) {
    app.quit();
    return;
  }
  await createWindow();

}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('before-quit', (event) => {
  stopRiotClientTrayMinimizer();
  const win = BrowserWindow.getAllWindows()[0];
  if (allowingWindowClose || !win || win.isDestroyed()) return;
  event.preventDefault();
  shutdownLeagueAndQuit(win).catch((error) => {
    console.error(`[league:shutdown] ${error.message}`);
    allowingWindowClose = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  stopRiotClientTrayMinimizer();
  if (process.platform !== 'darwin') app.quit();
});
