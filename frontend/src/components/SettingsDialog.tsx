import {useEffect, useMemo, useState} from 'react'
import {AppVersion, DefaultShellID, ListShells} from '../../wailsjs/go/main/App'
import {localterm, updatecheck} from '../../wailsjs/go/models'
import Icon from './Icon'
import {BrowserOpenURL} from '../../wailsjs/runtime'
import {DOCS_URL} from './sidebar/Sidebar'
import Select, {type SelectOption} from './Select'
import Toggle from './Toggle'
import {EDITOR_THEME_IDS, EDITOR_THEME_LABELS} from '../codemirror/themes'
import {UI_FONT_SCALES} from '../hooks/useUIFontScale'
import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, type TerminalThemeId} from '../xterm/terminalThemes'
import {TERMINAL_FONT_MAX, TERMINAL_FONT_MIN} from '../xterm/terminalFont'
import AgentSettings from './AgentSettings'
import {
    EDITOR_FONTS,
    EDITOR_FONT_SIZES,
    EDITOR_TAB_SIZES,
    EDITOR_TOOLBAR_MODES,
    editorFontStack,
    type EditorAppearance,
} from '../codemirror/editorAppearance'
import AiAccessPanel from './AiAccessPanel'

interface SettingsDialogProps {
    rememberMasterKey: boolean
    onToggleRememberMasterKey: (checked: boolean) => void
    editorThemeId: string
    onChangeEditorThemeId: (id: string) => void
    // El resto de la apariencia de los editores de código. Va y vuelve como
    // un objeto entero, no campo por campo: son seis ajustes que se editan
    // acá juntos y que los editores consumen juntos.
    editorAppearance: EditorAppearance
    onChangeEditorAppearance: (next: EditorAppearance) => void
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
    // Tamaño de letra de TODA la interfaz, en porcentaje. Distinto del cuerpo
    // del editor de acá abajo: aquello es para leer código, esto es para leer
    // la app.
    uiFontScale: number
    onChangeUIFontScale: (pct: number) => void
    updateInfo: updatecheck.Info | null
    onOpenRepo: () => void
    onClose: () => void
}

// Las secciones del modal. Agrupadas por DÓNDE se nota el ajuste, no por
// qué parte del código lo implementa: "recordar clave maestra" vivía entre
// las preferencias generales aunque lo único que hace es abrir el vault, y
// el backup automático estaba a tres pantallas del backup manual siendo la
// versión programada de lo mismo.
type SettingsSectionId = 'general' | 'vault' | 'terminal' | 'ai'

const SECTIONS: {id: SettingsSectionId; icon: string; label: string; hint: string}[] = [
    // "Apariencia" y no "Editor": desde que acá vive el tamaño de letra de
    // TODA la interfaz, la sección dejó de ser solo del editor de código. El
    // ajuste con más alcance no puede estar escondido detrás de una etiqueta
    // que sugiere que no aplica salvo que estés escribiendo SQL.
    {id: 'general', icon: 'format_size', label: 'Apariencia', hint: 'cómo se ve la app: tamaño de letra de la interfaz, y tema y tipografía del editor'},
    {id: 'vault', icon: 'lock', label: 'Vault', hint: 'la clave maestra y las copias de tus conexiones cifradas'},
    {id: 'terminal', icon: 'terminal', label: 'Terminal', hint: 'qué shell abre, con qué tipografía y con qué colores'},
    {id: 'ai', icon: 'smart_toy', label: 'IA', hint: 'qué pueden pedirle los agentes a esta app, y con qué CLI hablás'},
]

