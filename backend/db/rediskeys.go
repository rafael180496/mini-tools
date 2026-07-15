package db

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultRedisPageSize = 100

// RedisKeyEntry is one key found by ScanKeys, along with its type — fetched
// via TYPE in the same round-trip so the frontend key tree can pick an icon
// without a second call per key.
type RedisKeyEntry struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

// RedisScanPage is one page of ScanKeys. Cursor is opaque — the frontend
// only ever passes it back verbatim to ask for the next page; "" as input
// means start from the beginning, and a returned Cursor of "" means there
// are no more pages.
type RedisScanPage struct {
	Keys   []RedisKeyEntry `json:"keys"`
	Cursor string          `json:"cursor,omitempty"`
}

// RedisStats is the sidebar header's summary — TotalKeys is scoped to the
// connection's own logical database (DBSIZE), but UsedMemoryBytes is NOT:
// on standalone/Sentinel, Redis tracks memory as a single pool for the
// whole server, not per logical database, so this number is the same
// regardless of which of the 16 databases the connection selected; on
// Cluster it's the sum of every master shard's own pool instead (see
// getClusterRedisStats). Either way it's server/cluster-wide, never
// per-database — the frontend labels it accordingly.
type RedisStats struct {
	TotalKeys       int64 `json:"totalKeys"`
	UsedMemoryBytes int64 `json:"usedMemoryBytes"`
}

// GetRedisStats fetches the header summary — DBSIZE (cheap, O(1)) plus
// used_memory parsed out of INFO memory's text reply. Both DBSIZE and INFO
// have no key to route by, so on a *redis.ClusterClient they'd otherwise
// only reflect whichever single shard go-redis happens to pick (same
// keyless-command routing problem ScanKeys already special-cases below) —
// getClusterRedisStats sums both across every master shard instead.
func GetRedisStats(ctx context.Context, client redis.UniversalClient) (RedisStats, error) {
	if cc, ok := client.(*redis.ClusterClient); ok {
		return getClusterRedisStats(ctx, cc)
	}
	return getSingleNodeRedisStats(ctx, client)
}

func getSingleNodeRedisStats(ctx context.Context, client redis.Cmdable) (RedisStats, error) {
	total, err := client.DBSize(ctx).Result()
	if err != nil {
		return RedisStats{}, fmt.Errorf("db: DBSIZE de Redis: %w", err)
	}
	usedMemory, err := usedMemoryOf(ctx, client)
	if err != nil {
		return RedisStats{}, err
	}
	return RedisStats{TotalKeys: total, UsedMemoryBytes: usedMemory}, nil
}

// getClusterRedisStats sums DBSIZE (real per-shard keyspace) and
// used_memory (each shard's own memory pool — a cluster has no single
// server-wide pool the way standalone/Sentinel does) across every master.
// Not verified against a real multi-shard Cluster in this dev environment
// — same honesty precedent already applied to ScanKeys above.
func getClusterRedisStats(ctx context.Context, cc *redis.ClusterClient) (RedisStats, error) {
	var total, usedMemory int64
	err := cc.ForEachMaster(ctx, func(ctx context.Context, shard *redis.Client) error {
		n, err := shard.DBSize(ctx).Result()
		if err != nil {
			return err
		}
		m, err := usedMemoryOf(ctx, shard)
		if err != nil {
			return err
		}
		total += n
		usedMemory += m
		return nil
	})
	if err != nil {
		return RedisStats{}, fmt.Errorf("db: stats de Redis (cluster): %w", err)
	}
	return RedisStats{TotalKeys: total, UsedMemoryBytes: usedMemory}, nil
}

// usedMemoryOf parses used_memory out of INFO memory's text reply — a
// "key:value\r\n"-per-line text blob (not a structured RESP type), so this
// is a plain line scan for the one key we care about — same "best-effort
// text parsing of a tool's own output format" precedent already used for
// SQLite's EXPLAIN QUERY PLAN text (see the explain package).
func usedMemoryOf(ctx context.Context, client redis.Cmdable) (int64, error) {
	info, err := client.Info(ctx, "memory").Result()
	if err != nil {
		return 0, fmt.Errorf("db: INFO memory de Redis: %w", err)
	}
	for _, line := range strings.Split(info, "\r\n") {
		if v, ok := strings.CutPrefix(line, "used_memory:"); ok {
			n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return n, nil
		}
	}
	return 0, nil
}

