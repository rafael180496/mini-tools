package dockerctl

import (
	"context"
	"strings"
	"sync"
)

// Counts son los totales de cada sección, para el submenú de la barra lateral
// («Contenedores 6», «Imágenes 12»…). Un valor -1 es «no se pudo contar» (el
// historial de builds en un Docker sin buildx nuevo, por ejemplo): la interfaz
// no muestra número en vez de mostrar un cero que diría otra cosa.
type Counts struct {
	Containers int `json:"containers"`
	Images     int `json:"images"`
	Volumes    int `json:"volumes"`
	Networks   int `json:"networks"`
	Builds     int `json:"builds"`
}

// Counts cuenta todo con consultas de solo ids (`-q`), mucho más baratas que
// las listas completas con sus plantillas: es lo que se pide en cada
// actualización mientras la pestaña está a la vista. Corren en paralelo.
func CountAll(ctx context.Context) Counts {
	ctx, cancel := listCtx(ctx)
	defer cancel()

	count := func(args ...string) int {
		out, err := run(ctx, args...)
		if err != nil {
			return -1
		}
		n := 0
		for _, line := range strings.Split(out, "\n") {
			if strings.TrimSpace(line) != "" {
				n++
			}
		}
		return n
	}

	var c Counts
	var wg sync.WaitGroup
	for _, job := range []struct {
		dst  *int
		args []string
	}{
		{&c.Containers, []string{"ps", "-aq"}},
		{&c.Images, []string{"image", "ls", "-q"}},
		{&c.Volumes, []string{"volume", "ls", "-q"}},
		{&c.Networks, []string{"network", "ls", "-q"}},
		{&c.Builds, []string{"buildx", "history", "ls", "--format", "{{.Ref}}"}},
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			*job.dst = count(job.args...)
		}()
	}
	wg.Wait()
	return c
}
