// Package osopen abre una carpeta en el explorador del sistema o en un editor
// externo.
//
// **Por qué existe.** Adentro de la app se puede hacer casi todo con un
// repositorio, pero no todo: mover archivos con el mouse, abrir un PDF, o
// editar el proyecto en el editor de siempre con sus extensiones y su
// configuración. Hasta ahora eso obligaba a copiar la ruta y buscarla a mano en
// otra ventana — un paso tonto que se hace veinte veces al día.
//
// **Solo se ofrece lo que está instalado.** Un botón "Abrir en VS Code" en una
// máquina sin VS Code no falla de forma entendible: falla con un "comando no
// encontrado" que parece un error de esta app. Por eso `Editors` verifica antes
// y la interfaz esconde lo que no está.
//
// **Nunca se pasa la ruta por un intérprete.** Todo va como argumento de
// `exec.Command`, así que una carpeta llamada `; rm -rf ~` es exactamente eso:
// el nombre de una carpeta.
package osopen

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Editor es un editor externo detectado en esta máquina.
type Editor struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Path es el ejecutable resuelto. No se muestra: sirve para lanzarlo sin
	// depender del PATH que heredó la ventana, que abierta desde Finder no
	// incluye /usr/local/bin (el mismo problema que ya tuvieron los agentes).
	Path string `json:"-"`
}

// candidates son los editores que se buscan, con el nombre de su comando de
// línea y las rutas típicas donde el instalador lo deja cuando ese comando no
// está en el PATH.
//
// Se buscan varios y no solo VS Code porque el sucesor de una instalación de
// VS Code suele ser uno de estos, con el mismo comando y los mismos
// argumentos: reconocerlos cuesta una línea cada uno.
var candidates = []struct {
	id      string
	label   string
	command string
	macApp  string
}{
	{"vscode", "VS Code", "code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"},
	{"cursor", "Cursor", "cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"},
	{"vscodium", "VSCodium", "codium", "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"},
	{"zed", "Zed", "zed", "/Applications/Zed.app/Contents/MacOS/cli"},
}

// Editors devuelve los editores realmente instalados, en orden de preferencia.
func Editors() []Editor {
	out := []Editor{}
	for _, c := range candidates {
		if path := resolve(c.command, c.macApp); path != "" {
			out = append(out, Editor{ID: c.id, Label: c.label, Path: path})
		}
	}
	return out
}

func resolve(command, macApp string) string {
	if path, err := exec.LookPath(command); err == nil {
		return path
	}
	// En macOS el comando `code` solo existe si el usuario corrió "Shell
	// Command: Install 'code' in PATH". Sin eso el editor está instalado
	// igual, y esconder el botón por un atajo que falta sería mentir.
	if runtime.GOOS == "darwin" && macApp != "" {
		if _, err := os.Stat(macApp); err == nil {
			return macApp
		}
	}
	return ""
}

// OpenInEditor abre `path` con el editor indicado.
func OpenInEditor(editorID, path string) error {
	dir, err := checkDir(path)
	if err != nil {
		return err
	}
	for _, e := range Editors() {
		if e.ID != editorID {
			continue
		}
		// Sin esperar a que termine: el editor es una app de ventana y puede
		// quedar corriendo horas. Esperarla dejaría esta llamada colgada todo
		// ese tiempo.
		cmd := exec.Command(e.Path, dir)
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("no se pudo abrir %s: %w", e.Label, err)
		}
		go func() { _ = cmd.Wait() }() // Evita dejar un proceso zombi.
		return nil
	}
	return fmt.Errorf("%q no está instalado en esta máquina", editorID)
}

// Reveal abre la carpeta en el explorador de archivos del sistema.
func Reveal(path string) error {
	dir, err := checkDir(path)
	if err != nil {
		return err
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dir)
	case "windows":
		// `explorer` devuelve un código de salida distinto de cero incluso
		// cuando abre bien la ventana, así que el error se ignora a
		// propósito más abajo: tratarlo como fallo mostraría un error sobre
		// algo que funcionó.
		cmd = exec.Command("explorer", filepath.Clean(dir))
	default:
		cmd = exec.Command("xdg-open", dir)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("no se pudo abrir el explorador de archivos: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// checkDir valida que la ruta exista y sea una carpeta.
//
// Se comprueba acá y no se deja fallar al comando: un `open` sobre una ruta
// que ya no existe —el repositorio se movió, el disco externo no está
// montado— falla con un mensaje del sistema operativo que no dice cuál era la
// ruta, y el usuario termina sin saber qué buscar.
func checkDir(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("no hay ninguna carpeta que abrir")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("no se encontró la carpeta %q — ¿se movió o se borró?", abs)
	}
	if !info.IsDir() {
		// Un archivo se abre mostrando su carpeta: es lo que uno espera de
		// "mostrar en el explorador".
		return filepath.Dir(abs), nil
	}
	return abs, nil
}
