package git

import (
	"fmt"
	"strings"
)

// Git Flow, implementado nativo: solo configuración y ramas.
//
// # Por qué no se envuelve el binario `git-flow`
//
// Es la misma decisión que tomó todo este paquete al elegir `exec git` sobre
// go-git, mirada desde el otro lado: acá la dependencia externa NO aporta
// nada que no se pueda escribir en cien líneas. `git flow` es un script de
// shell que escribe unas claves de configuración y corre `git branch` y
// `git checkout` — pero no viene instalado en ninguna de las tres
// plataformas, así que envolverlo significaría o pedirle al usuario que lo
// instale, o mostrar un módulo que a veces está y a veces no.
//
// Escribiendo las MISMAS claves (`gitflow.branch.*`, `gitflow.prefix.*`) el
// repositorio queda compatible en las dos direcciones: quien use el binario
// en una terminal sobre este repo lo encuentra ya inicializado, y un repo
// inicializado con el binario se lee acá sin más.
//
// # Qué NO hace: finish
//
// Deliberado, no un recorte. `git flow feature finish` es merge + borrar la
// rama, y `release finish` es merge a master, tag, merge de vuelta a develop
// y borrar — cuatro operaciones destructivas encadenadas donde un fallo en
// la tercera deja el repositorio a mitad de camino, sin que el usuario sepa
// en cuál. Todas esas piezas ya están en la interfaz por separado (merge,
// tag, borrar rama), con su confirmación y su mensaje de error propio.
// Automatizar la cadena es una decisión de producto, no una omisión.

// GitFlowConfig es la convención de nombres que el repositorio declara.
type GitFlowConfig struct {
	// Master es la rama de producción ("main" o "master"), Develop la de
	// integración.
	Master  string `json:"master"`
	Develop string `json:"develop"`
	// Prefijos de cada tipo de rama, con la barra incluida ("feature/").
	Feature string `json:"feature"`
	Release string `json:"release"`
	Hotfix  string `json:"hotfix"`
	Support string `json:"support"`
	// VersionTag antepone algo a los tags de release ("v"). Vacío es válido
	// y es el default de git-flow.
	VersionTag string `json:"versionTag"`
	// Initialized es true cuando el repositorio ya tiene la configuración
	// escrita. Lo que decide es la presencia de gitflow.branch.develop: es
	// la clave que el propio git-flow considera la marca de inicialización.
	Initialized bool `json:"initialized"`
	// DevelopExists distingue "configurado" de "usable": la configuración
	// puede nombrar una rama develop que alguien borró después.
	DevelopExists bool `json:"developExists"`
	MasterExists  bool `json:"masterExists"`
}

// localConfig lee TODA la configuración local del repositorio de una sola
// vez, como mapa clave→valor.
//
// Existe para no preguntar clave por clave. `git config --get` sale con
// código 1 cuando la clave no está, que para gitflow.* es el estado normal
// —casi ningún repositorio usa Git Flow—, así que leer las siete claves por
// separado producía SIETE entradas en rojo en el panel "Comandos
// ejecutados" en cada refresco. Un registro de auditoría que marca errores
// donde no los hubo deja de servir para encontrar los de verdad; es la
// misma razón que CheckoutBranch documenta para no sondear con
// `rev-parse --verify`.
//
// `--list` en cambio siempre sale con 0 en un repositorio válido: .git/config
// nunca está vacío, siempre trae al menos las claves core.*.
func (r *Runner) localConfig(root string) map[string]string {
	return r.configList(root, "--local")
}

// configList es localConfig parametrizado por scope, para poder leer también
// ~/.gitconfig sin repetir el parseo.
func (r *Runner) configList(root, scope string) map[string]string {
	out, err := r.runLocal(root, "config", scope, "--list")
	if err != nil {
		return nil
	}
	conf := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		conf[key] = value
	}
	return conf
}

