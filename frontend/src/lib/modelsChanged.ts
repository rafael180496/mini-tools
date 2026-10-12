// Aviso de que cambiaron los modelos de un servidor (se descargó o se borró uno).
//
// El selector de modelo del chat lee la lista del servidor al elegir el
// proveedor y no vuelve a leerla sola: sin un aviso, el modelo recién bajado
// no aparece hasta cambiar de proveedor. La utilidad «Modelos» publica este
// evento en `window` y quien tenga una lista abierta la relee.
//
// Es un CustomEvent y no un contexto porque quien lo emite (la pestaña de
// Modelos) y quien lo escucha (el chat, en otra pestaña) no comparten ningún
// ancestro con estado propio.

import {MODEL_SERVER_PREFIX} from './modelServers'

export const MODELS_CHANGED_EVENT = 'mini-tools:models-changed'

export interface ModelsChangedDetail {
    serverId: string
}

export function notifyModelsChanged(serverId: string) {
    window.dispatchEvent(new CustomEvent<ModelsChangedDetail>(MODELS_CHANGED_EVENT, {detail: {serverId}}))
}

// Escucha el aviso de un servidor concreto. `agentId` es el del catálogo de
// agentes (`llm:<id>`); un CLI o un id vacío nunca coinciden y no se suscriben.
// Devuelve la función que quita el listener, lista para el cleanup de un effect.
export function onModelsChangedFor(agentId: string, handler: () => void): () => void {
    if (!agentId.startsWith(MODEL_SERVER_PREFIX)) return () => {}
    const serverId = agentId.slice(MODEL_SERVER_PREFIX.length)
    const listener = (e: Event) => {
        if ((e as CustomEvent<ModelsChangedDetail>).detail?.serverId === serverId) handler()
    }
    window.addEventListener(MODELS_CHANGED_EVENT, listener)
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, listener)
}
