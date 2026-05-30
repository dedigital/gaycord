using System.Windows;
using Velopack;

namespace Gaycord.Native;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // V7.8: Velopack MUST run first. On a normal launch this returns immediately and the WPF app
        // continues. When the app is (un)installed/updated, Velopack relaunches it with hook arguments;
        // VelopackApp handles those lifecycle hooks and exits before any window is shown. It never runs
        // arbitrary downloaded code — it only wires the install/update lifecycle hooks.
        VelopackApp.Build().Run();
        base.OnStartup(e);
    }
}
