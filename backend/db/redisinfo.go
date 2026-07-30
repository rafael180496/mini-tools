package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Health metrics from INFO — the numbers people open redis-cli for.
//
// INFO returns a text blob of "section:key:value" lines, not a structured
// RESP type, so this is a line scan. Same "best-effort parsing of a tool's
// own output" precedent already used for used_memory above and for SQLite's
// EXPLAIN QUERY PLAN text.
//
// Every field is best-effort: a missing key leaves a zero rather than
// failing the whole fetch. Redis versions differ in what they report, and a
// dashboard that refuses to render because one counter is absent is worse
// than one showing the rest.

// RedisServerInfo is the health snapshot the metrics panel renders.
type RedisServerInfo struct {
	Version string `json:"version"`
	Mode    string `json:"mode"`
	Role    string `json:"role"`
	// UptimeSeconds is how long the server has been up — context for the
	// counters below, which are all cumulative since start.
	UptimeSeconds int64 `json:"uptimeSeconds"`

	UsedMemoryBytes int64 `json:"usedMemoryBytes"`
	PeakMemoryBytes int64 `json:"peakMemoryBytes"`
	// MaxMemoryBytes is 0 when no limit is configured, which is Redis's
	// default and NOT the same as "no memory available" — the UI says
	// "sin límite" rather than drawing a 0-capacity bar.
	MaxMemoryBytes int64  `json:"maxMemoryBytes"`
	MaxMemoryPolicy string `json:"maxMemoryPolicy,omitempty"`
	// FragmentationRatio is used_memory_rss / used_memory. Meaningfully
	// above 1 means the allocator is holding memory the dataset no longer
	// uses; below 1 means part of the dataset is swapped out, which is far
	// worse and is why the raw number is shown rather than a verdict.
	FragmentationRatio float64 `json:"fragmentationRatio,omitempty"`

	ConnectedClients int64 `json:"connectedClients"`
	BlockedClients   int64 `json:"blockedClients"`
	MaxClients       int64 `json:"maxClients,omitempty"`

	KeyspaceHits   int64 `json:"keyspaceHits"`
	KeyspaceMisses int64 `json:"keyspaceMisses"`
	// HitRatePct is hits / (hits + misses) * 100, cumulative since the
	// server started — NOT a current rate. Labeled as such in the UI,
	// because a cache that was cold for a week reads badly here long after
	// it warmed up.
	HitRatePct float64 `json:"hitRatePct"`

	OpsPerSecond           int64 `json:"opsPerSecond"`
	TotalCommandsProcessed int64 `json:"totalCommandsProcessed"`
	TotalConnections       int64 `json:"totalConnections"`
	ExpiredKeys            int64 `json:"expiredKeys"`
	EvictedKeys            int64 `json:"evictedKeys"`
	// RejectedConnections is a direct symptom of hitting maxclients.
	RejectedConnections int64 `json:"rejectedConnections"`

	UsedCPUSys  float64 `json:"usedCpuSys,omitempty"`
	UsedCPUUser float64 `json:"usedCpuUser,omitempty"`

	// Nodes is how many masters the numbers were summed across. 1 for
	// standalone/Sentinel; on a cluster the counters are per-shard and
	// summing them is the only whole-cluster view there is.
	Nodes int `json:"nodes"`
}

// GetRedisServerInfo reads INFO and builds the health snapshot.
//
// INFO is keyless, so on a *redis.ClusterClient it would otherwise reflect
// whichever single shard go-redis happened to pick — the same routing
// problem ScanKeys and GetRedisStats already special-case. Counters are
// summed across masters; the descriptive fields (version, role) are taken
// from whichever master answered first, since they are properties of the
// deployment rather than quantities to add up.
func GetRedisServerInfo(ctx context.Context, client redis.UniversalClient) (RedisServerInfo, error) {
	if cc, ok := client.(*redis.ClusterClient); ok {
		return clusterServerInfo(ctx, cc)
	}

	raw, err := client.Info(ctx).Result()
	if err != nil {
		return RedisServerInfo{}, fmt.Errorf("db: INFO de Redis: %w", err)
	}
	info := parseRedisInfo(raw)
	info.Nodes = 1
	return info, nil
}

