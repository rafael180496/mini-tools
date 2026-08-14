package agentchat

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Adjuntos de imagen del chat.
//
// # Por qué se escriben a un archivo
//
// Los tres CLIs reciben imágenes por RUTA —Codex con su bandera `-i`, los
// otros dos abriéndolas con su herramienta de lectura—, así que una imagen
// pegada desde el portapapeles tiene que existir en el disco antes de poder
// mandarse. No hay forma de pasársela en memoria.
//
// # Dónde, y por qué NO en el repositorio
//
// Van a un directorio propio bajo los datos de la app, nunca dentro del
// repositorio abierto. Escribir ahí ensuciaría el árbol de trabajo con
// archivos que el usuario no creó: aparecerían en Cambios, se podrían
// commitear sin querer, y confundirían justamente el panel que sirve para
// revisar lo que hizo el agente.
//
// Se limpian solos: al guardar uno nuevo se borran los que tienen más de un
// día. Es lo que evita que una carpeta crezca para siempre con capturas
// pegadas una sola vez, sin necesidad de un recolector aparte.

const (
	// maxAttachBytes acota una imagen pegada. Una captura de pantalla ronda
	// unos pocos MB; 20 es holgado para cualquiera y corta un pegado
	// accidental de algo que no es una imagen.
	maxAttachBytes = 20 << 20
	// attachTTL es cuánto vive un adjunto. Un día alcanza de sobra para la
	// conversación en la que se pegó, que es lo único para lo que sirve.
	attachTTL = 24 * time.Hour
)

// allowedExt son las extensiones que se aceptan. Es una lista blanca y no una
// negra: lo que llega es un archivo que la app va a escribir en el disco y
// después nombrarle a otro programa, así que se acepta lo que se conoce en vez
// de rechazar lo que se teme.
var allowedExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
}

// SaveAttachment escribe una imagen del portapapeles (o elegida con el
// selector) y devuelve su ruta absoluta.
//
// name viene del frontend y NO se usa como ruta: solo se le mira la extensión.
// El nombre real lo arma este código, así que un `name` con `../` adentro no
// puede escribir fuera del directorio de adjuntos.
func SaveAttachment(dir, name, dataBase64 string) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	if !allowedExt[ext] {
		return "", fmt.Errorf("agentchat: solo se adjuntan imágenes (%s no)", ext)
	}

	// El base64 puede venir como data URL desde un pegado del navegador.
	if i := strings.Index(dataBase64, ","); strings.HasPrefix(dataBase64, "data:") && i > 0 {
		dataBase64 = dataBase64[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return "", fmt.Errorf("agentchat: la imagen no se pudo decodificar: %w", err)
	}
	if len(raw) == 0 {
		return "", fmt.Errorf("agentchat: la imagen está vacía")
	}
	if len(raw) > maxAttachBytes {
		return "", fmt.Errorf("agentchat: la imagen supera el tamaño máximo")
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("agentchat: preparando el directorio de adjuntos: %w", err)
	}
	pruneAttachments(dir)

	f, err := os.CreateTemp(dir, "adjunto-*"+ext)
	if err != nil {
		return "", fmt.Errorf("agentchat: creando el adjunto: %w", err)
	}
	path := f.Name()
	if _, err := f.Write(raw); err != nil {
		f.Close()
		os.Remove(path)
		return "", fmt.Errorf("agentchat: escribiendo el adjunto: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// pruneAttachments borra los adjuntos vencidos. Se hace al guardar uno nuevo
// en vez de con una tarea de fondo: el único momento en que esta carpeta
// crece es justo este, y un recolector aparte sería una pieza más que puede
// fallar sola.
func pruneAttachments(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-attachTTL)
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "adjunto-") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}
