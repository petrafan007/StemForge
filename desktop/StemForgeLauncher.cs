// StemForge desktop launcher (compiled to StemForge.exe by desktop\build-desktop-app.ps1).
//
// What it does when you double-click StemForge.exe:
//   1. Rebuilds the web app (npm run build) only if the source changed since the last build.
//   2. Starts the local GPU server (local-gpu-server\.venv) hidden, unless it is already running.
//      The server also serves the built web app at http://127.0.0.1:8000.
//   3. Opens StemForge in its own app window (Microsoft Edge or Chrome "--app" mode).
//   4. When you close that window, stops the GPU server it started (freeing VRAM), unless
//      Settings -> Desktop App -> "Keep the GPU engine running" is on.
//
// Double-clicking a .sfg project in Explorer runs "StemForge.exe <file.sfg>": the project is
// imported into the library and opened.
//
// Written for the C# 5 compiler that ships with Windows (.NET Framework 4.x csc.exe).

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace StemForge
{
    internal static class Launcher
    {
        private const string ServerUrl = "http://127.0.0.1:8000";
        private const string AppTitle = "StemForge";

        private static string _root;
        private static string _logPath;
        private static string _profileDir;
        private static Process _server;
        private static StreamWriter _log;
        private static string _launcherLogPath;
        private static string _openSfg;

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            _logPath = Path.Combine(_root, "logs", "stemforge-server.log");
            _launcherLogPath = Path.Combine(_root, "logs", "stemforge-launcher.log");
            foreach (string a in args)
            {
                if (a.EndsWith(".sfg", StringComparison.OrdinalIgnoreCase) && File.Exists(a))
                {
                    _openSfg = Path.GetFullPath(a);
                }
            }
            _profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "StemForge", "AppWindow");

            bool firstInstance;
            using (var mutex = new Mutex(true, "Local\\StemForgeDesktopLauncher", out firstInstance))
            {
                if (!firstInstance)
                {
                    // Already running: just open another StemForge window (with the .sfg, if any).
                    if (IsServerHealthy()) OpenAppWindow(false, ResolveStartUrl());
                    return 0;
                }

                try
                {
                    return Run();
                }
                catch (Exception ex)
                {
                    ShowError("StemForge hit an unexpected error:\n\n" + ex.Message);
                    return 1;
                }
                finally
                {
                    StopServer();
                }
            }
        }

        private static int Run()
        {
            string venvPython = Path.Combine(_root, "local-gpu-server", ".venv", "Scripts", "python.exe");
            if (!File.Exists(venvPython))
            {
                ShowError("The StemForge GPU engine is not installed yet.\n\nOpen PowerShell in\n" + _root +
                          "\\local-gpu-server\nand run:  .\\setup_windows.ps1");
                return 1;
            }

            string error = null;
            using (var splash = new SplashForm())
            {
                var worker = new Thread(() =>
                {
                    try
                    {
                        if (NeedsWebBuild())
                        {
                            splash.SetStatus("Updating StemForge (building the app)...");
                            if (!RunWebBuild()) error = "Building the StemForge web app failed. See " + _launcherLogPath;
                        }
                        if (error == null)
                        {
                            if (IsServerHealthy())
                            {
                                splash.SetStatus("Connecting to the running GPU engine...");
                            }
                            else
                            {
                                splash.SetStatus("Starting the GPU engine (RTX)...");
                                error = StartServer(venvPython);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        error = ex.Message;
                    }
                    splash.CloseFromWorker();
                });
                worker.IsBackground = true;
                worker.Start();
                Application.Run(splash);
                worker.Join();
            }

            if (error != null)
            {
                ShowError(error);
                return 1;
            }

            OpenAppWindow(true, ResolveStartUrl());
            return 0;
        }

        /// <summary>Imports the .sfg passed on the command line (if any) and returns the URL to open.</summary>
        private static string ResolveStartUrl()
        {
            if (_openSfg == null) return ServerUrl;
            try
            {
                string body = "{\"path\":\"" + _openSfg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
                using (var wc = new WebClient())
                {
                    wc.Proxy = null;
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                    string resp = wc.UploadString(ServerUrl + "/projects/import-path", "POST", body);
                    Match m = Regex.Match(resp, "\"id\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) return ServerUrl + "/?open=" + Uri.EscapeDataString(m.Groups[1].Value);
                }
            }
            catch (Exception ex)
            {
                ShowError("Could not open " + Path.GetFileName(_openSfg) + ":\n\n" + ex.Message);
            }
            return ServerUrl;
        }

        /// <summary>Reads desktop.keepEngineRunning from %LOCALAPPDATA%\StemForge\settings.json.</summary>
        private static bool KeepEngineRunning()
        {
            try
            {
                string path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StemForge", "settings.json");
                if (!File.Exists(path)) return false;
                string json = File.ReadAllText(path);
                Match m = Regex.Match(json, "\"keepEngineRunning\"\\s*:\\s*(true|false)");
                return m.Success && m.Groups[1].Value == "true";
            }
            catch
            {
                return false;
            }
        }

        // ------------------------------------------------------------------ web build

        private static bool NeedsWebBuild()
        {
            string builtIndex = Path.Combine(_root, "dist", "index.html");
            if (!File.Exists(builtIndex)) return true;
            DateTime built = File.GetLastWriteTimeUtc(builtIndex);

            string[] files = { "index.html", "package.json", "vite.config.ts" };
            foreach (string f in files)
            {
                string p = Path.Combine(_root, f);
                if (File.Exists(p) && File.GetLastWriteTimeUtc(p) > built) return true;
            }
            string src = Path.Combine(_root, "src");
            if (Directory.Exists(src))
            {
                foreach (string p in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
                {
                    if (File.GetLastWriteTimeUtc(p) > built) return true;
                }
            }
            return false;
        }

        private static bool RunWebBuild()
        {
            OpenLog(_launcherLogPath);
            string npmArgs = Directory.Exists(Path.Combine(_root, "node_modules"))
                ? "/c npm run build"
                : "/c npm install && npm run build";
            var psi = new ProcessStartInfo("cmd.exe", npmArgs)
            {
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = new Process { StartInfo = psi })
            {
                p.OutputDataReceived += (s, e) => WriteLog(e.Data);
                p.ErrorDataReceived += (s, e) => WriteLog(e.Data);
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                return p.ExitCode == 0 && File.Exists(Path.Combine(_root, "dist", "index.html"));
            }
        }

        // ------------------------------------------------------------------ GPU server

        private static string StartServer(string venvPython)
        {
            string serverDir = Path.Combine(_root, "local-gpu-server");
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
            string logForPython = _logPath.Replace("\\", "/");
            // The server writes its own log file, so it keeps working if it outlives this launcher.
            string code =
                "import sys; f = open(r'" + logForPython + "', 'w', buffering=1, encoding='utf-8', errors='replace'); " +
                "sys.stdout = sys.stderr = f; import uvicorn; " +
                "uvicorn.run('gpu_server:app', host='127.0.0.1', port=8000)";
            var psi = new ProcessStartInfo(venvPython, "-c \"" + code + "\"")
            {
                WorkingDirectory = serverDir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables["TORCH_HOME"] = Path.Combine(serverDir, "models");
            psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";

            _server = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _server.Start();

            DateTime deadline = DateTime.UtcNow.AddSeconds(120);
            while (DateTime.UtcNow < deadline)
            {
                if (_server.HasExited)
                {
                    return "The StemForge GPU engine stopped while starting (exit code " + _server.ExitCode +
                           ").\n\nIf another program is using port 8000, close it and try again.\n\nDetails: " + _logPath;
                }
                if (IsServerHealthy()) return null;
                Thread.Sleep(500);
            }
            return "The StemForge GPU engine did not start within 2 minutes.\n\nDetails: " + _logPath;
        }

        private static bool IsServerHealthy()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(ServerUrl + "/health");
                req.Timeout = 1500;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    return resp.StatusCode == HttpStatusCode.OK && body.Contains("\"ok\":true");
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StopServer()
        {
            try
            {
                if (_server != null && !_server.HasExited && !KeepEngineRunning())
                {
                    _server.Kill();
                    _server.WaitForExit(5000);
                }
            }
            catch
            {
                // best effort
            }
            WriteLog("[launcher] StemForge closed.");
            if (_log != null)
            {
                _log.Dispose();
                _log = null;
            }
        }

        // ------------------------------------------------------------------ app window

        private static string FindBrowser()
        {
            string[] appPaths = { "msedge.exe", "chrome.exe", "brave.exe" };
            foreach (string exe in appPaths)
            {
                foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
                {
                    using (RegistryKey key = hive.OpenSubKey(
                        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe))
                    {
                        if (key == null) continue;
                        string path = key.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(path) && File.Exists(path.Trim('"'))) return path.Trim('"');
                    }
                }
            }
            string[] fallbacks =
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            };
            foreach (string f in fallbacks)
            {
                if (File.Exists(f)) return f;
            }
            return null;
        }

        private static void OpenAppWindow(bool waitUntilClosed, string url)
        {
            string browser = FindBrowser();
            if (browser == null)
            {
                Process.Start(url);
                if (waitUntilClosed)
                {
                    MessageBox.Show("StemForge is running in your web browser at " + ServerUrl +
                                    "\n\nClick OK when you are finished to stop StemForge.",
                        AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return;
            }

            Directory.CreateDirectory(_profileDir);
            string args = "--app=" + url +
                          " --user-data-dir=\"" + _profileDir + "\"" +
                          " --no-first-run --no-default-browser-check --window-size=1440,900";
            Process window = Process.Start(new ProcessStartInfo(browser, args) { UseShellExecute = false });
            if (!waitUntilClosed || window == null) return;

            window.WaitForExit();
            // The browser can hand the window to a helper process; keep waiting while any
            // browser process for the StemForge window profile is still alive.
            Thread.Sleep(1500);
            while (AppWindowStillOpen())
            {
                Thread.Sleep(2000);
            }
        }

        private static bool AppWindowStillOpen()
        {
            try
            {
                string needle = _profileDir.Replace("\\", "\\\\").Replace("'", "''");
                string query = "SELECT ProcessId FROM Win32_Process WHERE CommandLine LIKE '%" + needle +
                               "%' AND (Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe')";
                using (var searcher = new ManagementObjectSearcher(query))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    return results.Count > 0;
                }
            }
            catch
            {
                return false;
            }
        }

        // ------------------------------------------------------------------ helpers

        private static readonly object LogLock = new object();

        private static void OpenLog(string path)
        {
            lock (LogLock)
            {
                if (_log != null) return;
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                _log = new StreamWriter(path, false) { AutoFlush = true };
                _log.WriteLine("[launcher] " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " starting StemForge");
            }
        }

        private static void WriteLog(string line)
        {
            if (line == null) return;
            lock (LogLock)
            {
                if (_log != null) _log.WriteLine(line);
            }
        }

        private static void ShowError(string message)
        {
            MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>Small "starting..." window shown while the GPU engine boots.</summary>
    internal sealed class SplashForm : Form
    {
        private readonly Label _status;

        public SplashForm()
        {
            Text = "StemForge";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            TopMost = true;
            BackColor = Color.FromArgb(19, 22, 28);
            Size = new Size(420, 150);
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                // default icon
            }

            var title = new Label
            {
                Text = "StemForge",
                ForeColor = Color.FromArgb(245, 158, 11),
                Font = new Font("Segoe UI", 20f, FontStyle.Bold),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Top,
                Height = 70,
            };
            _status = new Label
            {
                Text = "Starting...",
                ForeColor = Color.FromArgb(203, 213, 225),
                Font = new Font("Segoe UI", 10f),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Fill,
            };
            Controls.Add(_status);
            Controls.Add(title);
        }

        public void SetStatus(string text)
        {
            if (!IsHandleCreated) { _status.Text = text; return; }
            BeginInvoke(new Action(() => _status.Text = text));
        }

        public void CloseFromWorker()
        {
            // Wait until the window exists, then close it on the UI thread.
            while (!IsHandleCreated) Thread.Sleep(20);
            BeginInvoke(new Action(Close));
        }
    }
}
