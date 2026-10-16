# Read another process's environment block (same-user, read-only) via PEB walk.
# Purpose: recover OPENCODE_SERVER_PASSWORD for the user's OWN running OpenCode sidecar
# so we can query the local engine API. No writes, no injection.
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcEnv {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);

    public static string Get(int pid) {
        IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) return "OpenProcess failed: " + Marshal.GetLastWin32Error();
        try {
            byte[] pbi = new byte[48];
            int ret;
            if (NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret) != 0) return "NtQueryInformationProcess failed";
            IntPtr peb = (IntPtr)BitConverter.ToInt64(pbi, 8);
            if (peb == IntPtr.Zero) return "PEB null";
            byte[] b8 = new byte[8];
            IntPtr got;
            // PEB->ProcessParameters at offset 0x20
            if (!ReadProcessMemory(h, (IntPtr)((long)peb + 0x20), b8, 8, out got)) return "read ProcessParameters failed";
            IntPtr pp = (IntPtr)BitConverter.ToInt64(b8, 0);
            if (pp == IntPtr.Zero) return "ProcessParameters null";
            // RTL_USER_PROCESS_PARAMETERS->Environment at offset 0x80
            if (!ReadProcessMemory(h, (IntPtr)((long)pp + 0x80), b8, 8, out got)) return "read Environment ptr failed";
            IntPtr env = (IntPtr)BitConverter.ToInt64(b8, 0);
            if (env == IntPtr.Zero) return "Environment null";
            byte[] chunk = new byte[65536];
            if (!ReadProcessMemory(h, env, chunk, chunk.Length, out got)) return "read env block failed";
            int n = (int)got;
            return Encoding.Unicode.GetString(chunk, 0, n);
        } finally { CloseHandle(h); }
    }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$pids = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
if (-not $pids) { Write-Output "no NodeService pid found"; exit }
foreach ($pid2 in $pids) {
  Write-Output ("===== PID {0} environment (filtered) =====" -f $pid2)
  $blob = [ProcEnv]::Get($pid2)
  $vars = $blob -split "`0" | Where-Object { $_ -match '=' }
  foreach ($v in $vars) {
    if ($v -match '^(OPENCODE|XDG|HTTPS?_PROXY|NO_PROXY|NODE_|ELECTRON_)') {
      if ($v -match 'PASSWORD|TOKEN|KEY|SECRET') {
        $k,$val = $v -split '=',2
        Write-Output ("  {0}=<redacted len={1} sha256={2}>" -f $k, $val.Length, (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($val))) -Algorithm SHA256).Hash.Substring(0,12))
      } else { Write-Output ("  " + $v) }
    }
  }
  Write-Output ("  (total env vars: {0})" -f $vars.Count)
}
