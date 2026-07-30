package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Namespace analysis: what is actually in this keyspace, grouped by the
// prefix convention almost every Redis deployment uses (session:user:42,
// cache:product:9, cart:…).
//
// A flat list of a million keys answers nothing. The tree answers the
// question people actually have — "what is eating the memory / the key
// count" — and it is built from a SCAN sample, never from KEYS *.

// RedisPrefixNode is one namespace level.
type RedisPrefixNode struct {
	// Prefix is the full path including the trailing separator
	// ("session:user:"), which is what a SCAN match pattern is built from.
	Prefix string `json:"prefix"`
	// Segment is just this level's name, for display.
	Segment string `json:"segment"`
	// Keys is how many SAMPLED keys fall under this prefix.
	Keys int64 `json:"keys"`
	// Bytes is the summed MEMORY USAGE of the sampled keys under this
	// prefix, 0 when memory sampling was off or unavailable.
	Bytes    int64              `json:"bytes,omitempty"`
	Children []*RedisPrefixNode `json:"children,omitempty"`
}

// RedisPrefixReport is the whole analysis, plus what it is an analysis OF —
// the sample size and the real total — because a tree built from 10.000 of
// 4.000.000 keys is an estimate and must never be presented as a census.
type RedisPrefixReport struct {
	Roots []*RedisPrefixNode `json:"roots"`
	// Sampled is how many keys were actually scanned.
	Sampled int64 `json:"sampled"`
	// TotalKeys is DBSIZE — the real number, for comparison.
	TotalKeys int64 `json:"totalKeys"`
	// Truncated reports that the scan stopped at the sample limit rather
	// than reaching the end of the keyspace.
	Truncated bool `json:"truncated,omitempty"`
	// MemorySampled reports whether Bytes means anything.
	MemorySampled bool `json:"memorySampled,omitempty"`
	Separator     string `json:"separator"`
}

const (
	redisPrefixDefaultSample = 10_000
	redisPrefixScanBatch     = 500
	// Depth cap: deeper than this the "namespace" is usually the key's own
	// identity (session:user:42:token:abc), and rendering a node per key
	// turns the tree back into the flat list it exists to replace.
	redisPrefixMaxDepth = 4
	// Memory sampling costs one MEMORY USAGE round trip per key, so it is
	// capped well below the key sample. Bytes is an estimate either way.
	redisPrefixMemoryLimit = 2_000
)

// AnalyzeRedisPrefixes walks a bounded SCAN sample and groups the keys into
// a namespace tree.
//
// Bounded on purpose: this runs against production instances, and the whole
// reason SCAN exists is that a full keyspace walk blocks Redis. Stopping at
// sampleLimit and SAYING SO is the honest version of the feature; walking
// four million keys to be exact is the version that takes the instance down.
func AnalyzeRedisPrefixes(
	ctx context.Context,
	client redis.UniversalClient,
	separator string,
	sampleLimit int64,
	withMemory bool,
) (RedisPrefixReport, error) {
	if separator == "" {
		separator = ":"
	}
	if sampleLimit <= 0 {
		sampleLimit = redisPrefixDefaultSample
	}

	report := RedisPrefixReport{Separator: separator}

	if total, err := client.DBSize(ctx).Result(); err == nil {
		report.TotalKeys = total
	}

	root := &RedisPrefixNode{}
	cursor := ""
	memoryBudget := int64(0)
	if withMemory {
		memoryBudget = redisPrefixMemoryLimit
	}

	// truncated tracks WHY the walk ended: hitting the sample limit (an
	// estimate) versus reaching the end of the keyspace (a census). Reading
	// it off the cursor is wrong and was a real bug here — SCAN can return
	// the whole keyspace in one batch with a closed cursor while the limit
	// still cut the sample short inside that batch, which reported a
	// 100-of-480 sample as complete.
	truncated := false

	for {
		if report.Sampled >= sampleLimit {
			truncated = true
			break
		}

		page, err := ScanKeys(ctx, client, cursor, "*", "", redisPrefixScanBatch)
		if err != nil {
			return RedisPrefixReport{}, fmt.Errorf("db: escaneando prefijos: %w", err)
		}

		for _, entry := range page.Keys {
			if report.Sampled >= sampleLimit {
				truncated = true
				break
			}
			report.Sampled++

			var bytes int64
			if memoryBudget > 0 {
				if n, err := client.MemoryUsage(ctx, entry.Key).Result(); err == nil {
					bytes = n
					report.MemorySampled = true
				}
				memoryBudget--
			}

			insertPrefixPath(root, entry.Key, separator, bytes)
		}

		cursor = page.Cursor
		if cursor == "" {
			break
		}
	}

	report.Truncated = truncated
	report.Roots = sortedChildren(root)
	return report, nil
}