// branchesExist pregunta por varias ramas en UNA invocación.
//
// `git branch --list` acepta varios patrones, así que preguntar por cuatro
// ramas cuesta lo mismo que preguntar por una. Antes eran tres llamadas
// —una de ellas repetida, "main" se consultaba dos veces— para responder lo
// mismo.
func (r *Runner) branchesExist(root string, names ...string) map[string]bool {
	found := map[string]bool{}
	args := []string{"branch", "--list", "--format=%(refname:short)"}
	seen := map[string]bool{}
	for _, n := range names {
		n = strings.TrimSpace(n)
		// Un patrón que empiece con "-" lo leería como flag, y uno con
		// comodines devolvería ramas que no son la preguntada.
		if n == "" || seen[n] || strings.HasPrefix(n, "-") || strings.ContainsAny(n, "*?[") {
			continue
		}
		seen[n] = true
		args = append(args, n)
	}
	if len(args) == 3 {
		return found
	}
	out, err := r.runLocal(root, args...)
	if err != nil {
		return found
	}
	for _, line := range strings.Split(out, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			found[name] = true
		}
	}
	return found
}

// gitFlowPrefixes son los prefijos por defecto, los mismos que usa el
// binario git-flow.
func gitFlowPrefixes() GitFlowConfig {
	return GitFlowConfig{
		Develop:    "develop",
		Feature:    "feature/",
		Release:    "release/",
		Hotfix:     "hotfix/",
		Support:    "support/",
		VersionTag: "",
	}
}

// GitFlowStatus lee la configuración efectiva, completando con los defaults
// las claves que falten.
//
// Tres invocaciones de git en total (resolver la raíz, leer la config,
// preguntar por las ramas), ninguna de las cuales falla en el caso normal.
// Importa porque el frontend lo consulta en cada refresco para saber si el
// menú dice "Inicializar" o "Nueva feature".
func (r *Runner) GitFlowStatus(repoPath string) (GitFlowConfig, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return GitFlowConfig{}, err
	}

	conf := r.localConfig(root)
	cfg := gitFlowPrefixes()

	if v := conf["gitflow.branch.develop"]; v != "" {
		cfg.Develop = v
		cfg.Initialized = true
	}
	if v := conf["gitflow.prefix.feature"]; v != "" {
		cfg.Feature = v
	}
	if v := conf["gitflow.prefix.release"]; v != "" {
		cfg.Release = v
	}
	if v := conf["gitflow.prefix.hotfix"]; v != "" {
		cfg.Hotfix = v
	}
	if v := conf["gitflow.prefix.support"]; v != "" {
		cfg.Support = v
	}
	cfg.VersionTag = conf["gitflow.prefix.versiontag"]

	configured := conf["gitflow.branch.master"]
	// Se pregunta por todos los candidatos de una vez: el configurado, los
	// dos nombres habituales y la rama de desarrollo.
	exists := r.branchesExist(root, configured, "main", "master", cfg.Develop)

	// Qué rama de producción proponer cuando no hay ninguna configurada: se
	// MIRA el repositorio en vez de asumir "master". Desde 2020 los repos
	// nuevos se llaman "main" en las tres forjas, y proponer "master" en uno
	// que no la tiene deja Git Flow apuntando a una rama inexistente — error
	// que recién se manifiesta en el primer hotfix, semanas después.
	//
	// GetCurrentBranch queda como último recurso y no como primer paso
	// porque vuelve a resolver la raíz por su cuenta: preguntarlo siempre
	// agregaba dos procesos al camino común, donde main o master existe.
	switch {
	case configured != "":
		cfg.Master = configured
	case exists["main"]:
		cfg.Master = "main"
	case exists["master"]:
		cfg.Master = "master"
	default:
		if current, detached, err := r.GetCurrentBranch(root); err == nil && !detached && current != "" {
			cfg.Master = current
		} else {
			cfg.Master = "main"
		}
	}

	cfg.DevelopExists = exists[cfg.Develop]
	cfg.MasterExists = exists[cfg.Master]
	return cfg, nil
}

