' Detached AetherVox gateway starter (no console, survives parent exit).
Option Explicit
Dim sh, fso, root, pyw, server, http
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
pyw = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.venv\aethervox-gw\Scripts\pythonw.exe"
If Not fso.FileExists(pyw) Then
  pyw = root & "\.venv\Scripts\pythonw.exe"
End If
server = root & "\server.py"

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1200, 1200, 1200, 1200
http.setProxy 1
http.Open "GET", "http://127.0.0.1:8788/health", False
http.Send
If Err.Number = 0 Then
  If http.Status = 200 Then WScript.Quit 0
End If
Err.Clear
On Error GoTo 0

sh.CurrentDirectory = root
Dim logf
Set logf = fso.OpenTextFile(root & "\.gateway.autostart.log", 8, True)
logf.WriteLine Now & " start " & pyw & " " & server
logf.Close
sh.Run """" & pyw & """ """ & server & """", 0, False
