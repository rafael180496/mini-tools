import {useEffect, useState} from 'react'
import {AppVersion} from '../../wailsjs/go/main/App'
import {updatecheck} from '../../wailsjs/go/models'
import Icon from './Icon'
import Select from './Select'
import Toggle from './Toggle'
import {EDITOR_THEME_IDS, EDITOR_THEME_LABELS} from '../codemirror/themes'

interface SettingsDialogProps {
    rememberMasterKey: boolean
    onToggleRememberMasterKey: (checked: boolean) => void
    editorThemeId: string
    onChangeEditorThemeId: (id: string) => void
    onBackupVault: () => void
    onRestoreVault: () => void
    autoBackupEnabled: boolean
    onToggleAutoBackup: (checked: boolean) => void
    autoBackupIntervalHours: number
    onChangeAutoBackupInterval: (hours: number) => void
    autoBackupPath: string
    onPickAutoBackupFolder: () => void
    updateInfo: updatecheck.Info | null
    onOpenRepo: () => void
    onClose: () => void
}

const THEME_OPTIONS = EDITOR_THEME_IDS.map((id) => ({value: id, label: EDITOR_THEME_LABELS[id]}))
const AUTO_BACKUP_HOUR_OPTIONS = Array.from({length: 23}, (_, i) => i + 1).map((h) => ({
    value: String(h),
    label: h === 1 ? '1 hora' : `${h} horas`,
}))

