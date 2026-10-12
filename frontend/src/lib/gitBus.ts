// Pedidos de la barra lateral de Git a la pestaña de un repositorio.
//
// La barra es el único lugar donde se ven las ramas, los remotos, los tags y los
// stashes de cada repositorio; el grafo, en cambio, vive en la pestaña. Un clic
// en una rama o en un tag de la barra tiene que llevar el grafo hasta ese
// commit, y para eso la barra le habla a la pestaña de ESE repositorio sin
// conocerla: no comparten props (la pestaña cuelga de Workspace, la barra de
// otro lado) y un contexto nuevo sería demasiado para cuatro verbos.
//
// Cómo se entrega un pedido:
//
//   1. La barra pide abrir (o enfocar) la pestaña del repositorio con su
//      `onOpenRepo` y después llama a `requestGit(...)`.
//   2. Si la pestaña ya estaba montada, su `onGitRequest` lo atiende al
//      instante y marca el evento como atendido (`preventDefault`).
//   3. Si la pestaña se acaba de abrir, todavía no escucha: el pedido queda
//      guardado y la pestaña lo recoge al montarse con `takePendingGit`.
//
// Solo los pedidos de navegación (revelar, buscar) quedan pendientes. El aviso
// de anclas cambiadas no: una pestaña nueva lee las anclas del vault al abrir.

export type GitRequest =
    // Seleccionar la rama en la pestaña y llevar el grafo a su commit punta.
    | {repoId: string; kind: 'reveal-branch'; name: string; hash: string}
    // Llevar el grafo a un commit (el que marca un tag).
    | {repoId: string; kind: 'reveal-commit'; hash: string}
    // Acotar el buscador del grafo a la historia de una rama (`hash:<rama> `).
    | {repoId: string; kind: 'search-branch'; name: string}
    // Las ramas ancladas del repositorio cambiaron en el vault; `pinned` es la
    // lista completa y vigente. Las anclas también alimentan el «Modo foco» del
    // grafo, por eso la pestaña tiene que enterarse.
    | {repoId: string; kind: 'pinned-changed'; pinned: string[]}

const EVENT = 'mini-tools:git-request'

// Un pedido pendiente por repositorio y por tipo: si se hace clic en tres ramas
// antes de que la pestaña termine de montarse, importa la última.
// Caducan a los pocos segundos: uno que nadie recogió (la pestaña no llegó a
// abrirse) no debe dispararse minutos después, cuando alguien abra el
// repositorio por otra vía.
const PENDING_TTL_MS = 10_000
const pending = new Map<string, {req: GitRequest; at: number}>()
const keyOf = (r: GitRequest) => `${r.repoId}:${r.kind === 'reveal-commit' || r.kind === 'reveal-branch' ? 'reveal' : r.kind}`

export function requestGit(req: GitRequest): void {
    const ev = new CustomEvent<GitRequest>(EVENT, {detail: req, cancelable: true})
    const nobodyHandled = window.dispatchEvent(ev)
    if (nobodyHandled && req.kind !== 'pinned-changed') pending.set(keyOf(req), {req, at: Date.now()})
}

// La pestaña de `repoId` escucha sus pedidos. El handler se llama solo con los
// de su repositorio; el pedido se da por atendido apenas alguien lo recibe.
export function onGitRequest(repoId: string, handler: (req: GitRequest) => void): () => void {
    const listener = (e: Event) => {
        const req = (e as CustomEvent<GitRequest>).detail
        if (req.repoId !== repoId) return
        e.preventDefault()
        handler(req)
    }
    window.addEventListener(EVENT, listener)
    return () => window.removeEventListener(EVENT, listener)
}

// Lo que quedó esperando a que la pestaña de `repoId` se montara. Lo devuelve
// una sola vez: llamarlo de nuevo no repite el pedido.
export function takePendingGit(repoId: string): GitRequest[] {
    const out: GitRequest[] = []
    for (const [key, {req, at}] of pending) {
        if (req.repoId !== repoId) continue
        pending.delete(key)
        if (Date.now() - at <= PENDING_TTL_MS) out.push(req)
    }
    return out
}
