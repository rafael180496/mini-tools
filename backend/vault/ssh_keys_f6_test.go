package vault

import (
	"net/url"
	"strings"
	"testing"

	"mini-tools/backend/db"
)

// Verifica el key vault de F6: guardar/listar/borrar sin exponer material,
// rechazo de basura, y que un DSN con keyId se resuelva a la llave real.
func TestSSHKeyVaultRoundTrip(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	// Llave Ed25519 sin passphrase generada para este test.
	const pem = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBTKUBiDAY7O0ymyHWwVphmnNyefGEuvddCnGtfcqQ3nQAAAJh9gPoMfYD6
DAAAAAtzc2gtZWQyNTUxOQAAACBTKUBiDAY7O0ymyHWwVphmnNyefGEuvddCnGtfcqQ3nQ
AAAEALybHQv//53Wtdqw/lZurJwBrX55BM4ft8L8NTJyVh3FMpQGIMBjs7TKbIdbBWmGac
3J58YS6910Kca19ypDedAAAAD3Rlc3RAbWluaS10b29scwECAwQFBg==
-----END OPENSSH PRIVATE KEY-----
`

	// La misma idea pero protegida, para verificar que guardar sin la
	// passphrase falla con un mensaje que se pueda accionar.
	const pemProtegida = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBH14kyqD
It/wgWdwRss6uiAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIPps1fT1K+7+LGsB
WsoxN3DSWu1b3FJgQrbhoTVLn9gkAAAAoK2sjbslyfqHRF9NELwXawxASiDnjaGs+NLD1K
atK0fRjakV9JSU7K8QO2GOyyKt/5hmPEeVaOy5Ydaa1s06ihtxgMVkbO98Q/yjDdZRlN/f
sS7WHB1nGmutqAB5wqfW8mhY9KGNdRPcxtyeCIgXk2G7Gh3vw4l3dNvJvPhS38n90KfZRF
2+rB0fc3r+SCfycPS5i+tzeletIqPNIACKEi8=
-----END OPENSSH PRIVATE KEY-----
`

	// Una llave rota se rechaza AL GUARDAR, no al conectar.
	if _, err := store.SaveSSHKey("rota", "-----BEGIN OPENSSH PRIVATE KEY-----\nno-es-una-llave\n-----END OPENSSH PRIVATE KEY-----\n", ""); err == nil {
		t.Fatal("guardar una llave inválida debía fallar")
	}

	// Una llave protegida guardada sin su passphrase se rechaza diciendo por
	// qué, en vez de con "no key found".
	_, err := store.SaveSSHKey("protegida", pemProtegida, "")
	if err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Fatalf("se esperaba un error que mencione la passphrase, hubo: %v", err)
	}
	conPass, err := store.SaveSSHKey("protegida", pemProtegida, "secreto")
	if err != nil {
		t.Fatalf("SaveSSHKey con passphrase: %v", err)
	}
	if !conPass.HasPassphrase {
		t.Fatal("hasPassphrase debía ser true")
	}
	if _, pass, _ := store.SSHKeyMaterial(conPass.ID); pass != "secreto" {
		t.Fatal("la passphrase no volvió descifrada")
	}

	summary, err := store.SaveSSHKey("deploy prod", pem, "")
	if err != nil {
		t.Fatalf("SaveSSHKey: %v", err)
	}
	if summary.KeyType != "ssh-ed25519" {
		t.Fatalf("keyType = %q, se esperaba ssh-ed25519", summary.KeyType)
	}
	if !strings.HasPrefix(summary.Fingerprint, "SHA256:") {
		t.Fatalf("fingerprint = %q, se esperaba el formato de ssh-keygen", summary.Fingerprint)
	}
	if summary.HasPassphrase {
		t.Fatal("esta llave no tiene passphrase")
	}

	// El nombre es único: dos "id_rsa" hacen imposible saber cuál se vincula.
	if _, err := store.SaveSSHKey("deploy prod", pem, ""); err == nil {
		t.Fatal("un nombre repetido debía fallar")
	}

	list, err := store.ListSSHKeys()
	if err != nil {
		t.Fatalf("ListSSHKeys: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("se esperaban 2 llaves, hay %d", len(list))
	}

	// El material vuelve intacto solo por la vía interna.
	got, pass, err := store.SSHKeyMaterial(summary.ID)
	if err != nil {
		t.Fatalf("SSHKeyMaterial: %v", err)
	}
	if got != pem || pass != "" {
		t.Fatal("el material descifrado no coincide con el guardado")
	}

	// El DSN referencia la llave en vez de llevarla adentro.
	connector, _ := db.ConnectorFor(db.DBTypeSSH)
	dsn, err := connector.BuildDSN(map[string]string{
		"host": "10.0.0.5", "user": "deploy", "auth": db.SSHAuthKey, "keyId": summary.ID,
	})
	if err != nil {
		t.Fatalf("BuildDSN: %v", err)
	}
	if strings.Contains(dsn, "BEGIN OPENSSH") {
		t.Fatal("el DSN guardado no debe contener material de llave")
	}
	params, err := connector.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("ParseDSN: %v", err)
	}
	if params["keyId"] != summary.ID {
		t.Fatalf("keyId no sobrevivió el round-trip: %+v", params)
	}

	// Y la sustitución al conectar (misma lógica que App.resolveSSHKeyRef).
	u, _ := url.Parse(dsn)
	q := u.Query()
	material, passphrase, err := store.SSHKeyMaterial(q.Get("keyId"))
	if err != nil {
		t.Fatalf("resolviendo keyId: %v", err)
	}
	q.Del("keyId")
	q.Set("privateKey", material)
	if passphrase != "" {
		q.Set("passphrase", passphrase)
	}
	u.RawQuery = q.Encode()
	resolved, err := connector.ParseDSN(u.String())
	if err != nil {
		t.Fatalf("ParseDSN resuelto: %v", err)
	}
	if resolved["privateKey"] != pem {
		t.Fatal("el DSN resuelto no lleva la llave real")
	}
	if resolved["keyId"] != "" {
		t.Fatal("keyId debía desaparecer del DSN resuelto")
	}

	if err := store.DeleteSSHKey(summary.ID); err != nil {
		t.Fatalf("DeleteSSHKey: %v", err)
	}
	if _, _, err := store.SSHKeyMaterial(summary.ID); err == nil {
		t.Fatal("una llave borrada no debía seguir resolviendo")
	}
}

// El entorno se persiste y vuelve en la lista y por conexión.
func TestConnectionEnvironment(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	sum, err := store.SaveConnection("prod-01", db.DBTypeSSH, "ssh://u@h:22?auth=password", "", EnvProd)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if sum.Environment != EnvProd {
		t.Fatalf("environment = %q", sum.Environment)
	}

	env, err := store.ConnectionEnvironment(sum.ID)
	if err != nil || env != EnvProd {
		t.Fatalf("ConnectionEnvironment = %q, %v", env, err)
	}

	list, _ := store.ListConnections()
	if len(list) != 1 || list[0].Environment != EnvProd {
		t.Fatalf("la lista perdió el entorno: %+v", list)
	}

	// Sin marcar es el default, y sigue siéndolo tras un update.
	if err := store.UpdateConnection(sum.ID, "prod-01", db.DBTypeSSH, "ssh://u@h:22?auth=password", "", ""); err != nil {
		t.Fatalf("UpdateConnection: %v", err)
	}
	env, _ = store.ConnectionEnvironment(sum.ID)
	if env != "" {
		t.Fatalf("el entorno debía quedar sin marcar, quedó %q", env)
	}
}
