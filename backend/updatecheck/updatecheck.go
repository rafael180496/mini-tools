// Package updatecheck compares this build's version against the VERSION
// file published in the repo's default branch. Read-only over HTTP against
// GitHub's public API — never touches backend/vault or anything else in
// the app, by construction (this package doesn't even import vault). Every
// failure mode (offline, timeout, unexpected response) degrades to
// Info{Available: false}, never an error — a "new version" notice is a
// nice-to-have that must never interrupt or slow down normal offline use
// of the app.
package updatecheck

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// versionFileURL points at the VERSION file's content via GitHub's
	// Contents API — this repo does not use GitHub Releases (see
	// .claude/specs/releases.md: packaged artifacts live versioned inside
	// releases/<os>/ in the repo itself), so there is no releases/latest
	// endpoint to query. The Accept header asks for the raw file content
	// instead of the default JSON+base64 wrapper.
	versionFileURL = "https://api.github.com/repos/rafael180496/mini-tools/contents/VERSION"
	// RepoURL is where "open repo" points — there's no per-version release
	// page to link to instead, since packaged artifacts aren't published as
	// GitHub Releases here.
	RepoURL        = "https://github.com/rafael180496/mini-tools"
	requestTimeout = 5 * time.Second
	maxBodyBytes   = 1024
)

// Info is what Check returns — Available is false on every failure mode
// (no network, timeout, unexpected response), never an error.
type Info struct {
	Available  bool   `json:"available"`
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	ReleaseURL string `json:"releaseUrl"`
}

// Check compares currentVersion (main.appVersion) against the VERSION file
// published on the repo's default branch. A plain, unauthenticated read
// against GitHub's public API — never a write, and never touches the vault
// in any way; a caller with the vault locked, unlocked, or not yet opened
// at all sees identical behavior.
func Check(currentVersion string) Info {
	info := Info{Current: currentVersion, ReleaseURL: RepoURL}
	if currentVersion == "" || currentVersion == "dev" {
		return info
	}

	client := &http.Client{Timeout: requestTimeout}
	req, err := http.NewRequest(http.MethodGet, versionFileURL, nil)
	if err != nil {
		return info
	}
	req.Header.Set("Accept", "application/vnd.github.raw")

	resp, err := client.Do(req)
	if err != nil {
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return info
	}

	latest := strings.TrimSpace(string(body))
	if latest == "" {
		return info
	}
	info.Latest = latest
	info.Available = isNewer(latest, currentVersion)
	return info
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
