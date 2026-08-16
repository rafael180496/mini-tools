import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {NotesGraph} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Grafo de conocimiento: qué notas hay y cuáles apuntan a cuáles.
//
// **Canvas 2D y un layout dirigido por fuerzas escrito a mano**, ~80 líneas.
// No hay librería de grafos por la regla 12 (dependencias mínimas): las que
// existen traen su propio motor de render y su propio modelo de datos, y para
// una base de notas personales —decenas o cientos de nodos, no decenas de
// miles— el algoritmo clásico de repulsión + resortes alcanza y sobra. Si
// algún día no alcanza, el problema a resolver será ese, con números medidos.
//
// **Las notas privadas entran al grafo.** El cortafuegos es contra los
// agentes, no contra el usuario: poder ver cómo se relaciona lo propio es
// justamente para lo que existe esta vista. Se dibujan con el candado.

interface Node extends vault.NoteGraphNode {
    x: number
    y: number
    vx: number
    vy: number
}

interface Props {
    onOpenNote: (id: string) => void
    onClose: () => void
    // Nota abierta, para resaltarla en el grafo.
    activeNoteId: string | null
}

// Constantes del layout. Elegidas mirando el resultado, no derivadas de nada:
// lo que importa es que un grafo chico no se amontone en el centro y uno
// grande no se escape de la pantalla.
const REPULSION = 6000
const SPRING = 0.015
const SPRING_LENGTH = 90
const DAMPING = 0.85
const CENTER_PULL = 0.002

