// Package updatecheck compares this build's version against the latest
// published GitHub Release. Read-only over HTTP against GitHub's public
// API — never touches backend/vault or anything else in the app, by
// construction (this package doesn't even import vault). Every failure mode
// (offline, timeout, unexpected response) degrades to Info{Available:
// false}, never an error — a "new version" notice is a nice-to-have that
// must never interrupt or slow down normal offline use of the app.
package updatecheck

import (
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	// latestReleaseURL es de dónde sale la novedad.
	//
	// **Antes se leía el archivo VERSION de la rama por defecto**, porque este
	// repo no publicaba GitHub Releases: los artefactos empaquetados vivían
	// versionados dentro de releases/<so>/ y no había página de descarga a la
	// que mandar a nadie. Desde .github/workflows/release.yml sí los publica,
	// con el .dmg y el .exe adjuntos, así que preguntarle al release es a la
	// vez más correcto y más útil: da el link de descarga directo, y —lo que
	// importa más— solo avisa cuando hay algo que efectivamente se puede
	// bajar. El archivo VERSION se bumpea y se commitea ANTES de tagear, así
	// que leerlo anunciaba versiones cuyo release todavía no existía.
	latestReleaseURL = "https://api.github.com/repos/rafael180496/mini-tools/releases/latest"
	// versionFileURL es el plan B para cuando la API de releases no contesta
	// (sin releases todavía, o con el límite de peticiones anónimas agotado):
	// se sigue detectando la versión nueva, y el link lleva a la lista de
	// releases en vez de a un archivo.
	versionFileURL = "https://api.github.com/repos/rafael180496/mini-tools/contents/VERSION"
	// RepoURL is where "open repo" points.
	RepoURL = "https://github.com/rafael180496/mini-tools"
	// ReleasesURL es la lista de releases: el destino cuando se sabe que hay
	// una versión nueva pero no cuál es su archivo para este sistema.
	ReleasesURL    = RepoURL + "/releases"
	requestTimeout = 5 * time.Second
	// El JSON de un release trae las notas completas y la lista de assets. Un
	// tope generoso pero cerrado: esto no controla el servidor que contesta.
	maxBodyBytes = 512 * 1024
	// El archivo VERSION son cinco bytes.
	maxVersionBytes = 1024
)

// Info is what Check returns — Available is false on every failure mode
// (no network, timeout, unexpected response), never an error.
type Info struct {
	Available bool   `json:"available"`
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	// ReleaseURL es la página del release nuevo (o la lista de releases si no
	// se pudo determinar cuál).
	ReleaseURL string `json:"releaseUrl"`
	// DownloadURL es el archivo que le corresponde a ESTE sistema: el .dmg en
	// macOS, el .exe en Windows. Vacío cuando no se pudo determinar —en Linux,
	// que no se empaqueta, o si el release no trae el archivo esperado—, y ahí
	// el llamador manda a ReleaseURL, que siempre lleva a algún lado.
	DownloadURL string `json:"downloadUrl"`
	// AssetName es cómo se llama ese archivo, para poder decirlo antes de
	// empezar la descarga.
	AssetName string `json:"assetName"`
}

// release es lo que se usa de la respuesta de la API; el resto se ignora.
type release struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Draft   bool   `json:"draft"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// Check compares currentVersion (main.appVersion) against the latest
// published release. A plain, unauthenticated read against GitHub's public
// API — never a write, and never touches the vault in any way; a caller with
// the vault locked, unlocked, or not yet opened at all sees identical
// behavior.
func Check(currentVersion string) Info {
	info := Info{Current: currentVersion, ReleaseURL: ReleasesURL}
	if currentVersion == "" || currentVersion == "dev" {
		return info
	}

	client := &http.Client{Timeout: requestTimeout}

	if rel, ok := fetchLatestRelease(client); ok {
		latest := strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v")
		if latest != "" {
			info.Latest = latest
			info.Available = isNewer(latest, currentVersion)
			if rel.HTMLURL != "" {
				info.ReleaseURL = rel.HTMLURL
			}
			if name, url := pickAsset(rel); url != "" {
				info.AssetName, info.DownloadURL = name, url
			}
			return info
		}
	}

	// Plan B: el archivo VERSION. Avisa igual, sin link de descarga.
	if latest := fetchVersionFile(client); latest != "" {
		info.Latest = latest
		info.Available = isNewer(latest, currentVersion)
	}
	return info
}

func fetchLatestRelease(client *http.Client) (release, bool) {
	var rel release
	req, err := http.NewRequest(http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		return rel, false
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return rel, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return rel, false
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&rel); err != nil {
		return rel, false
	}
	// Un borrador no se puede descargar sin estar autenticado; anunciarlo sería
	// mandar a una página que da 404. (`/releases/latest` ya los excluye; la
	// comprobación está por si se cambia de endpoint.)
	if rel.Draft {
		return release{}, false
	}
	return rel, true
}

func fetchVersionFile(client *http.Client) string {
	req, err := http.NewRequest(http.MethodGet, versionFileURL, nil)
	if err != nil {
		return ""
	}
	// El Accept pide el contenido crudo en vez del envoltorio JSON+base64.
	req.Header.Set("Accept", "application/vnd.github.raw")

	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxVersionBytes))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(body))
}

// pickAsset elige el archivo de este sistema entre los adjuntos del release.
//
// Se elige por EXTENSIÓN y no por el nombre completo: el nombre lleva la
// versión adentro (mini-tools-v2.3.0.dmg), así que compararlo obligaría a
// reconstruirlo acá y a mantener dos lugares en sincronía con el workflow que
// los sube. La extensión, en cambio, es lo que define para qué sistema es.
//
// Linux no se empaqueta (ver .claude/specs/releases.md): ahí no hay archivo
// que ofrecer y se devuelve vacío, que manda a la página del release.
func pickAsset(rel release) (name, url string) {
	var want string
	switch runtime.GOOS {
	case "darwin":
		want = ".dmg"
	case "windows":
		want = ".exe"
	default:
		return "", ""
	}
	for _, a := range rel.Assets {
		if strings.HasSuffix(strings.ToLower(a.Name), want) && a.URL != "" {
			return a.Name, a.URL
		}
	}
	return "", ""
}

// isNewer does a plain 3-part semver comparison (X.Y.Z, the only shape
// VERSION/scripts/bump-version.sh ever produces) without pulling in
// golang.org/x/mod/semver just to compare three integers. Anything
// unparseable on either side degrades to false.
func isNewer(latest, current string) bool {
	l, okL := parseVersion(latest)
	c, okC := parseVersion(current)
	if !okL || !okC {
		return false
	}
	for i := 0; i < 3; i++ {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
