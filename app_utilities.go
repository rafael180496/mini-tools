package main

import (
	"context"
	"time"

	"mini-tools/backend/portkill"
	"mini-tools/backend/procmon"
)

// Bindings del módulo Utilidades (hoy: Port Killer y Activity Monitor).
//
// Viven en su propio archivo por la misma razón que app_localterm.go: Wails
// bindea todo método exportado de *App sin importar dónde esté declarado. El
// contrato está en .claude/specs/go-react-contract.md.
//
// Todos pasan por requireUnlocked. Listar puertos no lee el vault, pero
// terminar un proceso es una acción con los permisos del usuario sobre la
// máquina entera: misma razón por la que la terminal local también está detrás
// de la clave maestra (.claude/rules/technical.md punto 5).
//
// Ninguno deja nada corriendo: cada llamada ejecuta una herramienta del
// sistema y vuelve. Quién consulta cada cuánto es la pestaña, y solo mientras
// está abierta y a la vista.

// elevationTimeout es cuánto se espera a que el usuario escriba su contraseña o
// acepte el UAC antes de dar el pedido por abandonado.
const elevationTimeout = 2 * time.Minute

// procSampler guarda la lectura anterior del monitor de procesos: lo único que
// hace falta para convertir contadores acumulados en un % de CPU. Es un valor,
// no un servicio: no arranca nada y Reset lo vacía.
var procSampler procmon.Sampler

// ListListeningPorts devuelve los puertos TCP en escucha en esta máquina, con
// el proceso que tiene cada uno.
func (a *App) ListListeningPorts() ([]portkill.Listener, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return portkill.List(context.Background())
}

// KillProcess termina el proceso pid con los permisos de la app. Devuelve
// si ya había salido (un servidor puede atrapar el cierre ordenado y seguir
// vivo: ahí la interfaz ofrece forzar). Un proceso de otro usuario responde con
// el error de código `permission`, que es lo que lleva a pedir permisos.
func (a *App) KillProcess(pid int, force bool) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	return portkill.Kill(pid, force)
}

// KillProcessElevated es KillProcess pidiéndole al sistema permisos de
// administrador (contraseña en macOS, pkexec en Linux, UAC en Windows). Solo se
// llama después de que el usuario confirmó que quiere dar esos permisos.
func (a *App) KillProcessElevated(pid int, force bool) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), elevationTimeout)
	defer cancel()
	return portkill.KillElevated(ctx, pid, force)
}

// ProcessSnapshot lee los procesos del sistema con su CPU y su memoria, más los
// totales de la máquina. La primera llamada tarda unos 400 ms (necesita dos
// lecturas para calcular el % de CPU); las siguientes son una sola.
func (a *App) ProcessSnapshot() (*procmon.Snapshot, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return procSampler.Sample(ctx)
}

// StopProcessMonitor suelta la lectura anterior. La pestaña lo llama al
// cerrarse o quedar oculta: con la utilidad fuera de la vista el backend no
// retiene nada de ella.
func (a *App) StopProcessMonitor() error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	procSampler.Reset()
	return nil
}
