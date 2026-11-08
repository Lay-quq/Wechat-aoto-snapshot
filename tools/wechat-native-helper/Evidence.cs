using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace WeFlow.WechatNativeIdentity;

internal sealed class ProbeFailure(string code) : Exception(code)
{
    public string Code { get; } = code;
}

internal sealed class ScanBudget
{
    public const int LimitMilliseconds = 8000;
    private readonly Func<long> elapsed;
    internal ScanBudget(Func<long>? clock = null)
    {
        var timer = Stopwatch.StartNew();
        elapsed = clock ?? (() => timer.ElapsedMilliseconds);
    }
    internal bool Expired => elapsed() >= LimitMilliseconds;
    internal void Check() { if (Expired) throw new ProbeFailure("scan_timeout"); }
}

internal enum DatabaseFamily { Contact, Session, Message }
internal sealed record DatabasePath(string AccountRoot, string CanonicalAccount, DatabaseFamily Family);
internal sealed record OpenDatabaseFile(DatabasePath Path, uint VolumeSerial, ulong FileIndex);
internal enum DatabaseDisposition { Matched, DifferentAccount, NoActiveDatabases }
internal sealed record DatabaseBinding(DatabaseDisposition Disposition, string Digest);

internal static class DatabasePaths
{
    // Only this observed folder form is canonicalized. No prefix/contains matching.
    private static readonly Regex Account = new("^(wxid_[A-Za-z0-9]+)(?:_[A-Fa-f0-9]{4})?$", RegexOptions.CultureInvariant);
    private static readonly Regex Message = new("^message(?:_[0-9]+)?\\.db$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    internal static string Canonical(string value)
    {
        if (value.Length is < 6 or > 128 || value != value.Trim()) throw new ProbeFailure("account_invalid");
        var match = Account.Match(value);
        if (!match.Success) throw new ProbeFailure("account_invalid");
        return match.Groups[1].Value;
    }

    internal static DatabasePath? Classify(string value)
    {
        if (value.Length is < 4 or > 32760 || value.Any(character => character < 32)) return null;
        var candidate = value.Replace('/', '\\');
        if (candidate.StartsWith(@"\\?\", StringComparison.Ordinal)) candidate = candidate[4..];
        if (candidate.Length < 3 || !char.IsAsciiLetter(candidate[0]) || candidate[1] != ':' || candidate[2] != '\\') return null;
        if (candidate[2..].IndexOfAny([':', '*', '?', '<', '>', '|', '"']) >= 0) return null;
        var parts = candidate.Split('\\');
        if (parts.Any(part => part.Length == 0 || part is "." or ".." || part.EndsWith(' ') || part.EndsWith('.'))) return null;
        var indexes = Enumerable.Range(1, parts.Length - 1).Where(index => parts[index].Equals("db_storage", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (indexes.Length != 1) return null;
        var storage = indexes[0];
        if (storage < 2 || parts.Length != storage + 3) return null;
        var familyName = parts[storage + 1];
        var filename = parts[storage + 2];
        DatabaseFamily? family = familyName.Equals("contact", StringComparison.OrdinalIgnoreCase) && filename.Equals("contact.db", StringComparison.OrdinalIgnoreCase) ? DatabaseFamily.Contact
            : familyName.Equals("session", StringComparison.OrdinalIgnoreCase) && filename.Equals("session.db", StringComparison.OrdinalIgnoreCase) ? DatabaseFamily.Session
            : familyName.Equals("message", StringComparison.OrdinalIgnoreCase) && Message.IsMatch(filename) ? DatabaseFamily.Message : null;
        if (family is null) return null;
        // A recognized account database layout with an unrecognized owner cannot be silently discarded.
        var canonical = Canonical(parts[storage - 1]);
        return new DatabasePath(string.Join('\\', parts.Take(storage)), canonical, family.Value);
    }
}

internal sealed class DatabaseEvidence
{
    private readonly Dictionary<string, OpenDatabaseFile> identities = new(StringComparer.Ordinal);
    private readonly HashSet<string> roots = new(StringComparer.OrdinalIgnoreCase);
    internal void Add(OpenDatabaseFile file)
    {
        if (file.FileIndex == 0) throw new ProbeFailure("file_identity_unverifiable");
        roots.Add(file.Path.AccountRoot);
        if (roots.Count != 1) throw new ProbeFailure("account_roots_ambiguous");
        var key = file.VolumeSerial.ToString("x8") + ":" + file.FileIndex.ToString("x16");
        if (identities.TryGetValue(key, out var previous))
        {
            if (previous.Path.Family != file.Path.Family || previous.Path.CanonicalAccount != file.Path.CanonicalAccount
                || !previous.Path.AccountRoot.Equals(file.Path.AccountRoot, StringComparison.OrdinalIgnoreCase)) throw new ProbeFailure("file_alias_ambiguous");
            return;
        }
        identities.Add(key, file);
    }

    internal string Complete(string expectedAccountId)
    {
        var observed = Inspect(expectedAccountId);
        return observed.Disposition switch
        {
            DatabaseDisposition.Matched => observed.Digest,
            DatabaseDisposition.DifferentAccount => throw new ProbeFailure("account_mismatch"),
            _ => throw new ProbeFailure("no_active_databases")
        };
    }

    internal DatabaseBinding Inspect(string expectedAccountId)
    {
        var expected = DatabasePaths.Canonical(expectedAccountId);
        // This method is called only after the full handle scan. An empty completed scan is
        // affirmative absence; unreadable/unknown handles throw before this point.
        if (roots.Count == 0 && identities.Count == 0)
            return new DatabaseBinding(DatabaseDisposition.NoActiveDatabases,
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("no-active-account-databases-v1"))).ToLowerInvariant());
        if (roots.Count != 1 || identities.Count == 0) throw new ProbeFailure("active_databases_unverifiable");
        if (identities.Values.Select(file => file.Path.Family).Distinct().Count() != 3) throw new ProbeFailure("database_families_incomplete");
        var accounts = identities.Values.Select(file => file.Path.CanonicalAccount).Distinct(StringComparer.Ordinal).ToArray();
        if (accounts.Length != 1) throw new ProbeFailure("account_identity_ambiguous");
        var material = "active-db-handles-candidate-v1\n" + roots.Single().ToUpperInvariant() + "\n" + accounts[0] + "\n"
            + string.Join('\n', identities.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => pair.Key + ":" + pair.Value.Path.Family));
        return new DatabaseBinding(accounts[0].Equals(expected, StringComparison.Ordinal) ? DatabaseDisposition.Matched : DatabaseDisposition.DifferentAccount,
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant());
    }
}
