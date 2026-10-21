package mcpserver

import "testing"

func TestNormalizeArgsMapsCommonAliases(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{
		"connection": map[string]any{}, "query": map[string]any{},
	}}
	got := NormalizeArgs(schema, map[string]any{"alias": "prod", "sql": "select 1"})
	if got["connection"] != "prod" || got["query"] != "select 1" {
		t.Fatalf("sinónimos no traducidos: %v", got)
	}
	if _, ok := got["sql"]; ok {
		t.Errorf("el sinónimo debía moverse, no duplicarse: %v", got)
	}
}

func TestNormalizeArgsKeepsDeclaredAndPresentArgs(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{
		"title": map[string]any{}, "name": map[string]any{}, "content": map[string]any{}, "folder": map[string]any{},
	}}
	got := NormalizeArgs(schema, map[string]any{"name": "n", "content": "c", "text": "t", "Folder": "f"})
	if got["title"] != nil || got["name"] != "n" {
		t.Errorf("un sinónimo que la herramienta declara no se mueve: %v", got)
	}
	if got["content"] != "c" {
		t.Errorf("un argumento presente no se pisa: %v", got)
	}
	if got["folder"] != "f" {
		t.Errorf("capitalización: %v", got)
	}
	got = NormalizeArgs(schema, map[string]any{"content": "", "text": "t"})
	if got["content"] != "t" {
		t.Errorf("un \"\" no tapa al sinónimo: %v", got)
	}
}
