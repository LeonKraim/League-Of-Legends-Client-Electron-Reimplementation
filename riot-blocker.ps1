Add-Type @"
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
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public delegate void WinEventDelegate(IntPtr hHook, uint e, IntPtr hwnd, int idObj, int idChild, uint eThread, uint eTime);
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const uint QS_ALLINPUT = 0xFF;
  const uint WM_SYSCOMMAND = 0x0112;
  const uint SC_MINIMIZE = 0xF020;

  private static WinEventDelegate _del;
  private static IntPtr _hook;
  private static uint[] _pids = new uint[0];

  public static void RunForever() {
    _del = OnEvent;
    _hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, _del, 0, 0, WINEVENT_OUTOFCONTEXT);
    int lastPidScan = 0;
    MSG msg;
    while (true) {
      // Drain all pending messages (window events) instantly
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {
        if (msg.message == 0x12) { UnhookWinEvent(_hook); return; }
        TranslateMessage(ref msg);
        DispatchMessage(ref msg);
      }
      // Scan for Riot Client PIDs every 500ms
      int now = Environment.TickCount;
      if (now - lastPidScan > 500) {
        lastPidScan = now;
        try {
          _pids = Process.GetProcessesByName("Riot Client").Select(p => (uint)p.Id).ToArray();
          if (_pids.Length > 0) HideExisting(_pids);
        } catch { _pids = new uint[0]; }
      }
      // Block until next message or 500ms timeout — zero CPU while idle
      MsgWaitForMultipleObjects(0, IntPtr.Zero, false, 500, QS_ALLINPUT);
    }
  }

  private static void OnEvent(IntPtr hHook, uint e, IntPtr hwnd, int idObj, int idChild, uint eThread, uint eTime) {
    if (idObj != 0 || hwnd == IntPtr.Zero || _pids.Length == 0) return;
    uint pid = 0;
    GetWindowThreadProcessId(hwnd, out pid);
    foreach (uint tp in _pids) {
      if (pid == tp) {
        ShowWindow(hwnd, 6);
        PostMessage(hwnd, WM_SYSCOMMAND, (IntPtr)SC_MINIMIZE, IntPtr.Zero);
        ShowWindow(hwnd, 0);
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
