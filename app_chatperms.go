package main

import (
	"mini-tools/backend/mcpconf"
)

// chatMCPTools devuelve lo que un CLI necesita para tener permitidas, en un
// turno headless, las herramientas del servidor MCP de mini-tools: sus nombres
// (el catálogo que el servidor declara AHORA; vacío si el servidor está
// apagado) y el nombre con el que ESE CLI tiene registrada la entrada, que
// quien la agregó a mano pudo haber cambiado.
//
// Leer la configuración del CLI es barato (Scan no devuelve error: lo que no
// puede leer simplemente no aparece) y, si la entrada no está, se usa el
// nombre por defecto.
func (a *App) chatMCPTools(agentID string) (tools []string, server string) {
	if !a.mcpEnabled() {
		return nil, ""
	}
	infos := a.mcpTools()
	tools = make([]string, 0, len(infos))
	for _, t := range infos {
		tools = append(tools, t.Name)
	}
	return tools, miniToolsServerName(agentID)
}

// miniToolsServerName busca la entrada de mini-tools en la configuración del
// agente (la global de la máquina, que es donde Conectar la escribe) y devuelve
// su nombre; si no aparece, "mini-tools".
func miniToolsServerName(agentID string) string {
	for _, s := range mcpconf.Scan("").Servers {
		if s.Agent == agentID && s.Scope == mcpconf.ScopeUser && isMiniToolsServer(s) && s.Name != "" {
			return s.Name
		}
	}
	return mcpServerName
}
