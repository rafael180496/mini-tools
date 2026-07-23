package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"mini-tools/backend/git"
)

//go:embed all:frontend/dist
var assets embed.FS

// appVersion is stamped at build time via -ldflags "-X main.appVersion=..."
// (see scripts/build.sh) — read the VERSION file for the source of truth.
// Not exposed to the frontend; kept for support/debugging only.
var appVersion = "dev"

func main() {
	// git re-executes this same binary as its GIT_ASKPASS/SSH_ASKPASS helper
	// to collect a PAT or key passphrase (see backend/git/auth.go). That run
	// must answer on stdout and exit — it is not an app launch, so it has to
	// be handled before anything else here opens a window, touches the vault,
	// or writes to appdata.
	if git.IsAskpassInvocation() {
		git.AskpassMain()
		return
	}

	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "mini-tools",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		// Maximised, not a fixed size: Wails sizes this to the current
		// monitor's actual work area, so the app opens filling the screen
		// without needing internal scroll — no manual resolution detection
		// needed. Width/Height above only matter as the restore size if the
		// user un-maximises.
		WindowStartState: options.Maximised,
		Mac: &mac.Options{
			// Explicit (matches the zero-value default) so the native
			// green title-bar button stays enabled for maximize/fullscreen.
			DisableZoom: false,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
