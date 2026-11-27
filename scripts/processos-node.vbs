Option Explicit
Dim service, item
Function Encode(value)
  Dim i, result
  result = ""
  For i = 1 To Len(value)
    result = result & Right("0000" & Hex(AscW(Mid(value, i, 1)) And &HFFFF&), 4)
  Next
  Encode = result
End Function
Set service = GetObject("winmgmts:\\.\root\cimv2")
For Each item In service.ExecQuery("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE Name='node.exe'")
  If Not IsNull(item.ExecutablePath) And Not IsNull(item.CommandLine) Then
    WScript.Echo item.ProcessId & vbTab & Encode(item.ExecutablePath) & vbTab & Encode(item.CommandLine)
  End If
Next
