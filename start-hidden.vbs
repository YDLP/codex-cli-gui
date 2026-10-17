' Starts Codex GUI with NO console window at all, then opens the browser.
' Double-click this, or use the desktop shortcut.
'
' The window you used to see (and could accidentally close) is gone entirely:
' the service runs detached, so closing anything does not stop it.
' To stop it, run stop-codex-gui.cmd.
Option Explicit

Dim sh, fso, here, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Locate node: prefer PATH, fall back to the usual install location.
nodeExe = ""
On Error Resume Next
nodeExe = sh.RegRead("HKCU\Environment\CODEX_GUI_NODE")
On Error Goto 0

If nodeExe = "" Or Not fso.FileExists(nodeExe) Then
  Dim p, parts, i
  p = sh.ExpandEnvironmentStrings("%PATH%")
  parts = Split(p, ";")
  For i = 0 To UBound(parts)
    If parts(i) <> "" Then
      If fso.FileExists(parts(i) & "\node.exe") Then
        nodeExe = parts(i) & "\node.exe"
        Exit For
      End If
    End If
  Next
End If

If nodeExe = "" Then
  MsgBox "Node.js not found in PATH." & vbCrLf & _
         "Install Node.js 22 or later, then try again.", 16, "Codex GUI"
  WScript.Quit 1
End If

cmd = """" & nodeExe & """ """ & here & "\launch.cjs"" --detach"

' 0 = hide the window, False = do not wait (launch.cjs detaches the service).
sh.Run cmd, 0, False
