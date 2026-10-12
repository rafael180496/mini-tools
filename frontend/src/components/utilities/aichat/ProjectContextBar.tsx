import {useCallback, useEffect, useRef, useState} from 'react'
import {AgentWorkspaceContext} from '../../../../wailsjs/go/main/App'
import type {main} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {errorText, formatNumber, useT} from '../../../i18n'

// Franja bajo la cabecera del Chat de IA con lo que la app lee SOLA del proyecto
// elegido: los archivos de instrucciones (AGENTS.md, CLAUDE.md…) y las skills.
//
// Existe para que no haya magia invisible: si el modelo se comporta según una
// regla de un archivo, ese archivo tiene que poder verse — con su ruta, de dónde
// viene (proyecto o global), cuánto pesa y si se recortó. Un contexto que cambia
// las respuestas sin que nadie pueda mirarlo es la clase de cosa que hace
// desconfiar de todo lo demás.
//
// Se relee al cambiar de proyecto y al volver a la ventana: AGENTS.md se edita
// en otro programa, y una lista vieja es peor que no mostrar ninguna.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'
const CHIP_FILES = 3

interface Props {
    // Id del contexto de trabajo: un repositorio, o `ws:<id>` para una carpeta.
    contextId: string
    // El modelo es de un servidor de modelos: ahí la app inyecta el contexto. Un
    // CLI lee sus propios archivos y la franja solo informa.
    isModelServer: boolean
    agentLabel: string
    // La pestaña está a la vista (oculta no atiende el foco de la ventana).
    visible: boolean
    // La carpeta ya no existe en el disco.
    missing: boolean
}

const baseName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

