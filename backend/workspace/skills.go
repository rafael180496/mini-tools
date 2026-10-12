package workspace

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mini-tools/backend/i18n"
)

// SkillRef es un skill que el modelo puede cargar: su nombre y la carpeta que
// contiene su SKILL.md. Quien arma el Workspace (backend/agentctx lo descubre)
// lo entrega ya resuelto; este paquete no sabe dónde viven los skills.
type SkillRef struct {
	Name string
	Dir  string
}

// Topes de las herramientas de skills. Un SKILL.md de más de esto no es una
// guía sino un manual, y el resto se pide por partes con read_skill_file.
const (
	maxSkillBytes    = 64 * 1024
	maxSkillFiles    = 100
	maxSkillTreeDeep = 4
)

// HasSkills dice si hay skills cargables: sin ninguno, las herramientas no se
// declaran (una herramienta que figura y siempre falla invita a intentarla).
func (w *Workspace) HasSkills() bool { return len(w.opts.Skills) > 0 }

func (w *Workspace) skillNamed(name string) (SkillRef, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SkillRef{}, missing("name")
	}
	for _, s := range w.opts.Skills {
		if strings.EqualFold(s.Name, name) {
			return s, nil
		}
	}
	var names []string
	for _, s := range w.opts.Skills {
		names = append(names, s.Name)
	}
	sort.Strings(names)
	if len(names) > 40 {
		names = append(names[:40], "…")
	}
	if len(names) == 0 {
		return SkillRef{}, i18n.Errorf(i18n.Msg{ES: "no hay skills disponibles en este proyecto", EN: "there are no skills available in this project"})
	}
	return SkillRef{}, i18n.Errorf(i18n.Msg{
		ES: "no existe el skill %q. Disponibles: %s",
		EN: "there is no skill %q. Available: %s",
	}, name, strings.Join(names, ", "))
}

// skillBox abre la carpeta de un skill como si fuera un directorio de trabajo
// propio. Es la forma de reutilizar el confinamiento de resolve sin escribir
// otro: toda ruta se resuelve contra ESA carpeta, siguiendo symlinks, y una que
// termina fuera se rechaza.
//
// La carpeta del skill puede ser ella misma un enlace (es habitual enlazar
// ~/.claude/skills/x a un clon): se resuelve una vez, al abrir, y eso es lo
// que el usuario eligió. Lo que no se permite es que un enlace DENTRO del skill
// saque de ahí.
func skillBox(dir string) (*Workspace, error) {
	return New(dir, Options{})
}

// skillOutside traduce ErrOutside al contexto de un skill: el mensaje original
// habla de «el repositorio», que acá no es lo que se rechaza.
func skillOutside(err error) error {
	if err == ErrOutside {
		return i18n.Errorf(i18n.Msg{
			ES: "la ruta sale de la carpeta del skill: solo se leen archivos dentro de ella",
			EN: "the path leaves the skill's folder: only files inside it can be read",
		})
	}
	return err
}

// skill devuelve el SKILL.md de un skill y la lista de archivos de su carpeta.
func (w *Workspace) skill(args map[string]any) (string, error) {
	s, err := w.skillNamed(strArg(args, "name"))
	if err != nil {
		return "", err
	}
	box, err := skillBox(s.Dir)
	if err != nil {
		return "", err
	}
	abs, _, err := box.resolve("SKILL.md")
	if err != nil {
		return "", skillOutside(err)
	}
	f, err := os.Open(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer el SKILL.md de %q: %w", EN: "could not read the SKILL.md of %q: %w"}, s.Name, err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSkillBytes+1))
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer el SKILL.md de %q: %w", EN: "could not read the SKILL.md of %q: %w"}, s.Name, err)
	}
	cut := len(data) > maxSkillBytes
	if cut {
		data = data[:maxSkillBytes]
	}

	var b strings.Builder
	b.WriteString("[skill: " + s.Name + "]\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "Carpeta: %s", EN: "Folder: %s"}, box.Root()) + "\n\n")
	b.WriteString(strings.ToValidUTF8(string(data), "�"))
	if !strings.HasSuffix(b.String(), "\n") {
		b.WriteByte('\n')
	}
	if cut {
		b.WriteString(i18n.T(i18n.Msg{
			ES: "[SKILL.md cortado a %d KB: seguí con read_skill_file(skill, \"SKILL.md\", start_line=…)]\n",
			EN: "[SKILL.md cut at %d KB: continue with read_skill_file(skill, \"SKILL.md\", start_line=…)]\n",
		}, maxSkillBytes>>10))
	}

	files, more := skillFiles(box.Root())
	if len(files) > 0 {
		b.WriteString("\n" + i18n.T(i18n.Msg{
			ES: "Archivos del skill (se leen con read_skill_file; rutas relativas a su carpeta):",
			EN: "Skill files (read them with read_skill_file; paths relative to its folder):",
		}) + "\n")
		for _, f := range files {
			b.WriteString("- " + f + "\n")
		}
		if more {
			b.WriteString(i18n.T(i18n.Msg{ES: "[lista cortada a %d archivos]\n", EN: "[list cut at %d files]\n"}, maxSkillFiles))
		}
	}
	return b.String(), nil
}

// skillFiles lista los archivos regulares de la carpeta de un skill (sin
// SKILL.md), con `/` y ordenados. No sigue enlaces a carpetas: WalkDir no los
// recorre, y el tope de profundidad y de cantidad evita que un skill con un
// node_modules adentro llene el contexto.
func skillFiles(root string) (files []string, more bool) {
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if d.Name() == ".git" || d.Name() == "node_modules" || strings.Count(rel, "/") >= maxSkillTreeDeep {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || rel == "SKILL.md" {
			return nil
		}
		if len(files) >= maxSkillFiles {
			more = true
			return filepath.SkipAll
		}
		files = append(files, rel)
		return nil
	})
	sort.Strings(files)
	return files, more
}

// readSkillFile lee un archivo dentro de la carpeta de un skill. Es la única
// forma de leer un skill global: está fuera de la raíz del proyecto, donde
// read_file no llega.
func (w *Workspace) readSkillFile(args map[string]any) (string, error) {
	s, err := w.skillNamed(strArg(args, "skill"))
	if err != nil {
		return "", err
	}
	p := strArg(args, "path")
	if strings.TrimSpace(p) == "" {
		return "", missing("path")
	}
	box, err := skillBox(s.Dir)
	if err != nil {
		return "", err
	}
	abs, rel, err := box.resolve(p)
	if err != nil {
		return "", skillOutside(err)
	}
	if fi, err := os.Stat(abs); err == nil && fi.IsDir() {
		out, err := box.listDir(map[string]any{"path": rel})
		return out, skillOutside(err)
	}
	out, err := box.readFile(args)
	return out, skillOutside(err)
}
