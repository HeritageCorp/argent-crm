using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace KynextLauncher
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            // Verrou Anti-double instance
            bool createdNew = true;
            using (Mutex mutex = new Mutex(true, "KynextStudioAppMutex", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("Kynext est déjà en cours d'exécution.", "Kynext Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                // 1. Tuer les anciens processus sur le port
                KillProcessByPort(3001);

                // 2. Lancer Node.js de manière totalement invisible
                ProcessStartInfo nodeInfo = new ProcessStartInfo();
                nodeInfo.FileName = "node";
                nodeInfo.Arguments = "server_argent.js";
                nodeInfo.UseShellExecute = false;
                nodeInfo.CreateNoWindow = true; // Masque la console noire
                nodeInfo.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
                
                Process nodeProcess = Process.Start(nodeInfo);
                
                // Laisser au serveur 1.5s pour démarrer
                Thread.Sleep(1500);

                // 3. Ouvrir l'interface en mode "Application Native" (sans barre d'URL)
                ProcessStartInfo browserInfo = new ProcessStartInfo();
                
                // On tente de lancer MS Edge ou Chrome en mode --app (interface épurée)
                browserInfo.FileName = "cmd";
                browserInfo.Arguments = "/c start msedge --app=http://127.0.0.1:3001 || start chrome --app=http://127.0.0.1:3001 || start http://127.0.0.1:3001";
                browserInfo.UseShellExecute = false;
                browserInfo.CreateNoWindow = true;
                
                Process.Start(browserInfo);

                // 4. Garder le lanceur actif tant que Node tourne pour le fermer en cas de kill système
                nodeProcess.WaitForExit();
            }
        }

        static void KillProcessByPort(int port)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", $"/c FOR /F \"tokens=5\" %a IN ('netstat -aon ^| findstr :{port}') DO taskkill /F /PID %a");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process.Start(psi).WaitForExit();
            }
            catch { }
        }
    }
}