// ScanKeys lists keys matching match (a SCAN MATCH glob, "*" for all) in
// pages of roughly count keys — never via KEYS *, which blocks the server
// while it walks the entire keyspace (see .claude/rules/technical.md's
// performance expectations and .claude/skills/mini-tools-patterns/SKILL.md's
// Redis section).
//
// Bare keyspace SCAN is the one command that isn't uniform across
// topologies via redis.UniversalClient: a *redis.ClusterClient has no key
// to route it by, so calling Scan directly on it only scans whichever
// single node the client happens to pick — not the whole keyspace. This
// special-cases *redis.ClusterClient (fan out to every master shard,
// encoding "which shard + that shard's own cursor" into the opaque cursor)
// and falls back to a plain single-cursor scan for everything else
// (standalone, and Sentinel's FailoverClient — which wraps the same
// concrete *redis.Client type as standalone). Not verified against a real
// multi-shard Cluster in this dev environment — see the SKILL for the same
// honesty precedent already applied to Oracle/PL-SQL in this codebase.
// keyType, when non-empty, restricts the scan server-side to that Redis
// type (Redis's own SCAN ... TYPE t option, via ScanType below) instead of
// fetching everything and discarding non-matches — and since the type is
// then known up front for every returned key, entriesWithType's per-key
// TYPE round-trip is skipped entirely for this page.
func ScanKeys(ctx context.Context, client redis.UniversalClient, cursor, match, keyType string, count int64) (RedisScanPage, error) {
	if match == "" {
		match = "*"
	}
	if count <= 0 {
		count = defaultRedisPageSize
	}

	if cc, ok := client.(*redis.ClusterClient); ok {
		return scanClusterKeys(ctx, cc, cursor, match, keyType, count)
	}
	return scanSingleNodeKeys(ctx, client, cursor, match, keyType, count)
}

func scanSingleNodeKeys(ctx context.Context, client redis.Cmdable, cursor, match, keyType string, count int64) (RedisScanPage, error) {
	cur, err := parseCursorUint(cursor)
	if err != nil {
		return RedisScanPage{}, err
	}

	var keys []string
	var next uint64
	if keyType != "" {
		keys, next, err = client.ScanType(ctx, cur, match, count, keyType).Result()
	} else {
		keys, next, err = client.Scan(ctx, cur, match, count).Result()
	}
	if err != nil {
		return RedisScanPage{}, fmt.Errorf("db: SCAN de Redis: %w", err)
	}

	entries, err := entriesWithType(ctx, client, keys, keyType)
	if err != nil {
		return RedisScanPage{}, err
	}

	out := RedisScanPage{Keys: entries}
	if next != 0 {
		out.Cursor = strconv.FormatUint(next, 10)
	}
	return out, nil
}

// scanClusterKeys paginates one shard at a time — a call returns as soon as
// a shard yields keys or its own SCAN cursor wraps to 0, advancing to the
// next shard on the following call instead of walking every shard in one
// round-trip, keeping each request bounded like every other paginated call
// in this file.
func scanClusterKeys(ctx context.Context, cc *redis.ClusterClient, cursor, match, keyType string, count int64) (RedisScanPage, error) {
	shardsByAddr := map[string]*redis.Client{}
	err := cc.ForEachMaster(ctx, func(ctx context.Context, shard *redis.Client) error {
		shardsByAddr[shard.Options().Addr] = shard
		return nil
	})
	if err != nil {
		return RedisScanPage{}, fmt.Errorf("db: listando shards del cluster: %w", err)
	}
	if len(shardsByAddr) == 0 {
		return RedisScanPage{}, nil
	}
	addrs := make([]string, 0, len(shardsByAddr))
	for addr := range shardsByAddr {
		addrs = append(addrs, addr)
	}
	sort.Strings(addrs)

	shardIdx, shardCursor, err := parseClusterCursor(cursor)
	if err != nil {
		return RedisScanPage{}, err
	}

	for shardIdx < len(addrs) {
		shard := shardsByAddr[addrs[shardIdx]]
		var keys []string
		var next uint64
		if keyType != "" {
			keys, next, err = shard.ScanType(ctx, shardCursor, match, count, keyType).Result()
		} else {
			keys, next, err = shard.Scan(ctx, shardCursor, match, count).Result()
		}
		if err != nil {
			return RedisScanPage{}, fmt.Errorf("db: SCAN de Redis (shard %s): %w", addrs[shardIdx], err)
		}

		entries, err := entriesWithType(ctx, shard, keys, keyType)
		if err != nil {
			return RedisScanPage{}, err
		}

		if next != 0 {
			return RedisScanPage{Keys: entries, Cursor: encodeClusterCursor(shardIdx, next)}, nil
		}
		if len(entries) > 0 {
			return RedisScanPage{Keys: entries, Cursor: encodeClusterCursor(shardIdx+1, 0)}, nil
		}
		shardIdx++
		shardCursor = 0
	}

	return RedisScanPage{}, nil
}

