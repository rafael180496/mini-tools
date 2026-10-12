import {isModelServerAgent} from '../../lib/modelServers'

// Ícono Material Symbols de cada proveedor de IA: un servidor de modelos es un
// servidor (`dns`), y cada CLI conserva el suyo. Está en un solo lugar para que
// el selector del panel lateral y el del Chat de IA no se desincronicen.
export function agentIconName(agentId: string): string {
    if (isModelServerAgent(agentId)) return 'dns'
    if (agentId === 'claude') return 'auto_awesome'
    if (agentId === 'codex') return 'terminal'
    return 'rocket_launch'
}
