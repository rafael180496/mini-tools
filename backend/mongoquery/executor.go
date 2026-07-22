package mongoquery

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"mini-tools/backend/db"
)

// defaultFindLimit caps an unbounded find() so a huge collection can't flood
// the UI, mirroring how the mongo shell shows a bounded batch. The user can
// override it with an explicit .limit(n). Documented in the SKILL.
const defaultFindLimit = 50

// Event is what gets streamed to the frontend (via EmitFunc) under the query's
// ID — the MongoDB counterpart to query.Event / redisquery.Event. A script can
// hold several commands (parser.go); each gets its own done/error/cancelled
// event tagged with CommandIndex. Results are always Extended-JSON documents
// (Documents), so the frontend renders them as colorized JSON regardless of
// whether the command was a find, an insert ack, or an update summary.
type Event struct {
	Type          string   `json:"type"` // "done" | "cancelled" | "error"
	CommandIndex  int      `json:"commandIndex"`
	TotalCommands int      `json:"totalCommands"`
	CommandText   string   `json:"commandText,omitempty"`
	Documents     []string `json:"documents,omitempty"` // one relaxed-ExtJSON string per document
	Summary       string   `json:"summary,omitempty"`   // header line, e.g. "91 documento(s)"
	DurationMs    int64    `json:"durationMs,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// EmitFunc / HistorySink mirror the identical-shaped types in backend/query and
// backend/redisquery, so app.go's same closures satisfy all three.
type EmitFunc func(event string, data interface{})
type HistorySink func(connID, commandText, status string, rowsAffected, durationMs int64, errMsg string)

// Executor runs mongosh-style command scripts against a pooled *mongo.Client
// and streams the results back as Events — the parallel of query.Executor /
// redisquery.Executor for MongoDB (a non-database/sql engine).
type Executor struct {
	parentCtx context.Context
	pools     *db.MongoPoolManager
	emit      EmitFunc
	history   HistorySink

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewExecutor(parentCtx context.Context, pools *db.MongoPoolManager, emit EmitFunc, history HistorySink) *Executor {
	return &Executor{parentCtx: parentCtx, pools: pools, emit: emit, history: history, cancels: make(map[string]context.CancelFunc)}
}

// Execute parses and runs commandText against the given database on connID,
// streaming Events under queryID. database is the "current db" the mongosh `db`
// refers to (the frontend passes the active database — MongoDB browses many).
func (e *Executor) Execute(connID, queryID, database, commandText string) {
	go e.run(connID, queryID, database, commandText)
}

// Cancel cancels the in-flight script under queryID, if any.
func (e *Executor) Cancel(queryID string) {
	e.mu.Lock()
	cancel, ok := e.cancels[queryID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

func (e *Executor) run(connID, queryID, database, commandText string) {
	client, err := e.pools.Get(connID)
	if err != nil {
		e.emit(queryID, Event{Type: "error", Error: err.Error()})
		return
	}
	if strings.TrimSpace(database) == "" {
		e.emit(queryID, Event{Type: "error", Error: "mongodb: no hay una base de datos seleccionada"})
		return
	}

	cmds, err := parseStatements(commandText)
	if err != nil {
		e.emit(queryID, Event{Type: "error", Error: err.Error()})
		return
	}
	if len(cmds) == 0 {
		e.emit(queryID, Event{Type: "error", Error: "mongodb: no hay ningún comando para ejecutar"})
		return
	}
	total := len(cmds)

	ctx, cancel := context.WithCancel(e.parentCtx)
	e.registerCancel(queryID, cancel)
	defer e.clearCancel(queryID)
	defer cancel()

	dbHandle := client.Database(database)

	for idx, cmd := range cmds {
		if ctx.Err() != nil {
			// Cancelled while an earlier command ran — it already emitted its
			// own "cancelled" event; the rest never started (break, not
			// continue — same fantasma-event bug precedent as query/redisquery).
			break
		}

		start := time.Now()
		docs, summary, err := executeCommand(ctx, dbHandle, cmd)
		durationMs := time.Since(start).Milliseconds()

		if err != nil {
			if ctx.Err() != nil {
				e.recordHistory(connID, cmd.raw, "cancelled", 0, durationMs, "")
				e.emit(queryID, Event{Type: "cancelled", CommandIndex: idx, TotalCommands: total, CommandText: cmd.raw})
			} else {
				e.recordHistory(connID, cmd.raw, "error", 0, durationMs, err.Error())
				e.emit(queryID, Event{Type: "error", CommandIndex: idx, TotalCommands: total, CommandText: cmd.raw, Error: err.Error(), DurationMs: durationMs})
			}
			// A failed command doesn't stop the script (same as query/redisquery).
			continue
		}

		e.recordHistory(connID, cmd.raw, "done", int64(len(docs)), durationMs, "")
		e.emit(queryID, Event{
			Type: "done", CommandIndex: idx, TotalCommands: total, CommandText: cmd.raw,
			Documents: docs, Summary: summary, DurationMs: durationMs,
		})
	}
}

// executeCommand dispatches one parsed command to the driver and returns its
// result as Extended-JSON document strings plus a one-line summary.
func executeCommand(ctx context.Context, database *mongo.Database, cmd command) ([]string, string, error) {
	coll := database.Collection(cmd.collection)
	switch cmd.method {
	case "find":
		return runFind(ctx, coll, cmd)
	case "findOne":
		return runFindOne(ctx, coll, cmd)
	case "aggregate":
		return runAggregate(ctx, coll, cmd)
	case "countDocuments", "count":
		return runCount(ctx, coll, cmd)
	case "estimatedDocumentCount":
		n, err := coll.EstimatedDocumentCount(ctx)
		if err != nil {
			return nil, "", err
		}
		return countDoc(n)
	case "distinct":
		return runDistinct(ctx, coll, cmd)
	case "insertOne":
		return runInsertOne(ctx, coll, cmd)
	case "insertMany":
		return runInsertMany(ctx, coll, cmd)
	case "updateOne":
		return runUpdate(ctx, coll, cmd, false)
	case "updateMany":
		return runUpdate(ctx, coll, cmd, true)
	case "replaceOne":
		return runReplace(ctx, coll, cmd)
	case "deleteOne":
		return runDelete(ctx, coll, cmd, false)
	case "deleteMany":
		return runDelete(ctx, coll, cmd, true)
	case "createIndex":
		return runCreateIndex(ctx, coll, cmd)
	case "dropIndex":
		return runDropIndex(ctx, coll, cmd)
	case "getIndexes":
		return runGetIndexes(ctx, coll)
	default:
		return nil, "", fmt.Errorf("mongodb: método no soportado: %s()", cmd.method)
	}
}

func runFind(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	opts := options.Find()
	if proj, err := argAsDocOptional(cmd.args, 1); err != nil {
		return nil, "", err
	} else if proj != nil {
		opts.SetProjection(proj)
	}

	hasLimit := false
	for _, ch := range cmd.chain {
		switch ch.method {
		case "sort":
			d, err := argAsDoc(ch.args, 0)
			if err != nil {
				return nil, "", err
			}
			opts.SetSort(d)
		case "limit":
			n, err := argAsInt(ch.args, 0)
			if err != nil {
				return nil, "", err
			}
			opts.SetLimit(n)
			hasLimit = true
		case "skip":
			n, err := argAsInt(ch.args, 0)
			if err != nil {
				return nil, "", err
			}
			opts.SetSkip(n)
		case "projection":
			d, err := argAsDoc(ch.args, 0)
			if err != nil {
				return nil, "", err
			}
			opts.SetProjection(d)
		case "count":
			n, err := coll.CountDocuments(ctx, filter)
			if err != nil {
				return nil, "", err
			}
			return countDoc(n)
		case "pretty", "toArray":
			// no-op — results are always returned as an array, pretty-printed
			// by the frontend's JSON view.
		default:
			return nil, "", fmt.Errorf("mongodb: modificador de cursor no soportado: .%s()", ch.method)
		}
	}
	if !hasLimit {
		opts.SetLimit(defaultFindLimit)
	}

	cursor, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return nil, "", err
	}
	docs, err := marshalCursor(ctx, cursor)
	if err != nil {
		return nil, "", err
	}
	summary := fmt.Sprintf("%d documento(s)", len(docs))
	if !hasLimit && len(docs) == defaultFindLimit {
		summary += fmt.Sprintf(" (limitado a %d — agregá .limit(n) para más)", defaultFindLimit)
	}
	return docs, summary, nil
}

func runFindOne(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	opts := options.FindOne()
	if proj, err := argAsDocOptional(cmd.args, 1); err != nil {
		return nil, "", err
	} else if proj != nil {
		opts.SetProjection(proj)
	}
	var raw bson.Raw
	err = coll.FindOne(ctx, filter, opts).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, "sin resultados (null)", nil
	}
	if err != nil {
		return nil, "", err
	}
	j, err := bson.MarshalExtJSON(raw, false, false)
	if err != nil {
		return nil, "", err
	}
	return []string{string(j)}, "1 documento", nil
}

func runAggregate(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	pipeline, err := argAsArray(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, "", err
	}
	docs, err := marshalCursor(ctx, cursor)
	if err != nil {
		return nil, "", err
	}
	return docs, fmt.Sprintf("%d documento(s)", len(docs)), nil
}

func runCount(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	n, err := coll.CountDocuments(ctx, filter)
	if err != nil {
		return nil, "", err
	}
	return countDoc(n)
}

func runDistinct(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	if len(cmd.args) == 0 || strings.TrimSpace(cmd.args[0]) == "" {
		return nil, "", fmt.Errorf("mongodb: distinct requiere el nombre del campo")
	}
	field := strings.Trim(strings.TrimSpace(cmd.args[0]), `'"`)
	filter, err := argAsDocOptional(cmd.args, 1)
	if err != nil {
		return nil, "", err
	}
	if filter == nil {
		filter = bson.D{}
	}
	var values bson.A
	if err := coll.Distinct(ctx, field, filter).Decode(&values); err != nil {
		return nil, "", err
	}
	j, err := bson.MarshalExtJSON(bson.D{{Key: "values", Value: values}}, false, false)
	if err != nil {
		return nil, "", err
	}
	return []string{string(j)}, fmt.Sprintf("%d valor(es) distinto(s)", len(values)), nil
}

