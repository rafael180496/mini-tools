import {useEffect} from 'react'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import ModelServerForm from './ModelServerForm'
import {useT} from '../i18n'

// Diálogo «Agregar servidor de modelos», para abrirlo DESDE el selector de
// proveedor del chat sin pasar por Configuración.
//
// Existe por un malentendido real: el selector del chat lista los CLIs
// instalados, y quien tenía un Ollama en otra máquina no veía dónde agregarlo y
// concluía que había que instalar Ollama como un CLI. El encabezado lo dice sin
// vueltas —no se instala nada— y el formulario es el mismo de Configuración
// (`ModelServerForm`), no una copia reducida.
//
// También sirve para EDITAR un servidor guardado (`server`) y para DUPLICARLO
// (`template`): lo usa la lista de servidores de Utilidades → Modelos. Es el
// mismo formulario en los tres casos —no una copia reducida—; solo cambian el
// título y el aviso de arriba.
//
// Esc y el clic fuera lo cierran; guardar avisa con `onSaved` para que quien lo
// abrió elija el servidor nuevo.

interface Props {
    // Servidor guardado que se edita; sin él es un alta.
    server?: main.ModelServer
    // Servidor del que parte un alta nueva (Duplicar).
    template?: main.ModelServer
    onSaved: (saved: main.ModelServer) => void
    onClose: () => void
}

export default function ModelServerDialog({server, template, onSaved, onClose}: Props) {
    const t = useT()
    const m = t.settings.modelServers
    const d = t.models.servers.dialog

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                onClose()
            }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [onClose])

    return (
        <div
            className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose()
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="model-server-dialog-title"
                data-model-server-dialog
                className="flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-high p-5 text-on-surface shadow-lg"
            >
                <div className="flex items-start gap-2">
                    <h2 id="model-server-dialog-title" className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">
                        <Icon name={server ? 'edit' : template ? 'content_copy' : 'add_circle'} size={18} className="shrink-0 text-primary" />
                        {server ? d.editTitle({name: server.name}) : template ? d.duplicateTitle({name: template.name}) : m.dialogTitle}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        title={m.dialogCloseTitle}
                        aria-label={m.dialogClose}
                        className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>
                <p className="flex items-start gap-1.5 rounded-md bg-primary/10 px-2.5 py-2 text-xs text-on-surface-variant">
                    <Icon name={server || template ? 'info' : 'cloud_done'} size={15} className="mt-px shrink-0 text-primary" />
                    {server ? d.editIntro : template ? d.duplicateIntro : m.dialogIntro}
                </p>
                <ModelServerForm server={server ?? null} template={template} onSaved={onSaved} onCancel={onClose} bare autoFocus />
            </div>
        </div>
    )
}
