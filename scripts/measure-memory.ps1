[CmdletBinding()]
param(
    [string]$AppPath,
    [string]$OutputDirectory,
    [ValidateRange(120, 3600)][int]$DurationSeconds = 120,
    [ValidateSet('codex', 'claude')][string]$Provider = 'codex',
    [ValidateRange(30, 3600)][int]$AgentDeadlineSeconds = 1800,
    [string]$AuthenticationDataDirectory,
    [ValidateRange(0, 1800)][int]$AuthenticationTimeoutSeconds = 120,
    [switch]$AllowNonstandardDisplayScale
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $AppPath -or -not $OutputDirectory) { throw 'Supply -AppPath <release texypaper.exe> and -OutputDirectory <new evidence directory>; no interactive parameter prompting is used.' }
$repository = Split-Path -Parent $PSScriptRoot
$AppPath = (Resolve-Path -LiteralPath $AppPath).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory must not exist; measurements never overwrite a previous run.' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
$desktopOutput = Join-Path $OutputDirectory 'desktop'
$reportPath = Join-Path $OutputDirectory 'memory-results.json'
$samples = [Collections.Generic.List[object]]::new()
$identities = @{}
$owned = @{}
$phase = 'startup'
$rootPid = 0
$profile = ''
$launch = $null
$runner = $null
$report = $null
$metric = 'GetProcessMemoryInfo/PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize'
$commandLines = @{}
$unrelatedInaccessible = @{}
$displayScale = [ordered]@{ standardScaleRequired = 1; standardWindowDpiRequired = 96; observed = $null; rendererDevicePixelRatio = $null; rendererDprTolerance = 0.000001; nativeWindowDpi = $null; windowsScale = $null; nativeWindowHandle = $null; nativeDpiQueryAvailable = $false; nativeDpiQueryError = $null; accepted = $false; diagnosticOptIn = [bool]$AllowNonstandardDisplayScale; limitation = 'Physical scale has not yet been queried. Standard acceptance requires owned-window GetDpiForWindow=96 and renderer DPR within 1e-6 of 1; renderer/CDP scale alone is not physical-scale evidence.' }
$stream = [IO.StreamWriter]::new((Join-Path $OutputDirectory 'memory-samples.jsonl'), $false, [Text.UTF8Encoding]::new($false))
function Write-JsonFile([string]$Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false)) }
function Native-Argument([string]$Value) {
    # CommandLineToArgvW quoting, passed directly to CreateProcess (never cmd/PowerShell -Command).
    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', { param($match) ($match.Groups[1].Value + $match.Groups[1].Value + '\"') })
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Initialize-NativeSampler {
    if ('TexyPaperSmoke.NativeSampler' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
namespace TexyPaperSmoke {
    public sealed class ProcessInfo {
        public int ProcessId;
        public int ParentProcessId;
        public string Name;
        public DateTime CreationDate;
        public bool CreationKnown;
        public string MetadataError;
        public string CommandLine;
    }
    public static class NativeSampler {
        const uint QueryLimited = 0x1000;
        const uint SnapshotProcesses = 0x2;
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        struct ProcessEntry {
            public uint Size, Usage, ProcessId;
            public UIntPtr DefaultHeapId;
            public uint ModuleId, Threads, ParentProcessId;
            public int PriorityClass;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)]
            public string ExeFile;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct MemoryCountersEx2 {
            public uint Size, PageFaultCount;
            public UIntPtr PeakWorkingSetSize, WorkingSetSize;
            public UIntPtr QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
            public UIntPtr QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage;
            public UIntPtr PagefileUsage, PeakPagefileUsage, PrivateUsage, PrivateWorkingSetSize;
            public ulong SharedCommitUsage;
        }
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint length);
        [DllImport("psapi.dll", SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        static extern bool GetProcessMemoryInfo(IntPtr process, ref MemoryCountersEx2 counters, uint size);
        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, int length, out int returnedLength);
        public static void RequireEx2Support() {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion")) {
                if (key == null) throw new NotSupportedException("Cannot establish Windows support for PROCESS_MEMORY_COUNTERS_EX2.");
                int build = Convert.ToInt32(key.GetValue("CurrentBuildNumber", "0"));
                int revision = Convert.ToInt32(key.GetValue("UBR", -1));
                if (!(build >= 22631 || (build == 22621 && revision >= 2361) || (build == 19045 && revision >= 3448)))
                    throw new NotSupportedException("PrivateWorkingSetSize requires Windows 10/11 22H2 with the September 2023 cumulative update or later; observed build " + build + "." + revision + ". No private-commit substitute is used.");
            }
        }
        public static ProcessInfo[] Snapshot() {
            IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
            if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Toolhelp32 process snapshot failed");
            var result = new List<ProcessInfo>();
            try {
                var entry = new ProcessEntry();
                entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                bool found = Process32FirstW(snapshot, ref entry);
                if (!found) throw new Win32Exception(Marshal.GetLastWin32Error(), "Toolhelp32 first process failed");
                do {
                    if (entry.ProcessId == 0) continue;
                    var item = new ProcessInfo { ProcessId = (int)entry.ProcessId, ParentProcessId = (int)entry.ParentProcessId, Name = entry.ExeFile };
                    IntPtr handle = OpenProcess(QueryLimited, false, item.ProcessId);
                    if (handle == IntPtr.Zero) {
                        int openError = Marshal.GetLastWin32Error();
                        if (openError == 87 || openError == 1168) continue; // Ended between Toolhelp snapshot and handle acquisition.
                        item.MetadataError = "OpenProcess(query limited) failed: Win32 " + openError;
                    }
                    else {
                        try {
                            long creation, exit, kernel, user;
                            if (GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
                                if (exit != 0) continue;
                                item.CreationDate = DateTime.FromFileTimeUtc(creation);
                                item.CreationKnown = true;
                            } else item.MetadataError = "GetProcessTimes failed: Win32 " + Marshal.GetLastWin32Error();
                        } finally { CloseHandle(handle); }
                    }
                    result.Add(item);
                } while (Process32NextW(snapshot, ref entry));
                int error = Marshal.GetLastWin32Error();
                if (error != 18) throw new Win32Exception(error, "Toolhelp32 next process failed");
                return result.ToArray();
            } finally { CloseHandle(snapshot); }
        }
        static bool IsExpected(IntPtr handle, long expectedTicks) {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessTimes identity check failed");
            return exit == 0 && DateTime.FromFileTimeUtc(creation).Ticks == expectedTicks;
        }
        static IntPtr OpenExpected(int processId, long expectedTicks) {
            IntPtr handle = OpenProcess(QueryLimited, false, processId);
            if (handle == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                if (error == 87 || error == 1168) return IntPtr.Zero;
                throw new Win32Exception(error, "Cannot query owned/new process PID " + processId);
            }
            try {
                if (IsExpected(handle, expectedTicks)) return handle;
            } catch { CloseHandle(handle); throw; }
            CloseHandle(handle);
            return IntPtr.Zero;
        }
        public static bool Matches(int processId, long expectedTicks) {
            IntPtr handle = OpenExpected(processId, expectedTicks);
            if (handle == IntPtr.Zero) return false;
            CloseHandle(handle);
            return true;
        }
        public static long? PrivateWorkingSet(int processId, long expectedTicks) {
            IntPtr handle = OpenExpected(processId, expectedTicks);
            if (handle == IntPtr.Zero) return null;
            try {
                var counters = new MemoryCountersEx2();
                counters.Size = (uint)Marshal.SizeOf(typeof(MemoryCountersEx2));
                if (!GetProcessMemoryInfo(handle, ref counters, counters.Size)) {
                    int error = Marshal.GetLastWin32Error();
                    if (!IsExpected(handle, expectedTicks)) return null;
                    throw new Win32Exception(error, "GetProcessMemoryInfo(EX2) failed for live owned PID " + processId);
                }
                if (!IsExpected(handle, expectedTicks)) return null;
                return checked((long)counters.PrivateWorkingSetSize.ToUInt64());
            } finally { CloseHandle(handle); }
        }
        public static string ImagePath(int processId, long expectedTicks) {
            IntPtr handle = OpenExpected(processId, expectedTicks);
            if (handle == IntPtr.Zero) return null;
            try {
                var buffer = new StringBuilder(32768);
                uint length = (uint)buffer.Capacity;
                if (!QueryFullProcessImageNameW(handle, 0, buffer, ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read launched executable identity");
                return buffer.ToString();
            } finally { CloseHandle(handle); }
        }
        public static string CommandLine(int processId, long expectedTicks) {
            IntPtr handle = OpenExpected(processId, expectedTicks);
            if (handle == IntPtr.Zero) return null;
            try {
                int required;
                NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out required);
                int header = IntPtr.Size == 8 ? 16 : 8;
                if (required < header || required > 65536) throw new InvalidOperationException("Bounded process command-line query requires " + required + " bytes.");
                IntPtr buffer = Marshal.AllocHGlobal(required);
                try {
                    int returned;
                    int status = NtQueryInformationProcess(handle, 60, buffer, required, out returned);
                    if (status != 0) {
                        if (!IsExpected(handle, expectedTicks)) return null;
                        throw new InvalidOperationException("NtQueryInformationProcess(command line) returned 0x" + status.ToString("X8"));
                    }
                    int length = (ushort)Marshal.ReadInt16(buffer);
                    IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4);
                    long start = buffer.ToInt64(), address = text.ToInt64();
                    if ((length & 1) != 0 || (length != 0 && (address < start + header || address > start + required - length)))
                        throw new InvalidOperationException("Native command-line buffer has invalid UTF-16 bounds.");
                    return length == 0 ? String.Empty : Marshal.PtrToStringUni(text, length / 2);
                } finally { Marshal.FreeHGlobal(buffer); }
            } finally { CloseHandle(handle); }
        }
    }
}
'@
    [TexyPaperSmoke.NativeSampler]::RequireEx2Support()
}
function Get-CachedCommandLine($Process) {
    $key = Process-Key $Process
    if ($commandLines.ContainsKey($key)) { return $commandLines[$key] }
    $ticks = ([datetime]$Process.CreationDate).ToUniversalTime().Ticks
    try { $line = [TexyPaperSmoke.NativeSampler]::CommandLine([int]$Process.ProcessId, $ticks) }
    catch {
        $nativeError = $_.Exception.Message
        # Only newly seen process identities may use this bounded, one-time compatibility lookup.
        $fallback = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Process.ProcessId)" -ErrorAction Stop
        if (-not [TexyPaperSmoke.NativeSampler]::Matches([int]$Process.ProcessId, $ticks)) { return $null }
        if (-not $fallback -or $null -eq $fallback.CommandLine) { throw "Command-line ownership/classification is unavailable for live PID $($Process.ProcessId): $nativeError; one-time CIM lookup supplied no command line." }
        $line = [string]$fallback.CommandLine
    }
    $commandLines[$key] = $line
    return $line
}
function Process-Key($Process) { return ([string]$Process.ProcessId + ':' + ([datetime]$Process.CreationDate).ToUniversalTime().Ticks) }
function Get-Category($Process, $ByPid, $Depth = 0) {
    $name = ([string]$Process.Name).ToLowerInvariant()
    if ($name -eq 'msedgewebview2.exe') { return 'webview2' }
    if ($name -match '^(ssh|sftp|wsl|wslhost)\.exe$') { return 'ssh' }
    if ($name -match '^(latexmk|pdflatex|pdftex|xelatex|xetex|lualatex|luahbtex|luatex|bibtex|biber|makeindex|xdvipdfmx|synctex|miktex-latexmk|perl)\.exe$') { return 'tex' }
    if ($name -match '^(codex|claude|claude-code)\.exe$') { return 'ai' }
    if ($name -eq 'node.exe' -and ([string]$Process.CommandLine) -match '(?i)(@openai[\\/]codex|@anthropic-ai[\\/]claude-code|codex\.js|claude.*cli\.js)') { return 'ai' }
    if ($name -eq 'texypaper.exe') { return 'app' } # Includes app-owned MCP bridge and askpass helpers.
    if ($Depth -lt 32 -and $ByPid.ContainsKey([int]$Process.ParentProcessId)) { return Get-Category $ByPid[[int]$Process.ParentProcessId] $ByPid ($Depth + 1) }
    return 'app'
}
function Take-Sample {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $processes = [TexyPaperSmoke.NativeSampler]::Snapshot()
    $byPid = @{}; $presentKeys = @{}
    foreach ($process in $processes) {
        $byPid[[int]$process.ProcessId] = $process
        if ($process.CreationKnown) {
            $key = Process-Key $process; $presentKeys[$key] = $true
            if ($profile -and $process.Name -eq 'msedgewebview2.exe') { $process.CommandLine = Get-CachedCommandLine $process }
        } elseif ($profile -and $process.Name -eq 'msedgewebview2.exe') { throw "Cannot establish creation-time/profile ownership for WebView2 PID $($process.ProcessId): $($process.MetadataError)" }
    }
    foreach ($key in @($commandLines.Keys)) { if (-not $presentKeys.ContainsKey($key)) { $commandLines.Remove($key) } }
    if ($rootPid -and $byPid.ContainsKey($rootPid)) {
        if (-not $byPid[$rootPid].CreationKnown) { throw "Owned app creation identity is unavailable: $($byPid[$rootPid].MetadataError)" }
        $key = Process-Key $byPid[$rootPid]
        if (-not $script:rootIdentity) { $script:rootIdentity = $key }
        if ($key -ne $script:rootIdentity) { throw 'Root PID was reused by an unrelated process; refusing to attribute its memory.' }
        $owned[$key] = $true
    }
    for ($pass = 0; $pass -lt 32; $pass++) {
        $added = $false
        foreach ($process in $processes) {
            $parentId = [int]$process.ParentProcessId
            $parentKnown = $byPid.ContainsKey($parentId) -and $byPid[$parentId].CreationKnown
            $parentOwned = $parentKnown -and $owned.ContainsKey((Process-Key $byPid[$parentId]))
            if (-not $process.CreationKnown) {
                if ($parentOwned -and -not $unrelatedInaccessible.ContainsKey([int]$process.ProcessId)) {
                    # Protected/other-session processes deny query access but may carry a stale parent PID that an
                    # owned process now reuses. One CIM lookup supplies the creation time for the same stale-parent rule.
                    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$process.ProcessId)" -ErrorAction SilentlyContinue
                    if (-not $cim) { continue }
                    if ([datetime]$cim.CreationDate -lt [datetime]$byPid[$parentId].CreationDate) { $unrelatedInaccessible[[int]$process.ProcessId] = $true; continue }
                    throw "Owned descendant PID $($process.ProcessId) cannot be queried: $($process.MetadataError)"
                }
                continue
            }
            $key = Process-Key $process
            if ($owned.ContainsKey($key)) { continue }
            # A stale Toolhelp parent PID is not ancestry if the current parent was created later.
            $parentOwned = $parentOwned -and ([datetime]$process.CreationDate -ge [datetime]$byPid[$parentId].CreationDate)
            $profileOwned = $profile -and $process.Name -eq 'msedgewebview2.exe' -and ([string]$process.CommandLine).IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
            if ($parentOwned -or $profileOwned) { $owned[$key] = $true; $added = $true }
        }
        if (-not $added) { break }
    }
    foreach ($process in $processes) {
        if ($process.CreationKnown -and $process.Name -eq 'node.exe' -and $owned.ContainsKey((Process-Key $process))) { $process.CommandLine = Get-CachedCommandLine $process }
    }
    $totals = @{ app = [long]0; webview2 = [long]0; ssh = [long]0; tex = [long]0; ai = [long]0 }
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($process in $processes) {
        if (-not $process.CreationKnown) { continue }
        $key = Process-Key $process
        if (-not $owned.ContainsKey($key)) { continue }
        $processId = [int]$process.ProcessId
        $bytes = [TexyPaperSmoke.NativeSampler]::PrivateWorkingSet($processId, ([datetime]$process.CreationDate).ToUniversalTime().Ticks)
        # Null means this exact identity exited or was replaced. Query failures for live owned PIDs throw.
        if ($null -eq $bytes) { continue }
        $category = Get-Category $process $byPid
        $totals[$category] += [long]$bytes
        $row = [ordered]@{ pid = $processId; creationTime = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o'); parentPid = [int]$process.ParentProcessId; name = $process.Name; category = $category; workingSetPrivateBytes = [long]$bytes }
        $rows.Add($row)
        if (-not $identities.ContainsKey($key)) { $identities[$key] = $row }
    }
    $appBudget = $totals.app + $totals.webview2
    $sample = [ordered]@{ timestamp = [datetime]::UtcNow.ToString('o'); phase = $phase; metric = $metric; app = $totals.app; webview2 = $totals.webview2; ssh = $totals.ssh; tex = $totals.tex; ai = $totals.ai; appBudget = $appBudget; combined = $appBudget + $totals.ssh + $totals.tex + $totals.ai; collectionMs = $clock.ElapsedMilliseconds; processes = @($rows.ToArray()) }
    $samples.Add($sample); $stream.WriteLine(($sample | ConvertTo-Json -Compress -Depth 8)); $stream.Flush()
    $remaining = 1000 - $clock.ElapsedMilliseconds; if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
}
function Get-OwnedWindowDpi {
    try {
        if (-not ('TexyPaperSmoke.NativeDpi' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace TexyPaperSmoke {
    public static class NativeDpi {
        [DllImport("user32.dll", SetLastError=true)]
        public static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError=true)]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
        [DllImport("user32.dll")]
        public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    }
}
'@
        }
        $identity = [TexyPaperSmoke.NativeSampler]::Snapshot() | Where-Object { $_.ProcessId -eq $rootPid }
        if (-not $identity) { throw "Owned app PID $rootPid no longer exists." }
        if (-not $script:rootIdentity) {
            if (-not $identity.CreationKnown -or [int]$identity.ParentProcessId -ne $runner.Id -or [TexyPaperSmoke.NativeSampler]::ImagePath($rootPid, $identity.CreationDate.Ticks) -ine $AppPath) { throw "PID $rootPid does not match the exact app executable launched by this run's Node process." }
            $script:rootIdentity = Process-Key $identity
            $owned[$script:rootIdentity] = $true
        }
        if ((Process-Key $identity) -ne $script:rootIdentity) { throw "Owned app PID $rootPid creation identity changed; refusing an unrelated window." }
        $appProcess = Get-Process -Id $rootPid -ErrorAction Stop
        $appProcess.Refresh()
        $window = $appProcess.MainWindowHandle
        if ($window -eq [IntPtr]::Zero) { throw "Owned app PID $rootPid has no main window handle." }
        [uint32]$windowOwner = 0
        $threadId = [TexyPaperSmoke.NativeDpi]::GetWindowThreadProcessId($window, [ref]$windowOwner)
        if ($threadId -eq 0 -or $windowOwner -ne $rootPid) { throw "Main window handle is not owned by launched app PID $rootPid." }
        $dpi = [TexyPaperSmoke.NativeDpi]::GetDpiForWindow($window)
        if ($dpi -eq 0) { throw "GetDpiForWindow returned zero for owned app HWND $window (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
        $context = [TexyPaperSmoke.NativeDpi]::GetWindowDpiAwarenessContext($window)
        $awareness = [TexyPaperSmoke.NativeDpi]::GetAwarenessFromDpiAwarenessContext($context)
        if ($awareness -ne 2) { throw "Owned window DPI awareness is $awareness, not per-monitor-aware (2); GetDpiForWindow=$dpi cannot establish this monitor's physical scale without DPI virtualization." }
        return [ordered]@{ available = $true; nativeWindowDpi = [int]$dpi; windowsScale = ([double]$dpi / 96); nativeWindowHandle = $window.ToInt64().ToString(); windowOwnerPid = [int]$windowOwner; awareness = $awareness; error = $null }
    }
    catch {
        return [ordered]@{ available = $false; nativeWindowDpi = $null; windowsScale = $null; nativeWindowHandle = $null; windowOwnerPid = $rootPid; awareness = $null; error = $_.Exception.Message }
    }
}
function Get-RunnerExitCode {
    $runner.Refresh()
    if (-not $runner.HasExited) { throw "Desktop workload PID $($runner.Id) has not exited; no exit code is available yet." }
    $runner.WaitForExit()
    $runner.Refresh()
    $code = $runner.ExitCode
    if ($null -eq $code) { throw "Desktop workload PID $($runner.Id) exited, but Windows did not expose its exit code after WaitForExit/Refresh. Inspect desktop/failure.json and runner.stderr.log; no success code is inferred." }
    return [int]$code
}
function Wait-File([string]$Path, [int]$Seconds) {
    $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
    while (-not (Test-Path -LiteralPath $Path)) {
        $runner.Refresh()
        if ($runner.HasExited) { $exitCode = Get-RunnerExitCode; throw "Desktop workload exited with exit code $exitCode; see desktop/failure.json and runner.stderr.log." }
        if ([datetime]::UtcNow -ge $deadline) { throw "Timed out waiting for $Path" }
        Take-Sample
    }
}
function Distribution($Values) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) { throw 'Required measurement phase has no actual samples.' }
    $middle = [math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2) { $sorted[$middle] } else { ($sorted[$middle - 1] + $sorted[$middle]) / 2 }
    return [ordered]@{ count = $sorted.Count; medianBytes = $median; p95Bytes = $sorted[[math]::Max(0, [math]::Ceiling($sorted.Count * 0.95) - 1)]; maxBytes = $sorted[-1] }
}
$script:rootIdentity = ''
try {
    Initialize-NativeSampler
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $arguments = @((Join-Path $PSScriptRoot 'smoke-desktop.mjs'), '--binary', $AppPath, '--output', $desktopOutput, '--mode', 'memory', '--provider', $Provider, '--measurement-seconds', [string]$DurationSeconds, '--auth-timeout-seconds', [string]$AuthenticationTimeoutSeconds)
    if ($AuthenticationDataDirectory) { $arguments += @('--auth-data-dir', [IO.Path]::GetFullPath($AuthenticationDataDirectory)) }
    if ($AllowNonstandardDisplayScale) { $arguments += '--allow-nonstandard-display-scale' }
    $quoted = @($arguments | ForEach-Object { Native-Argument $_ })
    $runner = Start-Process -FilePath $node -ArgumentList ($quoted -join ' ') -WorkingDirectory $repository -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory 'runner.stdout.log') -RedirectStandardError (Join-Path $OutputDirectory 'runner.stderr.log')
    # Keep the exact launched process handle alive so Start-Process exit status remains observable after exit.
    $runnerHandle = $runner.Handle
    $launchPath = Join-Path $desktopOutput 'launch.json'
    Wait-File $launchPath 300
    $launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
    $rootPid = [int]$launch.pid; $profile = [string]$launch.profile
    Wait-File (Join-Path $desktopOutput 'memory-ready.json') 300
    $ready = Get-Content -LiteralPath (Join-Path $desktopOutput 'memory-ready.json') -Raw | ConvertFrom-Json
    $observedScale = [double]$ready.scale.devicePixelRatio
    if ([double]::IsNaN($observedScale) -or [double]::IsInfinity($observedScale) -or $observedScale -le 0) { throw 'The renderer DPR observation is invalid; no physical display-scale acceptance is inferred.' }
    $physicalScale = Get-OwnedWindowDpi
    $displayScale['observed'] = $observedScale
    $displayScale['rendererDevicePixelRatio'] = $observedScale
    $displayScale['nativeWindowDpi'] = $physicalScale.nativeWindowDpi
    $displayScale['windowsScale'] = $physicalScale.windowsScale
    $displayScale['nativeWindowHandle'] = $physicalScale.nativeWindowHandle
    $displayScale['nativeDpiQueryAvailable'] = [bool]$physicalScale.available
    $displayScale['nativeDpiQueryError'] = $physicalScale.error
    $displayScale['accepted'] = $physicalScale.available -and $physicalScale.nativeWindowDpi -eq 96 -and [math]::Abs($observedScale - 1) -le $displayScale.rendererDprTolerance
    $displayScale['limitation'] = if (-not $physicalScale.available) { "Physical Windows scale is unverified: $($physicalScale.error) Renderer DPR=$observedScale cannot replace GetDpiForWindow evidence; standard acceptance remains false. No OS scale was changed." } elseif ($displayScale.accepted) { "Owned-window GetDpiForWindow=96 establishes native 100% scale; renderer DPR=$observedScale agrees within 1e-6. Separate CDP high-DPI emulation is not physical-scale evidence." } else { "Owned-window GetDpiForWindow=$($physicalScale.nativeWindowDpi), Windows scale=$($physicalScale.windowsScale), renderer DPR=$observedScale. Standard acceptance requires physical DPI=96 and renderer DPR within 1e-6 of 1. Measurements describe the observed configuration only; no OS scale was changed and CDP is not treated as physical 100%." }
    Write-JsonFile (Join-Path $OutputDirectory 'display-scale.json') $displayScale
    if (-not $displayScale.accepted -and -not $AllowNonstandardDisplayScale) { throw "$($displayScale.limitation) Use -AllowNonstandardDisplayScale only for non-passing diagnostics." }
    if ($ready.sourceViews -ne 1) { throw "Expected one mounted editor, observed $($ready.sourceViews)." }
    $phase = 'warmup'; for ($index = 0; $index -lt 20; $index++) { Take-Sample }
    $phase = 'baseline'; for ($index = 0; $index -lt 10; $index++) { Take-Sample }
    [IO.File]::WriteAllText((Join-Path $desktopOutput 'memory-cycles.start'), 'start')
    $phase = 'standard'; $deadline = [datetime]::UtcNow.AddSeconds($DurationSeconds)
    while ([datetime]::UtcNow -lt $deadline) { $runner.Refresh(); if ($runner.HasExited) { $exitCode = Get-RunnerExitCode; throw "Desktop workload exited with exit code $exitCode during standard measurement; see desktop/failure.json and runner.stderr.log." }; Take-Sample }
    Wait-File (Join-Path $desktopOutput 'memory-cycles.done.json') 180
    $cycles = Get-Content -LiteralPath (Join-Path $desktopOutput 'memory-cycles.done.json') -Raw | ConvertFrom-Json
    if ($cycles.cycles -ne 20) { throw 'Twenty real project/PDF switch cycles were not completed.' }
    $phase = 'settling'; for ($index = 0; $index -lt 20; $index++) { Take-Sample }
    $phase = 'final'; for ($index = 0; $index -lt 10; $index++) { Take-Sample }
    [IO.File]::WriteAllText((Join-Path $desktopOutput 'memory-highdpi.start'), 'start')
    $phase = 'high-dpi'; $highDpiDeadline = [datetime]::UtcNow.AddSeconds(30)
    while ([datetime]::UtcNow -lt $highDpiDeadline) { Take-Sample }
    Wait-File (Join-Path $desktopOutput 'memory-highdpi.done.json') 120
    $highDpi = Get-Content -LiteralPath (Join-Path $desktopOutput 'memory-highdpi.done.json') -Raw | ConvertFrom-Json
    [IO.File]::WriteAllText((Join-Path $desktopOutput 'memory-highdpi.stop'), 'stop')
    [IO.File]::WriteAllText((Join-Path $desktopOutput 'memory-agent.start'), 'start')
    $phase = 'live-agent'; Wait-File (Join-Path $desktopOutput 'memory-agent.done.json') $AgentDeadlineSeconds
    $agent = Get-Content -LiteralPath (Join-Path $desktopOutput 'memory-agent.done.json') -Raw | ConvertFrom-Json
    # An unavailable official login fails the live gate but never discards the measured standard-workload evidence.
    $phase = 'agent-settling'; for ($index = 0; $index -lt 10; $index++) { Take-Sample }
    $categories = @('app', 'webview2', 'ssh', 'tex', 'ai', 'appBudget', 'combined')
    $summary = [ordered]@{}
    foreach ($category in $categories) {
        $summary[$category] = [ordered]@{}
        foreach ($name in @('startup', 'warmup', 'baseline', 'standard', 'settling', 'final', 'high-dpi', 'live-agent', 'agent-settling')) {
            $values = @($samples | Where-Object { $_.phase -eq $name } | ForEach-Object { $_[$category] })
            if ($values.Count) { $summary[$category][$name] = Distribution $values }
        }
    }
    $growth = $summary.appBudget.final.medianBytes - $summary.appBudget.baseline.medianBytes
    $budgetMax = [long]0
    foreach ($name in @('baseline', 'standard', 'settling', 'final')) { $budgetMax = [math]::Max($budgetMax, $summary.appBudget[$name].maxBytes) }
    $texConcurrent = @($samples | ForEach-Object { @($_.processes | Where-Object { $_.name -match '^(latexmk|miktex-latexmk)\.exe$' }).Count } | Measure-Object -Maximum).Maximum
    $aiConcurrent = @($samples | ForEach-Object { @($_.processes | Where-Object { $_.name -match '^(codex|claude|claude-code)\.exe$' }).Count } | Measure-Object -Maximum).Maximum
    $os = Get-CimInstance Win32_OperatingSystem
    $machine = Get-CimInstance Win32_ComputerSystem
    $standardSampleCount = @($samples | Where-Object { $_.phase -eq 'standard' }).Count
    $gates = [ordered]@{ standardAppBudgetAtMost300MiB = ($budgetMax -le 300MB); finalSameStateGrowthAtMost20MiB = ($growth -le 20MB); twentyRealCycles = ($cycles.cycles -eq 20); oneMountedEditor = ($ready.sourceViews -eq 1); oneCompilerAtATime = ($texConcurrent -le 1); oneAgentAtATime = ($aiConcurrent -le 1); realAgentWorkload = [bool]$agent.passed; highDpiScrollExercised = ([math]::Abs([double]$highDpi.effectiveDevicePixelRatio - 2) -le 0.000001); oneSecondSamplingCadence = ($standardSampleCount -ge $DurationSeconds - 2) }
    $gates['standardDisplayScale'] = [bool]$displayScale.accepted
    $report = [ordered]@{ version = 1; passed = -not ($gates.Values -contains $false); metric = $metric; unit = 'bytes'; durationSeconds = $DurationSeconds; warmupSeconds = 20; machine = @{ name = $env:COMPUTERNAME; os = $os.Caption; osVersion = $os.Version; totalPhysicalBytes = $machine.TotalPhysicalMemory; webview2Version = $ready.webviewVersion; devicePixelRatio = $ready.scale.devicePixelRatio; viewport = $ready.scale }; fixture = $ready.fixture; processIdentities = @($identities.Values); summary = $summary; finalMedianGrowthBytes = $growth; standardMaximumAppBudgetBytes = $budgetMax; maxConcurrentCompilerRoots = $texConcurrent; maxConcurrentProviderRoots = $aiConcurrent; gates = $gates; remote = @{ exercised = $false; note = 'This standard workload is local. Remote worker/TeX cost is not zero and is not measured by the Windows sampler.' }; provider = $Provider; targetSnapshots = $cycles.targetSnapshots }
    $report['highDpi'] = $highDpi
    $report['agent'] = $agent
    $report['sampling'] = @{ standardCount = $standardSampleCount; requestedSeconds = $DurationSeconds; maximumCollectionMs = ($samples | ForEach-Object { $_['collectionMs'] } | Measure-Object -Maximum).Maximum; note = 'Samples are actual snapshots; missed cadences are not filled with invented values.' }
    $report['displayScale'] = $displayScale
    $report.machine['nativeWindowDpi'] = $displayScale.nativeWindowDpi
    $report.machine['windowsScale'] = $displayScale.windowsScale
    $report.machine['rendererDevicePixelRatio'] = $observedScale
    $report['measurementMode'] = if ($displayScale.accepted) { 'standard-native-100-percent' } else { 'nonstandard-native-display-scale-diagnostic' }
    $report['standardAcceptance'] = [bool]$report.passed
    Write-JsonFile $reportPath $report
    [IO.File]::WriteAllText((Join-Path $desktopOutput 'memory-stop'), 'stop')
    if (-not $runner.WaitForExit(30000)) { throw 'Desktop workload failed to close after sampling.' }
    $runnerExitCode = Get-RunnerExitCode
    if ($runnerExitCode -ne 0) { throw "Desktop workload exited with exit code $runnerExitCode; see desktop/failure.json and runner.stderr.log." }
    if (-not $report.passed) { throw 'Memory acceptance gates failed; inspect memory-results.json. No ceiling has been claimed.' }
    Write-Output ($report | ConvertTo-Json -Depth 20)
}
catch {
    $caught = $_
    if ($report) { $report['passed'] = $false; $report['standardAcceptance'] = $false; $report['failure'] = $caught.Exception.Message; Write-JsonFile $reportPath $report }
    $failure = [ordered]@{ version = 1; passed = $false; phase = $phase; error = $_.Exception.Message; sampledCount = $samples.Count; metric = $metric }
    $failure['displayScale'] = $displayScale
    $partial = [ordered]@{}
    foreach ($category in @('app', 'webview2', 'ssh', 'tex', 'ai', 'appBudget', 'combined')) {
        $partial[$category] = [ordered]@{}
        foreach ($name in @($samples | ForEach-Object { $_.phase } | Select-Object -Unique)) {
            $partial[$category][$name] = Distribution @($samples | Where-Object { $_.phase -eq $name } | ForEach-Object { $_[$category] })
        }
    }
    $partialReport = [ordered]@{ passed = $false; standardAcceptance = $false; measuredSummary = $partial; blocker = $caught.Exception.Message; metric = $metric; displayScale = $displayScale }
    Write-JsonFile (Join-Path $OutputDirectory 'memory-partial-results.json') $partialReport
    Write-JsonFile (Join-Path $OutputDirectory 'failure.json') $failure
    [Console]::Error.WriteLine($caught.ToString())
    exit 1
}
finally {
    $stream.Dispose()
    # Creation-time identities, not bare recycled PIDs, bound cleanup even if the Node runner already crashed.
    if ('TexyPaperSmoke.NativeSampler' -as [type]) {
        foreach ($process in [TexyPaperSmoke.NativeSampler]::Snapshot()) {
            if ($process.CreationKnown -and $owned.ContainsKey((Process-Key $process))) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
        }
    }
    if ($runner -and -not $runner.HasExited) {
        & taskkill.exe /PID $runner.Id /T /F 2>$null
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 128) { Write-Warning "Runner cleanup exited $LASTEXITCODE" }
    }
}
