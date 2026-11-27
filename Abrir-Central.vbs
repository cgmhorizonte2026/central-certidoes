Option Explicit
Dim shell, fso, root, folder, node, candidate, entry, runtime, errorFile, result, details
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
node = ""
For Each entry In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
  folder = Replace(Trim(entry), """", "")
  If Len(folder) > 0 Then
    candidate = fso.BuildPath(folder, "node.exe")
    If fso.FileExists(candidate) Then
      node = candidate
      Exit For
    End If
  End If
Next
If node = "" Then
  MsgBox "Node.js nao encontrado. Solicite a instalacao a TI.", vbExclamation, "Central de Certidoes"
  WScript.Quit 1
End If
On Error Resume Next
If Not fso.FolderExists(fso.BuildPath(root, ".runtime")) Then fso.CreateFolder fso.BuildPath(root, ".runtime")
runtime = fso.BuildPath(root, ".runtime\inicializador")
If Not fso.FolderExists(runtime) Then fso.CreateFolder runtime
On Error GoTo 0
errorFile = fso.BuildPath(runtime, fso.GetTempName)
result = shell.Run("""" & node & """ """ & fso.BuildPath(root, "scripts\iniciar-oculto.cjs") & """ """ & errorFile & """", 0, True)
If result <> 0 Then
  details = "Consulte os logs em: " & runtime
  If fso.FileExists(errorFile) Then details = fso.OpenTextFile(errorFile, 1).ReadAll
  MsgBox details, vbExclamation, "Central de Certidoes"
ElseIf fso.FileExists(errorFile) Then
  fso.DeleteFile errorFile
End If
WScript.Quit result