// entriesWithType fills in each key's type — via a per-key TYPE call, or
// for free when knownType is set (the caller already scanned with that
// exact type filter, see ScanKeys/ScanType above).
func entriesWithType(ctx context.Context, client redis.Cmdable, keys []string, knownType string) ([]RedisKeyEntry, error) {
	entries := make([]RedisKeyEntry, 0, len(keys))
	for _, k := range keys {
		if knownType != "" {
			entries = append(entries, RedisKeyEntry{Key: k, Type: knownType})
			continue
		}
		typ, err := client.Type(ctx, k).Result()
		if err != nil {
			return nil, fmt.Errorf("db: TYPE de %q: %w", k, err)
		}
		entries = append(entries, RedisKeyEntry{Key: k, Type: typ})
	}
	return entries, nil
}

// RedisKeyInfo is a key's type + TTL, fetched before rendering its value.
type RedisKeyInfo struct {
	Key        string `json:"key"`
	Type       string `json:"type"`
	TTLSeconds int64  `json:"ttlSeconds"`
	// SizeBytes is MEMORY USAGE's estimate, best-effort: 0 (not an error)
	// on any failure — Redis < 4.0 doesn't have the command, and it can
	// also be disabled server-side. A stats nice-to-have shouldn't break
	// the core type/TTL fetch this function otherwise guarantees.
	SizeBytes int64 `json:"sizeBytes,omitempty"`
}

// GetRedisKeyInfo fetches key's type and TTL. TTLSeconds surfaces Redis's
// own -1 (no expiry) / -2 (key doesn't exist, e.g. it expired between the
// tree listing it and the user opening it) sentinels verbatim — never
// collapsed to 0.
func GetRedisKeyInfo(ctx context.Context, client redis.UniversalClient, key string) (RedisKeyInfo, error) {
	typ, err := client.Type(ctx, key).Result()
	if err != nil {
		return RedisKeyInfo{}, fmt.Errorf("db: TYPE de %q: %w", key, err)
	}

	ttl, err := client.TTL(ctx, key).Result()
	if err != nil {
		return RedisKeyInfo{}, fmt.Errorf("db: TTL de %q: %w", key, err)
	}

	var ttlSeconds int64
	switch ttl {
	// go-redis's DurationCmd keeps Redis's -2/-1 TTL sentinels (key
	// doesn't exist / no expiry) as literal -2ns/-1ns, NOT multiplied by
	// time.Second like a real duration would be — dividing by
	// time.Second below would silently collapse both to 0. Verified by
	// reading command.go's DurationCmd.readReply upstream, not assumed.
	case -1 * time.Nanosecond:
		ttlSeconds = -1
	case -2 * time.Nanosecond:
		ttlSeconds = -2
	default:
		ttlSeconds = int64(ttl / time.Second)
	}

	sizeBytes, err := client.MemoryUsage(ctx, key).Result()
	if err != nil {
		sizeBytes = 0
	}

	return RedisKeyInfo{Key: key, Type: typ, TTLSeconds: ttlSeconds, SizeBytes: sizeBytes}, nil
}

