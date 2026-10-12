import {useCallback, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {
    GitCheckout,
    GitCreateBranch,
    GitCreateTag,
    GitDeleteBranch,
    GitDeleteRemoteBranch,
    GitDeleteRemoteTag,
    GitDeleteTag,
    GitFetch,
    GitInProgress,
    GitMerge,
    GitPushTag,
    GitRebase,
    GitRemoteURLForCopy,
    GitRemoveRemote,
    GitRenameBranch,
    GitSetUpstream,
    GitStashApply,
    GitStashDrop,
    GitUnsetUpstream,
} from '../../../wailsjs/go/main/App'
import {git, vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import {useT} from '../../i18n'
import type {TreeMenuEntry} from '../sidebar/TreeMenu'
import {requestGit} from '../../lib/gitBus'
import {existsLocal, localNameOfRemote, remoteTrackingNames} from '../../lib/gitRefs'
import PromptDialog from './PromptDialog'

// Lo que la barra lateral sabe de un repositorio desplegado.
export interface RepoDetail {
    branches: git.Branch[]
    remotes: git.Remote[]
    tags: git.Tag[]
    stashes: git.Stash[]
}

// Un repositorio de la barra junto con su detalle cargado: el contexto de
// cualquier acción sobre sus ramas, tags o remotos.
export interface RepoCtx {
    repo: vault.GitRepo
    detail: RepoDetail
}

// Todo lo que PromptDialog recibe menos onClose: quien lo abre es dueño de
// cerrarlo.
export interface PromptSpec {
    title: string
    label: string
    initial?: string
    placeholder?: string
    confirmLabel?: string
    secondLabel?: string
    secondPlaceholder?: string
    description?: string
    onSubmit: (value: string, second: string) => void
}

interface ConfirmSpec {
    title: string
    description: string
    confirmLabel: string
    danger?: boolean
    run: () => Promise<unknown>
}

export interface RepoRefActionsDeps {
    menu: {openAt: (e: ReactMouseEvent, items: TreeMenuEntry[]) => void}
    // Avisa que Git cambió: recarga el detalle de lo desplegado en la barra y el
    // de las pestañas abiertas. Todas las mutaciones pasan por acá.
    onChanged: () => void
    setError: (msg: string | null) => void
    // Abre (o enfoca) la pestaña del repositorio.
    onOpenRepo: (repo: vault.GitRepo) => void
    openSettings: (repo: vault.GitRepo, tab: 'identity' | 'remotes') => void
    togglePin: (repo: vault.GitRepo, name: string) => void
    isPinned: (repo: vault.GitRepo, name: string) => boolean
}

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

// useRepoRefActions concentra lo que se puede hacer desde la barra lateral con
// las ramas, los tags, los remotos y los stashes de un repositorio: los menús
// contextuales, los diálogos que piden nombre o confirmación y los pedidos a la
// pestaña del repositorio.
//
// Hasta ahora esto estaba repartido: la barra tenía un menú recortado (checkout,
// renombrar, borrar) y el resto —merge, rebase, upstream, borrar del remoto,
// anclar— solo existía en el árbol interno de la pestaña. La barra es ahora el
// único lugar donde se ven las ramas, así que el menú completo vive acá.
export function useRepoRefActions(deps: RepoRefActionsDeps) {
    const {menu, onChanged, setError, onOpenRepo, openSettings, togglePin, isPinned} = deps
    const t = useT()
    const tg = t.sidebar.git
    const tr = t.sidebar.gitRefs
    const [prompt, setPrompt] = useState<PromptSpec | null>(null)
    const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)

    // Toda mutación: errores al banner de la barra y aviso de cambio al final.
    const guard = useCallback(
        async (fn: () => Promise<unknown>): Promise<boolean> => {
            setError(null)
            try {
                await fn()
                onChanged()
                return true
            } catch (e) {
                setError(String(e))
                return false
            }
        },
        [onChanged, setError],
    )

    // Un merge o un rebase que se detiene por conflictos deja el repositorio a
    // mitad de la operación. La barra no sabe resolverlos: abre la pestaña,
    // que sí tiene el resolvedor y el aviso de «continuar / abortar».
    const surfaceInProgress = useCallback(
        async (repo: vault.GitRepo) => {
            try {
                if (await GitInProgress(repo.id)) onOpenRepo(repo)
            } catch {
                // Si ni siquiera se puede preguntar, el error de la operación
                // ya está en el banner.
            }
        },
        [onOpenRepo],
    )

    // --- Pedidos a la pestaña del repositorio ---------------------------------

    const revealBranch = useCallback(
        (repo: vault.GitRepo, b: git.Branch) => {
            onOpenRepo(repo)
            requestGit({repoId: repo.id, kind: 'reveal-branch', name: b.name, hash: b.hash})
        },
        [onOpenRepo],
    )

    const revealCommit = useCallback(
        (repo: vault.GitRepo, hash: string) => {
            onOpenRepo(repo)
            requestGit({repoId: repo.id, kind: 'reveal-commit', hash})
        },
        [onOpenRepo],
    )

    const searchInBranch = useCallback(
        (repo: vault.GitRepo, b: git.Branch) => {
            onOpenRepo(repo)
            requestGit({repoId: repo.id, kind: 'search-branch', name: b.name})
        },
        [onOpenRepo],
    )

    // --- Acciones --------------------------------------------------------------

    const checkout = useCallback(
        async (repo: vault.GitRepo, b: git.Branch) => {
            if (await guard(() => GitCheckout(repo.id, b.name))) requestGit({repoId: repo.id, kind: 'reveal-branch', name: b.name, hash: b.hash})
        },
        [guard],
    )

    const startCreateBranch = useCallback(
        (repo: vault.GitRepo, opts: {from?: string; prefix?: string} = {}) => {
            const from = opts.from ?? ''
            const prefix = opts.prefix ?? ''
            setPrompt({
                title: prefix ? tr.branchInFolderPromptTitle({prefix}) : from ? tg.createBranchFrom({from}) : tg.createBranch,
                label: tg.branchName,
                // Con el prefijo puesto, una convención de nombres se sostiene
                // sola en vez de depender de que cada uno la escriba igual.
                initial: prefix ? `${prefix}/` : '',
                placeholder: tg.branchPlaceholder,
                confirmLabel: tg.createAndSwitch,
                description: from ? tg.createBranchFromDesc({from}) : tg.createBranchDesc,
                // startPoint vacío = HEAD; checkout = true.
                onSubmit: (name) => void guard(() => GitCreateBranch(repo.id, name, from, true)),
            })
        },
        [guard, tg, tr],
    )

    const startCreateTag = useCallback(
        (repo: vault.GitRepo) => {
            setPrompt({
                title: tg.createTag,
                label: tg.tagName,
                placeholder: 'v1.0.0',
                secondLabel: tg.tagMessage,
                secondPlaceholder: tg.tagMessagePlaceholder,
                confirmLabel: tg.createTag,
                description: tg.createTagDesc,
                onSubmit: async (name, msg) => {
                    // ref vacío = HEAD
                    if (!(await guard(() => GitCreateTag(repo.id, name, '', msg)))) return
                    // «Crear el tag y pushearlo» como un solo flujo, pero con el
                    // paso de red explícito.
                    setConfirm({
                        title: tg.pushTag,
                        description: tg.pushTagDesc({name}),
                        confirmLabel: tg.push,
                        run: () => GitPushTag(repo.id, 'origin', name, new git.AuthConfig({})),
                    })
                },
            })
        },
        [guard, tg],
    )

    const mergeInto = useCallback(
        async (repo: vault.GitRepo, name: string) => {
            if (!(await guard(() => GitMerge(repo.id, name, false)))) void surfaceInProgress(repo)
        },
        [guard, surfaceInProgress],
    )

    // --- Menús -----------------------------------------------------------------

    const pinEntry = (repo: vault.GitRepo, name: string): TreeMenuEntry => {
        const pinned = isPinned(repo, name)
        return {
            label: pinned ? tr.unpinMenu : tr.pinMenu,
            icon: pinned ? 'keep_off' : 'keep',
            title: tr.pinMenuTitle,
            onSelect: () => togglePin(repo, name),
        }
    }

    // Las acciones que valen para una rama local y para una remota.
    const sharedBranchEntries = (ctx: RepoCtx, b: git.Branch): TreeMenuEntry[] => {
        const {repo, detail} = ctx
        const current = detail.branches.find((x) => x.isCurrent && !x.isRemote)
        const into = current?.name ?? tr.theCurrent
        return [
            {
                label: tr.mergeInto({into}),
                icon: 'merge',
                disabled: b.isCurrent,
                title: tr.mergeTitle({name: b.name, into}),
                onSelect: () => void mergeInto(repo, b.name),
            },
            {
                label: tr.rebaseOnto({current: current?.name ?? tr.theCurrent}),
                icon: 'low_priority',
                danger: true,
                disabled: b.isCurrent,
                title: tr.rebaseTitle({current: current?.name ?? tr.theCurrent, name: b.name}),
                onSelect: () =>
                    setConfirm({
                        title: tr.rebaseConfirmTitle,
                        description: tr.rebaseConfirmDesc({current: current?.name ? `"${current.name}"` : tr.theCurrent, name: b.name}),
                        confirmLabel: tr.rebaseConfirm,
                        danger: true,
                        run: async () => {
                            try {
                                await GitRebase(repo.id, b.name, true)
                            } catch (err) {
                                void surfaceInProgress(repo)
                                throw err
                            }
                        },
                    }),
            },
            {label: tr.searchIn, icon: 'manage_search', title: tr.searchInTitle({name: b.name}), onSelect: () => searchInBranch(repo, b)},
        ]
    }

    const localBranchMenu = (e: ReactMouseEvent, ctx: RepoCtx, b: git.Branch) => {
        const {repo, detail} = ctx
        const remoteCandidates = remoteTrackingNames(detail.branches)
        menu.openAt(e, [
            {
                label: tg.checkout,
                icon: 'check',
                disabled: b.isCurrent,
                title: b.isCurrent ? tg.alreadyOnBranch : tg.checkoutTitle({name: b.name}),
                onSelect: () => void checkout(repo, b),
            },
            {label: tr.showInGraph, icon: 'timeline', title: tr.showInGraphTitle, onSelect: () => revealBranch(repo, b)},
            'separator',
            {label: tg.branchFromHere, icon: 'call_split', onSelect: () => startCreateBranch(repo, {from: b.name})},
            ...sharedBranchEntries(ctx, b),
            'separator',
            pinEntry(repo, b.name),
            {
                label: tg.renameEllipsis,
                icon: 'edit',
                onSelect: () =>
                    setPrompt({
                        title: tg.renameBranchTitle({name: b.name}),
                        label: tg.newName,
                        initial: b.name,
                        description: tg.renameBranchDesc,
                        onSubmit: (v) => void guard(() => GitRenameBranch(repo.id, b.name, v)),
                    }),
            },
            {
                label: tr.setUpstream,
                icon: 'link',
                disabled: remoteCandidates.length === 0,
                hint: b.upstream ? undefined : tr.noUpstream,
                title: b.upstream ? `${tr.setUpstreamTitle({name: b.name})} (${tr.upstreamNow({upstream: b.upstream})})` : tr.setUpstreamTitle({name: b.name}),
                onSelect: () =>
                    setPrompt({
                        title: tr.upstreamPromptTitle({name: b.name}),
                        label: tr.remoteBranchLabel,
                        initial: b.upstream || remoteCandidates[0] || '',
                        placeholder: tr.upstreamPlaceholder,
                        description: tr.upstreamDesc({remotes: remoteCandidates.join(', ') || tr.none}),
                        onSubmit: (v) => void guard(() => GitSetUpstream(repo.id, b.name, v)),
                    }),
            },
            {
                label: tr.unsetUpstream,
                icon: 'link_off',
                disabled: !b.upstream,
                title: tr.unsetUpstreamTitle,
                onSelect: () => void guard(() => GitUnsetUpstream(repo.id, b.name)),
            },
            {label: tg.copyName, icon: 'content_copy', onSelect: () => copy(b.name)},
            'separator',
            {
                label: tg.deleteBranch,
                icon: 'delete',
                danger: true,
                disabled: b.isCurrent,
                title: b.isCurrent ? tg.cantDeleteCurrent : tg.deleteBranchTitle,
                onSelect: () =>
                    setConfirm({
                        title: tg.deleteLocalBranch,
                        description: tg.deleteLocalBranchDesc({name: b.name}),
                        confirmLabel: t.common.delete,
                        danger: true,
                        run: () => GitDeleteBranch(repo.id, b.name, true),
                    }),
            },
        ])
    }

    const remoteBranchMenu = (e: ReactMouseEvent, ctx: RepoCtx, b: git.Branch) => {
        const {repo, detail} = ctx
        // "origin/feature/x" → "feature/x": solo se saca el remoto (primer
        // segmento) y se conserva el resto aunque tenga barras.
        const localName = localNameOfRemote(b.name)
        const exists = existsLocal(detail.branches, localName)
        menu.openAt(e, [
            {label: tg.checkout, icon: 'check', title: tg.checkoutRemoteTitle, onSelect: () => void checkout(repo, b)},
            {label: tr.showInGraph, icon: 'timeline', title: tr.showInGraphTitle, onSelect: () => revealBranch(repo, b)},
            'separator',
            {
                label: tr.createLocalFrom,
                icon: 'call_split',
                disabled: exists,
                title: exists ? tr.localExists : tr.createLocalFromTitle({name: localName}),
                onSelect: () => void guard(() => GitCreateBranch(repo.id, localName, b.name, true)),
            },
            ...sharedBranchEntries(ctx, b),
            'separator',
            pinEntry(repo, b.name),
            {label: tg.copyName, icon: 'content_copy', onSelect: () => copy(b.name)},
            'separator',
            {
                label: tr.deleteRemoteBranch,
                icon: 'delete',
                danger: true,
                title: tr.deleteRemoteBranchTitle,
                onSelect: () =>
                    setConfirm({
                        title: tr.deleteRemoteBranchConfirmTitle,
                        description: tr.deleteRemoteBranchConfirmDesc({name: b.name}),
                        confirmLabel: tr.deleteFromRemote,
                        danger: true,
                        run: () => GitDeleteRemoteBranch(repo.id, b.name, new git.AuthConfig({})),
                    }),
            },
        ])
    }

    // Carpeta de ramas locales (`feature/`, `claude/`…): crear una rama con ese
    // prefijo ya puesto, o copiarlo.
    const branchFolderMenu = (e: ReactMouseEvent, repo: vault.GitRepo, folderPath: string) =>
        menu.openAt(e, [
            {label: tr.branchInFolder({folder: folderPath}), icon: 'call_split', title: tr.branchInFolderTitle, onSelect: () => startCreateBranch(repo, {prefix: folderPath})},
            {label: tr.copyPrefix({folder: folderPath}), icon: 'content_copy', onSelect: () => copy(`${folderPath}/`)},
        ])

    // Carpeta dentro de un remoto: solo se puede copiar el prefijo (completo,
    // con el remoto adelante, que es como se escribe en un comando).
    const remoteFolderMenu = (e: ReactMouseEvent, remote: string, folderPath: string) =>
        menu.openAt(e, [{label: tr.copyPrefix({folder: `${remote}/${folderPath}`}), icon: 'content_copy', onSelect: () => copy(`${remote}/${folderPath}/`)}])

    const remoteMenu = (e: ReactMouseEvent, repo: vault.GitRepo, remote: git.Remote) =>
        menu.openAt(e, [
            {
                label: tg.fetchFrom({remote: remote.name}),
                icon: 'cloud_download',
                title: tr.remoteFetchTitle({remote: remote.name}),
                onSelect: () => void guard(() => GitFetch(repo.id, new git.FetchOptions({remote: remote.name}), new git.AuthConfig({}))),
            },
            'separator',
            {
                label: tg.editRemote,
                icon: 'edit',
                title: tg.editRemoteTitle,
                // Reemplaza a los viejos «Renombrar» y «Cambiar URL», que eran
                // prompts de una línea: servían para PEGAR una URL, no para ver
                // la que estaba puesta —que es lo que hace falta cuando el
                // remoto dejó de andar porque el token embebido venció—.
                onSelect: () => openSettings(repo, 'remotes'),
            },
            {
                label: tg.copyUrl,
                icon: 'link',
                onSelect: async () => {
                    try {
                        await navigator.clipboard.writeText(await GitRemoteURLForCopy(repo.id, remote.name))
                    } catch (err) {
                        setError(String(err))
                    }
                },
            },
            'separator',
            {
                label: tg.removeRemote,
                icon: 'delete',
                danger: true,
                onSelect: () =>
                    setConfirm({
                        title: tg.removeRemote,
                        description: tg.removeRemoteDesc({name: remote.name}),
                        confirmLabel: t.sidebar.folders.deleteAction,
                        danger: true,
                        run: () => GitRemoveRemote(repo.id, remote.name),
                    }),
            },
        ])

    // Local y remoto se borran por separado a propósito: borrar un tag local lo
    // deja vivo en el servidor y viceversa, que es la sorpresa número uno de
    // trabajar con tags. Un solo «Borrar» tendría que elegir por el usuario.
    const tagMenu = (e: ReactMouseEvent, ctx: RepoCtx, tag: git.Tag) => {
        const {repo} = ctx
        const short = tag.hash.slice(0, 8)
        menu.openAt(e, [
            {label: tr.showInGraph, icon: 'timeline', title: tr.showInGraphTitle, onSelect: () => revealCommit(repo, tag.hash)},
            'separator',
            // Primero «crear rama»: sacar un tag con checkout deja el repositorio
            // en HEAD desacoplado, que es donde se pierden commits. Casi siempre
            // lo que se quiere al mirar un release es trabajar desde él.
            {
                label: tr.branchFromTag,
                icon: 'call_split',
                title: tr.branchFromTagTitle,
                onSelect: () =>
                    setPrompt({
                        title: tg.createBranchFromTag({tag: tag.name}),
                        label: tg.branchName,
                        placeholder: tg.branchPlaceholder,
                        confirmLabel: tg.createAndSwitch,
                        description: tg.createBranchFromTagDesc({hash: short}),
                        onSubmit: (v) => void guard(() => GitCreateBranch(repo.id, v, tag.name, true)),
                    }),
            },
            {label: tg.checkout, icon: 'check', title: tg.checkoutTagTitle, onSelect: () => void guard(() => GitCheckout(repo.id, tag.name))},
            {label: tg.copyName, icon: 'content_copy', onSelect: () => copy(tag.name)},
            {label: tr.copyCommit({hash: short}), icon: 'content_copy', onSelect: () => copy(tag.hash)},
            'separator',
            {label: tg.pushToOrigin, icon: 'upload', onSelect: () => void guard(() => GitPushTag(repo.id, 'origin', tag.name, new git.AuthConfig({})))},
            'separator',
            {
                label: tg.deleteTag,
                icon: 'delete',
                danger: true,
                hint: tg.localHint,
                title: tg.deleteTagTitle,
                onSelect: () =>
                    setConfirm({
                        title: tg.deleteLocalTagTitle,
                        description: tg.deleteLocalTagDesc({name: tag.name}),
                        confirmLabel: t.common.delete,
                        danger: true,
                        run: () => GitDeleteTag(repo.id, tag.name),
                    }),
            },
            {
                label: tg.deleteFromOrigin,
                icon: 'delete_forever',
                danger: true,
                hint: tg.remoteHint,
                title: tg.deleteFromOriginTitle,
                onSelect: () =>
                    setConfirm({
                        title: tg.deleteRemoteTagTitle,
                        description: tg.deleteRemoteTagDesc({name: tag.name}),
                        confirmLabel: t.common.delete,
                        danger: true,
                        run: () => GitDeleteRemoteTag(repo.id, 'origin', tag.name, new git.AuthConfig({})),
                    }),
            },
        ])
    }

    // Menú de la fila de un grupo (Ramas, Remotos, Tags).
    const groupMenu = (e: ReactMouseEvent, items: TreeMenuEntry[]) => menu.openAt(e, items)

    const stashMenu = (e: ReactMouseEvent, repo: vault.GitRepo, stash: git.Stash) =>
        menu.openAt(e, [
            {label: tg.apply, icon: 'download', title: tg.applyTitle, onSelect: () => void guard(() => GitStashApply(repo.id, stash.ref, false))},
            {label: tg.pop, icon: 'move_up', title: tg.popTitle, onSelect: () => void guard(() => GitStashApply(repo.id, stash.ref, true))},
            'separator',
            {
                label: tg.dropStash,
                icon: 'delete',
                danger: true,
                onSelect: () =>
                    setConfirm({
                        title: tg.dropStash,
                        description: tg.dropStashDesc({message: stash.message}),
                        confirmLabel: tg.drop,
                        danger: true,
                        run: () => GitStashDrop(repo.id, stash.ref),
                    }),
            },
        ])

    const dialogs: ReactNode = (
        <>
            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    description={confirm.description}
                    confirmLabel={confirm.confirmLabel}
                    danger={confirm.danger}
                    onConfirm={() => void guard(confirm.run)}
                    onClose={() => setConfirm(null)}
                />
            )}
            {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
        </>
    )

    return {
        dialogs,
        checkout,
        revealBranch,
        revealCommit,
        startCreateBranch,
        startCreateTag,
        localBranchMenu,
        remoteBranchMenu,
        branchFolderMenu,
        remoteFolderMenu,
        remoteMenu,
        groupMenu,
        tagMenu,
        stashMenu,
    }
}

export type RepoRefActions = ReturnType<typeof useRepoRefActions>
