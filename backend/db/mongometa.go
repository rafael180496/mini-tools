package db

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// MongoDatabaseInfo is one database in the sidebar tree's top level.
type MongoDatabaseInfo struct {
	Name       string `json:"name"`
	SizeOnDisk int64  `json:"sizeOnDisk"`
	Empty      bool   `json:"empty"`
}

// MongoCollectionInfo is one collection (or view) under a database.
type MongoCollectionInfo struct {
	Name           string `json:"name"`
	Type           string `json:"type"` // "collection" | "view" | "timeseries"
	EstimatedCount int64  `json:"estimatedCount"`
}

// MongoIndex is one index on a collection, shown under it in the tree.
// KeysJSON is the index key spec as relaxed Extended JSON (e.g. {"email":1}),
// preserving field order.
type MongoIndex struct {
	Name     string `json:"name"`
	KeysJSON string `json:"keysJson"`
	Unique   bool   `json:"unique"`
	Sparse   bool   `json:"sparse"`
}

// ListMongoDatabases lists every database on the server (including admin/
// config/local, matching what Compass shows) with its on-disk size.
func ListMongoDatabases(ctx context.Context, client *mongo.Client) ([]MongoDatabaseInfo, error) {
	res, err := client.ListDatabases(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("db: listando bases Mongo: %w", err)
	}
	out := make([]MongoDatabaseInfo, 0, len(res.Databases))
	for _, d := range res.Databases {
		out = append(out, MongoDatabaseInfo{Name: d.Name, SizeOnDisk: d.SizeOnDisk, Empty: d.Empty})
	}
	return out, nil
}

// ListMongoCollections lists the collections/views of one database, each with
// a fast estimated document count (from collection metadata, not a full scan).
func ListMongoCollections(ctx context.Context, client *mongo.Client, dbName string) ([]MongoCollectionInfo, error) {
	database := client.Database(dbName)
	specs, err := database.ListCollectionSpecifications(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("db: listando colecciones Mongo de %q: %w", dbName, err)
	}

	out := make([]MongoCollectionInfo, 0, len(specs))
	for _, spec := range specs {
		info := MongoCollectionInfo{Name: spec.Name, Type: spec.Type}
		// EstimatedDocumentCount only applies to real collections; a view has
		// no metadata count (and would run the underlying pipeline), so skip it.
		if spec.Type == "" || spec.Type == "collection" || spec.Type == "timeseries" {
			if count, err := database.Collection(spec.Name).EstimatedDocumentCount(ctx); err == nil {
				info.EstimatedCount = count
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// GetMongoIndexes lists the indexes of one collection, for the tree/DDL-style
// viewer.
func GetMongoIndexes(ctx context.Context, client *mongo.Client, dbName, collName string) ([]MongoIndex, error) {
	cursor, err := client.Database(dbName).Collection(collName).Indexes().List(ctx)
	if err != nil {
		return nil, fmt.Errorf("db: listando índices Mongo de %q.%q: %w", dbName, collName, err)
	}
	defer cursor.Close(ctx)

	var indexes []MongoIndex
	for cursor.Next(ctx) {
		// Decode into a struct with the key spec kept as bson.Raw, so its
		// field order survives (a bson.M/bson.D map would not) when re-marshaled
		// to ExtJSON below.
		var doc struct {
			Name   string   `bson:"name"`
			Key    bson.Raw `bson:"key"`
			Unique bool     `bson:"unique"`
			Sparse bool     `bson:"sparse"`
		}
		if err := cursor.Decode(&doc); err != nil {
			return nil, fmt.Errorf("db: decodificando índice Mongo: %w", err)
		}
		idx := MongoIndex{Name: doc.Name, Unique: doc.Unique, Sparse: doc.Sparse}
		if len(doc.Key) > 0 {
			if keysJSON, err := bson.MarshalExtJSON(doc.Key, false, false); err == nil {
				idx.KeysJSON = string(keysJSON)
			}
		}
		indexes = append(indexes, idx)
	}
	return indexes, cursor.Err()
}
