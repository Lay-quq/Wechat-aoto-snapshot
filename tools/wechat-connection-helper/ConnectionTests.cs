using System.Text.Json;

namespace WeFlow.WechatNativeIdentity;

internal static class ConnectionTests
{
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("assertion_failed"); }
    private static void Error(Action action, string code)
    {
        try { action(); } catch (ProbeFailure failure) { Check(failure.Code == code); return; }
        throw new InvalidOperationException("expected_failure");
    }
    internal static int Run()
    {
        var count = 0;
        void Test(string name, Action action) { action(); count++; Console.WriteLine("PASS " + name); }
        var a = new WindowMetadata(12, 24, 36, ConnectionProbe.MainWindowClass);
        var b = new WindowMetadata(13, 25, 37, ConnectionProbe.QtMainWindowClass);
        var digest = new string('a', 64);
        var active = new DatabaseBinding(DatabaseDisposition.Matched, digest);
        var empty = new DatabaseBinding(DatabaseDisposition.NoActiveDatabases, digest);
        Test("unique_active_account_over_login_shell", () => Check(ConnectionProbe.SelectAccountThread([new(b, empty), new(a, active)]) == a));
        Test("two_active_accounts_never_pick_first", () => Error(() => ConnectionProbe.SelectAccountThread([new(a, active), new(b, active)]), "account_thread_ambiguous"));
        Test("no_logged_in_account_never_guesses", () => Error(() => ConnectionProbe.SelectAccountThread([new(a, empty), new(b, empty)]), "no_active_databases"));
        Test("invalid_other_candidate_blocks_discovery", () => Error(() => ConnectionProbe.SelectAccountThread([new(a, active), new(b, new DatabaseBinding((DatabaseDisposition)12, digest))]), "candidate_binding_unverifiable"));
        Test("all_database_families_required", () => { var evidence = new DatabaseEvidence(); evidence.Add(new OpenDatabaseFile(DatabasePaths.Classify(@"D:\synthetic\wxid_a_dd14\db_storage\session\session.db")!, 1, 1)); Error(() => evidence.Inspect("wxid_a"), "database_families_incomplete"); });
        Test("two_directories_for_same_account_are_ambiguous", () => { var evidence = new DatabaseEvidence(); evidence.Add(new OpenDatabaseFile(DatabasePaths.Classify(@"D:\synthetic\wxid_a_dd14\db_storage\session\session.db")!, 1, 1)); Error(() => evidence.Add(new OpenDatabaseFile(DatabasePaths.Classify(@"D:\synthetic\wxid_a_abcd\db_storage\session\session.db")!, 1, 2)), "account_roots_ambiguous"); });
        var request = "{\"id\":\"11111111-1111-4111-8111-111111111111\",\"method\":\"discover\",\"params\":{}}";
        var calls = 0;
        ActiveWechatDirectory Discover() { calls++; return new(1, "active-database-directory", 12, "123", @"D:\synthetic\wxid_a_dd14", "wxid_a", DateTimeOffset.UtcNow.ToString("O")); }
        Test("discover_returns_local_root_without_send_claims", () => { var value = ConnectionProtocol.Handle(request, Discover); Check(calls == 1 && value.Contains("accountDirectory") && !value.Contains("sendReady") && !value.Contains("nativeLoginVerified")); });
        foreach (var invalid in new[] { request.Replace("\"discover\"", "\"probe\""), request.Replace("\"params\":{}", "\"params\":{\"path\":\"D:\\\\private\"}"), request.Replace("\"params\":{}", "\"params\":{},\"pid\":12"), request.Replace("\"params\":{}", "\"params\":{},\"params\":{}"), request.Replace("11111111-1111-4111-8111-111111111111", "wxid_private") })
            Test("caller_cannot_select_account_path_or_process", () => { using var value = JsonDocument.Parse(ConnectionProtocol.Handle(invalid, Discover)); Check(value.RootElement.TryGetProperty("error", out _) && calls == 1); });
        Test("bounded_request", () => { using var value = JsonDocument.Parse(ConnectionProtocol.Handle(new string('x', 1025), Discover)); Check(value.RootElement.GetProperty("error").GetProperty("code").GetString() == "request_too_large"); });
        Test("exception_never_echoes_paths", () => Check(!ConnectionProtocol.Handle(request, () => throw new Exception(@"D:\private\secret")).Contains("private")));
        Console.WriteLine(JsonSerializer.Serialize(new { passed = count, failed = 0, syntheticOnly = true }));
        return 0;
    }
}
