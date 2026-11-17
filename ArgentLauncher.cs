using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

class ArgentLauncher {
    const string CockpitUrl = "http://127.0.0.1:3001/";

    static bool IsCockpitRunning() {
        try {
            var request = (HttpWebRequest)WebRequest.Create(CockpitUrl);
            request.Timeout = 1500;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                var body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK &&
                    body.IndexOf("<title>Kynext", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    body.Contains("X-Argent-Token") &&
                    !body.Contains("__ARGENT_API_TOKEN__");
            }
        } catch {
            return false;
        }
    }

    static void Main() {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string serverFile = Path.Combine(dir, "server_argent.js");
        if (!File.Exists(serverFile)) {
            MessageBox.Show("Le fichier server_argent.js est introuvable dans le dossier du lanceur.",
                "Kynext", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (!IsCockpitRunning()) {
            try {
                var psi = new ProcessStartInfo {
                    FileName = "node.exe",
                    Arguments = "\"server_argent.js\"",
                    WorkingDirectory = dir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Process.Start(psi);
            } catch (Exception ex) {
                MessageBox.Show("Impossible de demarrer Kynext. Verifie que Node.js est installe.\n\n" + ex.Message,
                    "Kynext", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }

        bool ready = false;
        for (int i = 0; i < 30; i++) {
            if (IsCockpitRunning()) { ready = true; break; }
            Thread.Sleep(500);
        }
        if (!ready) {
            MessageBox.Show("Kynext ne repond pas sur le port 3001. Verifie que ce port est libre et que Node.js fonctionne.",
                "Kynext", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try {
            Process.Start(new ProcessStartInfo("msedge.exe", "--app=" + CockpitUrl + " --start-maximized") { UseShellExecute = true });
        } catch {
            Process.Start(new ProcessStartInfo(CockpitUrl) { UseShellExecute = true });
        }
    }
}
