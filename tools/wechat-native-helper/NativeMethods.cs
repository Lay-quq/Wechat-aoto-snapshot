using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WeFlow.WechatNativeIdentity;

internal sealed class OwnedKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public OwnedKernelHandle() : base(true) { }
    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativeFileTime
{
    internal uint Low, High;
    internal readonly ulong Value => ((ulong)High << 32) | Low;
}

[StructLayout(LayoutKind.Sequential)]
internal struct FileInformation
{
    internal uint Attributes;
    internal NativeFileTime Created, Accessed, Written;
    internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    internal readonly ulong FileIndex => ((ulong)IndexHigh << 32) | IndexLow;
    internal readonly ulong Length => ((ulong)SizeHigh << 32) | SizeLow;
}

// x64 SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX, System Informer phnt/ntexapi.h.
[StructLayout(LayoutKind.Sequential)]
internal struct ExtendedHandleEntry
{
    internal nint Object;
    internal nuint ProcessId, HandleValue;
    internal uint GrantedAccess;
    internal ushort BackTraceIndex, ObjectTypeIndex;
    internal uint Attributes, Reserved;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct ModuleEntry
{
    internal uint Size, ModuleId, ProcessId, GlobalUse, ProcessUse;
    internal nint BaseAddress;
    internal uint ModuleSize;
    internal nint ModuleHandle;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] internal string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Path;
}

internal static class NativeMethods
{
    internal const uint QueryLimitedInformation = 0x1000, DuplicateProcessHandle = 0x40;
    internal const uint FileReadAttributes = 0x80, FileTypeDisk = 1, FileTypeChar = 2, FileTypePipe = 3;
    internal const uint ModuleSnapshotFlags = 0x8 | 0x10; // Never TH32CS_INHERIT.
    internal const int ExtendedHandleInformation = 64;
    internal const int InfoLengthMismatch = unchecked((int)0xc0000004);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern OwnedKernelHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll")] internal static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(OwnedKernelHandle process, out NativeFileTime creation, out NativeFileTime exit, out NativeFileTime kernel, out NativeFileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(OwnedKernelHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DuplicateHandle(OwnedKernelHandle process, nint source, nint currentProcess, out OwnedKernelHandle duplicate, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetFileType(OwnedKernelHandle file);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] internal static extern uint GetFinalPathNameByHandleW(OwnedKernelHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(SafeHandle file, out FileInformation information);
    [DllImport("ntdll.dll")] internal static extern int NtQuerySystemInformation(int informationClass, nint buffer, uint size, out uint returnedLength);
    [DllImport("ntdll.dll")] internal static extern int NtQueryObject(OwnedKernelHandle handle, int informationClass, nint buffer, uint size, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern OwnedKernelHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Module32FirstW(OwnedKernelHandle snapshot, ref ModuleEntry module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Module32NextW(OwnedKernelHandle snapshot, ref ModuleEntry module);
    internal delegate bool WindowCallback(nint hwnd, nint parameter);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool EnumWindows(WindowCallback callback, nint parameter);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern int GetClassNameW(nint hwnd, StringBuilder name, int capacity);
}
