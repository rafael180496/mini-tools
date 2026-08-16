import {useEffect, useMemo, useState} from 'react'
import {AppVersion, DefaultShellID, ListShells} from '../../wailsjs/go/main/App'
import {localterm, updatecheck} from '../../wailsjs/go/models'
import Icon from './Icon'
import Select, {type SelectOption} from './Select'
import Toggle from './Toggle'
import {EDITOR_THEME_IDS, EDITOR_THEME_LABELS} from '../codemirror/themes'
import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, type TerminalThemeId} from '../xterm/terminalThemes'
import {TERMINAL_FONT_MAX, TERMINAL_FONT_MIN} from '../xterm/terminalFont'
import AgentSettings from './AgentSettings'
import AiAccessPanel from './AiAccessPanel'

interface SettingsDialogProps {
    rememberMasterKey: boolean
    onToggleRememberMasterKey: (checked: boolean) => void
    editorThemeId: string
    onChangeEditorThemeId: (id: string) => void
    // Tema de colores compartido por TODAS las terminales de la app (las
    // sesiones SSH y la terminal local del módulo Git). Hasta ahora solo se
    // podía cambiar desde el selector de una pestaña SSH abierta, que es un
    // lugar poco obvio para una preferencia global.
    terminalThemeId: string
    onChangeTerminalThemeId: (id: TerminalThemeId) => void
    // Cuerpo de fuente de todas las terminales. También se ajusta desde la
    // barra de la propia terminal; los dos lugares escriben el mismo valor.
    terminalFontSize: number
    onChangeTerminalFontSize: (px: number) => void
    // Intérprete que abre la terminal local integrada. "" = automático.
    localShellId: string
    onChangeLocalShellId: (id: string) => void
    onBackupVault: () => void
    onRestoreVault: () => void
    autoBackupEnabled: boolean
    onToggleAutoBackup: (checked: boolean) => void
    autoBackupIntervalHours: number
    onChangeAutoBackupInterval: (hours: number) => void
    autoBackupPath: string
    onPickAutoBackupFolder: () => void
    autoSaveEnabled: boolean
    onToggleAutoSave: (checked: boolean) => void
    autoSaveIntervalSeconds: number
    onChangeAutoSaveInterval: (seconds: number) => void
    updateInfo: updatecheck.Info | null
    onOpenRepo: () => void
    onClose: () => void
}

