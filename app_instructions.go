package main

import (
	"errors"
	"os"
	"path/filepath"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/i18n"
)

// instructionTargets son los archivos de instrucciones que se pueden crear
// como puntero, en el orden en que se elige la fuente: el primero presente
// (distinto del destino) es del que se apunta. No incluye
// .github/copilot-instructions.md: tiene otro formato y otro lugar, y un
// puntero ahí no lo leería nadie con la sintaxis de import de los otros.
var instructionTargets = []string{"CLAUDE.md", "AGENTS.md", "GEMINI.md"}

// GitCreateInstructionPointer crea en la raíz del repositorio el archivo de
// instrucciones `file` que falta, como puntero corto a otro que ya existe
// (ver agentctx.InstructionPointer para la sintaxis de cada uno). Devuelve el
// archivo fuente usado.
//
// **Nunca pisa**: se abre con O_EXCL, así que si el archivo existe —aunque
// aparezca entre el chequeo y la escritura— falla en vez de reemplazarlo. Son
// las reglas del equipo, no un artefacto regenerable.
//
// `file` es un nombre de la lista y no una ruta: cualquier otro valor, incluido
// uno con separadores o `..`, se rechaza antes de tocar el disco.
func (a *App) GitCreateInstructionPointer(repoID, file string) (string, error) {
	root, err := a.gitRepo(repoID) // pasa por requireUnlocked
	if err != nil {
		return "", err
	}
	return createInstructionPointer(root, file)
}

func createInstructionPointer(root, file string) (string, error) {
	valid := false
	for _, f := range instructionTargets {
		if f == file {
			valid = true
		}
	}
	if !valid {
		return "", i18n.Errorf(i18n.Msg{ES: "archivo de instrucciones no soportado: %q", EN: "unsupported instructions file: %q"}, file)
	}

	source := ""
	for _, f := range instructionTargets {
		if f == file {
			continue
		}
		if st, err := os.Stat(filepath.Join(root, f)); err == nil && st.Mode().IsRegular() {
			source = f
			break
		}
	}
	if source == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "no hay ningún otro archivo de instrucciones del que apuntar para crear %s", EN: "there is no other instructions file to point to in order to create %s"}, file)
	}

	f, err := os.OpenFile(filepath.Join(root, file), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", i18n.Errorf(i18n.Msg{ES: "%s ya existe y no se pisa", EN: "%s already exists and is not overwritten"}, file)
		}
		return "", err
	}
	_, werr := f.WriteString(agentctx.InstructionPointer(file, source))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		// Un archivo a medias es peor que ninguno: el panel lo daría por
		// presente y el agente leería un puntero truncado.
		_ = os.Remove(filepath.Join(root, file))
		return "", werr
	}
	return source, nil
}