// InitGitFlow escribe la configuración y crea la rama develop si falta.
//
// No hace checkout de develop al terminar, a diferencia del binario: mover
// al usuario de rama como efecto secundario de "configurar" es la clase de
// sorpresa que hace perder de vista dónde se está parado — y si tenía
// cambios sin commitear, el checkout falla y la inicialización queda a
// medias.
func (r *Runner) InitGitFlow(repoPath string, cfg GitFlowConfig) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}

	// Los defaults salen de GitFlowStatus para que el asistente proponga
	// exactamente lo mismo que la interfaz muestra — una sola definición de
	// "qué es lo razonable acá".
	defaults, err := r.GitFlowStatus(root)
	if err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Master) == "" {
		cfg.Master = defaults.Master
	}
	if strings.TrimSpace(cfg.Develop) == "" {
		cfg.Develop = defaults.Develop
	}
	if cfg.Feature == "" {
		cfg.Feature = defaults.Feature
	}
	if cfg.Release == "" {
		cfg.Release = defaults.Release
	}
	if cfg.Hotfix == "" {
		cfg.Hotfix = defaults.Hotfix
	}
	if cfg.Support == "" {
		cfg.Support = defaults.Support
	}

	for label, v := range map[string]string{"rama de producción": cfg.Master, "rama de desarrollo": cfg.Develop} {
		if err := checkRefArg(label, v); err != nil {
			return err
		}
	}
	if cfg.Master == cfg.Develop {
		return fmt.Errorf("la rama de producción y la de desarrollo no pueden ser la misma (%q)", cfg.Master)
	}
	if !r.localBranchExists(root, cfg.Master) {
		return fmt.Errorf("la rama de producción %q no existe en este repositorio", cfg.Master)
	}

	// La rama develop primero: si falla, no queda una configuración que
	// apunta a algo inexistente.
	if !r.localBranchExists(root, cfg.Develop) {
		if err := r.CreateBranch(root, cfg.Develop, cfg.Master, false); err != nil {
			return fmt.Errorf("no se pudo crear la rama %q: %w", cfg.Develop, err)
		}
	}

	for key, value := range map[string]string{
		"gitflow.branch.master":  cfg.Master,
		"gitflow.branch.develop": cfg.Develop,
		"gitflow.prefix.feature": cfg.Feature,
		"gitflow.prefix.release": cfg.Release,
		"gitflow.prefix.hotfix":  cfg.Hotfix,
		"gitflow.prefix.support": cfg.Support,
	} {
		if err := r.setOrUnset(root, "--local", key, value); err != nil {
			return err
		}
	}
	// versiontag se escribe aparte porque el vacío es un valor LEGÍTIMO y
	// setOrUnset trata el vacío como "borrá la clave" — que acá es
	// exactamente lo que corresponde: sin clave, el default es vacío.
	return r.setOrUnset(root, "--local", "gitflow.prefix.versiontag", cfg.VersionTag)
}

// GitFlowKind es el tipo de rama que se arranca.
type GitFlowKind string

const (
	FlowFeature GitFlowKind = "feature"
	FlowRelease GitFlowKind = "release"
	FlowHotfix  GitFlowKind = "hotfix"
	FlowSupport GitFlowKind = "support"
)

// StartGitFlowBranch crea la rama con el prefijo del tipo pedido, desde la
// base que le corresponde, y se cambia a ella.
//
// La base es lo único que hay que saber de git-flow y lo que más se
// equivoca a mano: feature y release salen de develop, hotfix y support
// salen de la rama de producción. Un hotfix arrancado por error desde
// develop se lleva a producción todo lo que develop tenga sin publicar, que
// es el accidente que este flujo existe para evitar.
func (r *Runner) StartGitFlowBranch(repoPath string, kind GitFlowKind, name string) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}

	cfg, err := r.GitFlowStatus(root)
	if err != nil {
		return "", err
	}
	if !cfg.Initialized {
		return "", fmt.Errorf("este repositorio todavía no tiene Git Flow inicializado")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("el nombre no puede estar vacío")
	}

	var prefix, base string
	switch kind {
	case FlowFeature:
		prefix, base = cfg.Feature, cfg.Develop
	case FlowRelease:
		prefix, base = cfg.Release, cfg.Develop
	case FlowHotfix:
		prefix, base = cfg.Hotfix, cfg.Master
	case FlowSupport:
		prefix, base = cfg.Support, cfg.Master
	default:
		return "", fmt.Errorf("tipo de rama desconocido: %q", kind)
	}

	if !r.localBranchExists(root, base) {
		return "", fmt.Errorf("falta la rama base %q: volvé a inicializar Git Flow", base)
	}

	// Si el usuario ya escribió el prefijo, no se duplica: "feature/x" y "x"
	// tienen que dar la misma rama.
	full := name
	if prefix != "" && !strings.HasPrefix(name, prefix) {
		full = prefix + name
	}
	if err := checkRefArg("rama", full); err != nil {
		return "", err
	}
	if r.localBranchExists(root, full) {
		return "", fmt.Errorf("la rama %q ya existe", full)
	}

	if err := r.CreateBranch(root, full, base, true); err != nil {
		return "", err
	}
	return full, nil
}
