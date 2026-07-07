package db

import (
	"path/filepath"
	"testing"
)

func TestSQLiteBuildDSNAndPing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	connector, err := ConnectorFor(DBTypeSQLite)
	if err != nil {
		t.Fatalf("ConnectorFor: %v", err)
	}

	dsn, err := connector.BuildDSN(map[string]string{"path": path})
	if err != nil {
		t.Fatalf("BuildDSN: %v", err)
	}

	if err := Ping(DBTypeSQLite, dsn); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestSQLiteBuildDSNMissingPath(t *testing.T) {
	connector, err := ConnectorFor(DBTypeSQLite)
	if err != nil {
		t.Fatalf("ConnectorFor: %v", err)
	}

	if _, err := connector.BuildDSN(map[string]string{}); err == nil {
		t.Fatal("expected an error when 'path' is missing")
	}
}

func TestPoolManagerOpenIsReusedAndWALIsOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	connector, err := ConnectorFor(DBTypeSQLite)
	if err != nil {
		t.Fatalf("ConnectorFor: %v", err)
	}
	dsn, err := connector.BuildDSN(map[string]string{"path": path})
	if err != nil {
		t.Fatalf("BuildDSN: %v", err)
	}

	pm := NewPoolManager()
	t.Cleanup(pm.CloseAll)

	pool1, err := pm.Open("conn-1", DBTypeSQLite, dsn)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	pool2, err := pm.Open("conn-1", DBTypeSQLite, dsn)
	if err != nil {
		t.Fatalf("Open (second call): %v", err)
	}
	if pool1 != pool2 {
		t.Fatal("expected Open to return the same pool for the same connID, not reopen it")
	}

	got, err := pm.Get("conn-1")
	if err != nil || got != pool1 {
		t.Fatalf("Get returned a different pool: got=%v err=%v", got, err)
	}

	var journalMode string
	if err := pool1.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatalf("querying journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Fatalf("expected WAL journal mode, got %q", journalMode)
	}

	if err := pm.Close("conn-1"); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := pm.Get("conn-1"); err == nil {
		t.Fatal("expected Get to fail after Close")
	}
}
