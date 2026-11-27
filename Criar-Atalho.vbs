Option Explicit
Dim shell, fso, root, shortcut
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set shortcut = shell.CreateShortcut(fso.BuildPath(shell.SpecialFolders("Desktop"), "Central de Certidoes.lnk"))
shortcut.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
shortcut.Arguments = """" & fso.BuildPath(root, "Abrir-Central.vbs") & """"
shortcut.WorkingDirectory = root
shortcut.Description = "Abrir a Central de Certidoes no navegador"
shortcut.Save
MsgBox "Atalho criado na Area de Trabalho. Use Central de Certidoes para abrir o sistema.", vbInformation, "Central de Certidoes"
