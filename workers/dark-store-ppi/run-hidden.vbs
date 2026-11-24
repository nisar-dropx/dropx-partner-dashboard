' Run a cmd line with no console window.
' Usage: wscript //B //Nologo run-hidden.vbs "cmd /c ..."
If WScript.Arguments.Count < 1 Then WScript.Quit 1
CreateObject("WScript.Shell").Run WScript.Arguments.Item(0), 0, True
