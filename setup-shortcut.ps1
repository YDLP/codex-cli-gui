# Creates Desktop shortcuts for Codex GUI.
#
# Run this once:  powershell -NoProfile -ExecutionPolicy Bypass -File setup-shortcut.ps1
# It is idempotent - running it again just refreshes the shortcuts.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less script using
# the system ANSI codepage (GBK here), so non-ASCII source text can break parsing.
# The shortcut is named "Codex GUI" - ASCII - so no encoding tricks are needed.
#
# Two shortcuts are created:
#   "Codex GUI"      -> start-hidden.vbs   (no window at all; closing anything
#                                           cannot stop the service)
#   "Codex GUI (stop)" -> stop-codex-gui.cmd
#
# The old console launcher (start-codex-gui.cmd) is kept for troubleshooting:
# it attaches the service to its console, so closing it stops the server.

$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$hidden   = Join-Path $here 'start-hidden.vbs'
$stopper  = Join-Path $here 'stop-codex-gui.cmd'
$console  = Join-Path $here 'start-codex-gui.cmd'
$icon     = Join-Path $here 'codex-gui.ico'
$desktop  = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Codex GUI.lnk'
$stopLnk  = Join-Path $desktop 'Codex GUI (stop).lnk'
$wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'

foreach ($f in @($hidden, $stopper, $console)) {
    if (-not (Test-Path -LiteralPath $f)) {
        Write-Output ('ERROR: missing file: ' + $f)
        exit 1
    }
}

$shell = New-Object -ComObject WScript.Shell

# --- main launcher: hidden, detached ---
$sc = $shell.CreateShortcut($shortcut)
$sc.TargetPath       = $wscript
$sc.Arguments        = '"' + $hidden + '"'
$sc.WorkingDirectory = $here
$sc.Description      = 'Local web UI for the Codex CLI (ChatGPT Plus) - runs in the background'
$sc.WindowStyle      = 7          # wscript shows nothing anyway; keeps it tidy
if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon + ',0' }
$sc.Save()

# --- stop shortcut ---
$st = $shell.CreateShortcut($stopLnk)
$st.TargetPath       = $stopper
$st.WorkingDirectory = $here
$st.Description      = 'Stop the Codex GUI background service'
# MUST be 1 (normal). A minimized window (7) hides the result, so the user cannot
# tell whether the stop actually worked -- which is exactly what was reported.
$st.WindowStyle      = 1
if (Test-Path -LiteralPath $icon) { $st.IconLocation = $icon + ',0' }
$st.Save()

Write-Output 'Desktop shortcuts created:'
Write-Output ('  ' + $shortcut + '  -> runs with NO window')
Write-Output ('  ' + $stopLnk + '  -> stops the service')
Write-Output ''
Write-Output ('  hidden : ' + $hidden)
Write-Output ('  stop   : ' + $stopper)
Write-Output ('  icon   : ' + $icon)
Write-Output ''
Write-Output 'The service runs detached: closing any window will not stop it.'
Write-Output 'Use the "(stop)" shortcut to shut it down.'
Write-Output ''
Write-Output ('For troubleshooting use the console launcher instead: ' + $console)