export default function NotesGraphView({onOpenNote, onClose, activeNoteId}: Props) {
    const [data, setData] = useState<vault.NoteGraphData | null>(null)
    const [error, setError] = useState('')
    const [hideOrphans, setHideOrphans] = useState(false)
    const [hidePrivate, setHidePrivate] = useState(false)
    const [hovered, setHovered] = useState<string | null>(null)
    // El bucle de animación se registra una sola vez: leer el hover y la nota
    // activa por ref evita cancelar y recrear el requestAnimationFrame en cada
    // movimiento del mouse, que es lo que hacía la versión anterior.
    const hoveredRef = useRef<string | null>(null)
    hoveredRef.current = hovered
    const activeRef = useRef<string | null>(activeNoteId)
    activeRef.current = activeNoteId
    const edgesRef = useRef<vault.NoteGraphEdge[]>([])

    const canvasRef = useRef<HTMLCanvasElement>(null)
    const nodesRef = useRef<Node[]>([])
    // `moved` distingue arrastrar de hacer clic. Sin él, soltar después de
    // mover un nodo abría la nota: la comparación anterior medía la posición
    // final contra sí misma, así que siempre daba "no se movió".
    const dragRef = useRef<{id: string; dx: number; dy: number; moved: boolean} | null>(null)
    const viewRef = useRef({zoom: 1, panX: 0, panY: 0})

    // Esc cierra, como cualquier vista a pantalla completa de la app — y como
    // lo promete el tooltip del botón de cerrar.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const reload = useCallback(() => {
        NotesGraph()
            .then(setData)
            .catch((e) => setError(String(e)))
    }, [])

    useEffect(reload, [reload])

    // El candado de un nodo se actualiza sin cerrar el grafo: si cambió la
    // privacidad mientras esta vista está abierta, acá se ve.
    useEffect(() => EventsOn('note:privacy', reload), [reload])

    const filtered = useMemo(() => {
        if (!data) return {nodes: [], edges: []}
        let nodes = data.nodes
        if (hidePrivate) nodes = nodes.filter((n) => !n.isPrivate)
        if (hideOrphans) nodes = nodes.filter((n) => n.degree > 0)
        const ids = new Set(nodes.map((n) => n.id))
        return {nodes, edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target))}
    }, [data, hidePrivate, hideOrphans])

    useEffect(() => {
        edgesRef.current = filtered.edges
    }, [filtered.edges])

    // Posiciones iniciales en círculo: arrancar todos en el mismo punto hace
    // que la repulsión los dispare de forma caótica en los primeros cuadros.
    useEffect(() => {
        const prev = new Map(nodesRef.current.map((n) => [n.id, n]))
        nodesRef.current = filtered.nodes.map((n, i) => {
            const old = prev.get(n.id)
            if (old) return {...n, x: old.x, y: old.y, vx: 0, vy: 0}
            const angle = (i / Math.max(1, filtered.nodes.length)) * Math.PI * 2
            const radius = 120 + filtered.nodes.length * 2
            return {...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0}
        })
    }, [filtered.nodes])

    // Simulación + dibujo en el mismo bucle de animación.
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        let raf = 0
        const styles = getComputedStyle(document.documentElement)
        const color = (token: string, fallback: string) =>
            styles.getPropertyValue(token).trim() || fallback

        const tick = () => {
            const nodes = nodesRef.current
            const byId = new Map(nodes.map((n) => [n.id, n]))

            // Repulsión de todos contra todos. O(n²), que a esta escala es
            // irrelevante y evita el aparato de un quadtree.
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i]
                    const b = nodes[j]
                    let dx = b.x - a.x
                    let dy = b.y - a.y
                    let d2 = dx * dx + dy * dy
                    if (d2 < 1) {
                        // Dos nodos exactamente encima: se los separa con un
                        // empujón determinista en vez de dividir por cero.
                        dx = (i - j) * 0.5
                        dy = 0.5
                        d2 = 1
                    }
                    const force = REPULSION / d2
                    const d = Math.sqrt(d2)
                    const fx = (dx / d) * force
                    const fy = (dy / d) * force
                    a.vx -= fx
                    a.vy -= fy
                    b.vx += fx
                    b.vy += fy
                }
            }

            // Resortes de las aristas.
            for (const e of edgesRef.current) {
                const a = byId.get(e.source)
                const b = byId.get(e.target)
                if (!a || !b) continue
                const dx = b.x - a.x
                const dy = b.y - a.y
                const d = Math.sqrt(dx * dx + dy * dy) || 1
                const force = (d - SPRING_LENGTH) * SPRING
                const fx = (dx / d) * force
                const fy = (dy / d) * force
                a.vx += fx
                a.vy += fy
                b.vx -= fx
                b.vy -= fy
            }

            for (const n of nodes) {
                if (dragRef.current?.id === n.id) continue
                // Atracción suave al centro: sin esto, un subgrafo aislado se
                // va de la pantalla y no vuelve nunca.
                n.vx -= n.x * CENTER_PULL
                n.vy -= n.y * CENTER_PULL
                n.vx *= DAMPING
                n.vy *= DAMPING
                n.x += n.vx
                n.y += n.vy
            }

            // --- dibujo ---
            const {width, height} = canvas
            ctx.clearRect(0, 0, width, height)
            ctx.save()
            const v = viewRef.current
            ctx.translate(width / 2 + v.panX, height / 2 + v.panY)
            ctx.scale(v.zoom, v.zoom)

            const outline = color('--color-outline-variant', '#555')
            const primary = color('--color-primary', '#7aa2f7')
            const onSurface = color('--color-on-surface', '#ddd')
            const variant = color('--color-on-surface-variant', '#999')

            ctx.lineWidth = 1
            for (const e of edgesRef.current) {
                const a = byId.get(e.source)
                const b = byId.get(e.target)
                if (!a || !b) continue
                const touching = hoveredRef.current === a.id || hoveredRef.current === b.id
                ctx.strokeStyle = touching ? primary : outline
                ctx.globalAlpha = touching ? 0.9 : 0.35
                ctx.beginPath()
                ctx.moveTo(a.x, a.y)
                ctx.lineTo(b.x, b.y)
                ctx.stroke()
            }
            ctx.globalAlpha = 1

            for (const n of nodes) {
                const r = 5 + Math.min(10, n.degree * 1.5)
                const isActive = n.id === activeRef.current
                const isHovered = n.id === hoveredRef.current
                ctx.beginPath()
                ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
                ctx.fillStyle = isActive || isHovered ? primary : outline
                ctx.fill()
                if (n.isPrivate) {
                    // El candado como anillo: dibujar un ícono dentro de un
                    // círculo de 12px sería una mancha.
                    ctx.strokeStyle = variant
                    ctx.lineWidth = 2
                    ctx.beginPath()
                    ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2)
                    ctx.stroke()
                    ctx.lineWidth = 1
                }

                // La etiqueta solo en los nodos relevantes: doscientos títulos
                // superpuestos no se leen y tapan el propio grafo.
                if (isHovered || isActive || n.degree >= 3 || nodes.length <= 25) {
                    ctx.fillStyle = isHovered || isActive ? onSurface : variant
                    ctx.font = `${isHovered || isActive ? 12 : 10}px sans-serif`
                    ctx.textAlign = 'center'
                    const label = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title || 'Sin título'
                    ctx.fillText(label, n.x, n.y + r + 12)
                }
            }
            ctx.restore()

            raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [])

    // El canvas se dimensiona en píxeles reales del dispositivo: sin esto, en
    // una pantalla Retina el grafo se ve borroso.
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const resize = () => {
            const rect = canvas.getBoundingClientRect()
            const dpr = window.devicePixelRatio || 1
            canvas.width = rect.width * dpr
            canvas.height = rect.height * dpr
            const ctx = canvas.getContext('2d')
            ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        resize()
        window.addEventListener('resize', resize)
        return () => window.removeEventListener('resize', resize)
    }, [])

    const toGraphCoords = (e: React.MouseEvent) => {
        const canvas = canvasRef.current
        if (!canvas) return {x: 0, y: 0}
        const rect = canvas.getBoundingClientRect()
        const v = viewRef.current
        return {
            x: (e.clientX - rect.left - rect.width / 2 - v.panX) / v.zoom,
            y: (e.clientY - rect.top - rect.height / 2 - v.panY) / v.zoom,
        }
    }

    const nodeAt = (x: number, y: number) =>
        nodesRef.current.find((n) => {
            const r = 5 + Math.min(10, n.degree * 1.5) + 4
            return (n.x - x) ** 2 + (n.y - y) ** 2 <= r * r
        })

    return (
        <div className="fixed inset-0 z-20 flex flex-col bg-background">
            <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container px-3 py-1.5 text-[11px]">
                <Icon name="hub" size={15} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">Grafo de conocimiento</span>
                {data && (
                    <span className="text-on-surface-variant">
                        {filtered.nodes.length} notas · {filtered.edges.length} enlaces
                        {data.selfLinks > 0 && (
                            <span
                                className="ml-1 text-on-surface-variant/70"
                                title="Notas que se enlazan a sí mismas. No se dibujan —una línea de un nodo a sí mismo no dice nada— pero se cuentan acá: si no, el enlace aparece en el panel lateral de la nota y en el grafo no se ve ninguna línea, y el grafo parece roto."
                            >
                                · {data.selfLinks} a sí misma
                            </span>
                        )}
                        {data.brokenLinks > 0 && (
                            <span
                                className="ml-1 text-tertiary"
                                title="Enlaces que apuntan a notas que todavía no existen. No se dibujan porque no hay a dónde ponerlos, pero se cuentan: son el trabajo pendiente de tu base."
                            >
                                · {data.brokenLinks} sin destino
                            </span>
                        )}
                    </span>
                )}

                <label
                    className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-on-surface-variant"
                    title="Oculta las notas que no enlazan ni son enlazadas por ninguna otra"
                >
                    <input type="checkbox" checked={hideOrphans} onChange={(e) => setHideOrphans(e.target.checked)} />
                    Sin huérfanas
                </label>
                <label
                    className="flex shrink-0 cursor-pointer items-center gap-1 text-on-surface-variant"
                    title="Oculta las notas marcadas como privadas. Solo cambia esta vista: siguen existiendo y siguen sin ser legibles para los agentes."
                >
                    <input type="checkbox" checked={hidePrivate} onChange={(e) => setHidePrivate(e.target.checked)} />
                    Sin privadas
                </label>
                <button
                    onClick={onClose}
                    title="Cierra el grafo y vuelve a lo que estabas haciendo (Esc)"
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>

            {error && <p className="p-3 text-xs text-error">{error}</p>}

            {data && data.nodes.length === 0 && (
                <p className="p-6 text-center text-xs text-on-surface-variant">
                    Todavía no hay notas que graficar. Escribí <span className="font-mono">[[Otra nota]]</span> dentro de
                    una para empezar a conectarlas.
                </p>
            )}

            <canvas
                ref={canvasRef}
                className="min-h-0 flex-1 cursor-grab"
                title="Arrastrá un nodo para moverlo, el fondo para desplazar el grafo, y la rueda para acercar. Un clic abre la nota."
                onMouseDown={(e) => {
                    const {x, y} = toGraphCoords(e)
                    const hit = nodeAt(x, y)
                    if (hit) dragRef.current = {id: hit.id, dx: hit.x - x, dy: hit.y - y, moved: false}
                    else
                        dragRef.current = {
                            id: '',
                            dx: e.clientX - viewRef.current.panX,
                            dy: e.clientY - viewRef.current.panY,
                            moved: false,
                        }
                }}
                onMouseMove={(e) => {
                    const {x, y} = toGraphCoords(e)
                    const drag = dragRef.current
                    if (drag?.id) {
                        const n = nodesRef.current.find((k) => k.id === drag.id)
                        if (n) {
                            const nx = x + drag.dx
                            const ny = y + drag.dy
                            if (Math.abs(nx - n.x) > 0.5 || Math.abs(ny - n.y) > 0.5) drag.moved = true
                            n.x = nx
                            n.y = ny
                            n.vx = 0
                            n.vy = 0
                        }
                        return
                    }
                    if (drag) {
                        viewRef.current.panX = e.clientX - drag.dx
                        viewRef.current.panY = e.clientY - drag.dy
                        return
                    }
                    setHovered(nodeAt(x, y)?.id ?? null)
                }}
                onMouseUp={() => {
                    const drag = dragRef.current
                    dragRef.current = null
                    // Un clic sin arrastre abre la nota; uno con arrastre solo
                    // la mueve.
                    if (drag?.id && !drag.moved) {
                        onOpenNote(drag.id)
                        onClose()
                    }
                }}
                onWheel={(e) => {
                    const next = viewRef.current.zoom * (e.deltaY < 0 ? 1.1 : 0.9)
                    viewRef.current.zoom = Math.min(4, Math.max(0.2, next))
                }}
            />
        </div>
    )
}
