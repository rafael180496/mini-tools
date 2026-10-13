import {RenameAgentChat} from '../../wailsjs/go/main/App'
import {cleanChatTitle} from './chatTitle'
import {notifyAgentChatsChanged} from './appBus'

// Renombra una conversación del historial: valida (recorta, máx. 120, vacío =
// no hace nada), la guarda —el backend también actualiza el título de la
// sesión viva— y avisa a quien tenga el historial cargado. Devuelve el nombre
// guardado, o null si no se cambió nada (vacío o fallo).
export async function renameChat(id: string, raw: string): Promise<string | null> {
    const title = cleanChatTitle(raw)
    if (!title) return null
    try {
        await RenameAgentChat(id, title)
    } catch {
        return null
    }
    notifyAgentChatsChanged()
    return title
}
