package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoFieldInfo is one field path discovered by sampling a collection.
//
// MongoDB has no schema to read, so the only way to know what a collection
// contains is to look at documents. That makes this an approximation by
// construction: a field present in one document out of a million may not
// show up in a sample. Frequency is reported for exactly that reason —
// a field seen in 100% of the sample is something to suggest confidently,
// one seen in 2% is worth showing but not worth ranking first.
type MongoFieldInfo struct {
	// Path is the dot-joined path, e.g. "usuario.direccion.ciudad".
	Path string `json:"path"`
	// Types are the BSON type names seen at this path, most common first.
	// More than one means the collection is inconsistent there, which is
	// worth knowing before filtering on it.
	Types []string `json:"types"`
	// Count is how many sampled documents contained the path.
	Count int `json:"count"`
	// Frequency is Count / sampled, 0-1.
	Frequency float64 `json:"frequency"`
}

const (
	// mongoSampleDefault is how many documents to look at. Large enough to
	// find the fields that matter, small enough to stay instant on a
	// collection with millions of documents.
	mongoSampleDefault = 50
	// mongoSampleMaxDepth bounds recursion into nested documents. Three
	// levels covers "usuario.direccion.ciudad"; deeper paths are rare
	// enough that suggesting them is not worth walking every document.
	mongoSampleMaxDepth = 3
	// mongoSampleMaxFields caps the result so a collection of wildly
	// heterogeneous documents cannot return thousands of one-off keys.
	mongoSampleMaxFields = 400
)

// SampleMongoFields reads the first sampleSize documents of a collection and
// returns the field paths found, ordered by how many documents contain them.
//
// Deliberately a plain find().limit(N) rather than an $sample aggregation:
// $sample on a large collection either scans or relies on an internal
// random cursor, and this runs interactively every time the user picks a
// collection. Reading the first N documents is bounded, instant, and good
// enough for an autocomplete — it is not a statistics job.
func SampleMongoFields(ctx context.Context, client *mongo.Client, database, collection string, sampleSize int64) ([]MongoFieldInfo, error) {
	if sampleSize <= 0 {
		sampleSize = mongoSampleDefault
	}

	cur, err := client.Database(database).Collection(collection).
		Find(ctx, bson.D{}, options.Find().SetLimit(sampleSize))
	if err != nil {
		return nil, fmt.Errorf("db: muestreando campos de %s.%s: %w", database, collection, err)
	}
	defer cur.Close(ctx)

	counts := map[string]int{}
	types := map[string]map[string]int{}
	sampled := 0

	for cur.Next(ctx) {
		var doc bson.D
		if err := cur.Decode(&doc); err != nil {
			// One undecodable document must not lose the whole sample.
			continue
		}
		sampled++
		seen := map[string]bool{}
		walkMongoDoc(doc, "", 0, seen, types)
		for path := range seen {
			counts[path]++
		}
	}
	if err := cur.Err(); err != nil {
		return nil, fmt.Errorf("db: leyendo muestra de %s.%s: %w", database, collection, err)
	}

	out := make([]MongoFieldInfo, 0, len(counts))
	for path, count := range counts {
		info := MongoFieldInfo{Path: path, Count: count, Types: rankTypes(types[path])}
		if sampled > 0 {
			info.Frequency = float64(count) / float64(sampled)
		}
		out = append(out, info)
	}

	// Most common first, then alphabetically so the order is stable between
	// two samples that happen to tie.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > mongoSampleMaxFields {
		out = out[:mongoSampleMaxFields]
	}
	return out, nil
}

// walkMongoDoc records every path in one document into seen, and the BSON
// type observed at each into types.
func walkMongoDoc(doc bson.D, prefix string, depth int, seen map[string]bool, types map[string]map[string]int) {
	if depth > mongoSampleMaxDepth {
		return
	}
	for _, e := range doc {
		path := e.Key
		if prefix != "" {
			path = prefix + "." + e.Key
		}
		seen[path] = true
		recordType(types, path, bsonTypeName(e.Value))

		switch v := e.Value.(type) {
		case bson.D:
			walkMongoDoc(v, path, depth+1, seen, types)
		case bson.A:
			// Array elements share the parent's path, which is how a filter
			// on an array of subdocuments is actually written in MongoDB:
			// {"items.sku": "x"} matches any element. Suggesting
			// "items.0.sku" would be technically valid and practically
			// useless.
			for _, item := range v {
				if sub, ok := item.(bson.D); ok {
					walkMongoDoc(sub, path, depth+1, seen, types)
				}
			}
		}
	}
}

func recordType(types map[string]map[string]int, path, name string) {
	if name == "" {
		return
	}
	m, ok := types[path]
	if !ok {
		m = map[string]int{}
		types[path] = m
	}
	m[name]++
}

// rankTypes returns the type names seen at a path, most common first.
func rankTypes(counts map[string]int) []string {
	if len(counts) == 0 {
		return nil
	}
	names := make([]string, 0, len(counts))
	for n := range counts {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	return names
}

// bsonTypeName maps a decoded value to the type name the UI shows and, more
// importantly, to the name MongoDB's own $type operator accepts — so a
// suggested type can be used in a filter verbatim.
func bsonTypeName(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "bool"
	case int32:
		return "int"
	case int64:
		return "long"
	case float64:
		return "double"
	case bson.ObjectID:
		return "objectId"
	case bson.DateTime:
		return "date"
	case bson.Decimal128:
		return "decimal"
	case bson.Binary:
		return "binData"
	case bson.Regex:
		return "regex"
	case bson.D:
		return "object"
	case bson.A:
		return "array"
	case bson.Timestamp:
		return "timestamp"
	default:
		// Unknown types still get a name rather than being dropped: seeing
		// something odd is more useful than seeing nothing.
		return strings.ToLower(fmt.Sprintf("%T", t))
	}
}