// RedisValue is a paginated view of one key's value, shaped by its type —
// only the field matching Type is populated. Never fetches a whole
// list/set/hash/zset/stream in one shot regardless of how small it looks;
// always windowed via cursor/offset.
type RedisValue struct {
	Type          string              `json:"type"`
	StringVal     string              `json:"stringVal,omitempty"`
	HashPairs     []RedisFieldValue   `json:"hashPairs,omitempty"`
	ListItems     []string            `json:"listItems,omitempty"`
	SetMembers    []string            `json:"setMembers,omitempty"`
	ZsetItems     []RedisScoredMember `json:"zsetItems,omitempty"`
	StreamEntries []RedisStreamEntry  `json:"streamEntries,omitempty"`
	// Cursor is opaque, same convention as RedisScanPage.Cursor — "" means
	// no further pages.
	Cursor string `json:"cursor,omitempty"`
}

type RedisFieldValue struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

type RedisScoredMember struct {
	Member string  `json:"member"`
	Score  float64 `json:"score"`
}

type RedisStreamEntry struct {
	ID     string            `json:"id"`
	Fields map[string]string `json:"fields"`
}

// GetRedisValue fetches one page of key's value according to typ (as
// returned by GetRedisKeyInfo — callers always fetch type/TTL first).
// Pagination differs by type since Redis has no single uniform primitive
// for it: hash/set use HSCAN/SSCAN's own cursor (same opaque-string
// convention as ScanKeys); zset/list use an offset window (offset is the
// window's start index, advanced by count each page); stream uses XRANGE
// with an exclusive start from the last seen entry ID.
func GetRedisValue(ctx context.Context, client redis.UniversalClient, key, typ, cursor string, offset, count int64) (RedisValue, error) {
	if count <= 0 {
		count = defaultRedisPageSize
	}

	switch typ {
	case "string":
		v, err := client.Get(ctx, key).Result()
		if err != nil && err != redis.Nil {
			return RedisValue{}, fmt.Errorf("db: GET de %q: %w", key, err)
		}
		return RedisValue{Type: typ, StringVal: v}, nil

	case "hash":
		return scanHashValue(ctx, client, key, cursor, count)

	case "set":
		return scanSetValue(ctx, client, key, cursor, count)

	case "zset":
		return rangeZsetValue(ctx, client, key, offset, count)

	case "list":
		return rangeListValue(ctx, client, key, offset, count)

	case "stream":
		return rangeStreamValue(ctx, client, key, cursor, count)

	case "ReJSON-RL":
		// RedisJSON key — unlike the other cases, this isn't a user-typed
		// command's arbitrary syntax to parse, it's a fixed call we
		// control entirely, so the typed JSONGet builder (go-redis
		// already ships one) is used directly instead of client.Do. The
		// whole document comes back as one JSON string in StringVal — the
		// frontend pretty-prints it (see lib/prettyPrintJSON.ts), same
		// field a plain Redis "string" value already uses.
		v, err := client.JSONGet(ctx, key).Result()
		if err != nil {
			return RedisValue{}, fmt.Errorf("db: JSON.GET de %q: %w", key, err)
		}
		return RedisValue{Type: typ, StringVal: v}, nil

	default:
		return RedisValue{}, fmt.Errorf("db: tipo de valor Redis no soportado para inspección: %q", typ)
	}
}

func scanHashValue(ctx context.Context, client redis.UniversalClient, key, cursor string, count int64) (RedisValue, error) {
	cur, err := parseCursorUint(cursor)
	if err != nil {
		return RedisValue{}, err
	}
	// HSCAN's reply is a flat field,value,field,value,... slice, same
	// ScanCmd type SCAN/SSCAN use.
	flat, next, err := client.HScan(ctx, key, cur, "", count).Result()
	if err != nil {
		return RedisValue{}, fmt.Errorf("db: HSCAN de %q: %w", key, err)
	}
	pairs := make([]RedisFieldValue, 0, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		pairs = append(pairs, RedisFieldValue{Field: flat[i], Value: flat[i+1]})
	}
	out := RedisValue{Type: "hash", HashPairs: pairs}
	if next != 0 {
		out.Cursor = strconv.FormatUint(next, 10)
	}
	return out, nil
}

