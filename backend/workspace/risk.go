package workspace

import (
	"regexp"
	"strings"

	"mini-tools/backend/i18n"
)

// Risk dice si un comando es de los que SIEMPRE se confirman, y por qué
// ("" = no lo es). Pregunta en todos los modos, incluso en «auto», donde el
// resto de los comandos corre sin preguntar.
//
// Es una **lista de patrones y no un análisis del shell**: no entiende
// alias, funciones ni variables, y un modelo decidido puede escribir lo mismo
// de otra manera. Por eso no es la barrera de seguridad —la barrera es el
// modo y que el usuario elija «auto» sabiéndolo— sino una red para los
// descuidos más caros. Se erra del lado de preguntar: un `echo "rm -rf /"`
// también pregunta, porque buscamos el patrón en todo el texto (así también
// se ve dentro de `bash -c "…"` y de `$(…)`).
func Risk(command string) string {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return ""
	}
	for _, r := range riskRules {
		if r.re.MatchString(cmd) {
			return i18n.T(r.why)
		}
	}
	// Sin espacios, el fork bomb clásico `:(){ :|:& };:` (con o sin ellos).
	if strings.Contains(strings.ReplaceAll(cmd, " ", ""), ":(){") {
		return i18n.T(i18n.Msg{ES: "fork bomb", EN: "fork bomb"})
	}
	// Redirecciones a dispositivos: `> /dev/sda` pisa un disco; /dev/null, los
	// descriptores y la terminal son inofensivos.
	for _, m := range devRedirect.FindAllStringSubmatch(cmd, -1) {
		switch dev := m[1]; {
		case dev == "/dev/null", dev == "/dev/stdout", dev == "/dev/stderr", dev == "/dev/tty",
			strings.HasPrefix(dev, "/dev/fd/"):
			continue
		}
		return i18n.T(i18n.Msg{ES: "escribe en un dispositivo (%s)", EN: "writes to a device (%s)"}, m[1])
	}
	return ""
}

// sep es lo que puede venir antes del nombre de un comando: inicio, un
// separador del shell, una apertura de subshell o una comilla.
const sep = "(?:^|[\\s;&|(`\"'])"

type riskRule struct {
	re  *regexp.Regexp
	why i18n.Msg
}

var devRedirect = regexp.MustCompile(`>>?\s*(/dev/\S+)`)

func rule(pattern string, es, en string) riskRule {
	return riskRule{re: regexp.MustCompile(pattern), why: i18n.Msg{ES: es, EN: en}}
}

var riskRules = []riskRule{
	// rm con -r/-R/--recursive en cualquier posición de las banderas: cubre
	// `rm -rf`, `rm -fr`, `rm -f -r`, `rm --recursive` y `rm -Rf`.
	rule(sep+`rm\s+(?:\S+\s+)*?(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?:\s|$)`, "borrado recursivo (rm -r)", "recursive delete (rm -r)"),
	rule(sep+`find\s[^;&|]*\s-delete\b`, "borrado masivo (find -delete)", "bulk delete (find -delete)"),
	rule(sep+`shred\s`, "borrado irrecuperable (shred)", "irrecoverable delete (shred)"),
	// git push con --force / --force-with-lease / -f / -fu / +refspec.
	rule(sep+`git\s+(?:\S+\s+)*push\b[^;&|]*(?:\s--force\S*|\s-[A-Za-z]*f[A-Za-z]*(?:\s|$)|\s\+\S)`, "push forzado (git push --force)", "force push (git push --force)"),
	// Cualquier otro push también: publica trabajo hacia afuera (remoto,
	// CI, compañeros) y no se deshace desde acá. La regla anterior, más
	// específica, gana para los forzados y da su propio motivo.
	rule(sep+`git\s+(?:\S+\s+)*push\b`, "publica en un remoto (git push)", "publishes to a remote (git push)"),
	rule(sep+`git\s+(?:\S+\s+)*reset\b[^;&|]*\s--hard\b`, "descarta cambios (git reset --hard)", "discards changes (git reset --hard)"),
	rule(sep+`git\s+(?:\S+\s+)*clean\b[^;&|]*(?:\s--force|\s-[A-Za-z]*f)`, "borra archivos sin trackear (git clean -f)", "deletes untracked files (git clean -f)"),
	rule(sep+`(?:sudo|doas)(?:\s|$)`, "eleva privilegios (sudo)", "elevates privileges (sudo)"),
	rule(sep+`su(?:\s|$)`, "cambia de usuario (su)", "switches user (su)"),
	rule(sep+`(?:mkfs(?:\.\w+)?|wipefs|fdisk|sfdisk|parted)(?:\s|$)`, "formatea o particiona un disco", "formats or partitions a disk"),
	rule(sep+`diskutil\s+(?:erase|partition|zero|secure)`, "borra un disco (diskutil)", "erases a disk (diskutil)"),
	rule(sep+`dd(?:\s|$)`, "copia a bajo nivel (dd)", "low-level copy (dd)"),
	rule(sep+`(?:chmod|chown|chgrp)\s+(?:\S+\s+)*?(?:-[A-Za-z]*R[A-Za-z]*|--recursive)(?:\s|$)`, "cambio recursivo de permisos (chmod/chown -R)", "recursive permission change (chmod/chown -R)"),
	rule(sep+`(?:shutdown|reboot|halt|poweroff)(?:\s|$)`, "apaga o reinicia la máquina", "shuts down or reboots the machine"),
	rule(sep+`systemctl\s+(?:poweroff|reboot|halt|kexec)\b`, "apaga o reinicia la máquina", "shuts down or reboots the machine"),
	rule(sep+`init\s+[06](?:\s|$)`, "apaga o reinicia la máquina", "shuts down or reboots the machine"),
	// curl/wget canalizado a un shell, o ejecutado con sustitución.
	rule(`(?:curl|wget|fetch)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|c)?sh\b`, "ejecuta un script descargado (curl | sh)", "runs a downloaded script (curl | sh)"),
	rule(`(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b`, "ejecuta un script descargado (sh <(curl …))", "runs a downloaded script (sh <(curl …))"),
	rule(`\$\(\s*(?:curl|wget)\b[^)]*\)`, "ejecuta lo que descarga ($(curl …))", "runs what it downloads ($(curl …))"),
	rule(sep+`eval\s+.*\b(?:curl|wget)\b`, "ejecuta lo que descarga (eval)", "runs what it downloads (eval)"),
}