// Not verified against a real multi-shard Cluster in this dev environment —
// same honesty precedent already applied to ScanKeys and GetRedisStats.
func clusterServerInfo(ctx context.Context, cc *redis.ClusterClient) (RedisServerInfo, error) {
	var total RedisServerInfo

	err := cc.ForEachMaster(ctx, func(ctx context.Context, shard *redis.Client) error {
		raw, err := shard.Info(ctx).Result()
		if err != nil {
			return err
		}
		one := parseRedisInfo(raw)

		if total.Nodes == 0 {
			total.Version = one.Version
			total.Mode = one.Mode
			total.Role = one.Role
			total.MaxMemoryPolicy = one.MaxMemoryPolicy
			// Uptime is the deployment's, not a sum: the shortest uptime is
			// the most useful one (a shard that restarted five minutes ago
			// is the fact worth surfacing).
			total.UptimeSeconds = one.UptimeSeconds
		} else if one.UptimeSeconds < total.UptimeSeconds {
			total.UptimeSeconds = one.UptimeSeconds
		}
		total.Nodes++

		total.UsedMemoryBytes += one.UsedMemoryBytes
		total.PeakMemoryBytes += one.PeakMemoryBytes
		total.MaxMemoryBytes += one.MaxMemoryBytes
		total.ConnectedClients += one.ConnectedClients
		total.BlockedClients += one.BlockedClients
		total.MaxClients += one.MaxClients
		total.KeyspaceHits += one.KeyspaceHits
		total.KeyspaceMisses += one.KeyspaceMisses
		total.OpsPerSecond += one.OpsPerSecond
		total.TotalCommandsProcessed += one.TotalCommandsProcessed
		total.TotalConnections += one.TotalConnections
		total.ExpiredKeys += one.ExpiredKeys
		total.EvictedKeys += one.EvictedKeys
		total.RejectedConnections += one.RejectedConnections
		total.UsedCPUSys += one.UsedCPUSys
		total.UsedCPUUser += one.UsedCPUUser
		return nil
	})
	if err != nil {
		return RedisServerInfo{}, fmt.Errorf("db: INFO de Redis (cluster): %w", err)
	}

	total.HitRatePct = hitRate(total.KeyspaceHits, total.KeyspaceMisses)
	return total, nil
}

func parseRedisInfo(raw string) RedisServerInfo {
	fields := map[string]string{}
	// INFO uses \r\n, but be tolerant: some proxies normalise line endings,
	// and a dashboard that silently shows zeros because of a line ending is
	// a bad way to find out.
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields[key] = value
	}

	info := RedisServerInfo{
		Version:                fields["redis_version"],
		Mode:                   fields["redis_mode"],
		Role:                   fields["role"],
		MaxMemoryPolicy:        fields["maxmemory_policy"],
		UptimeSeconds:          asInt(fields["uptime_in_seconds"]),
		UsedMemoryBytes:        asInt(fields["used_memory"]),
		PeakMemoryBytes:        asInt(fields["used_memory_peak"]),
		MaxMemoryBytes:         asInt(fields["maxmemory"]),
		FragmentationRatio:     asFloat(fields["mem_fragmentation_ratio"]),
		ConnectedClients:       asInt(fields["connected_clients"]),
		BlockedClients:         asInt(fields["blocked_clients"]),
		MaxClients:             asInt(fields["maxclients"]),
		KeyspaceHits:           asInt(fields["keyspace_hits"]),
		KeyspaceMisses:         asInt(fields["keyspace_misses"]),
		OpsPerSecond:           asInt(fields["instantaneous_ops_per_sec"]),
		TotalCommandsProcessed: asInt(fields["total_commands_processed"]),
		TotalConnections:       asInt(fields["total_connections_received"]),
		ExpiredKeys:            asInt(fields["expired_keys"]),
		EvictedKeys:            asInt(fields["evicted_keys"]),
		RejectedConnections:    asInt(fields["rejected_connections"]),
		UsedCPUSys:             asFloat(fields["used_cpu_sys"]),
		UsedCPUUser:            asFloat(fields["used_cpu_user"]),
	}
	info.HitRatePct = hitRate(info.KeyspaceHits, info.KeyspaceMisses)
	return info
}

// hitRate is 0 when nothing has been looked up yet — reporting 100% for a
// server that has served zero reads would be a flattering lie.
func hitRate(hits, misses int64) float64 {
	total := hits + misses
	if total == 0 {
		return 0
	}
	return float64(hits) / float64(total) * 100
}

func asInt(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

func asFloat(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}
