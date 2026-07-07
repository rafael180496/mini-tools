package vault

import (
	"bytes"
	"path/filepath"
	"testing"

	"mini-tools/backend/db"
)

func TestConnectionLifecycle(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	sqliteFile := filepath.Join(t.TempDir(), "mydata.db")
	dsn := "file://" + sqliteFile

	summary, err := store.SaveConnection("local dev", db.DBTypeSQLite, dsn)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if summary.ID == "" || summary.Name != "local dev" || summary.DBType != "sqlite" {
		t.Fatalf("unexpected summary: %+v", summary)
	}

	list, err := store.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if len(list) != 1 || list[0].ID != summary.ID {
		t.Fatalf("expected 1 connection matching summary, got %+v", list)
	}

	gotType, gotDSN, err := store.ConnectionDSN(summary.ID)
	if err != nil {
		t.Fatalf("ConnectionDSN: %v", err)
	}
	if gotType != db.DBTypeSQLite || gotDSN != dsn {
		t.Fatalf("decrypted dsn mismatch: type=%v dsn=%q want dsn=%q", gotType, gotDSN, dsn)
	}

	if err := store.DeleteConnection(summary.ID); err != nil {
		t.Fatalf("DeleteConnection: %v", err)
	}
	list, err = store.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections after delete: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected no connections after delete, got %+v", list)
	}
}

func TestConnectionDSNIsStoredEncrypted(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	dsn := "file:///tmp/plaintext-marker.db"
	summary, err := store.SaveConnection("marker", db.DBTypeSQLite, dsn)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	var ciphertext []byte
	if err := store.db.QueryRow(`SELECT encrypted_dsn FROM connections WHERE id = ?`, summary.ID).Scan(&ciphertext); err != nil {
		t.Fatalf("reading raw encrypted_dsn: %v", err)
	}
	if bytes.Contains(ciphertext, []byte(dsn)) {
		t.Fatal("encrypted_dsn column contains the plaintext DSN — it must be opaque ciphertext")
	}
}