export default function ProjectContextBar({contextId, isModelServer, agentLabel, visible, missing}: Props) {
    const t = useT()
    const tc = t.utilities.aiChat.context
    const rootRef = useRef<HTMLDivElement>(null)
    const [info, setInfo] = useState<main.WorkspaceContextInfo | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [open, setOpen] = useState(false)
    // Solo vale la respuesta de la última pregunta: cambiar de proyecto con una
    // lectura en vuelo no puede pintar la lista del anterior.
    const seq = useRef(0)

    const load = useCallback(() => {
        const mine = ++seq.current
        setLoading(true)
        AgentWorkspaceContext('utilities', contextId)
            .then((r) => {
                if (mine !== seq.current) return
                setInfo(r ?? null)
                setError('')
            })
            .catch((e) => {
                if (mine !== seq.current) return
                setInfo(null)
                setError(errorText(e))
            })
            .finally(() => mine === seq.current && setLoading(false))
    }, [contextId])

    useEffect(() => {
        setInfo(null)
        setOpen(false)
        load()
    }, [load])

    // Al volver a la ventana (y mientras la pestaña está a la vista).
    useEffect(() => {
        if (!visible) return
        window.addEventListener('focus', load)
        return () => window.removeEventListener('focus', load)
    }, [visible, load])

    // El popover se cierra con Esc y con un clic fuera.
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        const onDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('mousedown', onDown)
        return () => {
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('mousedown', onDown)
        }
    }, [open])

    const instructions = info?.instructions ?? []
    const skills = info?.skills ?? []

    // Nombres sin repetir: el global y el del proyecto suelen llamarse igual.
    const names: string[] = []
    for (const i of instructions) {
        const n = baseName(i.path)
        if (!names.includes(n)) names.push(n)
    }
    const shown = names.slice(0, CHIP_FILES)
    const parts = [
        ...shown,
        ...(names.length > shown.length ? [tc.moreFiles({n: names.length - shown.length})] : []),
        ...(skills.length > 0 ? [tc.skillsCount({n: skills.length})] : []),
    ]
    const summary = loading && !info ? tc.loading : error ? tc.unavailable : parts.length > 0 ? parts.join(' · ') : tc.none

    const scopeLabel = (scope: string) => (scope === 'global' ? tc.scopeGlobal : tc.scopeProject)

    return (
        <div
            ref={rootRef}
            data-project-bar
            className="relative flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-outline-variant bg-surface-container-low px-3 py-1 text-ui-11"
        >
            <button
                type="button"
                data-context-chip
                onClick={() => {
                    setOpen((v) => !v)
                    if (!open) load()
                }}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={tc.chipTitle}
                className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-outline-variant px-2 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${
                    open ? 'bg-surface-variant text-on-surface' : ''
                } ${FOCUS}`}
            >
                <Icon name="rule_folder" size={13} className="shrink-0 text-primary" />
                <span className="shrink-0 font-medium text-on-surface">{tc.label}:</span>
                <span className="min-w-0 truncate font-mono">{summary}</span>
                <Icon name="expand_more" size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {info?.isGit && info.branch && (
                <span className="flex items-center gap-1 text-on-surface-variant" title={tc.branchTitle({branch: info.branch})}>
                    <Icon name="account_tree" size={12} />
                    <span className="font-mono">{info.branch}</span>
                </span>
            )}
            {info && !info.isGit && (
                <span className="flex items-center gap-1 text-on-surface-variant" title={tc.notGitTitle}>
                    <Icon name="folder_open" size={12} />
                    {tc.notGit}
                </span>
            )}
            {missing && (
                <span className="flex items-center gap-1 text-error" role="alert" title={tc.missingTitle}>
                    <Icon name="folder_off" size={12} />
                    {tc.missing}
                </span>
            )}

            {open && (
                <div
                    role="dialog"
                    aria-label={tc.popoverTitle}
                    data-context-popover
                    className="absolute top-full left-3 z-20 mt-1 flex max-h-[min(28rem,60vh)] w-[min(36rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
                >
                    <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                        <Icon name="rule_folder" size={16} className="text-primary" />
                        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{tc.popoverTitle}</h2>
                        <button
                            type="button"
                            onClick={load}
                            title={tc.reloadTitle}
                            aria-label={tc.reload}
                            className={`rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
                        >
                            <Icon name="sync" size={14} className={loading ? 'animate-spin' : ''} />
                        </button>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            title={tc.closeTitle}
                            aria-label={tc.closeTitle}
                            className={`rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
                        >
                            <Icon name="close" size={14} />
                        </button>
                    </div>

                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
                        <p className="flex items-start gap-1.5 text-on-surface-variant" data-context-explain>
                            <Icon name={isModelServer ? 'bolt' : 'info'} size={13} className="mt-px shrink-0 text-primary" />
                            <span>{isModelServer ? tc.explainModelServer : tc.explainCli({agent: agentLabel})}</span>
                        </p>

                        {error && (
                            <p role="alert" className="rounded-lg border border-error/40 bg-error-container/30 px-2 py-1.5 text-error">
                                {tc.loadFailed({error})}
                            </p>
                        )}

                        {info && (
                            <>
                                <section>
                                    <h3 className="mb-1 flex items-center gap-1.5 font-medium text-on-surface">
                                        <Icon name="description" size={13} className="text-on-surface-variant" />
                                        {tc.instructionsTitle}
                                        <span className="font-normal text-on-surface-variant">({instructions.length})</span>
                                    </h3>
                                    {instructions.length === 0 ? (
                                        <p className="text-on-surface-variant">{tc.noInstructions}</p>
                                    ) : (
                                        <ul className="space-y-1">
                                            {instructions.map((i) => (
                                                <li
                                                    key={`${i.scope}:${i.path}`}
                                                    className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-surface-container px-2 py-1"
                                                >
                                                    <span className="min-w-0 flex-1 truncate font-mono" title={i.path}>
                                                        {i.path}
                                                    </span>
                                                    <span
                                                        className={`shrink-0 rounded px-1.5 text-ui-10 ${
                                                            i.scope === 'global' ? 'bg-tertiary/15 text-tertiary' : 'bg-primary/15 text-primary'
                                                        }`}
                                                        title={i.scope === 'global' ? tc.scopeGlobalTitle : tc.scopeProjectTitle}
                                                    >
                                                        {scopeLabel(i.scope)}
                                                    </span>
                                                    <span className="shrink-0 text-on-surface-variant">{tc.chars({n: formatNumber(i.chars)})}</span>
                                                    {i.truncated && (
                                                        <span
                                                            className="shrink-0 rounded bg-error-container/40 px-1.5 text-ui-10 text-error"
                                                            title={tc.truncatedTitle}
                                                        >
                                                            {tc.truncated}
                                                        </span>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {isModelServer && instructions.length > 0 && (
                                        <p className="mt-1 text-on-surface-variant">{tc.total({n: formatNumber(info.totalChars)})}</p>
                                    )}
                                </section>

                                <section>
                                    <h3 className="mb-1 flex items-center gap-1.5 font-medium text-on-surface">
                                        <Icon name="psychology" size={13} className="text-on-surface-variant" />
                                        {tc.skillsTitle}
                                        <span className="font-normal text-on-surface-variant">({skills.length})</span>
                                    </h3>
                                    {skills.length === 0 ? (
                                        <p className="text-on-surface-variant">{tc.noSkills}</p>
                                    ) : (
                                        <>
                                            <p className="mb-1 text-on-surface-variant">{tc.skillsExplain}</p>
                                            <ul className="space-y-1">
                                                {skills.map((s) => (
                                                    <li key={`${s.scope}:${s.name}:${s.path}`} className="rounded-lg bg-surface-container px-2 py-1" title={s.path}>
                                                        <div className="flex items-center gap-2">
                                                            <span className="min-w-0 flex-1 truncate font-mono font-medium">{s.name}</span>
                                                            <span
                                                                className={`shrink-0 rounded px-1.5 text-ui-10 ${
                                                                    s.scope === 'global' ? 'bg-tertiary/15 text-tertiary' : 'bg-primary/15 text-primary'
                                                                }`}
                                                                title={s.scope === 'global' ? tc.scopeGlobalTitle : tc.scopeProjectTitle}
                                                            >
                                                                {scopeLabel(s.scope)}
                                                            </span>
                                                        </div>
                                                        {s.description && <p className="line-clamp-2 text-on-surface-variant">{s.description}</p>}
                                                    </li>
                                                ))}
                                            </ul>
                                        </>
                                    )}
                                </section>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