func scanSetValue(ctx context.Context, client redis.UniversalClient, key, cursor string, count int64) (RedisValue, error) {
	cur, err := parseCursorUint(cursor)
	if err != nil {
		return RedisValue{}, err
	}
	members, next, err := client.SScan(ctx, key, cur, "", count).Result()
	if err != nil {
		return RedisValue{}, fmt.Errorf("db: SSCAN de %q: %w", key, err)
	}
	out := RedisValue{Type: "set", SetMembers: members}
	if next != 0 {
		out.Cursor = strconv.FormatUint(next, 10)
	}
	return out, nil
}

func rangeZsetValue(ctx context.Context, client redis.UniversalClient, key string, offset, count int64) (RedisValue, error) {
	stop := offset + count - 1
	items, err := client.ZRangeWithScores(ctx, key, offset, stop).Result()
	if err != nil {
		return RedisValue{}, fmt.Errorf("db: ZRANGE de %q: %w", key, err)
	}
	members := make([]RedisScoredMember, len(items))
	for i, z := range items {
		member, _ := z.Member.(string)
		members[i] = RedisScoredMember{Member: member, Score: z.Score}
	}
	out := RedisValue{Type: "zset", ZsetItems: members}
	if int64(len(members)) == count {
		out.Cursor = strconv.FormatInt(offset+count, 10)
	}
	return out, nil
}

func rangeListValue(ctx context.Context, client redis.UniversalClient, key string, offset, count int64) (RedisValue, error) {
	stop := offset + count - 1
	items, err := client.LRange(ctx, key, offset, stop).Result()
	if err != nil {
		return RedisValue{}, fmt.Errorf("db: LRANGE de %q: %w", key, err)
	}
	out := RedisValue{Type: "list", ListItems: items}
	if int64(len(items)) == count {
		out.Cursor = strconv.FormatInt(offset+count, 10)
	}
	return out, nil
}

func rangeStreamValue(ctx context.Context, client redis.UniversalClient, key, cursor string, count int64) (RedisValue, error) {
	start := "-"
	if cursor != "" {
		// "(" makes the range exclusive of the last seen ID — see XRANGE's
		// own syntax for excluding the start boundary.
		start = "(" + cursor
	}

	msgs, err := client.XRangeN(ctx, key, start, "+", count).Result()
	if err != nil {
		return RedisValue{}, fmt.Errorf("db: XRANGE de %q: %w", key, err)
	}

	entries := make([]RedisStreamEntry, len(msgs))
	var lastID string
	for i, m := range msgs {
		fields := make(map[string]string, len(m.Values))
		for k, v := range m.Values {
			fields[k] = fmt.Sprintf("%v", v)
		}
		entries[i] = RedisStreamEntry{ID: m.ID, Fields: fields}
		lastID = m.ID
	}

	out := RedisValue{Type: "stream", StreamEntries: entries}
	if int64(len(entries)) == count {
		out.Cursor = lastID
	}
	return out, nil
}

// DeleteRedisKey deletes key — an explicit, single action (the frontend
// confirms first via ConfirmDialog, never inline/silent), matching the
// project's existing "explicit action over silent mutation" philosophy for
// row data (see .claude/skills/mini-tools-patterns/SKILL.md).
func DeleteRedisKey(ctx context.Context, client redis.UniversalClient, key string) error {
	if err := client.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("db: DEL de %q: %w", key, err)
	}
	return nil
}

// --- Escritura (Redis Browser: edición inline por tipo) ---

// SetStringValue overwrites key's whole string value, preserving any
// existing TTL via redis.KeepTTL — a plain SET without it silently clears
// the key's expiration, a destructive side effect the caller (editing a
// value inline) never asked for.
func SetStringValue(ctx context.Context, client redis.UniversalClient, key, value string) error {
	if err := client.Set(ctx, key, value, redis.KeepTTL).Err(); err != nil {
		return fmt.Errorf("db: SET de %q: %w", key, err)
	}
	return nil
}

// SetJSONValue overwrites key's whole RedisJSON document at the root path.
// Unlike SET, JSON.SET does not clear an existing TTL — it's an in-place
// document update, not a key recreate — so there's no KEEPTTL equivalent
// needed here.
func SetJSONValue(ctx context.Context, client redis.UniversalClient, key, value string) error {
	if err := client.JSONSet(ctx, key, "$", value).Err(); err != nil {
		return fmt.Errorf("db: JSON.SET de %q: %w", key, err)
	}
	return nil
}