func runInsertOne(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	doc, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	res, err := coll.InsertOne(ctx, doc)
	if err != nil {
		return nil, "", err
	}
	return marshalDoc(bson.D{{Key: "acknowledged", Value: true}, {Key: "insertedId", Value: res.InsertedID}}, "1 documento insertado")
}

func runInsertMany(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	arr, err := argAsArray(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	res, err := coll.InsertMany(ctx, []interface{}(arr))
	if err != nil {
		return nil, "", err
	}
	return marshalDoc(
		bson.D{{Key: "insertedCount", Value: len(res.InsertedIDs)}, {Key: "insertedIds", Value: res.InsertedIDs}},
		fmt.Sprintf("%d documento(s) insertado(s)", len(res.InsertedIDs)),
	)
}

func runUpdate(ctx context.Context, coll *mongo.Collection, cmd command, many bool) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	update, err := argAsAny(cmd.args, 1)
	if err != nil {
		return nil, "", err
	}
	var res *mongo.UpdateResult
	if many {
		res, err = coll.UpdateMany(ctx, filter, update)
	} else {
		res, err = coll.UpdateOne(ctx, filter, update)
	}
	if err != nil {
		return nil, "", err
	}
	return updateResultDoc(res)
}

func runReplace(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	repl, err := argAsDoc(cmd.args, 1)
	if err != nil {
		return nil, "", err
	}
	res, err := coll.ReplaceOne(ctx, filter, repl)
	if err != nil {
		return nil, "", err
	}
	return updateResultDoc(res)
}

