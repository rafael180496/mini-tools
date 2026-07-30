package git

import (
	"fmt"
	"net/url"
	"strings"
)

// Pull-request URLs.
//
// Deliberately URL construction and nothing else: no API client, no token,
// no secret to store. Opening the provider's own "create PR" page in the
// browser gets the user to the same place, works with whatever session they
// already have, and adds zero attack surface — where an API integration
// would mean a new credential per forge, stored and refreshed, for a button.

// ForgeInfo describes what can be done with a remote's host.
type ForgeInfo struct {
	// Provider is "github", "gitlab", "bitbucket" or "" when unrecognised.
	Provider string `json:"provider"`
	// WebURL is the repository's browsable page, "" when unknown.
	WebURL string `json:"webUrl"`
	// CompareURL opens the "create pull/merge request" page for a branch.
	// Empty when the provider is unknown or the branch was not supplied.
	CompareURL string `json:"compareUrl"`
}

// ForgeForRemote turns a remote URL into a browsable one, plus the compare
// link for branch against base.
//
// Handles both remote forms: the SSH shorthand (git@host:owner/repo.git),
// which is NOT a valid URL and cannot be parsed as one, and the https form.
// Self-hosted GitLab is recognised by path shape rather than by hostname —
// gitlab.example.com is far more common than gitlab.com in the kind of repo
// this app gets pointed at.
func ForgeForRemote(remoteURL, branch, base string) ForgeInfo {
	host, path := splitRemote(remoteURL)
	if host == "" || path == "" {
		return ForgeInfo{}
	}

	info := ForgeInfo{WebURL: "https://" + host + "/" + path}

	switch {
	case strings.Contains(host, "github"):
		info.Provider = "github"
		if branch != "" {
			// expand=1 opens the form already filled in rather than a plain
			// diff page — one click less, and it is what the "Compare &
			// pull request" button on GitHub itself links to.
			info.CompareURL = fmt.Sprintf("%s/compare/%s...%s?expand=1",
				info.WebURL, url.PathEscape(orDefault(base, "main")), url.PathEscape(branch))
		}
	case strings.Contains(host, "bitbucket"):
		info.Provider = "bitbucket"
		if branch != "" {
			info.CompareURL = fmt.Sprintf("%s/pull-requests/new?source=%s&dest=%s",
				info.WebURL, url.QueryEscape(branch), url.QueryEscape(orDefault(base, "main")))
		}
	default:
		// GitLab, including self-hosted. Its merge-request URL shape is
		// distinctive enough that assuming it for an unknown host is a
		// better bet than giving up — a wrong guess lands on a 404 the user
		// can read, while no button at all leaves them copying the branch
		// name by hand.
		info.Provider = "gitlab"
		if branch != "" {
			info.CompareURL = fmt.Sprintf(
				"%s/-/merge_requests/new?merge_request[source_branch]=%s&merge_request[target_branch]=%s",
				info.WebURL, url.QueryEscape(branch), url.QueryEscape(orDefault(base, "main")))
		}
	}

	return info
}

// splitRemote returns the host and the owner/repo path of a remote URL,
// normalising away the .git suffix and any embedded credentials.
func splitRemote(remote string) (string, string) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", ""
	}

	// SSH shorthand: git@host:owner/repo.git — not a URL, so url.Parse
	// would silently read the whole thing as a path.
	if !strings.Contains(remote, "://") && strings.Contains(remote, ":") && strings.Contains(remote, "@") {
		at := strings.LastIndex(remote, "@")
		rest := remote[at+1:]
		host, path, ok := strings.Cut(rest, ":")
		if !ok {
			return "", ""
		}
		return host, strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	}

	u, err := url.Parse(remote)
	if err != nil || u.Host == "" {
		return "", ""
	}
	// u.Hostname() drops the port and, importantly, any user:password the
	// remote might carry — that must never end up in a URL handed to a
	// browser.
	return u.Hostname(), strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git")
}

func orDefault(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