// SetHashField creates or overwrites one field of a hash.
func SetHashField(ctx context.Context, client redis.UniversalClient, key, field, value string) error {
	if err := client.HSet(ctx, key, field, value).Err(); err != nil {
		return fmt.Errorf("db: HSET de %q: %w", key, err)
	}
	return nil
}

// DeleteHashField removes one field from a hash.
func DeleteHashField(ctx context.Context, client redis.UniversalClient, key, field string) error {
	if err := client.HDel(ctx, key, field).Err(); err != nil {
		return fmt.Errorf("db: HDEL de %q: %w", key, err)
	}
	return nil
}

// SetListIndex overwrites the element at index.
func SetListIndex(ctx context.Context, client redis.UniversalClient, key string, index int64, value string) error {
	if err := client.LSet(ctx, key, index, value).Err(); err != nil {
		return fmt.Errorf("db: LSET de %q: %w", key, err)
	}
	return nil
}

// PushListValue appends value to the end of a list.
func PushListValue(ctx context.Context, client redis.UniversalClient, key, value string) error {
	if err := client.RPush(ctx, key, value).Err(); err != nil {
		return fmt.Errorf("db: RPUSH de %q: %w", key, err)
	}
	return nil
}

// RemoveListIndex deletes the element at index — Redis has no native
// "remove by index" primitive, so this uses the standard two-step trick:
// LSET the slot to a sentinel value no real element could collide with,
// then LREM the first occurrence of that sentinel. Wrapped in a
// MULTI/EXEC pipeline (both commands target the same key, so this is also
// cluster-safe — same single-slot requirement TxPipelined always has) so a
// crash between the two steps can't leave the sentinel behind as a real
// list element.
func RemoveListIndex(ctx context.Context, client redis.UniversalClient, key string, index int64) error {
	sentinel := fmt.Sprintf("\x00__mini_tools_delete_sentinel__%d\x00", time.Now().UnixNano())
	_, err := client.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.LSet(ctx, key, index, sentinel)
		pipe.LRem(ctx, key, 1, sentinel)
		return nil
	})
	if err != nil {
		return fmt.Errorf("db: eliminando índice %d de %q: %w", index, key, err)
	}
	return nil
}

// AddSetMember adds member to a set.
func AddSetMember(ctx context.Context, client redis.UniversalClient, key, member string) error {
	if err := client.SAdd(ctx, key, member).Err(); err != nil {
		return fmt.Errorf("db: SADD de %q: %w", key, err)
	}
	return nil
}

// RemoveSetMember removes member from a set.
func RemoveSetMember(ctx context.Context, client redis.UniversalClient, key, member string) error {
	if err := client.SRem(ctx, key, member).Err(); err != nil {
		return fmt.Errorf("db: SREM de %q: %w", key, err)
	}
	return nil
}

// AddZSetMember adds (or updates the score of) member in a sorted set.
func AddZSetMember(ctx context.Context, client redis.UniversalClient, key, member string, score float64) error {
	if err := client.ZAdd(ctx, key, redis.Z{Member: member, Score: score}).Err(); err != nil {
		return fmt.Errorf("db: ZADD de %q: %w", key, err)
	}
	return nil
}

// RemoveZSetMember removes member from a sorted set.
func RemoveZSetMember(ctx context.Context, client redis.UniversalClient, key, member string) error {
	if err := client.ZRem(ctx, key, member).Err(); err != nil {
		return fmt.Errorf("db: ZREM de %q: %w", key, err)
	}
	return nil
}

// --- Exportación masiva (Redis Browser: selección + exportar) ---

// RedisKeyExport is one exported key — Value is already shaped by Type,
// same per-type convention RedisValue uses, but never paginated: export
// means the whole value, however large, unlike the detail panel's
// page-at-a-time fetch.
type RedisKeyExport struct {
	Key        string      `json:"key"`
	Type       string      `json:"type"`
	TTLSeconds int64       `json:"ttlSeconds"`
	Value      interface{} `json:"value"`
}

