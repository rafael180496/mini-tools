package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/appdata"
	"mini-tools/backend/git"
	"mini-tools/backend/mcpserver"
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

	// Same shape as askpass above: git re-executes this binary as its
	// sequence editor during an interactive rebase, hands it the todo file
	// as argv[1], and uses whatever is left there. It must write and exit
	// before anything else here opens a window or touches the vault.
	if git.IsSequenceEditorInvocation() {
		git.SequenceEditorMain()
		return
	}

	// Tercer re-exec, misma forma que los dos de arriba pero lo lanza un CLI
	// agéntico y no git: el hook PreToolUse con el que el agente pregunta
	// antes de cada acción. Reenvía la pregunta al proceso de la app por un
	// socket, así que tampoco es un arranque de la app y va antes de todo lo
	// demás (ver backend/agentapprove/hook.go).
	if agentapprove.IsHookInvocation() {
		agentapprove.HookMain()
		return
	}

	// Cuarto re-exec, el mismo patrón: un CLI agéntico lanza este binario como
	// su servidor MCP (`mini-tools --mcp`). Reenvía cada llamada a la ventana
	// abierta por un socket local —no tiene la clave maestra, así que no puede
	// leer nada por su cuenta— y por eso tampoco es un arranque de la app.
	//
	// **Si la ventana no está, o el vault está bloqueado, o el servidor no fue
	// encendido, este proceso no obtiene datos**: contesta explicando qué falta.
	// No hay una segunda ruta al vault.
	if len(os.Args) > 1 && os.Args[1] == "--mcp" {
		dir, err := appdata.Dir()
		if err != nil {
			fmt.Fprintln(os.Stderr, "mini-tools: no se pudo resolver el directorio de datos:", err)
			os.Exit(1)
		}
		if err := mcpserver.RunStdio(dir, appVersion); err != nil {
			fmt.Fprintln(os.Stderr, "mini-tools:", err)
			os.Exit(1)
		}
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
		// Lets files be dragged from Finder/Explorer onto the SFTP pane.
		// CSSDropProperty/CSSDropValue mark WHICH elements accept a drop:
		// without a drop target the whole window would swallow every drag,
		// including ones meant for the editor. Only elements carrying
		// `--wails-drop-target: drop` receive the paths.
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			CSSDropProperty:    "--wails-drop-target",
			CSSDropValue:       "drop",
			DisableWebViewDrop: false,
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