const THEME_OPTIONS = EDITOR_THEME_IDS.map((id) => ({value: id, label: EDITOR_THEME_LABELS[id]}))
const EDITOR_FONT_OPTIONS = EDITOR_FONTS.map((f) => ({value: f.id, label: f.label, hint: f.hint}))
const EDITOR_FONT_SIZE_OPTIONS = EDITOR_FONT_SIZES.map((n) => ({value: String(n), label: `${n} px`}))
const UI_FONT_SCALE_OPTIONS = UI_FONT_SCALES.map((s) => ({value: String(s.value), label: `${s.label} · ${s.value}%`, hint: s.hint}))
const EDITOR_TAB_SIZE_OPTIONS = EDITOR_TAB_SIZES.map((n) => ({value: String(n), label: `${n} espacios`}))
const EDITOR_TOOLBAR_OPTIONS = EDITOR_TOOLBAR_MODES.map((m) => ({value: m.id, label: m.label, hint: m.hint}))
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
    editorAppearance,
    onChangeEditorAppearance,
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
    uiFontScale,
    onChangeUIFontScale,
    updateInfo,
    onOpenRepo,
    onClose,
}: SettingsDialogProps) {
    // Stamped at build time (main.appVersion). "dev" for an unstamped build.
    // Qué sección está abierta. Arranca siempre en General y no se recuerda
    // entre aperturas: el modal se abre para cambiar una cosa puntual, y
    // devolverlo donde quedó la última vez esconde las otras tres detrás de
    // una decisión vieja.
    const [section, setSection] = useState<SettingsSectionId>('general')
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
                // Alto por contenido, con piso y techo, en vez de un alto fijo: tres de
                // las cuatro secciones son cortas, y un alto fijo que le entre a la
                // más larga las dejaba con media pantalla en blanco abajo. El piso
                // evita que cambiar de sección haga saltar el modal entre tamaños
                // muy distintos; el techo es lo que hace scrollear a la sección de
                // IA, que es la única larga de verdad.
                className="flex min-h-[26rem] max-h-[88vh] w-[58rem] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
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

                {/* Navegación por secciones + cuerpo de la sección abierta.
                    Antes era un solo scroll con las cinco secciones apiladas:
                    para llegar al tamaño de fuente de la terminal había que
                    pasar por el servidor MCP, el backup del vault y cuatro
                    preferencias, y ninguna de esas se estaba buscando. El
                    modal ancho existe para esto — la columna de la izquierda
                    dice qué hay y el ancho que sobra lo aprovecha el
                    contenido, no un margen. */}
                <div className="flex min-h-0 flex-1">
                    <nav
                        role="tablist"
                        aria-orientation="vertical"
                        aria-label="Secciones de configuración"
                        className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-outline-variant p-2"
                    >
                        {SECTIONS.map((sec) => {
                            const isActive = sec.id === section
                            return (
                                <button
                                    key={sec.id}
                                    role="tab"
                                    aria-selected={isActive}
                                    onClick={() => setSection(sec.id)}
                                    title={`${sec.label} — ${sec.hint}`}
                                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                                        isActive
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name={sec.icon} size={18} className="shrink-0" />
                                    <span className="min-w-0 flex-1 truncate">{sec.label}</span>
                                </button>
                            )
                        })}
                    </nav>

                    <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
                        {section === 'general' && (
                            <>
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
                                {/* Tamaño de letra de la interfaz.

                                    Va ANTES del cuerpo del editor y no al lado:
                                    es el ajuste de mayor alcance de esta
                                    pantalla —vale para los menús, las listas,
                                    los diálogos y los íconos de todos los
                                    módulos— y quien viene a Configuración
                                    porque no llega a leer la app tiene que
                                    encontrarlo antes que una preferencia del
                                    editor SQL. */}
                                <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <div className="flex items-center gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                            <Icon name="format_size" size={18} />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium text-on-surface">Tamaño de letra de la interfaz</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                Texto e íconos de toda la app, en todos los módulos.
                                            </span>
                                        </div>
                                        <Select
                                            value={String(uiFontScale)}
                                            options={UI_FONT_SCALE_OPTIONS}
                                            onChange={(v) => onChangeUIFontScale(Number(v))}
                                            ariaLabel="Tamaño de letra de la interfaz"
                                            title="Agranda o achica el texto y los íconos de la app entera: barra lateral, menús, listas, diálogos y etiquetas. No cambia el editor de código ni las terminales, que tienen su propio cuerpo acá abajo y en Terminal."
                                            className="w-52"
                                        />
                                    </div>

                                    {/* El cambio se ve en el momento y en toda
                                        la ventana, así que no hace falta una
                                        muestra aparte como la de la tipografía:
                                        la muestra es el diálogo mismo. Lo que sí
                                        hace falta es decir qué NO cambia, que es
                                        de donde salen las sorpresas. */}
                                    <p className="text-xs text-on-surface-variant">
                                        Se aplica al instante y se recuerda entre sesiones — también en la pantalla de desbloqueo. El
                                        editor de código y las terminales conservan su propio cuerpo, que se ajusta por separado.
                                    </p>
                                </div>

                                {/* Apariencia del texto. Vale para el editor SQL
                                    y para el editor de archivos del módulo Git —
                                    los dos son editores de código y no hay razón
                                    para que se vean distinto. El editor de notas
                                    queda fuera a propósito: es prosa, con
                                    tipografía de documento, ancho de lectura
                                    acotado y sin gutter (ver
                                    codemirror/markdownTheme.ts); ponerle una
                                    monoespaciada y numeración de línea sería
                                    deshacer una decisión, no aplicar una
                                    preferencia. */}
                                <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <div className="flex items-center gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                            <Icon name="text_fields" size={18} />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium text-on-surface">Tipografía</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                Fuente y cuerpo del editor SQL y del de archivos de Git.
                                            </span>
                                        </div>
                                        <Select
                                            value={editorAppearance.fontFamily}
                                            options={EDITOR_FONT_OPTIONS}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, fontFamily: v as EditorAppearance['fontFamily']})}
                                            ariaLabel="Fuente del editor"
                                            title="Solo JetBrains Mono y Hanken Grotesk vienen con la app; el resto son fuentes del sistema y dependen de que esta máquina las tenga instaladas"
                                            className="w-52"
                                        />
                                        <Select
                                            value={String(editorAppearance.fontSize)}
                                            options={EDITOR_FONT_SIZE_OPTIONS}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, fontSize: Number(v)})}
                                            ariaLabel="Cuerpo de la fuente del editor"
                                            title="Tamaño del texto en el editor, en píxeles"
                                            className="w-24"
                                        />
                                    </div>

                                    {/* Muestra en vivo, con la fuente y el cuerpo
                                        elegidos: los nombres de una lista no
                                        dicen cómo se ve una tipografía, y menos
                                        cuál de las del sistema existe realmente
                                        en esta máquina. */}
                                    <div
                                        className="overflow-x-auto rounded border border-outline-variant bg-surface-container-lowest px-3 py-2 text-on-surface"
                                        style={{fontFamily: editorFontStack(editorAppearance.fontFamily), fontSize: `${editorAppearance.fontSize}px`}}
                                    >
                                        <span className="whitespace-pre">SELECT id, nombre FROM clientes WHERE saldo &gt; 0; -- 0O1lI|</span>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <div className="flex items-center gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                            <Icon name="format_align_left" size={18} />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium text-on-surface">Comportamiento del texto</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                Ajuste de línea, numeración y ancho de la tabulación.
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            Ajustar líneas largas
                                            <span className="block text-ui-11 opacity-70">En vez de desplazarse en horizontal.</span>
                                        </span>
                                        <Toggle
                                            checked={editorAppearance.lineWrap}
                                            onChange={(checked) => onChangeEditorAppearance({...editorAppearance, lineWrap: checked})}
                                            title={editorAppearance.lineWrap ? 'Desactivar: las líneas largas se salen a la derecha y el editor se desplaza' : 'Activar: una línea larga se parte visualmente en varias, sin cambiar el texto guardado'}
                                            ariaLabel="Ajustar líneas largas"
                                        />
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            Números de línea
                                            <span className="block text-ui-11 opacity-70">La columna de la izquierda.</span>
                                        </span>
                                        <Toggle
                                            checked={editorAppearance.lineNumbers}
                                            onChange={(checked) => onChangeEditorAppearance({...editorAppearance, lineNumbers: checked})}
                                            title={editorAppearance.lineNumbers ? 'Ocultar la numeración y ganar ese ancho para el texto' : 'Mostrar la numeración de líneas'}
                                            ariaLabel="Números de línea"
                                        />
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            Tabulación
                                            <span className="block text-ui-11 opacity-70">Cuánto ocupa un Tab.</span>
                                        </span>
                                        <Select
                                            value={String(editorAppearance.tabSize)}
                                            options={EDITOR_TAB_SIZE_OPTIONS}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, tabSize: Number(v)})}
                                            ariaLabel="Ancho de la tabulación"
                                            title="A cuántos espacios equivale un Tab dentro del editor"
                                            size="sm"
                                            className="w-32"
                                        />
                                    </div>
                                </div>

                                <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                        <Icon name="toolbar" size={18} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-on-surface">Barra de acciones</span>
                                        <span className="block truncate text-xs text-on-surface-variant">
                                            Guardar, Ejecutar, Explain… Ocultarla no desactiva nada: todo tiene atajo.
                                        </span>
                                    </div>
                                    <Select
                                        value={editorAppearance.toolbar}
                                        options={EDITOR_TOOLBAR_OPTIONS}
                                        onChange={(v) => onChangeEditorAppearance({...editorAppearance, toolbar: v as EditorAppearance['toolbar']})}
                                        ariaLabel="Barra de acciones del editor"
                                        title="Normal muestra íconos y etiquetas; Compacta deja solo los íconos; Oculta la saca del todo y deja los atajos de teclado"
                                        className="w-52"
                                    />
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
                            </>
                        )}

                        {section === 'vault' && (
                            <>
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
                            </>
                        )}

                        {section === 'terminal' && (
                            <>
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
                            </>
                        )}

                        {section === 'ai' && (
                            <>
                                <AiAccessPanel />
                                <AgentSettings />
                            </>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-center gap-1.5 border-t border-outline-variant px-5 py-2.5 text-xs text-on-surface-variant">
                    {updateInfo?.available ? (
                        <button
                            onClick={onOpenRepo}
                            title={
                                updateInfo.assetName
                                    ? `Hay una versión nueva disponible (v${updateInfo.latest}, la tuya es v${version || '—'}) — clic para descargar ${updateInfo.assetName}`
                                    : `Hay una versión nueva disponible (v${updateInfo.latest}, la tuya es v${version || '—'}) — clic para abrir su página de descarga`
                            }
                            className="flex items-center gap-1.5 text-primary hover:underline"
                        >
                            <Icon name="new_releases" size={14} />
                            mini-tools v{version} · Nueva versión v{updateInfo.latest} disponible
                            <Icon name={updateInfo.downloadUrl ? 'download' : 'open_in_new'} size={12} />
                        </button>
                    ) : (
                        <>
                            <Icon name="info" size={14} />
                            mini-tools {version ? `v${version}` : '—'}
                        </>
                    )}
                    {/* La documentación también acá: Configuración es donde
                        mira quien busca ayuda y no encontró el botón de la
                        barra lateral. */}
                    <span aria-hidden className="text-outline-variant">·</span>
                    <button
                        onClick={() => BrowserOpenURL(DOCS_URL)}
                        title="Abrir la documentación en el navegador: qué hace cada módulo, ejemplos de uso y recetas de principio a fin"
                        className="flex items-center gap-1.5 hover:text-on-surface hover:underline"
                    >
                        <Icon name="help" size={14} />
                        Documentación
                        <Icon name="open_in_new" size={12} />
                    </button>
                </div>
            </div>
        </div>
    )
}