// ExportRedisKeys fetches type/TTL/full value for every key in keys, one at
// a time (Redis has no bulk "export by type" primitive). Each value is
// fully paginated internally via GetRedisValue's cursor — an export must
// be faithful to the whole value, never truncated to whatever the detail
// panel's first page happened to show.
func ExportRedisKeys(ctx context.Context, client redis.UniversalClient, keys []string) ([]RedisKeyExport, error) {
	out := make([]RedisKeyExport, 0, len(keys))
	for _, key := range keys {
		info, err := GetRedisKeyInfo(ctx, client, key)
		if err != nil {
			return nil, err
		}
		value, err := fullRedisValue(ctx, client, key, info.Type)
		if err != nil {
			return nil, err
		}
		out = append(out, RedisKeyExport{Key: key, Type: info.Type, TTLSeconds: info.TTLSeconds, Value: value})
	}
	return out, nil
}

// fullRedisValue pages through GetRedisValue until its cursor is exhausted
// and returns the whole value shaped for JSON export — a scalar for
// string/ReJSON-RL, a map for hash, a slice for list/set, a slice of
// {member,score} for zset, a slice of stream entries for stream.
func fullRedisValue(ctx context.Context, client redis.UniversalClient, key, typ string) (interface{}, error) {
	switch typ {
	case "string", "ReJSON-RL":
		page, err := GetRedisValue(ctx, client, key, typ, "", 0, defaultRedisPageSize)
		if err != nil {
			return nil, err
		}
		return page.StringVal, nil

	case "hash":
		fields := map[string]string{}
		cursor := ""
		for {
			page, err := GetRedisValue(ctx, client, key, typ, cursor, 0, defaultRedisPageSize)
			if err != nil {
				return nil, err
			}
			for _, p := range page.HashPairs {
				fields[p.Field] = p.Value
			}
			if page.Cursor == "" {
				return fields, nil
			}
			cursor = page.Cursor
		}

	case "set":
		members := []string{}
		cursor := ""
		for {
			page, err := GetRedisValue(ctx, client, key, typ, cursor, 0, defaultRedisPageSize)
			if err != nil {
				return nil, err
			}
			members = append(members, page.SetMembers...)
			if page.Cursor == "" {
				return members, nil
			}
			cursor = page.Cursor
		}

	case "zset":
		items := []RedisScoredMember{}
		var offset int64
		for {
			page, err := GetRedisValue(ctx, client, key, typ, "", offset, defaultRedisPageSize)
			if err != nil {
				return nil, err
			}
			items = append(items, page.ZsetItems...)
			if page.Cursor == "" {
				return items, nil
			}
			offset += defaultRedisPageSize
		}

	case "list":
		items := []string{}
		var offset int64
		for {
			page, err := GetRedisValue(ctx, client, key, typ, "", offset, defaultRedisPageSize)
			if err != nil {
				return nil, err
			}
			items = append(items, page.ListItems...)
			if page.Cursor == "" {
				return items, nil
			}
			offset += defaultRedisPageSize
		}

	case "stream":
		entries := []RedisStreamEntry{}
		cursor := ""
		for {
			page, err := GetRedisValue(ctx, client, key, typ, cursor, 0, defaultRedisPageSize)
			if err != nil {
				return nil, err
			}
			entries = append(entries, page.StreamEntries...)
			if page.Cursor == "" {
				return entries, nil
			}
			cursor = page.Cursor
		}

	default:
		return nil, fmt.Errorf("db: tipo de valor Redis no soportado para exportación: %q", typ)
	}
}

func parseCursorUint(cursor string) (uint64, error) {
	if cursor == "" {
		return 0, nil
	}
	n, err := strconv.ParseUint(cursor, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("db: cursor de Redis inválido: %w", err)
	}
	return n, nil
}

func parseClusterCursor(cursor string) (shardIdx int, shardCursor uint64, err error) {
	if cursor == "" {
		return 0, 0, nil
	}
	parts := strings.SplitN(cursor, ":", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("db: cursor de cluster Redis inválido: %q", cursor)
	}
	idx, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("db: cursor de cluster Redis inválido: %w", err)
	}
	sc, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("db: cursor de cluster Redis inválido: %w", err)
	}
	return idx, sc, nil
}

func encodeClusterCursor(shardIdx int, shardCursor uint64) string {
	return fmt.Sprintf("%d:%d", shardIdx, shardCursor)
}
