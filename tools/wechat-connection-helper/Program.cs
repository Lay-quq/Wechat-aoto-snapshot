using System.Text;
using System.Text.Json;

namespace WeFlow.WechatNativeIdentity;

internal static class ConnectionProtocol
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    internal static string Handle(string line, Func<ActiveWechatDirectory> discover)
    {
        string? id = null;
        try
        {
            if (line.Length > 1024) throw new ProbeFailure("request_too_large");
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            Exact(root, "id", "method", "params");
            if (root.GetProperty("id").ValueKind != JsonValueKind.String
                || !Guid.TryParseExact(root.GetProperty("id").GetString(), "D", out var requestId)) throw new ProbeFailure("invalid_request");
            id = requestId.ToString("D");
            if (root.GetProperty("method").ValueKind != JsonValueKind.String || root.GetProperty("method").GetString() != "discover") throw new ProbeFailure("unsupported_operation");
            Exact(root.GetProperty("params"));
            return JsonSerializer.Serialize(new { id, result = discover() }, JsonOptions);
        }
        catch (ProbeFailure error) { return JsonSerializer.Serialize(new { id, error = new { code = error.Code } }, JsonOptions); }
        catch { return JsonSerializer.Serialize(new { id, error = new { code = "discovery_unverifiable" } }, JsonOptions); }
    }
    private static void Exact(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new ProbeFailure("invalid_request");
        var found = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject()) if (!found.Add(property.Name) || !keys.Contains(property.Name, StringComparer.Ordinal)) throw new ProbeFailure("invalid_request");
        if (found.Count != keys.Length) throw new ProbeFailure("invalid_request");
    }
}

internal static class Program
{
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test") return ConnectionTests.Run();
        if (args.Length != 0) return 1;
        var request = new StringBuilder();
        while (request.Length <= 1024)
        {
            var next = Console.In.Read();
            if (next == -1 || next == '\n') break;
            request.Append((char)next);
        }
        Console.WriteLine(ConnectionProtocol.Handle(request.ToString(), ConnectionProbe.Discover));
        return 0;
    }
}
