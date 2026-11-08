using System.Runtime.InteropServices;

namespace WeFlow.WechatNativeIdentity;

internal sealed record TargetFileHandle(nint Value, uint GrantedAccess);
internal static class HandleTable
{
    internal const int MaximumBytes = 64 * 1024 * 1024, MaximumTargetHandles = 8192, MaximumFileHandles = 4096;
    internal static List<TargetFileHandle> Parse(nint buffer, uint length, uint targetPid, uint selfPid, nuint moduleFileHandle, ScanBudget budget)
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<ExtendedHandleEntry>() != 40 || length < 16 || length > MaximumBytes) throw new ProbeFailure("handle_layout_unverifiable");
        var count = unchecked((ulong)Marshal.ReadInt64(buffer));
        if (count > 1_000_000 || count > ((ulong)length - 16) / 40) throw new ProbeFailure("handle_table_invalid");
        ushort? fileType = null;
        var target = new List<ExtendedHandleEntry>();
        for (ulong index = 0; index < count; index++)
        {
            if (index % 128 == 0) budget.Check();
            var address = nint.Add(buffer, checked(16 + (int)index * 40));
            // Filter PID before interpreting or duplicating any target handle. Kernel Object pointers are ignored.
            var pid = unchecked((ulong)Marshal.ReadInt64(address, 8));
            if (pid == targetPid)
            {
                if (target.Count >= MaximumTargetHandles) throw new ProbeFailure("handle_limit");
                target.Add(Marshal.PtrToStructure<ExtendedHandleEntry>(address));
            }
            else if (pid == selfPid && unchecked((ulong)Marshal.ReadInt64(address, 16)) == moduleFileHandle)
            {
                var observed = unchecked((ushort)Marshal.ReadInt16(address, 30));
                if (observed == 0 || fileType is not null && fileType != observed) throw new ProbeFailure("file_type_unverifiable");
                fileType = observed;
            }
        }
        budget.Check();
        if (fileType is null) throw new ProbeFailure("file_type_unverifiable");
        var files = target.Where(entry => entry.ObjectTypeIndex == fileType).ToArray();
        // A successful complete table with no File objects is conclusive absence,
        // unlike a missing type anchor or an incomplete/unreadable enumeration.
        if (files.Length > MaximumFileHandles) throw new ProbeFailure("file_handle_limit");
        if (files.Select(entry => entry.HandleValue).Distinct().Count() != files.Length) throw new ProbeFailure("handle_table_invalid");
        return files.Select(entry => new TargetFileHandle(unchecked((nint)entry.HandleValue), entry.GrantedAccess)).ToList();
    }

    internal static List<TargetFileHandle> Read(uint targetPid, nuint moduleFileHandle, ScanBudget budget)
    {
        var size = 1024 * 1024;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            budget.Check();
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                var status = NativeMethods.NtQuerySystemInformation(NativeMethods.ExtendedHandleInformation, buffer, (uint)size, out var required);
                budget.Check();
                if (status == 0)
                {
                    if (required < 16 || required > size) throw new ProbeFailure("handle_table_invalid");
                    return Parse(buffer, required, targetPid, (uint)Environment.ProcessId, moduleFileHandle, budget);
                }
                if (status != NativeMethods.InfoLengthMismatch) throw new ProbeFailure("handle_query_failed");
                var next = Math.Max((long)size * 2, (long)required + 65536);
                if (next > MaximumBytes) throw new ProbeFailure("handle_table_limit");
                size = (int)next;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new ProbeFailure("handle_query_unstable");
    }
}