// Configuración general de la app (no de una conexión particular) — se abre
// desde el ícono de engranaje en la esquina del toolbar. Regla del proyecto:
// toda opción de este tipo vive acá, no suelta en el toolbar principal (ver
// .claude/rules/conventions.md). Diseño MD3: modal en surface-container-high,
// cada opción en una tarjeta surface-container-highest, agrupadas por sección
// (ver .claude/specs/design-system.md para el mapeo de roles de color).
export default function SettingsDialog({
    rememberMasterKey,
    onToggleRememberMasterKey,
    editorThemeId,
    onChangeEditorThemeId,
    onBackupVault,
    onRestoreVault,
    autoBackupEnabled,
    onToggleAutoBackup,
    autoBackupIntervalHours,
    onChangeAutoBackupInterval,
    autoBackupPath,
    onPickAutoBackupFolder,
    updateInfo,
    onOpenRepo,
    onClose,
}: SettingsDialogProps) {
    // Stamped at build time (main.appVersion). "dev" for an unstamped build.
    const [version, setVersion] = useState('')
    useEffect(() => {
        AppVersion()
            .then(setVersion)
            .catch(() => setVersion(''))
    }, [])

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[92vh] w-136 max-w-[94vw] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
            >
                {/* Header */}
                <div className="flex items-center gap-3 border-b border-outline-variant px-5 py-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                        <Icon name="settings" size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold leading-tight">Configuración</h2>
                        <p className="text-xs text-on-surface-variant">Ajustes generales de la aplicación</p>
                    </div>
                    <button
                        onClick={onClose}
                        title="Cerrar configuración"
                        className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
                    {/* Vault */}
                    <section className="flex flex-col gap-2">
                        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Vault</h3>

                        <button
                            onClick={onBackupVault}
                            title="Copia el archivo del vault (donde se guardan tus conexiones cifradas) a otra ubicación, por si necesitás restaurarlo después — pide tu clave maestra para confirmar, porque el archivo puede terminar en otra máquina"
                            className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3 text-left transition-colors hover:border-secondary/60 hover:bg-surface-variant"
                        >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/15 text-secondary">
                                <Icon name="backup" size={18} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-on-surface">Backup del vault</span>
                                <span className="block truncate text-xs text-on-surface-variant">
                                    Copia cifrada de tus conexiones. Pide la clave maestra.
                                </span>
                            </span>
                            <Icon name="chevron_right" size={20} className="shrink-0 text-on-surface-variant" />
                        </button>

                        <button
                            onClick={onRestoreVault}
                            title="Reemplaza TODO el vault actual (conexiones, snippets, historial) con el contenido de un archivo .mtbackup elegido — destructivo, pide la clave actual y la del backup, y después te pide desbloquear de nuevo"
                            className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3 text-left transition-colors hover:border-error/60 hover:bg-error-container/30"
                        >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-error/15 text-error">
                                <Icon name="restore" size={18} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-error">Restaurar backup</span>
                                <span className="block truncate text-xs text-on-surface-variant">
                                    Reemplaza todo el vault con un .mtbackup. Destructivo.
                                </span>
                            </span>
                            <Icon name="chevron_right" size={20} className="shrink-0 text-error/70" />
                        </button>
                    </section>

                    {/* Preferencias */}
                    <section className="flex flex-col gap-2">
                        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Preferencias</h3>

                        {/* Recordar clave — toggle */}
                        <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                <Icon name="key" size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-on-surface">Recordar clave maestra</span>
                                <span
                                    className="block truncate text-xs text-on-surface-variant"
                                    title="Guarda tu clave maestra en el Keychain de este equipo para no tener que escribirla cada vez. Cualquiera que pueda entrar a tu sesión del sistema podría desbloquear el vault sin conocer la clave — mismo nivel de exposición que un 'recordarme' de cualquier gestor de contraseñas."
                                >
                                    Desbloqueá con el Keychain, sin reescribir la clave.
                                </span>
                            </div>
                            <Toggle
                                checked={rememberMasterKey}
                                onChange={onToggleRememberMasterKey}
                                title={rememberMasterKey ? 'Desactivar — volver a pedir la clave siempre' : 'Activar — recordar la clave en el Keychain'}
                                ariaLabel="Recordar clave maestra"
                            />
                        </div>

                        {/* Tema del editor */}
                        <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                <Icon name="palette" size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-on-surface">Tema del editor</span>
                                <span className="block truncate text-xs text-on-surface-variant">Colores del editor SQL/Redis.</span>
                            </div>
                            <Select
                                value={editorThemeId}
                                options={THEME_OPTIONS}
                                onChange={onChangeEditorThemeId}
                                ariaLabel="Tema del editor"
                                className="w-52"
                            />
                        </div>

                        {/* Backup automático */}
                        <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                    <Icon name="schedule" size={18} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-on-surface">Backup automático</span>
                                    <span className="block truncate text-xs text-on-surface-variant">
                                        Guarda una copia del vault cada tantas horas, en la carpeta que elijas.
                                    </span>
                                </div>
                                <Toggle
                                    checked={autoBackupEnabled}
                                    onChange={onToggleAutoBackup}
                                    title={
                                        autoBackupEnabled
                                            ? 'Desactivar el backup automático del vault'
                                            : 'Activar el backup automático del vault — te va a pedir elegir una carpeta de destino'
                                    }
                                    ariaLabel="Backup automático"
                                />
                            </div>

                            {autoBackupEnabled && (
                                <div className="flex flex-col gap-2 border-t border-outline-variant pt-3 pl-12">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs text-on-surface-variant">Cada</span>
                                        <Select
                                            value={String(autoBackupIntervalHours)}
                                            options={AUTO_BACKUP_HOUR_OPTIONS}
                                            onChange={(v) => onChangeAutoBackupInterval(Number(v))}
                                            ariaLabel="Frecuencia del backup automático"
                                            title="Cada cuántas horas se genera un backup automático del vault (reemplaza el anterior, no se acumulan archivos)"
                                            className="w-28"
                                            size="sm"
                                        />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={onPickAutoBackupFolder}
                                            title="Elegí la carpeta donde se guarda el backup automático del vault. Cada backup reemplaza al anterior (mismo nombre de archivo), no se acumulan"
                                            className="flex items-center gap-1.5 rounded-md border border-outline-variant bg-surface px-2.5 py-1 text-xs font-medium text-on-surface-variant transition-colors hover:border-primary/60 hover:text-on-surface"
                                        >
                                            <Icon name="folder_open" size={14} />
                                            Elegir carpeta
                                        </button>
                                        <span
                                            className="min-w-0 flex-1 truncate text-xs text-on-surface-variant"
                                            title={autoBackupPath || 'Todavía no elegiste una carpeta'}
                                        >
                                            {autoBackupPath || 'Sin carpeta elegida'}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-center gap-1.5 border-t border-outline-variant px-5 py-2.5 text-xs text-on-surface-variant">
                    {updateInfo?.available ? (
                        <button
                            onClick={onOpenRepo}
                            title={`Hay una versión nueva disponible (v${updateInfo.latest}, la tuya es v${version || '—'}) — clic para abrir el repositorio en el navegador y descargarla`}
                            className="flex items-center gap-1.5 text-primary hover:underline"
                        >
                            <Icon name="new_releases" size={14} />
                            mini-tools v{version} · Nueva versión v{updateInfo.latest} disponible
                            <Icon name="open_in_new" size={12} />
                        </button>
                    ) : (
                        <>
                            <Icon name="info" size={14} />
                            mini-tools {version ? `v${version}` : '—'}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