const THEME_OPTIONS = EDITOR_THEME_IDS.map((id) => ({value: id, label: EDITOR_THEME_LABELS[id]}))
const TERMINAL_THEME_OPTIONS = TERMINAL_THEME_IDS.map((id) => ({value: id, label: TERMINAL_THEME_LABELS[id]}))
const AUTO_BACKUP_HOUR_OPTIONS = Array.from({length: 23}, (_, i) => i + 1).map((h) => ({
    value: String(h),
    label: h === 1 ? '1 hora' : `${h} horas`,
}))
const AUTO_SAVE_INTERVAL_OPTIONS = [5, 10, 15, 30, 60, 120, 300, 600].map((s) => ({
    value: String(s),
    label: s < 60 ? `${s} segundos` : s === 60 ? '1 minuto' : `${s / 60} minutos`,
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
    terminalThemeId,
    onChangeTerminalThemeId,
    terminalFontSize,
    onChangeTerminalFontSize,
    localShellId,
    onChangeLocalShellId,
    onBackupVault,
    onRestoreVault,
    autoBackupEnabled,
    onToggleAutoBackup,
    autoBackupIntervalHours,
    onChangeAutoBackupInterval,
    autoBackupPath,
    onPickAutoBackupFolder,
    autoSaveEnabled,
    onToggleAutoSave,
    autoSaveIntervalSeconds,
    onChangeAutoSaveInterval,
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

    // Shells de ESTE sistema operativo. Se piden a Go y no se hardcodean en
    // el frontend porque la lista depende de qué hay realmente instalado:
    // en Windows, Git Bash y WSL están o no según la máquina, y en macOS
    // fish suele venir de Homebrew.
    const [shells, setShells] = useState<localterm.Shell[]>([])
    const [defaultShellId, setDefaultShellId] = useState('')
    useEffect(() => {
        ListShells()
            .then((s) => setShells(s ?? []))
            .catch(() => setShells([]))
        DefaultShellID()
            .then(setDefaultShellId)
            .catch(() => setDefaultShellId(''))
    }, [])

    const shellOptions: SelectOption[] = useMemo(() => {
        const auto = shells.find((s) => s.id === defaultShellId)
        const options: SelectOption[] = [
            {
                value: '',
                label: 'Automático',
                // Nombrar cuál va a abrir convierte "Automático" en una
                // opción informada: sin esto no hay forma de saber qué se
                // está eligiendo.
                hint: auto ? `Usa ${auto.label}, el de este equipo` : 'El shell por defecto del sistema',
            },
        ]
        for (const s of shells) {
            options.push({
                value: s.id,
                label: s.label,
                // Los no instalados se listan igual, deshabilitados: omitirlos
                // no permitiría distinguir "no existe en este sistema" de "no
                // lo tenés instalado todavía", y lo segundo es accionable.
                hint: s.available ? s.path : 'No está instalado en este equipo',
                disabled: !s.available,
            })
        }
        return options
    }, [shells, defaultShellId])

    const selectedShell = shells.find((s) => s.id === localShellId)

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
                    <AiAccessPanel />

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

                        {/* Auto-guardar editores */}
                        <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                    <Icon name="save" size={18} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-on-surface">Auto-guardar editores</span>
                                    <span className="block truncate text-xs text-on-surface-variant">
                                        Guarda automáticamente las pestañas con archivo a disco cada tantos segundos.
                                    </span>
                                </div>
                                <Toggle
                                    checked={autoSaveEnabled}
                                    onChange={onToggleAutoSave}
                                    title={
                                        autoSaveEnabled
                                            ? 'Desactivar el auto-guardado de los editores'
                                            : 'Activar el auto-guardado — solo afecta pestañas que ya tienen un archivo asociado, las nuevas sin guardar no se tocan'
                                    }
                                    ariaLabel="Auto-guardar editores"
                                />
                            </div>

                            {autoSaveEnabled && (
                                <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                    <span className="text-xs text-on-surface-variant">Cada</span>
                                    <Select
                                        value={String(autoSaveIntervalSeconds)}
                                        options={AUTO_SAVE_INTERVAL_OPTIONS}
                                        onChange={(v) => onChangeAutoSaveInterval(Number(v))}
                                        ariaLabel="Frecuencia del auto-guardado"
                                        title="Cada cuántos segundos se guardan a disco las pestañas con cambios sin guardar"
                                        className="w-32"
                                        size="sm"
                                    />
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Terminal — sección propia y no dentro de Preferencias:
                        son los ajustes de una herramienta concreta (la shell
                        integrada del módulo Git y las sesiones SSH), no
                        preferencias sueltas de la app. */}
                    <section className="flex flex-col gap-2">
                        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Terminal</h3>

                        {/* Shell */}
                        <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                    <Icon name="terminal" size={18} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-on-surface">Intérprete de comandos</span>
                                    <span className="block truncate text-xs text-on-surface-variant">
                                        Qué shell abre la terminal integrada de este equipo.
                                    </span>
                                </div>
                                <Select
                                    value={localShellId}
                                    options={shellOptions}
                                    onChange={onChangeLocalShellId}
                                    ariaLabel="Intérprete de la terminal local"
                                    title="Elegí con qué shell se abre la terminal integrada (la del panel inferior de una pestaña Git). Cambiarlo reinicia las terminales abiertas: no se le puede cambiar el intérprete a un proceso que ya está corriendo."
                                    className="w-52"
                                />
                            </div>

                            {/* La nota del shell elegido explica en una línea
                                para qué sirve — la diferencia entre cmd,
                                PowerShell y Git Bash no es obvia para quien
                                abre la app por primera vez. */}
                            <p className="border-t border-outline-variant pt-3 pl-12 text-xs text-on-surface-variant">
                                {selectedShell
                                    ? selectedShell.note
                                    : 'Automático: se usa el shell que ya tenés configurado en este equipo. Es la opción segura si no sabés cuál elegir.'}
                            </p>
                        </div>

                        {/* Tamaño de fuente */}
                        <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                <Icon name="format_size" size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-on-surface">Tamaño de letra</span>
                                <span className="block truncate text-xs text-on-surface-variant">
                                    Cuerpo de fuente de la terminal local y de las SSH.
                                </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant bg-surface px-1 py-0.5">
                                <button
                                    onClick={() => onChangeTerminalFontSize(terminalFontSize - 1)}
                                    disabled={terminalFontSize <= TERMINAL_FONT_MIN}
                                    title={
                                        terminalFontSize <= TERMINAL_FONT_MIN
                                            ? `Ya estás en el mínimo (${TERMINAL_FONT_MIN}px) — más chico deja de leerse`
                                            : `Achicar a ${terminalFontSize - 1}px: entran más columnas y más líneas en la misma terminal`
                                    }
                                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <Icon name="text_decrease" size={16} />
                                </button>
                                <span className="w-10 text-center font-mono text-xs text-on-surface" title="Tamaño actual, en píxeles">
                                    {terminalFontSize}px
                                </span>
                                <button
                                    onClick={() => onChangeTerminalFontSize(terminalFontSize + 1)}
                                    disabled={terminalFontSize >= TERMINAL_FONT_MAX}
                                    title={
                                        terminalFontSize >= TERMINAL_FONT_MAX
                                            ? `Ya estás en el máximo (${TERMINAL_FONT_MAX}px) — más grande entran tan pocas columnas que la salida se rompe`
                                            : `Agrandar a ${terminalFontSize + 1}px`
                                    }
                                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <Icon name="text_increase" size={16} />
                                </button>
                            </div>
                        </div>

                        {/* Tema de terminal */}
                        <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                <Icon name="palette" size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-on-surface">Tema de terminal</span>
                                <span className="block truncate text-xs text-on-surface-variant">
                                    Colores de la terminal local y de las sesiones SSH.
                                </span>
                            </div>
                            <Select
                                value={terminalThemeId}
                                options={TERMINAL_THEME_OPTIONS}
                                onChange={(v) => onChangeTerminalThemeId(v as TerminalThemeId)}
                                ariaLabel="Tema de terminal"
                                title="Esquema de colores de todas las terminales de la app. «Automático» sigue el modo claro/oscuro general; el resto son paletas fijas. Se aplica al instante en las terminales abiertas."
                                className="w-52"
                            />
                        </div>
                    </section>

                    <AgentSettings />
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