func runDelete(ctx context.Context, coll *mongo.Collection, cmd command, many bool) ([]string, string, error) {
	filter, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	var res *mongo.DeleteResult
	if many {
		res, err = coll.DeleteMany(ctx, filter)
	} else {
		res, err = coll.DeleteOne(ctx, filter)
	}
	if err != nil {
		return nil, "", err
	}
	return marshalDoc(bson.D{{Key: "deletedCount", Value: res.DeletedCount}}, fmt.Sprintf("%d documento(s) eliminado(s)", res.DeletedCount))
}

func runCreateIndex(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	keys, err := argAsDoc(cmd.args, 0)
	if err != nil {
		return nil, "", err
	}
	idxOpts := options.Index()
	if len(cmd.args) > 1 && strings.TrimSpace(cmd.args[1]) != "" {
		optDoc, err := argAsDoc(cmd.args, 1)
		if err != nil {
			return nil, "", err
		}
		for _, el := range optDoc {
			switch el.Key {
			case "unique":
				if v, ok := el.Value.(bool); ok && v {
					idxOpts.SetUnique(true)
				}
			case "sparse":
				if v, ok := el.Value.(bool); ok && v {
					idxOpts.SetSparse(true)
				}
			case "name":
				if v, ok := el.Value.(string); ok && v != "" {
					idxOpts.SetName(v)
				}
			}
		}
	}
	name, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: keys, Options: idxOpts})
	if err != nil {
		return nil, "", err
	}
	return marshalDoc(bson.D{{Key: "createdIndex", Value: name}}, "índice creado: "+name)
}

func runDropIndex(ctx context.Context, coll *mongo.Collection, cmd command) ([]string, string, error) {
	if len(cmd.args) == 0 || strings.TrimSpace(cmd.args[0]) == "" {
		return nil, "", fmt.Errorf("mongodb: dropIndex requiere el nombre del índice")
	}
	name := strings.Trim(strings.TrimSpace(cmd.args[0]), `'"`)
	if err := coll.Indexes().DropOne(ctx, name); err != nil {
		return nil, "", err
	}
	return marshalDoc(bson.D{{Key: "droppedIndex", Value: name}}, "índice eliminado: "+name)
}

