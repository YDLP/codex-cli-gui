# Native Windows folder picker for Codex GUI.
#
# IMPORTANT: keep this file ASCII-only.
# Windows PowerShell 5.1 reads a BOM-less script as the system ANSI codepage
# (GBK on this machine), so non-ASCII source text turns into a parse error and
# the dialog never opens.
#
# The dialog belongs to a background process, so Windows may open it behind the
# browser. A short watcher thread nudges it to the foreground.
#
# Watcher rules learned the hard way:
#   * NEVER call FlashWindow repeatedly - Windows renders that as continuous
#     flashing, which looks like the window border is glitching. Flash at most
#     twice, early.
#   * Detect the dialog by WINDOW CLASS (#32770), not by title: the shell folder
#     picker is localized ("Browse For Folder" / the OS display language).
#   * Only force the foreground while it is NOT already foreground, and give up
#     after a few attempts so a user who moves focus away is not fought.
#
# Output the bridge parses is exactly one line:
#   PICKED=<path> | CANCELED | ERROR=<message>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PickerFg {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool FlashWindow(IntPtr h, bool invert);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    /// SetForegroundWindow silently fails for a background process unless the
    /// calling thread is attached to the current foreground thread's input queue.
    private static void ForceForeground(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != myThread) {
            attached = AttachThreadInput(myThread, fgThread, true);
        }
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(myThread, fgThread, false);
    }

    private static IntPtr _dlg = IntPtr.Zero;

    private static string ClassOf(IntPtr h) {
        var sb = new StringBuilder(128);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // A shell folder dialog is a visible #32770 (dialog) hosting a tree view.
    private static bool LooksLikeFolderDialog(IntPtr h) {
        if (!IsWindowVisible(h)) return false;
        if (ClassOf(h) != "#32770") return false;
        bool hasTree = false;
        EnumChildWindows(h, (c, l) => {
            if (ClassOf(c) == "SysTreeView32") { hasTree = true; return false; }
            return true;
        }, IntPtr.Zero);
        return hasTree;
    }

    /// Nudge the dialog forward. Returns once it is in the foreground or after
    /// `maxTries`, whichever comes first.
    public static void Watch(int maxTries, int intervalMs) {
        var t = new Thread(() => {
            int flashed = 0;
            for (int i = 0; i < maxTries; i++) {
                Thread.Sleep(intervalMs);

                if (_dlg == IntPtr.Zero || !IsWindow(_dlg)) {
                    _dlg = IntPtr.Zero;
                    EnumWindows((h, l) => {
                        // The dialog can be a child of another top-level window,
                        // so inspect children too.
                        if (LooksLikeFolderDialog(h)) { _dlg = h; return false; }
                        IntPtr found = IntPtr.Zero;
                        EnumChildWindows(h, (c, l2) => {
                            if (LooksLikeFolderDialog(c)) { found = c; return false; }
                            return true;
                        }, IntPtr.Zero);
                        if (found != IntPtr.Zero) { _dlg = found; return false; }
                        return true;
                    }, IntPtr.Zero);
                }

                if (_dlg == IntPtr.Zero) continue;

                IntPtr fg = GetForegroundWindow();
                // Already on top (or one of its ancestors owns focus) -> stop.
                if (fg == _dlg || GetAncestor(_dlg, 3 /*GA_ROOTOWNER*/) == fg) return;

                ForceForeground(_dlg);

                // Flash at most twice, only at the very start.
                if (flashed < 2) { FlashWindow(_dlg, true); flashed++; }
            }
        });
        t.IsBackground = true;   // must not keep the process alive
        t.Start();
    }
}
'@

try {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Select the working directory for Codex'
    $dlg.ShowNewFolderButton = $true
    # NOTE: UseDescriptionForTitle is .NET Core only; omitted deliberately.

    if ($args.Count -ge 1 -and $args[0]) {
        if (Test-Path -LiteralPath $args[0]) {
            $dlg.SelectedPath = (Resolve-Path -LiteralPath $args[0]).Path
        }
    }

    # 30 tries x 150ms = ~4.5s of gentle nudging, then leave the user alone.
    [PickerFg]::Watch(30, 150)

    $result = $dlg.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {
        Write-Output ('PICKED=' + $dlg.SelectedPath)
    } else {
        Write-Output 'CANCELED'
    }
}
catch {
    Write-Output ('ERROR=' + $_.Exception.Message)
}
