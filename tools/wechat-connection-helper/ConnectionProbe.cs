// Read-only connection discovery derived from ../wechat-native-helper/NativeProbe.cs.
// The original send helper and its accepted resource manifest are unchanged.
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace WeFlow.WechatNativeIdentity;

internal sealed record ModuleBinding(string Name, string Version, string FileSha256, string BaseAddress, uint ImageSize, string ModulePath);
internal sealed record ConnectionProbeResult(int Protocol, string ProbeKind, bool ActiveDatabaseHandlesMatched, bool NativeLoginVerified, bool SendReady,
    uint ProcessId, string ProcessStartedAtUtcFileTime, string WindowHandle, uint WindowThreadId, string WindowClass,
    ModuleBinding Module, string BindingSha256, string ProbedAtUtc);
internal sealed record ModuleMetadata(string Path, nint BaseAddress, uint ImageSize);
internal sealed record WindowMetadata(uint ProcessId, nint Handle, uint ThreadId, string ClassName);
internal sealed record WindowCandidate(uint ProcessId, nint Handle, uint ThreadId, string ClassName, nint OwnerHandle = default);
internal sealed record ThreadDatabaseBinding(WindowMetadata Window, DatabaseBinding Database);
internal sealed record ActiveDirectoryBinding(DatabaseBinding Binding, string? Directory, string? AccountId);
internal sealed record ActiveWechatDirectory(int Protocol, string ProbeKind, uint ProcessId, string ProcessStartedAtUtcFileTime, string AccountDirectory, string AccountId, string ObservedAtUtc);

internal static class ConnectionProbe
{
    internal const string Version = "4.1.15.56";
    internal const string DllSha256 = "e0428a7b691853de496532523c2c09aa095f90941c37c9f4cfb3f137f3c66556";
    internal const string ModuleName = "Weixin.dll", MainWindowClass = "mmui::MainWindow";
    internal const string QtMainWindowClass = "Qt51514QWindowIcon";