// insertPrefixPath accumulates one key's counts along its namespace path.
// Every ancestor level is credited, so a parent's total is the sum of what
// is under it without a second pass.
func insertPrefixPath(root *RedisPrefixNode, key, separator string, bytes int64) {
	segments := strings.Split(key, separator)
	// A key with no separator has no namespace; it is grouped under a
	// single node named after itself only at depth 1, which keeps
	// unstructured keyspaces from producing an empty tree.
	if len(segments) > redisPrefixMaxDepth {
		segments = segments[:redisPrefixMaxDepth]
	}

	node := root
	prefix := ""
	for _, seg := range segments {
		prefix += seg + separator
		child := findChild(node, seg)
		if child == nil {
			child = &RedisPrefixNode{Prefix: prefix, Segment: seg}
			node.Children = append(node.Children, child)
		}
		child.Keys++
		child.Bytes += bytes
		node = child
	}
}

func findChild(parent *RedisPrefixNode, segment string) *RedisPrefixNode {
	for _, c := range parent.Children {
		if c.Segment == segment {
			return c
		}
	}
	return nil
}

// sortedChildren orders every level by key count, biggest first — the
// question being asked is "what is taking up the space", so the answer
// belongs at the top rather than in alphabetical order.
func sortedChildren(node *RedisPrefixNode) []*RedisPrefixNode {
	sort.Slice(node.Children, func(i, j int) bool {
		if node.Children[i].Keys != node.Children[j].Keys {
			return node.Children[i].Keys > node.Children[j].Keys
		}
		return node.Children[i].Segment < node.Children[j].Segment
	})
	for _, c := range node.Children {
		c.Children = sortedChildren(c)
	}
	return node.Children
}

// DeleteRedisKeys removes several keys in one call.
//
// Chunked rather than one giant DEL: a single command with tens of
// thousands of arguments blocks Redis for as long as it takes to free them
// all, which is exactly the stall this app avoids everywhere else. Errors
// stop the loop and report how many were already deleted, because "it
// failed" without saying what already happened is unusable when the
// operation is destructive.
func DeleteRedisKeys(ctx context.Context, client redis.UniversalClient, keys []string) (int64, error) {
	const chunk = 200
	var deleted int64

	for i := 0; i < len(keys); i += chunk {
		end := i + chunk
		if end > len(keys) {
			end = len(keys)
		}

		batch := keys[i:end]
		// On a cluster, one DEL cannot span slots — the keys of a batch may
		// live on different shards. Deleting one at a time there is slower
		// but is the only thing that works, and correctness wins.
		if _, isCluster := client.(*redis.ClusterClient); isCluster {
			for _, k := range batch {
				n, err := client.Del(ctx, k).Result()
				if err != nil {
					return deleted, fmt.Errorf("db: borrando %q (ya se borraron %d): %w", k, deleted, err)
				}
				deleted += n
			}
			continue
		}

		n, err := client.Del(ctx, batch...).Result()
		if err != nil {
			return deleted, fmt.Errorf("db: borrando un lote de claves (ya se borraron %d): %w", deleted, err)
		}
		deleted += n
	}

	return deleted, nil
}
