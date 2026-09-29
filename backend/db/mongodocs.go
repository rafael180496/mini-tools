package db

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"mini-tools/backend/i18n"
)

// parseMongoFilter parses a relaxed/Extended-JSON filter string into an ordered
// bson.D. An empty string or "{}" means "no filter". This is the STRICT
// Extended-JSON path used by the document browser panel (whose values come
// from the DB already as ExtJSON) — the editor's mongosh command language has
// its own lenient parser (backend/mongoquery) that also accepts unquoted keys
// and ObjectId(...)/ISODate(...) helpers.
func parseMongoFilter(filterJSON string) (bson.D, error) {
	filter := bson.D{}
	trimmed := strings.TrimSpace(filterJSON)
	if trimmed == "" || trimmed == "{}" {
		return filter, nil
	}
	if err := bson.UnmarshalExtJSON([]byte(trimmed), false, &filter); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "db: filtro Mongo inválido: %w", EN: "db: invalid Mongo filter: %w"}, err)
	}
	return filter, nil
}

// docID extracts the _id element from an ordered document, for building the
// {_id: ...} filter that identifies a single document to replace/delete.
func docID(doc bson.D) (interface{}, bool) {
	for _, e := range doc {
		if e.Key == "_id" {
			return e.Value, true
		}
	}
	return nil, false
}

// ListMongoDocuments returns a page of documents from a collection as relaxed
// Extended-JSON strings, ordered by _id, optionally filtered. Used by the
// browser panel; the editor's find command goes through backend/mongoquery.
func ListMongoDocuments(ctx context.Context, client *mongo.Client, dbName, collName, filterJSON string, skip, limit int64) ([]string, error) {
	filter, err := parseMongoFilter(filterJSON)
	if err != nil {
		return nil, err
	}

	opts := options.Find().SetSkip(skip).SetLimit(limit).SetSort(bson.D{{Key: "_id", Value: 1}})
	cursor, err := client.Database(dbName).Collection(collName).Find(ctx, filter, opts)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "db: buscando documentos Mongo en %q.%q: %w", EN: "db: finding Mongo documents in %q.%q: %w"}, dbName, collName, err)
	}
	defer cursor.Close(ctx)

	var out []string
	for cursor.Next(ctx) {
		j, err := bson.MarshalExtJSON(cursor.Current, false, false)
		if err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "db: serializando documento Mongo: %w", EN: "db: serializing Mongo document: %w"}, err)
		}
		out = append(out, string(j))
	}
	return out, cursor.Err()
}

// CountMongoDocuments returns the exact count matching filterJSON (empty =
// whole collection), for the browser panel's total/pagination.
func CountMongoDocuments(ctx context.Context, client *mongo.Client, dbName, collName, filterJSON string) (int64, error) {
	filter, err := parseMongoFilter(filterJSON)
	if err != nil {
		return 0, err
	}
	count, err := client.Database(dbName).Collection(collName).CountDocuments(ctx, filter)
	if err != nil {
		return 0, i18n.Errorf(i18n.Msg{ES: "db: contando documentos Mongo en %q.%q: %w", EN: "db: counting Mongo documents in %q.%q: %w"}, dbName, collName, err)
	}
	return count, nil
}

// ReplaceMongoDocument replaces a whole document, identified by the _id inside
// docJSON itself (relaxed/Extended JSON). Errors if the document has no _id —
// MongoDB has no stable way to identify which document to replace otherwise.
func ReplaceMongoDocument(ctx context.Context, client *mongo.Client, dbName, collName, docJSON string) error {
	var doc bson.D
	if err := bson.UnmarshalExtJSON([]byte(docJSON), false, &doc); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: documento Mongo inválido: %w", EN: "db: invalid Mongo document: %w"}, err)
	}
	id, ok := docID(doc)
	if !ok {
		return i18n.Errorf(i18n.Msg{ES: "db: el documento no tiene campo _id, no se puede reemplazar", EN: "db: the document has no _id field, it can't be replaced"})
	}
	_, err := client.Database(dbName).Collection(collName).
		ReplaceOne(ctx, bson.D{{Key: "_id", Value: id}}, doc)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: reemplazando documento Mongo: %w", EN: "db: replacing Mongo document: %w"}, err)
	}
	return nil
}

// DeleteMongoDocument deletes the single document whose _id matches the one
// inside docJSON (relaxed/Extended JSON).
func DeleteMongoDocument(ctx context.Context, client *mongo.Client, dbName, collName, docJSON string) error {
	var doc bson.D
	if err := bson.UnmarshalExtJSON([]byte(docJSON), false, &doc); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: documento Mongo inválido: %w", EN: "db: invalid Mongo document: %w"}, err)
	}
	id, ok := docID(doc)
	if !ok {
		return i18n.Errorf(i18n.Msg{ES: "db: el documento no tiene campo _id, no se puede eliminar", EN: "db: the document has no _id field, it can't be deleted"})
	}
	_, err := client.Database(dbName).Collection(collName).
		DeleteOne(ctx, bson.D{{Key: "_id", Value: id}})
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: eliminando documento Mongo: %w", EN: "db: deleting Mongo document: %w"}, err)
	}
	return nil
}