    internal static ActiveWechatDirectory Discover()
    {
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8) throw new ProbeFailure("platform_unsupported");
        var budget = new ScanBudget();
        var windows = CandidateWindows(budget);
        var candidates = new List<CandidateState>();
        try
        {
            foreach (var window in SelectThreadWindows(windows)) candidates.Add(OpenCandidate(window, budget));
            // Round one and round two cover every candidate, including excluded login shells.
            // A candidate cannot be discarded merely because a call failed or timed out.
            foreach (var candidate in candidates)
                candidate.First = ScanDatabases(candidate.Process, candidate.Window.ProcessId, candidate.Anchor, budget);
            foreach (var candidate in candidates)
            {
                var second = ScanDatabases(candidate.Process, candidate.Window.ProcessId, candidate.Anchor, budget);
                if (candidate.First != second) throw new ProbeFailure("active_databases_changed");
            }
            if (!windows.SequenceEqual(CandidateWindows(budget))) throw new ProbeFailure("process_binding_changed");
            foreach (var candidate in candidates) ValidateCandidate(candidate, budget);
            var selected = SelectAccountThread(candidates.Select(candidate => new ThreadDatabaseBinding(candidate.Window, candidate.First!.Binding)));
            var chosen = candidates.Single(candidate => candidate.Window == selected);
            return new ActiveWechatDirectory(1, "active-database-directory", selected.ProcessId,
                chosen.Started.ToString(CultureInfo.InvariantCulture), chosen.First!.Directory!, chosen.First.AccountId!, DateTimeOffset.UtcNow.ToString("O"));
        }
        finally { foreach (var candidate in candidates) candidate.Dispose(); }
    }

    private sealed class CandidateState(WindowMetadata window, OwnedKernelHandle process, ulong started, ModuleMetadata module, FileStream image, FileInformation before, bool ownsImage) : IDisposable
    {
        internal WindowMetadata Window { get; } = window;
        internal OwnedKernelHandle Process { get; } = process;
        internal ulong Started { get; } = started;
        internal ModuleMetadata Module { get; } = module;
        internal FileStream Image { get; } = image;
        internal FileInformation Before { get; } = before;
        internal nuint Anchor => unchecked((nuint)Image.SafeFileHandle.DangerousGetHandle());
        internal ActiveDirectoryBinding? First { get; set; }
        public void Dispose() { if (ownsImage) Image.Dispose(); Process.Dispose(); }
    }

    private static CandidateState OpenCandidate(WindowMetadata window, ScanBudget budget)
    {
        budget.Check();
        var process = NativeMethods.OpenProcess(NativeMethods.QueryLimitedInformation | NativeMethods.DuplicateProcessHandle, false, window.ProcessId);
        FileStream? image = null;
        var ownsImage = true;
        try
        {
            if (process.IsInvalid) throw new ProbeFailure("process_access_denied");
            var started = ProcessStart(process, budget);
            var module = Module(window.ProcessId, budget);
            // Only the pinned application DLL is read. Database streams are never opened/read.
            image = new FileStream(module.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 128 * 1024, FileOptions.SequentialScan);
            if (!NativeMethods.GetFileInformationByHandle(image.SafeFileHandle, out var before) || before.Length is 0 or > 536870912) throw new ProbeFailure("module_unverifiable");
            {
                var version = FileVersionInfo.GetVersionInfo(module.Path);
                if (version.FileMajorPart != 4 || version.FileMinorPart != 1 || version.FileBuildPart != 15 || version.FilePrivatePart != 56) throw new ProbeFailure("module_version_unsupported");
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[128 * 1024];
                int count;
                while ((count = image.Read(buffer)) > 0) { budget.Check(); hash.AppendData(buffer, 0, count); }
                if (!Convert.ToHexString(hash.GetHashAndReset()).Equals(DllSha256, StringComparison.OrdinalIgnoreCase)) throw new ProbeFailure("module_hash_mismatch");
            }
            budget.Check();
            return new CandidateState(window, process, started, module, image, before, ownsImage);
        }
        catch { if (ownsImage) image?.Dispose(); process.Dispose(); throw; }
    }

    private static void ValidateCandidate(CandidateState candidate, ScanBudget budget)
    {
        if (ProcessStart(candidate.Process, budget) != candidate.Started) throw new ProbeFailure("process_binding_changed");
        var currentModule = Module(candidate.Window.ProcessId, budget);
        if (currentModule.BaseAddress != candidate.Module.BaseAddress || currentModule.ImageSize != candidate.Module.ImageSize
            || !currentModule.Path.Equals(candidate.Module.Path, StringComparison.OrdinalIgnoreCase)) throw new ProbeFailure("module_binding_changed");
        if (!NativeMethods.GetFileInformationByHandle(candidate.Image.SafeFileHandle, out var after) || candidate.Before.FileIndex != after.FileIndex
            || candidate.Before.VolumeSerial != after.VolumeSerial || candidate.Before.Length != after.Length || candidate.Before.Written.Value != after.Written.Value)
            throw new ProbeFailure("module_file_changed");
        budget.Check();
    }

    private static List<WindowMetadata> CandidateWindows(ScanBudget budget)
    {
        budget.Check();
        var candidates = Process.GetProcessesByName("Weixin");
        HashSet<uint> processIds;
        try
        {
            budget.Check();
            if (candidates.Length == 0) throw new ProbeFailure("process_not_found");
            processIds = candidates.Select(process => checked((uint)process.Id)).ToHashSet();
        }
        finally { foreach (var process in candidates) process.Dispose(); }
        // Child/helper processes can share the executable name. The exact ownerless top-level window,
        // not process enumeration order or process count, identifies the only acceptable owner.
        // Qt51514QWindowIcon is an observed 4.1.15.56 profile variant, not a generic Qt matcher.
        // A window candidate alone never proves account/login identity; the pinned module and two
        // complete database-handle scans must still pass before any result can leave Run().
        var found = new List<WindowCandidate>();
        var interrupted = false;
        var succeeded = NativeMethods.EnumWindows((hwnd, _) =>
        {
            try
            {
                if (budget.Expired) { interrupted = true; return false; }
                var tid = NativeMethods.GetWindowThreadProcessId(hwnd, out var owner);
                if (!processIds.Contains(owner)) return true;
                if (tid == 0) { interrupted = true; return false; }
                var className = new StringBuilder(128);
                if (NativeMethods.GetClassNameW(hwnd, className, className.Capacity) == 0) { interrupted = true; return false; }
                var name = className.ToString();
                if (IsSupportedWindowClass(name) && NativeMethods.GetWindow(hwnd, 4) == nint.Zero)
                    found.Add(new WindowCandidate(owner, hwnd, tid, name));
                return found.Count < 128;
            }
            catch { interrupted = true; return false; }
        }, nint.Zero);
        budget.Check();
        if (found.Count >= 128) throw new ProbeFailure("window_limit");
        if (!succeeded || interrupted) throw new ProbeFailure("window_unverifiable");
        return NormalizeWindows(processIds, found);
    }

    internal static List<WindowMetadata> NormalizeWindows(IReadOnlySet<uint> processIds, IEnumerable<WindowCandidate> windows)
    {
        if (processIds.Count == 0 || processIds.Contains(0)) throw new ProbeFailure("process_not_found");
        var selected = new List<WindowMetadata>();
        var handles = new HashSet<nint>();
        foreach (var window in windows)
        {
            if (!processIds.Contains(window.ProcessId) || !IsSupportedWindowClass(window.ClassName) || window.OwnerHandle != nint.Zero) continue;
            if (window.Handle.ToInt64() <= 0 || window.ThreadId == 0 || !handles.Add(window.Handle)) throw new ProbeFailure("window_unverifiable");
            if (selected.Count >= 128) throw new ProbeFailure("window_limit");
            selected.Add(new WindowMetadata(window.ProcessId, window.Handle, window.ThreadId, window.ClassName));
        }
        if (selected.Count == 0) throw new ProbeFailure("window_unverifiable");
        return selected.OrderBy(window => window.ProcessId).ThenBy(window => window.ThreadId).ThenBy(window => window.Handle.ToInt64()).ToList();
    }

    internal static List<WindowMetadata> SelectThreadWindows(IEnumerable<WindowMetadata> windows)
    {
        // An exact-class window only wakes its owning thread. It never selects a contact.
        // Deduplicate only identical PID/TID and pick a stable minimum nonzero HWND;
        // all windows remain part of the final cohort stability check and binding digest.
        var groups = windows.GroupBy(window => (window.ProcessId, window.ThreadId)).OrderBy(group => group.Key.ProcessId)
            .ThenBy(group => group.Key.ThreadId).Select(group => group.OrderBy(window => window.Handle.ToInt64()).First()).ToList();
        if (groups.Count is 0 or > 8) throw new ProbeFailure("window_thread_limit");
        return groups;
    }

    internal static WindowMetadata SelectMainWindow(IReadOnlySet<uint> processIds, IEnumerable<WindowCandidate> windows)
    {
        var groups = SelectThreadWindows(NormalizeWindows(processIds, windows));
        if (groups.Count != 1) throw new ProbeFailure("window_ambiguous");
        return groups[0];
    }

    internal static WindowMetadata SelectAccountThread(IEnumerable<ThreadDatabaseBinding> bindings)
    {
        var values = bindings.ToArray();
        if (values.Length is 0 or > 8 || values.Any(value => !Enum.IsDefined(value.Database.Disposition)
                || value.Database.Digest.Length != 64 || value.Database.Digest.Any(character => !char.IsAsciiHexDigit(character))
                || value.Window.ProcessId == 0 || value.Window.ThreadId == 0 || value.Window.Handle.ToInt64() <= 0 || !IsSupportedWindowClass(value.Window.ClassName))
            || values.Select(value => (value.Window.ProcessId, value.Window.ThreadId)).Distinct().Count() != values.Length)
            throw new ProbeFailure("candidate_binding_unverifiable");
        var matched = values.Where(value => value.Database.Disposition == DatabaseDisposition.Matched).ToArray();
        if (matched.Length > 1) throw new ProbeFailure("account_thread_ambiguous");
        if (matched.Length == 0) throw new ProbeFailure(values.All(value => value.Database.Disposition == DatabaseDisposition.NoActiveDatabases)
            ? "no_active_databases" : "account_mismatch");
        return matched[0].Window;
    }

    private static bool IsSupportedWindowClass(string name) => name.Equals(MainWindowClass, StringComparison.Ordinal)
        || name.Equals(QtMainWindowClass, StringComparison.Ordinal);

    private static ulong ProcessStart(OwnedKernelHandle process, ScanBudget budget)
    {
        budget.Check();
        if (!NativeMethods.GetExitCodeProcess(process, out var exit) || exit != 259
            || !NativeMethods.GetProcessTimes(process, out var started, out _, out _, out _) || started.Value == 0) throw new ProbeFailure("process_unverifiable");
        budget.Check();
        return started.Value;
    }

    internal static string ValidateModulePath(string path)
    {
        // Only the already-loaded application DLL path is returned over private IPC. Never allow
        // this field to carry a database path/account root, a remote path, or an alternate stream.
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal)
            || path.Length < 4 || path[2..].Contains(':') || path.Contains('/') || path.Contains('\0')) throw new ProbeFailure("module_unverifiable");
        var components = path.Split('\\');
        if (components.Any(part => part is "" or "." or ".." || part.EndsWith(' ') || part.EndsWith('.')
                || part.Equals("db_storage", StringComparison.OrdinalIgnoreCase) || part.StartsWith("wxid_", StringComparison.OrdinalIgnoreCase))
            || !components[^1].Equals(ModuleName, StringComparison.OrdinalIgnoreCase)) throw new ProbeFailure("module_unverifiable");
        return path;
    }

    private static ModuleMetadata Module(uint pid, ScanBudget budget)
    {
        budget.Check();
        using var snapshot = NativeMethods.CreateToolhelp32Snapshot(NativeMethods.ModuleSnapshotFlags, pid);
        if (snapshot.IsInvalid) throw new ProbeFailure("module_snapshot_failed");
        var entry = new ModuleEntry { Size = (uint)Marshal.SizeOf<ModuleEntry>(), Name = "", Path = "" };
        if (!NativeMethods.Module32FirstW(snapshot, ref entry)) throw new ProbeFailure("module_unverifiable");
        ModuleMetadata? selected = null;
        var count = 0;
        do
        {
            budget.Check();
            if (++count > 1024) throw new ProbeFailure("module_limit");
            if (entry.ProcessId == pid && entry.Name.Equals(ModuleName, StringComparison.OrdinalIgnoreCase))
            {
                if (selected is not null || entry.BaseAddress == nint.Zero || entry.ModuleSize == 0) throw new ProbeFailure("module_unverifiable");
                selected = new ModuleMetadata(ValidateModulePath(entry.Path), entry.BaseAddress, entry.ModuleSize);
            }
        } while (NativeMethods.Module32NextW(snapshot, ref entry));
        if (Marshal.GetLastWin32Error() != 18) throw new ProbeFailure("module_enumeration_incomplete");
        return selected ?? throw new ProbeFailure("module_not_found");
    }

    private static ActiveDirectoryBinding ScanDatabases(OwnedKernelHandle process, uint pid, nuint moduleFileHandle, ScanBudget budget)
    {
        var targets = HandleTable.Read(pid, moduleFileHandle, budget);
        var evidence = new DatabaseEvidence();
        string? directory = null, accountId = null;
        foreach (var target in targets)
        {
            budget.Check();
            DatabasePath? candidate;
            string candidatePath;
            // A zero-access duplicate suffices for type classification; no write/read-data rights are copied.
            var duplicated = NativeMethods.DuplicateHandle(process, target.Value, NativeMethods.GetCurrentProcess(), out var typeHandle, 0, false, 0);
            using (typeHandle)
            {
                if (!duplicated || typeHandle.IsInvalid) throw new ProbeFailure("handle_unverifiable");
                var type = NativeMethods.GetFileType(typeHandle);
                var typeError = Marshal.GetLastWin32Error();
                budget.Check();
                if (type is NativeMethods.FileTypeChar or NativeMethods.FileTypePipe) continue;
                if (type != NativeMethods.FileTypeDisk)
                {
                    if (type != 0 || typeError != 0) throw new ProbeFailure("file_type_unverifiable");
                    var deviceName = ObjectName(typeHandle, budget);
                    if (IsNonFilesystemDevice(deviceName)) continue;
                    throw new ProbeFailure("file_type_unverifiable");
                }
                // Name metadata can be queried without copying data-read or extra attribute rights.
                // Only canonical database files require FILE_READ_ATTRIBUTES for physical identity.
                candidatePath = FinalPath(typeHandle, budget);
                candidate = DatabasePaths.Classify(candidatePath);
                if (candidate is null) continue;
            }
            duplicated = NativeMethods.DuplicateHandle(process, target.Value, NativeMethods.GetCurrentProcess(), out var file, NativeMethods.FileReadAttributes, false, 0);
            using (file)
            {
                if (!duplicated || file.IsInvalid || NativeMethods.GetFileType(file) != NativeMethods.FileTypeDisk) throw new ProbeFailure("disk_handle_unverifiable");
                if (!NativeMethods.GetFileInformationByHandle(file, out var information)) throw new ProbeFailure("file_identity_unverifiable");
                if ((information.Attributes & 0x10) != 0) throw new ProbeFailure("database_file_unverifiable");
                var value = FinalPath(file, budget);
                if (!value.Equals(candidatePath, StringComparison.OrdinalIgnoreCase)) throw new ProbeFailure("database_handle_changed");
                evidence.Add(new OpenDatabaseFile(candidate, information.VolumeSerial, information.FileIndex));
                directory = candidate.AccountRoot; accountId = candidate.CanonicalAccount;
            }
        }
        budget.Check();
        return new ActiveDirectoryBinding(evidence.Inspect(accountId ?? "wxid_connection"), directory, accountId);
    }

    // Only four exact, observed Windows device endpoints, not a blanket \\Device\\ prefix rule.
    // Their names are metadata; no device data, controls, or secrets are accessed.
    internal static bool IsNonFilesystemDevice(string name) => name.Equals(@"\Device\KsecDD", StringComparison.OrdinalIgnoreCase)
        || name.Equals(@"\Device\CNG", StringComparison.OrdinalIgnoreCase)
        || name.Equals(@"\Device\DeviceApi", StringComparison.OrdinalIgnoreCase)
        || name.Equals(@"\Device\Nsi", StringComparison.OrdinalIgnoreCase);

    internal static string ParseObjectName(nint buffer, uint returned, int allocated)
    {
        if (buffer == nint.Zero || allocated is < 16 or > 65536 || returned < 16 || returned > allocated) throw new ProbeFailure("object_name_unverifiable");
        var length = unchecked((ushort)Marshal.ReadInt16(buffer));
        var capacity = unchecked((ushort)Marshal.ReadInt16(buffer, 2));
        var text = Marshal.ReadIntPtr(buffer, 8);
        var offset = text.ToInt64() - buffer.ToInt64();
        if (length == 0 || (length & 1) != 0 || (capacity & 1) != 0 || length > capacity || offset < 16
            || offset > (long)returned - capacity) throw new ProbeFailure("object_name_unverifiable");
        var name = Marshal.PtrToStringUni(text, length / 2);
        if (name is null || name.Any(character => character < 32)) throw new ProbeFailure("object_name_unverifiable");
        return name;
    }

    private static string ObjectName(OwnedKernelHandle handle, ScanBudget budget)
    {
        var size = 4096;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            budget.Check();
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                var status = NativeMethods.NtQueryObject(handle, 1, buffer, (uint)size, out var needed);
                budget.Check();
                if (status == 0)
                    return ParseObjectName(buffer, needed, size);
                if (status is not (unchecked((int)0xc0000004)) and not (unchecked((int)0xc0000023)) and not (unchecked((int)0x80000005))
                    || needed <= size || needed > 65536) throw new ProbeFailure("object_name_unverifiable");
                size = checked((int)needed);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new ProbeFailure("object_name_unverifiable");
    }

    private static string FinalPath(OwnedKernelHandle file, ScanBudget budget)
    {
        budget.Check();
        var value = new StringBuilder(1024);
        // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS resolves junctions. The unique root goes only to the trusted local host.
        var length = NativeMethods.GetFinalPathNameByHandleW(file, value, (uint)value.Capacity, 0);
        budget.Check();
        if (length == 0 || length > 32760) throw new ProbeFailure("file_path_unverifiable");
        if (length >= value.Capacity)
        {
            value = new StringBuilder(checked((int)length + 1));
            length = NativeMethods.GetFinalPathNameByHandleW(file, value, (uint)value.Capacity, 0);
            budget.Check();
            if (length == 0 || length >= value.Capacity) throw new ProbeFailure("file_path_unverifiable");
        }
        return value.ToString();
    }
}
