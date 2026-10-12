import type {git} from '../../wailsjs/go/models'
import {buildBranchTree, expandedForBranch} from './branchTree'

// Funciones puras para armar lo que la barra lateral dibuja de un repositorio
// (ramas, remotos, tags). Sin React ni llamadas a git: reciben listas y
// devuelven listas, para que se puedan leer —y cambiar— sin tocar el árbol.

// matchesRef es el filtro de texto de un repositorio: subcadena sin distinguir
// mayúsculas. Sirve para encontrar "9595" o "hotfix" entre cien ramas, no para
// patrones. Un filtro vacío deja pasar todo.
export function matchesRef(name: string, query: string): boolean {
    const q = query.trim().toLowerCase()
    return !q || name.toLowerCase().includes(q)
}

// splitPinned reparte las ramas entre ancladas y el resto, conservando el orden
// de entrada en cada grupo. Las ancladas se dibujan planas arriba de todo: la
// razón de anclar es sacarlas del montón, y volver a meterlas dentro de su
// carpeta anularía la función.
export function splitPinned(branches: git.Branch[], pinned: string[]): {pinned: git.Branch[]; rest: git.Branch[]} {
    const set = new Set(pinned)
    return {pinned: branches.filter((b) => set.has(b.name)), rest: branches.filter((b) => !set.has(b.name))}
}

// localNameOfRemote saca el prefijo del remoto: "origin/feature/x" → "feature/x".
// Solo el primer segmento es el remoto; lo que sigue puede tener más barras.
export function localNameOfRemote(remoteBranch: string): string {
    return remoteBranch.slice(remoteBranch.indexOf('/') + 1)
}

// foldersToOpenFor devuelve las carpetas del árbol de ramas locales que hay que
// abrir para que la rama actual quede a la vista. Se calcula sobre el árbol ya
// construido porque la compactación (`agpr` + `agpr/2026` en una sola fila)
// cambia qué rutas existen de verdad.
export function foldersToOpenFor(localBranches: git.Branch[], currentName: string): string[] {
    return expandedForBranch(buildBranchTree(localBranches), currentName)
}

// existsLocal dice si ya hay una rama local con ese nombre (para no ofrecer
// «crear rama local» desde una remota cuando ya existe).
export function existsLocal(branches: git.Branch[], name: string): boolean {
    return branches.some((b) => !b.isRemote && b.name === name)
}

// remoteTrackingNames son las ramas remotas que se pueden usar como upstream.
export function remoteTrackingNames(branches: git.Branch[]): string[] {
    return branches.filter((b) => b.isRemote).map((b) => b.name)
}

// shortDate recorta la fecha de un tag a AAAA-MM-DD.
export function shortDate(iso: string): string {
    return iso ? iso.slice(0, 10) : ''
}
