import Icon from './Icon'
import {EDITOR_THEME_IDS, EDITOR_THEME_LABELS} from '../codemirror/themes'

interface SettingsDialogProps {
    rememberMasterKey: boolean
    onToggleRememberMasterKey: (checked: boolean) => void
    editorThemeId: string
    onChangeEditorThemeId: (id: string) => void
    onBackupVault: () => void
    onClose: () => void
}

// Configuración general de la app (no de una conexión particular) — se abre
// desde el ícono de engranaje en la esquina del toolbar. Regla del proyecto:
// toda opción de este tipo vive acá, no suelta en el toolbar principal (ver
// .claude/rules/conventions.md). Mismo patrón visual que
// PasswordConfirmDialog: modal temado con los tokens semánticos de
// Material Design 3, no clases neutral-* hardcodeadas.
export default function SettingsDialog({
    rememberMasterKey,
    onToggleRememberMasterKey,
    editorThemeId,
    onChangeEditorThemeId,
    onBackupVault,
    onClose,
}: SettingsDialogProps) {
    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex w-96 flex-col gap-4 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg">
                <div className="flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Icon name="settings" size={18} className="text-primary" />
                        Configuración
                    </h2>
                    <button
                        onClick={onClose}
                        title="Cerrar configuración"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <div className="flex flex-col gap-1">
                    <button
                        onClick={onBackupVault}
                        title="Copia el archivo del vault (donde se guardan tus conexiones cifradas) a otra ubicación, por si necesitás restaurarlo después — pide tu clave maestra para confirmar, porque el archivo puede terminar en otra máquina"
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="backup" size={16} />
                        Backup vault
                    </button>
                    <label
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-on-surface-variant"
                        title="Guarda tu clave maestra en el Keychain de este equipo para no tener que escribirla cada vez que abrís la app. Trade-off real: cualquiera que pueda entrar a tu sesión de usuario del sistema operativo podría desbloquear el vault sin conocer la clave — mismo nivel de exposición que un 'recordarme' de cualquier gestor de contraseñas. Desactivalo para que vuelva a pedirla siempre."
                    >
                        <input
                            type="checkbox"
                            checked={rememberMasterKey}
                            onChange={(e) => onToggleRememberMasterKey(e.target.checked)}
                            className="accent-primary"
                        />
                        Recordar clave
                    </label>
                    <label
                        className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium text-on-surface-variant"
                        title="Tema de color del editor SQL/Redis. 'Automático' sigue el toggle claro/oscuro de la app en vez de un preset fijo."
                    >
                        Tema del editor
                        <select
                            value={editorThemeId}
                            onChange={(e) => onChangeEditorThemeId(e.target.value)}
                            className="rounded-md border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface"
                        >
                            {EDITOR_THEME_IDS.map((id) => (
                                <option key={id} value={id}>
                                    {EDITOR_THEME_LABELS[id]}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
            </div>
        </div>
    )
}
