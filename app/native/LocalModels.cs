using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace XMStudioHost
{
    internal sealed partial class StudioAppContext
    {
        private const string LocalModelHost = "http://127.0.0.1:11435";
        private static readonly string[] LocalModelNames =
        {
            "qwen3.5:4b", "qwen3.5:9b",
            "deepseek-r1:1.5b", "deepseek-r1:7b", "deepseek-r1:14b", "deepseek-r1:32b", "deepseek-r1:70b"
        };
        private static readonly HttpClient LocalModelHttp = CreateLocalModelHttp();

        private readonly SemaphoreSlim _localModelGate = new SemaphoreSlim(1, 1);
        private readonly SemaphoreSlim _localStartGate = new SemaphoreSlim(1, 1);
        private CancellationTokenSource _localModelCancel;
        private Process _localModelServer;
        private object _localModelProgress = LmObj("stage", "idle", "message", "");
        private object _localHardware;

        private string LocalModelRoot { get { return Path.Combine(_userDataDir, "local-ai"); } }
        private string LocalRuntime { get { return Path.Combine(LocalModelRoot, "runtime"); } }
        private string LocalModelsPath { get { return Path.Combine(LocalModelRoot, "models"); } }
        private string LocalOllamaExe { get { return Path.Combine(LocalRuntime, "ollama.exe"); } }

        private static HttpClient CreateLocalModelHttp()
        {
            var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("LazyCut/" + CurrentVersion);
            return client;
        }

        private static Dictionary<string, object> LmObj(params object[] pairs)
        {
            var dict = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                dict[Convert.ToString(pairs[i])] = pairs[i + 1];
            }
            return dict;
        }

        private object LmDecode(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            try { return _json.DeserializeObject(raw); }
            catch { return null; }
        }

        private static object LmGet(object obj, string key)
        {
            var dict = obj as IDictionary<string, object>;
            if (dict == null) return null;
            object value;
            return dict.TryGetValue(key, out value) ? value : null;
        }

        private static string LmStr(object obj, string key, string fallback = "")
        {
            object value = LmGet(obj, key);
            if (value == null) return fallback;
            string text = Convert.ToString(value);
            return string.IsNullOrEmpty(text) ? fallback : text;
        }

        private static double LmNum(object obj, string key)
        {
            object value = LmGet(obj, key);
            if (value == null) return 0;
            try { return Convert.ToDouble(value); }
            catch { return 0; }
        }

        private static bool LmBool(object obj, string key)
        {
            object value = LmGet(obj, key);
            if (value == null) return false;
            try { return Convert.ToBoolean(value); }
            catch { return false; }
        }

        private static IEnumerable<object> LmArr(object value)
        {
            var seq = value as IEnumerable;
            if (seq == null || value is string) return Enumerable.Empty<object>();
            return seq.Cast<object>();
        }

        private void LogLocalModel(string message)
        {
            try
            {
                Directory.CreateDirectory(LocalModelRoot);
                File.AppendAllText(
                    Path.Combine(LocalModelRoot, "local-model.log"),
                    DateTime.Now.ToString("HH:mm:ss ") + message + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }

        private void ReportLocalModel(string stage, string message, long completed = 0, long total = 0)
        {
            _localModelProgress = LmObj("stage", stage, "message", message, "completed", completed, "total", total);
            SendEventToMain("bos:local-model-progress", _localModelProgress);
        }

        private async Task<object> LocalModelStatus(bool detectHardware = false)
        {
            var modelList = LocalModelNames
                .Where(name => File.Exists(Path.Combine(LocalModelsPath, "manifests", "registry.ollama.ai", "library", name.Split(':')[0], name.Split(':')[1])))
                .ToList();
            bool running = false;
            try
            {
                using (var cts = new CancellationTokenSource(1500))
                using (var response = await LocalModelHttp.GetAsync(LocalModelHost + "/api/tags", cts.Token))
                {
                    if (response.IsSuccessStatusCode)
                    {
                        var payload = LmDecode(await response.Content.ReadAsStringAsync());
                        foreach (var item in LmArr(LmGet(payload, "models")))
                        {
                            string name = LmStr(item, "name");
                            if (!string.IsNullOrEmpty(name)) modelList.Add(name);
                        }
                        running = true;
                    }
                }
            }
            catch { /* The local service is not running yet. */ }

            if (_localHardware == null && detectHardware)
            {
                _localHardware = await Task.Run(() => (object)DetectLocalHardware());
            }

            return LmObj(
                "runtimeInstalled", File.Exists(LocalOllamaExe),
                "running", running,
                "models", modelList.Distinct(StringComparer.Ordinal).Cast<object>().ToArray(),
                "root", LocalModelRoot,
                "endpoint", LocalModelHost + "/v1",
                "progress", _localModelProgress,
                "hardware", _localHardware);
        }

        private async Task<object> LocalModelAction(string action, string model)
        {
            if (action == "detect")
            {
                _localHardware = null;
                return await LocalModelStatus(true);
            }
            if (action == "status") return await LocalModelStatus(false);
            if (action == "sources")
            {
                return await CheckLocalModelSources(LocalModelNames.Contains(model, StringComparer.Ordinal) ? model : "deepseek-r1:7b");
            }
            if (action == "cancel")
            {
                if (_localModelCancel != null) _localModelCancel.Cancel();
                return await LocalModelStatus(false);
            }
            if (action == "start")
            {
                await StartLocalModelServer();
                return await LocalModelStatus(false);
            }
            if (action == "stop")
            {
                await StopLocalModelServer();
                return await LocalModelStatus(false);
            }
            if (action != "install-runtime" && action != "pull") throw new Exception("无效的本地模型操作。");
            if (action == "pull" && !LocalModelNames.Contains(model, StringComparer.Ordinal)) throw new Exception("不支持此模型，请从列表中选择。");
            if (!await _localModelGate.WaitAsync(0)) throw new Exception("已有本地模型下载任务正在进行。");

            using (var cts = new CancellationTokenSource())
            {
                _localModelCancel = cts;
                try
                {
                    if (action == "install-runtime") await InstallLocalRuntime(cts.Token);
                    else
                    {
                        await StartLocalModelServer();
                        await PullLocalModel(model, cts.Token);
                    }
                    ReportLocalModel("done", action == "pull" ? model + " 已下载，可以加入分析模型。" : "本地运行环境已安装到数据目录。");
                    return await LocalModelStatus(false);
                }
                catch (OperationCanceledException)
                {
                    ReportLocalModel("cancelled", "下载已取消。已下载的模型分块可在下次继续使用。");
                    throw new Exception("下载已取消。");
                }
                catch (Exception error)
                {
                    if (cts.IsCancellationRequested)
                    {
                        ReportLocalModel("cancelled", "下载已取消。已下载的模型分块可在下次继续使用。");
                        throw new Exception("下载已取消。");
                    }
                    ReportLocalModel("error", error.Message);
                    throw;
                }
                finally
                {
                    _localModelCancel = null;
                    _localModelGate.Release();
                }
            }
        }

        private async Task<object> CheckLocalModelSources(string model)
        {
            var runtimeTask = CheckRuntimeSource();
            var modelTask = CheckModelSource(model);
            await Task.WhenAll(runtimeTask, modelTask);
            return LmObj("runtime", runtimeTask.Result, "model", modelTask.Result, "modelName", model);
        }

        private async Task<object> CheckRuntimeSource()
        {
            try
            {
                using (var cts = new CancellationTokenSource(30000))
                using (var release = await LocalModelHttp.GetAsync("https://api.github.com/repos/ollama/ollama/releases/latest", cts.Token))
                {
                    release.EnsureSuccessStatusCode();
                    var payload = LmDecode(await release.Content.ReadAsStringAsync());
                    var asset = LmArr(LmGet(payload, "assets")).FirstOrDefault(item => LmStr(item, "name") == "ollama-windows-amd64.zip");
                    if (asset == null) throw new Exception("官方发布中没有 Windows x64 文件。");
                    string url = LmStr(asset, "browser_download_url");
                    Uri address;
                    if (!Uri.TryCreate(url, UriKind.Absolute, out address) || address.Scheme != "https" || address.Host != "github.com")
                        throw new Exception("下载地址无效。");

                    bool headAvailable = false;
                    try
                    {
                        using (var request = new HttpRequestMessage(HttpMethod.Head, address))
                        using (var response = await LocalModelHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token))
                        {
                            response.EnsureSuccessStatusCode();
                            headAvailable = true;
                        }
                    }
                    catch (OperationCanceledException) { throw; }
                    catch { /* Some release CDNs reject HEAD; probe one byte below. */ }

                    if (!headAvailable)
                    {
                        using (var request = new HttpRequestMessage(HttpMethod.Get, address))
                        {
                            request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 0);
                            using (var response = await LocalModelHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token))
                            {
                                if (response.StatusCode != System.Net.HttpStatusCode.PartialContent)
                                    throw new Exception("下载服务器未提供文件分段检测。");
                            }
                        }
                    }
                    return LmObj("ok", true, "message", "Windows 运行环境文件可连接");
                }
            }
            catch (Exception error)
            {
                return LmObj("ok", false, "message", "运行环境下载源不可用：" + error.Message);
            }
        }

        private async Task<object> CheckModelSource(string model)
        {
            try
            {
                using (var cts = new CancellationTokenSource(15000))
                {
                    string root = "https://registry.ollama.ai/v2/library/" + model.Split(':')[0] + "/";
                    using (var manifest = await LocalModelHttp.GetAsync(root + "manifests/" + model.Split(':')[1], cts.Token))
                    {
                        manifest.EnsureSuccessStatusCode();
                        var payload = LmDecode(await manifest.Content.ReadAsStringAsync());
                        var layer = LmArr(LmGet(payload, "layers")).OrderByDescending(item => LmNum(item, "size")).FirstOrDefault();
                        string digest = LmStr(layer, "digest");
                        if (!digest.StartsWith("sha256:", StringComparison.Ordinal) || digest.Length != 71)
                            throw new Exception("模型文件信息无效。");
                        using (var request = new HttpRequestMessage(HttpMethod.Head, root + "blobs/" + digest))
                        using (var response = await LocalModelHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token))
                        {
                            response.EnsureSuccessStatusCode();
                            return LmObj("ok", true, "message", model + " 模型文件可连接");
                        }
                    }
                }
            }
            catch (Exception error)
            {
                return LmObj("ok", false, "message", "模型下载源不可用：" + error.Message);
            }
        }

        private void EnsureFreeDiskSpace(long requiredBytes, string message)
        {
            string root = Path.GetPathRoot(LocalModelRoot);
            if (string.IsNullOrEmpty(root) || root.StartsWith("\\\\", StringComparison.Ordinal)) return;
            var drive = new DriveInfo(root);
            if (drive.AvailableFreeSpace < requiredBytes) throw new Exception(message);
        }

        private async Task InstallLocalRuntime(CancellationToken token)
        {
            if (File.Exists(LocalOllamaExe)) return;
            if (Directory.Exists(LocalRuntime)) throw new Exception("运行环境目录已存在但缺少 ollama.exe，请检查 " + LocalRuntime);
            Directory.CreateDirectory(LocalModelRoot);
            ReportLocalModel("runtime", "正在查询 Ollama 官方 Windows 运行环境…");

            object release;
            using (var response = await LocalModelHttp.GetAsync("https://api.github.com/repos/ollama/ollama/releases/latest", token))
            {
                response.EnsureSuccessStatusCode();
                release = LmDecode(await response.Content.ReadAsStringAsync());
            }

            var asset = LmArr(LmGet(release, "assets")).FirstOrDefault(item => LmStr(item, "name") == "ollama-windows-amd64.zip");
            if (asset == null) throw new Exception("官方发布中没有 Windows x64 运行环境。");
            string url = LmStr(asset, "browser_download_url");
            string digest = LmStr(asset, "digest");
            Uri address;
            if (!Uri.TryCreate(url, UriKind.Absolute, out address)
                || address.Scheme != "https"
                || address.Host != "github.com"
                || !address.AbsolutePath.Contains("/ollama/ollama/releases/download/")
                || !digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
            {
                throw new Exception("官方运行环境下载信息无效。");
            }

            long size = (long)LmNum(asset, "size");
            EnsureFreeDiskSpace(Math.Max(size * 4, 7L * 1024 * 1024 * 1024), "数据目录所在磁盘空间不足，运行环境需要至少 7 GB 可用空间。");

            string archive = Path.Combine(LocalModelRoot, "ollama-windows-amd64.zip");
            string stage = Path.Combine(LocalModelRoot, "runtime-stage-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var response = await LocalModelHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token))
                {
                    response.EnsureSuccessStatusCode();
                    long total = response.Content.Headers.ContentLength ?? size;
                    long completed = 0;
                    using (var input = await response.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(archive, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024, true))
                    {
                        var buffer = new byte[1024 * 1024];
                        int count;
                        while ((count = await input.ReadAsync(buffer, 0, buffer.Length, token)) > 0)
                        {
                            await output.WriteAsync(buffer, 0, count, token);
                            completed += count;
                            if (completed == count || completed % (16 * 1024 * 1024) < count)
                                ReportLocalModel("runtime", "正在下载运行环境", completed, total);
                        }
                    }
                }

                ReportLocalModel("verify", "正在校验官方文件…");
                string hash = await Task.Run(() =>
                {
                    using (var sha = SHA256.Create())
                    using (var file = File.OpenRead(archive))
                        return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                }, token);
                if (!hash.Equals(digest.Substring(7), StringComparison.OrdinalIgnoreCase))
                    throw new Exception("运行环境校验失败，请重试下载。");

                ReportLocalModel("extract", "正在解压运行环境到数据目录…");
                await Task.Run(() =>
                {
                    Directory.CreateDirectory(stage);
                    string root = Path.GetFullPath(stage).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    using (var zip = ZipFile.OpenRead(archive))
                    {
                        foreach (var entry in zip.Entries)
                        {
                            token.ThrowIfCancellationRequested();
                            string target = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                                throw new IOException("运行环境压缩包包含无效路径。");
                            if (entry.Name.Length == 0) Directory.CreateDirectory(target);
                            else
                            {
                                Directory.CreateDirectory(Path.GetDirectoryName(target));
                                entry.ExtractToFile(target);
                            }
                        }
                    }
                }, token);

                if (!File.Exists(Path.Combine(stage, "ollama.exe")))
                    throw new Exception("运行环境解压后缺少 ollama.exe。");
                Directory.Move(stage, LocalRuntime);
            }
            finally
            {
                if (File.Exists(archive)) File.Delete(archive);
                if (Directory.Exists(stage)) Directory.Delete(stage, true);
            }
        }

        private async Task StartLocalModelServer()
        {
            await _localStartGate.WaitAsync();
            try
            {
                if (!File.Exists(LocalOllamaExe)) throw new Exception("请先下载本地运行环境。");
                if (_localModelServer != null && !_localModelServer.HasExited && LmBool(await LocalModelStatus(false), "running"))
                    return;

                Directory.CreateDirectory(LocalModelsPath);
                var info = new ProcessStartInfo(LocalOllamaExe, "serve")
                {
                    WorkingDirectory = LocalRuntime,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                info.EnvironmentVariables["OLLAMA_MODELS"] = LocalModelsPath;
                info.EnvironmentVariables["OLLAMA_HOST"] = "127.0.0.1:11435";
                info.EnvironmentVariables["OLLAMA_NO_CLOUD"] = "1";
                info.EnvironmentVariables["OLLAMA_NUM_PARALLEL"] = "1";
                info.EnvironmentVariables["OLLAMA_TMPDIR"] = Path.Combine(LocalModelRoot, "temp");
                Directory.CreateDirectory(info.EnvironmentVariables["OLLAMA_TMPDIR"]);

                if (LmBool(await LocalModelStatus(false), "running"))
                    throw new Exception("11435 端口已有其他服务，请先关闭该服务。");

                _localModelServer = Process.Start(info);
                if (_localModelServer == null) throw new Exception("无法启动 Ollama 本地服务。");
                _localModelServer.OutputDataReceived += (s, e) => { if (e.Data != null) LogLocalModel(e.Data); };
                _localModelServer.ErrorDataReceived += (s, e) => { if (e.Data != null) LogLocalModel(e.Data); };
                _localModelServer.BeginOutputReadLine();
                _localModelServer.BeginErrorReadLine();

                for (int attempt = 0; attempt < 30; attempt++)
                {
                    if (_localModelServer.HasExited) throw new Exception("Ollama 本地服务启动失败，请查看启动日志。");
                    if (LmBool(await LocalModelStatus(false), "running")) return;
                    await Task.Delay(500);
                }
                throw new Exception("Ollama 本地服务启动超时，请查看启动日志。");
            }
            finally
            {
                _localStartGate.Release();
            }
        }

        private async Task PullLocalModel(string model, CancellationToken token)
        {
            long modelBytes = model.EndsWith(":70b") ? 43L * 1024 * 1024 * 1024
                : model == "qwen3.5:4b" ? 4L * 1024 * 1024 * 1024
                : model == "qwen3.5:9b" ? 8L * 1024 * 1024 * 1024
                : model.EndsWith(":32b") ? 20L * 1024 * 1024 * 1024
                : model.EndsWith(":14b") ? 9L * 1024 * 1024 * 1024
                : model.EndsWith(":7b") ? 5L * 1024 * 1024 * 1024 : 2L * 1024 * 1024 * 1024;
            EnsureFreeDiskSpace(modelBytes, "模型下载所需空间不足，请清理安装磁盘后重试。");

            for (int attempt = 0; attempt < 3; attempt++)
            {
                token.ThrowIfCancellationRequested();
                ReportLocalModel("model", attempt == 0 ? "正在下载 " + model + "…" : "连接中断，正在续传 " + model + "（" + (attempt + 1) + "/3）…");
                bool retry = false;
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Post, LocalModelHost + "/api/pull"))
                    {
                        request.Content = new StringContent(_json.Serialize(LmObj("name", model, "stream", true)), Encoding.UTF8, "application/json");
                        using (var response = await LocalModelHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token))
                        {
                            response.EnsureSuccessStatusCode();
                            using (token.Register(() => response.Dispose()))
                            using (var reader = new StreamReader(await response.Content.ReadAsStreamAsync()))
                            {
                                string line;
                                while ((line = await reader.ReadLineAsync()) != null)
                                {
                                    token.ThrowIfCancellationRequested();
                                    var progress = LmDecode(line);
                                    string error = LmStr(progress, "error");
                                    if (error.Length > 0) throw new Exception("模型下载失败：" + error);
                                    ReportLocalModel(
                                        "model",
                                        LmStr(progress, "status", "正在下载 " + model),
                                        (long)LmNum(progress, "completed"),
                                        (long)LmNum(progress, "total"));
                                }
                            }
                        }
                    }
                }
                catch (Exception error)
                {
                    if (token.IsCancellationRequested) throw new OperationCanceledException(token);
                    if (attempt == 2 || !IsRetryableModelDownload(error)) throw;
                    retry = true;
                }
                if (retry)
                {
                    await Task.Delay(TimeSpan.FromSeconds(3 * (attempt + 1)), token);
                    continue;
                }
                break;
            }

            var status = await LocalModelStatus(false);
            if (!LmArr(LmGet(status, "models")).OfType<string>().Contains(model, StringComparer.Ordinal))
                throw new Exception("下载结束后没有检测到模型，请重试。");
        }

        private static bool IsRetryableModelDownload(Exception error)
        {
            if (error is IOException || error is HttpRequestException) return true;
            return error.Message.IndexOf("EOF", StringComparison.OrdinalIgnoreCase) >= 0
                || error.Message.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0
                || error.Message.IndexOf("connection reset", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private async Task StopLocalModelServer()
        {
            await _localStartGate.WaitAsync();
            try
            {
                if (_localModelCancel != null) throw new Exception("请先取消当前模型下载，再停止本地服务。");
                if (_localModelServer == null)
                {
                    if (LmBool(await LocalModelStatus(false), "running"))
                        throw new Exception("本地服务不是由剪辑台启动，请在启动它的程序中停止。");
                    return;
                }
                if (!_localModelServer.HasExited)
                {
                    _localModelServer.Kill();
                    if (!_localModelServer.WaitForExit(5000))
                        throw new Exception("本地服务未能在 5 秒内停止。");
                }
                _localModelServer.Dispose();
                _localModelServer = null;
            }
            finally
            {
                _localStartGate.Release();
            }
        }

        private void StopLocalModels()
        {
            if (_localModelCancel != null) _localModelCancel.Cancel();
            try { if (_localModelServer != null && !_localModelServer.HasExited) _localModelServer.Kill(); } catch { }
            if (_localModelServer != null) _localModelServer.Dispose();
            _localModelServer = null;
        }
    }
}
