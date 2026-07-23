import {Component, type ErrorInfo, type ReactNode} from 'react'
import Icon from '../Icon'

interface Props {
    children: ReactNode
    // Shown in the fallback so the user knows which repository failed when
    // several tabs are open.
    label: string
}

interface State {
    error: Error | null
    stack: string
}

// Error boundary around the Git module.
//
// Without one, any exception thrown while rendering unmounts the entire React
// tree and leaves a blank white window — no sidebar, no tabs, no message. That
// happened for real here: several backend functions returned Go nil slices,
// which cross the Wails binding as JSON null, and the first `.map` on one of
// them took down the whole app with nothing on screen to explain it.
//
// The nil slices are fixed at the source (backend/git now returns empty slices),
// but the failure mode is worth keeping closed: a bug in one panel should cost
// that panel, not the application, and it should print something the user can
// report instead of a white rectangle.
//
// Class component because React has no hook equivalent — componentDidCatch is
// only available on classes.
export default class GitErrorBoundary extends Component<Props, State> {
    state: State = {error: null, stack: ''}

    static getDerivedStateFromError(error: Error): Partial<State> {
        return {error}
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Console only — never a notification: this is developer-facing detail,
        // and the component stack is where the actual culprit is named.
        console.error('[git] render error:', error, info.componentStack)
        this.setState({stack: info.componentStack ?? ''})
    }

    render() {
        if (!this.state.error) return this.props.children

        return (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-surface p-8">
                <Icon name="error" size={32} className="text-error" />
                <p className="text-sm font-medium text-on-surface">El módulo Git falló al renderizar</p>
                <p className="max-w-lg text-center text-xs text-on-surface-variant">
                    Esto es un bug de la app, no de tu repositorio ({this.props.label}). El resto de mini-tools sigue funcionando: podés cerrar esta pestaña y seguir trabajando.
                </p>
                <pre className="max-h-64 w-full max-w-2xl overflow-auto whitespace-pre-wrap break-words rounded-lg border border-outline-variant bg-surface-container-lowest p-3 font-mono text-[10px] text-on-surface-variant">
                    {this.state.error.message}
                    {this.state.stack}
                </pre>
                <button
                    onClick={() => this.setState({error: null, stack: ''})}
                    title="Volver a intentar renderizar el módulo — sirve si el error fue transitorio"
                    className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90"
                >
                    Reintentar
                </button>
            </div>
        )
    }
}
