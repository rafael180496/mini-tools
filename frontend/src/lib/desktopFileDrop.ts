import {OnFileDrop, OnFileDropOff} from '../../wailsjs/runtime'

// Files dragged from Finder/Explorer onto a zone of the app.
//
// Wails' OnFileDrop is a SINGLE global callback — calling it twice replaces
// the first handler rather than adding a second. Two SFTP panes (or an SFTP
// tab plus a hybrid tab's drawer) each registering directly would silently
// disable all but the last one. So registration goes through this module: it
// installs exactly one runtime handler and routes each drop to whichever
// registered element is under the cursor.
//
// The browser's own drag events are NOT an option here: a WebView receives
// only the file NAME from an OS drag, never the path, and an upload needs the
// path. That is the whole reason this native hook exists.

type DropHandler = (paths: string[]) => void

interface Zone {
    el: HTMLElement
    handler: DropHandler
}

const zones: Zone[] = []
let installed = false

function dispatch(x: number, y: number, paths: string[]) {
    if (paths.length === 0) return

    // Hit-test rather than trusting the drop target: Wails tells us WHERE the
    // drop happened, not which of our zones it was. elementFromPoint plus a
    // contains() walk finds the innermost registered zone, so a drawer laid
    // over a pane wins over the pane behind it.
    const target = document.elementFromPoint(x, y)
    if (!target) return
    for (let i = zones.length - 1; i >= 0; i--) {
        if (zones[i].el.contains(target)) {
            zones[i].handler(paths)
            return
        }
    }
}

// registerDropZone marks el as accepting OS file drops. Returns the unregister
// function; call it on unmount.
export function registerDropZone(el: HTMLElement, handler: DropHandler): () => void {
    // The CSS custom property is what the native layer looks for to decide a
    // drop is allowed at all (CSSDropProperty in main.go). Setting it here
    // instead of in a stylesheet keeps the marker and the handler impossible
    // to get out of sync.
    el.style.setProperty('--wails-drop-target', 'drop')

    const zone: Zone = {el, handler}
    zones.push(zone)

    if (!installed) {
        OnFileDrop(dispatch, true)
        installed = true
    }

    return () => {
        const i = zones.indexOf(zone)
        if (i >= 0) zones.splice(i, 1)
        el.style.removeProperty('--wails-drop-target')
        if (zones.length === 0 && installed) {
            OnFileDropOff()
            installed = false
        }
    }
}
