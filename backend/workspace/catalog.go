package workspace

import "mini-tools/backend/i18n"

// Catalog son las herramientas, con la descripción que lee el modelo. Los
// nombres de los argumentos (`path`, `content`, `new_string`, `command`,
// `pattern`) son los que agentapprove.Describe ya sabe leer: el resumen de una
// llamada en el chat y la pregunta de permiso salen del mismo texto sin
// código extra.
func Catalog() []Tool {
	str := func(desc string) map[string]any {
		return map[string]any{"type": "string", "description": desc}
	}
	num := func(desc string) map[string]any {
		return map[string]any{"type": "integer", "description": desc}
	}
	flag := func(desc string) map[string]any {
		return map[string]any{"type": "boolean", "description": desc}
	}
	obj := func(props map[string]any, required ...string) map[string]any {
		m := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			m["required"] = required
		}
		return m
	}
	path := i18n.T(i18n.Msg{ES: "Ruta relativa al directorio de trabajo (por ejemplo «src/app.go»).", EN: "Path relative to the working directory (for example “src/app.go”)."})

	return []Tool{
		{
			Name: ToolReadFile, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Lee un archivo de texto del repositorio. Devuelve su contenido (sin numerar las líneas); un archivo grande se corta y la respuesta dice cómo pedir el resto con start_line/end_line.",
				EN: "Reads a text file from the repository. Returns its content (lines are not numbered); a large file is cut and the answer says how to ask for the rest with start_line/end_line.",
			}),
			Parameters: obj(map[string]any{
				"path":       str(path),
				"start_line": num(i18n.T(i18n.Msg{ES: "Primera línea a leer (empieza en 1). Opcional.", EN: "First line to read (starts at 1). Optional."})),
				"end_line":   num(i18n.T(i18n.Msg{ES: "Última línea a leer, incluida. Opcional.", EN: "Last line to read, inclusive. Optional."})),
			}, "path"),
		},
		{
			Name: ToolListDir, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Lista los archivos y carpetas de un directorio del repositorio (un nivel). Las carpetas terminan en «/».",
				EN: "Lists the files and folders of a repository directory (one level). Folders end in “/”.",
			}),
			Parameters: obj(map[string]any{
				"path": str(i18n.T(i18n.Msg{ES: "Directorio, relativo al de trabajo. Vacío = la raíz.", EN: "Directory, relative to the working one. Empty = the root."})),
			}),
		},
		{
			Name: ToolSearch, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Busca texto (o una expresión regular) en los archivos del repositorio. Respeta .gitignore. Devuelve «ruta:línea: texto».",
				EN: "Searches text (or a regular expression) in the repository files. Respects .gitignore. Returns “path:line: text”.",
			}),
			Parameters: obj(map[string]any{
				"pattern":     str(i18n.T(i18n.Msg{ES: "Texto a buscar. Con regex=true, una expresión regular.", EN: "Text to search for. With regex=true, a regular expression."})),
				"path":        str(i18n.T(i18n.Msg{ES: "Carpeta o archivo donde buscar. Vacío = todo el repositorio.", EN: "Folder or file to search in. Empty = the whole repository."})),
				"glob":        str(i18n.T(i18n.Msg{ES: "Filtro por nombre de archivo, por ejemplo «*.go». Opcional.", EN: "File name filter, for example “*.go”. Optional."})),
				"regex":       flag(i18n.T(i18n.Msg{ES: "Tratar pattern como expresión regular (por defecto es texto literal).", EN: "Treat pattern as a regular expression (it is literal text by default)."})),
				"ignore_case": flag(i18n.T(i18n.Msg{ES: "No distinguir mayúsculas de minúsculas.", EN: "Ignore case."})),
				"max_results": num(i18n.T(i18n.Msg{ES: "Máximo de coincidencias (100 por defecto).", EN: "Maximum number of matches (100 by default)."})),
			}, "pattern"),
		},
		{
			Name: ToolGlob, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Busca ARCHIVOS por nombre con un patrón glob (por ejemplo «**/*.go», «src/**/test_*.py», «*.{ts,tsx}»). «**» cruza carpetas; un patrón sin «/» se busca en todas las carpetas. Respeta .gitignore. Devuelve rutas relativas a la raíz, listas para read_file.",
				EN: "Finds FILES by name with a glob pattern (for example “**/*.go”, “src/**/test_*.py”, “*.{ts,tsx}”). “**” crosses folders; a pattern without “/” is searched in every folder. Respects .gitignore. Returns paths relative to the root, ready for read_file.",
			}),
			Parameters: obj(map[string]any{
				"pattern": str(i18n.T(i18n.Msg{ES: "Patrón glob de las rutas a buscar.", EN: "Glob pattern of the paths to find."})),
				"path":    str(i18n.T(i18n.Msg{ES: "Carpeta desde donde buscar; el patrón se evalúa relativo a ella. Vacío = la raíz.", EN: "Folder to search from; the pattern is evaluated relative to it. Empty = the root."})),
			}, "pattern"),
		},
		{
			Name: ToolSkill, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Carga un skill: devuelve su SKILL.md completo y la lista de archivos de su carpeta. Usala cuando la tarea coincida con la descripción de uno de los skills disponibles, ANTES de empezar. Los archivos auxiliares se leen con read_skill_file.",
				EN: "Loads a skill: returns its full SKILL.md and the list of files in its folder. Use it when the task matches the description of one of the available skills, BEFORE starting. Auxiliary files are read with read_skill_file.",
			}),
			Parameters: obj(map[string]any{
				"name": str(i18n.T(i18n.Msg{ES: "Nombre del skill, tal como figura en la lista de skills disponibles.", EN: "Name of the skill, as it appears in the list of available skills."})),
			}, "name"),
		},
		{
			Name: ToolReadSkillFile, Kind: KindRead,
			Description: i18n.T(i18n.Msg{
				ES: "Lee un archivo de la carpeta de un skill (guías, plantillas, scripts). Solo funciona dentro de la carpeta de ese skill, aunque esté fuera del proyecto. Para un directorio devuelve su contenido.",
				EN: "Reads a file from a skill's folder (guides, templates, scripts). It only works inside that skill's folder, even if it lives outside the project. For a directory it returns its entries.",
			}),
			Parameters: obj(map[string]any{
				"skill":      str(i18n.T(i18n.Msg{ES: "Nombre del skill.", EN: "Name of the skill."})),
				"path":       str(i18n.T(i18n.Msg{ES: "Ruta relativa a la carpeta del skill (por ejemplo «references/api.md»).", EN: "Path relative to the skill's folder (for example “references/api.md”)."})),
				"start_line": num(i18n.T(i18n.Msg{ES: "Primera línea a leer (empieza en 1). Opcional.", EN: "First line to read (starts at 1). Optional."})),
				"end_line":   num(i18n.T(i18n.Msg{ES: "Última línea a leer, incluida. Opcional.", EN: "Last line to read, inclusive. Optional."})),
			}, "skill", "path"),
		},
		{
			Name: ToolWriteFile, Kind: KindWrite,
			Description: i18n.T(i18n.Msg{
				ES: "Crea un archivo o REEMPLAZA su contenido entero. Crea las carpetas que falten. Para cambiar una parte de un archivo existente usá edit_file.",
				EN: "Creates a file or REPLACES its whole content. Creates missing folders. To change part of an existing file use edit_file.",
			}),
			Parameters: obj(map[string]any{
				"path":    str(path),
				"content": str(i18n.T(i18n.Msg{ES: "El contenido completo del archivo.", EN: "The complete file content."})),
			}, "path", "content"),
		},
		{
			Name: ToolEditFile, Kind: KindWrite,
			Description: i18n.T(i18n.Msg{
				ES: "Reemplaza un fragmento de un archivo existente. old_string tiene que aparecer EXACTAMENTE una vez (con su sangría y saltos de línea); si aparece varias, agregá líneas de contexto; si no aparece, releé el archivo.",
				EN: "Replaces a piece of an existing file. old_string must appear EXACTLY once (with its indentation and line breaks); if it appears several times add context lines; if it does not appear, re-read the file.",
			}),
			Parameters: obj(map[string]any{
				"path":       str(path),
				"old_string": str(i18n.T(i18n.Msg{ES: "El texto actual a reemplazar, tal cual está en el archivo.", EN: "The current text to replace, exactly as it is in the file."})),
				"new_string": str(i18n.T(i18n.Msg{ES: "El texto nuevo.", EN: "The new text."})),
			}, "path", "old_string", "new_string"),
		},
		{
			Name: ToolRunCommand, Kind: KindCommand,
			Description: i18n.T(i18n.Msg{
				ES: "Ejecuta un comando de shell en el directorio de trabajo (tests, build, git…). Tiene un tiempo máximo y la salida (stdout y stderr juntas) se recorta. No hay entrada interactiva: un comando que espera que se le conteste no termina.",
				EN: "Runs a shell command in the working directory (tests, build, git…). It has a time limit and the output (stdout and stderr together) is trimmed. There is no interactive input: a command that waits to be answered never finishes.",
			}),
			Parameters: obj(map[string]any{
				"command":         str(i18n.T(i18n.Msg{ES: "El comando completo.", EN: "The full command."})),
				"timeout_seconds": num(i18n.T(i18n.Msg{ES: "Tiempo máximo en segundos (120 por defecto, 600 como tope).", EN: "Time limit in seconds (120 by default, 600 at most)."})),
			}, "command"),
		},
	}
}

// KindOf devuelve la clase de una herramienta del catálogo.
func KindOf(name string) (Kind, bool) {
	switch name {
	case ToolReadFile, ToolListDir, ToolSearch, ToolGlob, ToolSkill, ToolReadSkillFile:
		return KindRead, true
	case ToolWriteFile, ToolEditFile:
		return KindWrite, true
	case ToolRunCommand:
		return KindCommand, true
	}
	return 0, false
}
