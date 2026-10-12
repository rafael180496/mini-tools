import * as AppApi from '../../wailsjs/go/main/App'

// Persistir el proveedor de una conversación que cambió de proveedor a mitad
// de camino (Chat de IA, de un servidor de modelos a otro).
//
// **Hace falta una función del backend que todavía puede no existir.**
// `SendAgentChat` ya acepta mandar un turno de una conversación guardada con otro
// `agentId` (la memoria viva y la que se siembra desde el historial se indexan
// por conversación, no por proveedor), pero la fila de `agent_chats` conserva el
// proveedor con que nació: sin un `SetAgentChatAgent(chatId, agentId)` el
// historial seguiría rotulando la conversación con el proveedor viejo. Mientras
// el binding no exista el cambio funciona igual en la sesión abierta, y esta
// función devuelve `false` en vez de romper; al regenerarse los bindings con él,
// se usa sola. Se busca por nombre sobre el módulo de bindings (y no con un
// import con nombre) justamente porque un import a algo que no existe no
// compilaría.

type SetAgentChatAgent = (chatId: string, agentId: string) => Promise<void>

// El nombre va en una variable para que el empaquetador no lo resuelva como un
// import estático (y avise de que el módulo no lo exporta mientras no exista).
const BINDING = 'SetAgentChatAgent'

function binding(): SetAgentChatAgent | null {
    const fn = Object.getOwnPropertyDescriptor(AppApi, BINDING)?.value ?? (AppApi as unknown as Record<string, unknown>)[BINDING]
    return typeof fn === 'function' ? (fn as SetAgentChatAgent) : null
}

// ¿El backend sabe guardar el cambio de proveedor de una conversación?
export function canPersistChatAgent(): boolean {
    return binding() !== null
}

// Guarda el proveedor nuevo de la conversación. true si quedó guardado.
export async function persistChatAgent(chatId: string, agentId: string): Promise<boolean> {
    const fn = binding()
    if (!fn) return false
    try {
        await fn(chatId, agentId)
        return true
    } catch {
        return false
    }
}
