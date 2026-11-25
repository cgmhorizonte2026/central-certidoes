Option Explicit
Dim shell, files, root, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & root & "\INICIAR-CENTRAL.ps1" & Chr(34)
If WScript.Arguments.Count > 0 Then
 If WScript.Arguments(0) = "atalho" Then command = command & " -CreateShortcut"
End If
shell.Run command, 0, False