func runGetIndexes(ctx context.Context, coll *mongo.Collection) ([]string, string, error) {
	cursor, err := coll.Indexes().List(ctx)
	if err != nil {
		return nil, "", err
	}
	docs, err := marshalCursor(ctx, cursor)
	if err != nil {
		return nil, "", err
	}
	return docs, fmt.Sprintf("%d índice(s)", len(docs)), nil
}

// --- argument / result helpers ---

func argAsDoc(args []string, idx int) (bson.D, error) {
	d, err := argAsDocOptional(args, idx)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return bson.D{}, nil
	}
	return d, nil
}

func argAsDocOptional(args []string, idx int) (bson.D, error) {
	if idx >= len(args) || strings.TrimSpace(args[idx]) == "" {
		return nil, nil
	}
	ej, err := toExtJSON(args[idx])
	if err != nil {
		return nil, err
	}
	var d bson.D
	if err := bson.UnmarshalExtJSON([]byte(ej), false, &d); err != nil {
		return nil, fmt.Errorf("mongodb: argumento inválido: %w", err)
	}
	return d, nil
}

func argAsArray(args []string, idx int) (bson.A, error) {
	if idx >= len(args) || strings.TrimSpace(args[idx]) == "" {
		return bson.A{}, nil
	}
	ej, err := toExtJSON(args[idx])
	if err != nil {
		return nil, err
	}
	var a bson.A
	if err := bson.UnmarshalExtJSON([]byte(ej), false, &a); err != nil {
		return nil, fmt.Errorf("mongodb: se esperaba un array: %w", err)
	}
	return a, nil
}

// argAsAny returns a bson.A for array-shaped args (pipeline-form updates) or a
// bson.D for object-shaped args.
func argAsAny(args []string, idx int) (interface{}, error) {
	if idx >= len(args) || strings.TrimSpace(args[idx]) == "" {
		return nil, fmt.Errorf("mongodb: falta el argumento %d", idx+1)
	}
	ej, err := toExtJSON(args[idx])
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(strings.TrimSpace(ej), "[") {
		var a bson.A
		if err := bson.UnmarshalExtJSON([]byte(ej), false, &a); err != nil {
			return nil, fmt.Errorf("mongodb: argumento inválido: %w", err)
		}
		return a, nil
	}
	var d bson.D
	if err := bson.UnmarshalExtJSON([]byte(ej), false, &d); err != nil {
		return nil, fmt.Errorf("mongodb: argumento inválido: %w", err)
	}
	return d, nil
}

func argAsInt(args []string, idx int) (int64, error) {
	if idx >= len(args) || strings.TrimSpace(args[idx]) == "" {
		return 0, fmt.Errorf("mongodb: se esperaba un número")
	}
	n, err := strconv.ParseInt(strings.TrimSpace(args[idx]), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("mongodb: número inválido %q", args[idx])
	}
	return n, nil
}

func marshalCursor(ctx context.Context, cursor *mongo.Cursor) ([]string, error) {
	defer cursor.Close(ctx)
	out := []string{}
	for cursor.Next(ctx) {
		j, err := bson.MarshalExtJSON(cursor.Current, false, false)
		if err != nil {
			return nil, err
		}
		out = append(out, string(j))
	}
	return out, cursor.Err()
}

func marshalDoc(v interface{}, summary string) ([]string, string, error) {
	j, err := bson.MarshalExtJSON(v, false, false)
	if err != nil {
		return nil, "", err
	}
	return []string{string(j)}, summary, nil
}

func countDoc(n int64) ([]string, string, error) {
	return marshalDoc(bson.D{{Key: "count", Value: n}}, fmt.Sprintf("%d", n))
}

func updateResultDoc(res *mongo.UpdateResult) ([]string, string, error) {
	return marshalDoc(
		bson.D{
			{Key: "matchedCount", Value: res.MatchedCount},
			{Key: "modifiedCount", Value: res.ModifiedCount},
			{Key: "upsertedCount", Value: res.UpsertedCount},
			{Key: "upsertedId", Value: res.UpsertedID},
		},
		fmt.Sprintf("%d encontrado(s), %d modificado(s)", res.MatchedCount, res.ModifiedCount),
	)
}

func (e *Executor) recordHistory(connID, commandText, status string, rowsAffected, durationMs int64, errMsg string) {
	if e.history == nil {
		return
	}
	e.history(connID, commandText, status, rowsAffected, durationMs, errMsg)
}

func (e *Executor) registerCancel(queryID string, cancel context.CancelFunc) {
	e.mu.Lock()
	e.cancels[queryID] = cancel
	e.mu.Unlock()
}

func (e *Executor) clearCancel(queryID string) {
	e.mu.Lock()
	delete(e.cancels, queryID)
	e.mu.Unlock()
}
