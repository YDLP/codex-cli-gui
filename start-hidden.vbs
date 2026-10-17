' Starts Codex GUI with NO console window at all, then opens the browser.
' Double-click this, or use the desktop shortcut.
'
' The service runs detached, so closing any window does not stop it.
' To stop it, run stop-codex-gui.cmd.
'
' Every attempt appends one line to .codex-gui\launch.log, because "I
' double-clicked and nothing happened" is otherwise impossible to diagnose:
' wscript has no console, so any error would vanish.
Option Explicit

Dim sh, fso, here, nodeExe, cmd, logFile, logStream, stamp

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here    = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = here & "\.codex-gui\launch.log"
stamp   = Now

Sub LogIt(msg)
  On Error Resume Next
  Dim dir, ts
  dir = here & "\.codex-gui"
  If Not fso.FolderExists(dir) Then fso.CreateFolder(dir)
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine stamp & "  " & msg
  ts.Close
  On Error Goto 0
End Sub

' A PATH entry may end with a backslash, which would produce "D:\nodejs\\node.exe".
Function StripSlash(p)
  Dim s
  s = p
  Do While Right(s, 1) = "\"
    s = Left(s, Len(s) - 1)
  Loop
  StripSlash = s
End Function

' --- locate node ---------------------------------------------------------
nodeExe = ""

' 1. explicit override
On Error Resume Next
nodeExe = sh.RegRead("HKCU\Environment\CODEX_GUI_NODE")
On Error Goto 0
If nodeExe <> "" And Not fso.FileExists(nodeExe) Then nodeExe = ""

' 2. PATH
If nodeExe = "" Then
  Dim parts, i
  parts = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For i = 0 To UBound(parts)
    If parts(i) <> "" Then
      If fso.FileExists(StripSlash(parts(i)) & "\node.exe") Then
        nodeExe = StripSlash(parts(i)) & "\node.exe"
        Exit For
      End If
    End If
  Next
End If

' 3. the places installers actually use
If nodeExe = "" Then
  Dim cands, c
  cands = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    "D:\nodejs\node.exe", _
    "C:\nodejs\node.exe")
  For Each c In cands
    If fso.FileExists(c) Then
      nodeExe = c
      Exit For
    End If
  Next
End If

' 4. registry InstallPath
If nodeExe = "" Then
  On Error Resume Next
  Dim inst
  inst = sh.RegRead("HKLM\SOFTWARE\Node.js\InstallPath")
  If Err.Number = 0 And inst <> "" Then
    If fso.FileExists(inst & "\node.exe") Then nodeExe = inst & "\node.exe"
  End If
  Err.Clear
  On Error Goto 0
End If

If nodeExe = "" Then
  LogIt "FAIL  node.exe not found (PATH, common folders, registry)"
  MsgBox "Node.js not found." & vbCrLf & vbCrLf & _
         "Install Node.js 22 or later, or set the user environment variable" & vbCrLf & _
         "CODEX_GUI_NODE to the full path of node.exe." & vbCrLf & vbCrLf & _
         "Details: " & logFile, 16, "Codex GUI"
  WScript.Quit 1
End If

If Not fso.FileExists(here & "\launch.cjs") Then
  LogIt "FAIL  launch.cjs missing next to start-hidden.vbs"
  MsgBox "launch.cjs is missing from:" & vbCrLf & here, 16, "Codex GUI"
  WScript.Quit 1
End If

' --- start the service (browser opening is done HERE, not in node) -------
' Why: this script launches node with window style 0 (SW_HIDE). That show state
' is inherited by anything node spawns, so a browser started from launch.cjs got
' a HIDDEN window: it exists, it loads the page, and IsWindowVisible/AppActivate
' both say there is nothing. Measured -- the window was simply invisible.
' Opening the URL from here with style 1 gives the browser a normal window.
cmd = """" & nodeExe & """ """ & here & "\launch.cjs"" --detach --no-browser"
LogIt "start  node=" & nodeExe

On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
  LogIt "FAIL  " & Err.Number & ": " & Err.Description
  MsgBox "Could not start Codex GUI:" & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
         "Details: " & logFile, 16, "Codex GUI"
  WScript.Quit 1
End If
On Error Goto 0

' --- wait for the service, then open the page ---------------------------
Dim waited, healthy, http
healthy = False
waited = 0
Do While waited < 25000
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:8790/api/health", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then healthy = True
  Err.Clear
  On Error Goto 0
  If healthy Then Exit Do

  WScript.Sleep 500
  waited = waited + 500
Loop

If healthy Then
  LogIt "service healthy after " & waited & " ms -> opening the page"
  On Error Resume Next
  ' style 1 = normal window, so the browser window is VISIBLE
  sh.Run "http://127.0.0.1:8790/", 1, False
  If Err.Number <> 0 Then
    LogIt "FAIL  could not open the page: " & Err.Number & ": " & Err.Description
    MsgBox "The service is running, but the page could not be opened:" & vbCrLf & _
           "http://127.0.0.1:8790/" & vbCrLf & vbCrLf & "Details: " & logFile, 48, "Codex GUI"
  End If
  On Error Goto 0
Else
  LogIt "WARN  the service never became healthy; not opening a page"
  MsgBox "Codex GUI did not start within 25 seconds." & vbCrLf & vbCrLf & _
         "Details: " & logFile, 48, "Codex GUI"
  WScript.Quit 1
End If

' --- bring the window to the front --------------------------------------
' Windows refuses to let a background process steal focus, so even a visible
' window can open BEHIND whatever the user is looking at -- which reads as
' "double-clicking does nothing". AppActivate is allowed from here.
Dim focused
focused = False
waited = 0
Do While waited < 15000
  WScript.Sleep 500
  waited = waited + 500
  If sh.AppActivate("Codex GUI") Then
    focused = True
    Exit Do
  End If
Loop
If focused Then
  LogIt "focused the Codex GUI window after " & waited & " ms"
Else
  LogIt "WARN  no Codex GUI window to focus after " & waited & " ms (the page may still have opened)"
End If
