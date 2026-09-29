import {useEffect, useMemo, useState} from 'react'
import {AppVersion, DefaultShellID, ListShells} from '../../wailsjs/go/main/App'
import {localterm, updatecheck} from '../../wailsjs/go/models'
import Icon from './Icon'
import {BrowserOpenURL} from '../../wailsjs/runtime'
import {docsUrl} from './sidebar/Sidebar'
import Select, {type SelectOption} from './Select'
import Toggle from './Toggle'
import {EDITOR_THEME_IDS, EDITOR_THEME_LABELS} from '../codemirror/themes'
import {UI_FONT_SCALES} from '../hooks/useUIFontScale'
import {useLanguage} from '../hooks/useLanguage'
import {LANGUAGES, formatNumber, useT, type Lang} from '../i18n'
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
    // Cómo terminó el último backup, para contarlo ACÁ.
    //
    // Antes la ruta del archivo se anunciaba en la barra de contexto del
    // toolbar de bases de datos: un renglón truncado, al lado del selector de
    // esquema y del Auto-commit, en una pantalla que no tiene nada que ver con
    // el vault y que ni siquiera está a la vista si estabas en otro módulo. El
    // resultado de una acción se cuenta donde se pidió la acción.
    backupResult: {ok: boolean; text: string} | null
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

const SECTIONS: {id: SettingsSectionId; icon: string}[] = [
    // "Apariencia" y no "Editor": desde que acá vive el tamaño de letra de
    // TODA la interfaz, la sección dejó de ser solo del editor de código. El
    // ajuste con más alcance no puede estar escondido detrás de una etiqueta
    // que sugiere que no aplica salvo que estés escribiendo SQL.
    {id: 'general', icon: 'format_size'},
    {id: 'vault', icon: 'lock'},
    {id: 'terminal', icon: 'terminal'},
    {id: 'ai', icon: 'smart_toy'},
]

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
    backupResult,
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
    const t = useT()
    const st = t.settings
    const {lang, changeLanguage} = useLanguage()

    // Las listas de opciones se arman acá y no a nivel de módulo: sus textos
    // tienen que seguir el idioma activo.
    const themeOptions = EDITOR_THEME_IDS.map((id) => ({value: id, label: EDITOR_THEME_LABELS[id]}))
    const editorFontOptions = EDITOR_FONTS.map((f) => ({value: f.id, label: st.appearance.fonts[f.id].label, hint: st.appearance.fonts[f.id].hint}))
    const editorFontSizeOptions = EDITOR_FONT_SIZES.map((n) => ({value: String(n), label: st.px(n)}))
    const uiFontScaleOptions = UI_FONT_SCALES.map((sc) => ({
        value: String(sc.value),
        label: `${st.uiScale[sc.key].label} · ${formatNumber(sc.value)}%`,
        hint: st.uiScale[sc.key].hint,
    }))
    const editorTabSizeOptions = EDITOR_TAB_SIZES.map((n) => ({value: String(n), label: st.appearance.tabSpaces(n)}))
    const editorToolbarOptions = EDITOR_TOOLBAR_MODES.map((m) => ({
        value: m.id,
        label: st.appearance.toolbarModes[m.id].label,
        hint: st.appearance.toolbarModes[m.id].hint,
    }))
    const terminalThemeOptions = TERMINAL_THEME_IDS.map((id) => ({value: id, label: TERMINAL_THEME_LABELS[id]}))
    const autoBackupHourOptions = Array.from({length: 23}, (_, i) => i + 1).map((h) => ({value: String(h), label: st.hours(h)}))
    const autoSaveIntervalOptions = [5, 10, 15, 30, 60, 120, 300, 600].map((sec) => ({value: String(sec), label: st.seconds(sec)}))
    // Stamped at build time (main.appVersion). "dev" for an unstamped build.
    // Qué sección está abierta. Arranca siempre en General y no se recuerda
    // entre aperturas: el modal se abre para cambiar una cosa puntual, y
    // devolverlo donde quedó la última vez esconde las otras tres detrás de
    // una decisión vieja.
    const [section, setSection] = useState<SettingsSectionId>('general')
    const isSection = (id: SettingsSectionId) => section === id
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
                label: st.shell.auto,
                // Nombrar cuál va a abrir convierte "Automático" en una
                // opción informada: sin esto no hay forma de saber qué se
                // está eligiendo.
                hint: auto ? st.shell.autoUses({shell: auto.label}) : st.shell.autoSystem,
            },
        ]
        for (const s of shells) {
            options.push({
                value: s.id,
                label: s.label,
                // Los no instalados se listan igual, deshabilitados: omitirlos
                // no permitiría distinguir "no existe en este sistema" de "no
                // lo tenés instalado todavía", y lo segundo es accionable.
                hint: s.available ? s.path : st.shell.notInstalled,
                disabled: !s.available,
            })
        }
        return options
    }, [shells, defaultShellId, st])

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
                        <h2 className="text-base font-semibold leading-tight">{st.title}</h2>
                        <p className="text-xs text-on-surface-variant">{st.subtitle}</p>
                    </div>
                    <button
                        onClick={onClose}
                        title={st.close}
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
                        aria-label={st.sectionsLabel}
                        className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-outline-variant p-2"
                    >
                        {SECTIONS.map((sec) => {
                            const isActive = sec.id === section
                            return (
                                <button
                                    key={sec.id}
                                    role="tab"
                                    data-section={sec.id}
                                    aria-selected={isActive}
                                    onClick={() => setSection(sec.id)}
                                    title={st.sectionTitle({label: st.sections[sec.id].label, hint: st.sections[sec.id].hint})}
                                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                                        isActive
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name={sec.icon} size={18} className="shrink-0" />
                                    <span className="min-w-0 flex-1 truncate">{st.sections[sec.id].label}</span>
                                </button>
                            )
                        })}
                    </nav>

                    <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
                        {isSection('general') && (
                            <>
                                {/* Idioma. Primero de todo: cambia TODA la
                                    pantalla, incluida esta, y quien no entiende
                                    el idioma actual tiene que encontrarlo sin
                                    leer el resto. El nombre de cada idioma va
                                    en su propio idioma ("English", "Español")
                                    por el mismo motivo. */}
                                <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                        <Icon name="translate" size={18} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-on-surface">{t.settings.language.title}</span>
                                        <span className="block truncate text-xs text-on-surface-variant">{t.settings.language.note}</span>
                                    </div>
                                    <Select
                                        value={lang}
                                        options={LANGUAGES.map((l) => ({value: l.id, label: l.label}))}
                                        onChange={(v) => changeLanguage(v as Lang)}
                                        ariaLabel={t.settings.language.title}
                                        title={t.settings.language.tooltip}
                                        className="w-52"
                                    />
                                </div>

                                {/* Tema del editor */}
                                                    <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                                            <Icon name="palette" size={18} />
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium text-on-surface">{st.appearance.editorTheme}</span>
                                                            <span className="block truncate text-xs text-on-surface-variant">{st.appearance.editorThemeHint}</span>
                                                        </div>
                                                        <Select
                                                            value={editorThemeId}
                                                            options={themeOptions}
                                                            onChange={onChangeEditorThemeId}
                                                            ariaLabel={st.appearance.editorTheme}
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
                                            <span className="block text-sm font-medium text-on-surface">{st.appearance.uiScale}</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                {st.appearance.uiScaleHint}
                                            </span>
                                        </div>
                                        <Select
                                            value={String(uiFontScale)}
                                            options={uiFontScaleOptions}
                                            onChange={(v) => onChangeUIFontScale(Number(v))}
                                            ariaLabel={st.appearance.uiScale}
                                            title={st.appearance.uiScaleTitle}
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
                                        {st.appearance.uiScaleNote}
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
                                            <span className="block text-sm font-medium text-on-surface">{st.appearance.typography}</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                {st.appearance.typographyHint}
                                            </span>
                                        </div>
                                        <Select
                                            value={editorAppearance.fontFamily}
                                            options={editorFontOptions}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, fontFamily: v as EditorAppearance['fontFamily']})}
                                            ariaLabel={st.appearance.fontLabel}
                                            title={st.appearance.fontTitle}
                                            className="w-52"
                                        />
                                        <Select
                                            value={String(editorAppearance.fontSize)}
                                            options={editorFontSizeOptions}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, fontSize: Number(v)})}
                                            ariaLabel={st.appearance.fontSizeLabel}
                                            title={st.appearance.fontSizeTitle}
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
                                        <span className="whitespace-pre">{st.appearance.fontSample}</span>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                    <div className="flex items-center gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                            <Icon name="format_align_left" size={18} />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium text-on-surface">{st.appearance.textBehavior}</span>
                                            <span className="block truncate text-xs text-on-surface-variant">
                                                {st.appearance.textBehaviorHint}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            {st.appearance.lineWrap}
                                            <span className="block text-ui-11 opacity-70">{st.appearance.lineWrapHint}</span>
                                        </span>
                                        <Toggle
                                            checked={editorAppearance.lineWrap}
                                            onChange={(checked) => onChangeEditorAppearance({...editorAppearance, lineWrap: checked})}
                                            title={editorAppearance.lineWrap ? st.appearance.lineWrapOff : st.appearance.lineWrapOn}
                                            ariaLabel={st.appearance.lineWrap}
                                        />
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            {st.appearance.lineNumbers}
                                            <span className="block text-ui-11 opacity-70">{st.appearance.lineNumbersHint}</span>
                                        </span>
                                        <Toggle
                                            checked={editorAppearance.lineNumbers}
                                            onChange={(checked) => onChangeEditorAppearance({...editorAppearance, lineNumbers: checked})}
                                            title={editorAppearance.lineNumbers ? st.appearance.lineNumbersOff : st.appearance.lineNumbersOn}
                                            ariaLabel={st.appearance.lineNumbers}
                                        />
                                    </div>

                                    <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                        <span className="min-w-0 text-xs text-on-surface-variant">
                                            {st.appearance.tabSize}
                                            <span className="block text-ui-11 opacity-70">{st.appearance.tabSizeHint}</span>
                                        </span>
                                        <Select
                                            value={String(editorAppearance.tabSize)}
                                            options={editorTabSizeOptions}
                                            onChange={(v) => onChangeEditorAppearance({...editorAppearance, tabSize: Number(v)})}
                                            ariaLabel={st.appearance.tabSizeLabel}
                                            title={st.appearance.tabSizeTitle}
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
                                        <span className="block text-sm font-medium text-on-surface">{st.appearance.toolbar}</span>
                                        <span className="block truncate text-xs text-on-surface-variant">
                                            {st.appearance.toolbarHint}
                                        </span>
                                    </div>
                                    <Select
                                        value={editorAppearance.toolbar}
                                        options={editorToolbarOptions}
                                        onChange={(v) => onChangeEditorAppearance({...editorAppearance, toolbar: v as EditorAppearance['toolbar']})}
                                        ariaLabel={st.appearance.toolbarLabel}
                                        title={st.appearance.toolbarTitle}
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
                                                                <span className="block text-sm font-medium text-on-surface">{st.appearance.autoSave}</span>
                                                                <span className="block truncate text-xs text-on-surface-variant">
                                                                    {st.appearance.autoSaveHint}
                                                                </span>
                                                            </div>
                                                            <Toggle
                                                                checked={autoSaveEnabled}
                                                                onChange={onToggleAutoSave}
                                                                title={
                                                                    autoSaveEnabled
                                                                        ? st.appearance.autoSaveOff
                                                                        : st.appearance.autoSaveOn
                                                                }
                                                                ariaLabel={st.appearance.autoSave}
                                                            />
                                                        </div>

                                                        {autoSaveEnabled && (
                                                            <div className="flex items-center justify-between gap-3 border-t border-outline-variant pt-3 pl-12">
                                                                <span className="text-xs text-on-surface-variant">{st.every}</span>
                                                                <Select
                                                                    value={String(autoSaveIntervalSeconds)}
                                                                    options={autoSaveIntervalOptions}
                                                                    onChange={(v) => onChangeAutoSaveInterval(Number(v))}
                                                                    ariaLabel={st.appearance.autoSaveIntervalLabel}
                                                                    title={st.appearance.autoSaveIntervalTitle}
                                                                    className="w-32"
                                                                    size="sm"
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                            </>
                        )}

                        {isSection('vault') && (
                            <>
                                {/* Recordar clave — toggle */}
                                                    <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                                            <Icon name="key" size={18} />
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium text-on-surface">{st.vault.remember}</span>
                                                            <span
                                                                className="block truncate text-xs text-on-surface-variant"
                                                                title={st.vault.rememberTitle}
                                                            >
                                                                {st.vault.rememberHint}
                                                            </span>
                                                        </div>
                                                        <Toggle
                                                            checked={rememberMasterKey}
                                                            onChange={onToggleRememberMasterKey}
                                                            title={rememberMasterKey ? st.vault.rememberOff : st.vault.rememberOn}
                                                            ariaLabel={st.vault.remember}
                                                        />
                                                    </div>
                                <button
                                                        onClick={onBackupVault}
                                                        title={st.vault.backupTitle}
                                                        className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3 text-left transition-colors hover:border-secondary/60 hover:bg-surface-variant"
                                                    >
                                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/15 text-secondary">
                                                            <Icon name="backup" size={18} />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium text-on-surface">{st.vault.backup}</span>
                                                            <span className="block truncate text-xs text-on-surface-variant">
                                                                {st.vault.backupHint}
                                                            </span>
                                                        </span>
                                                        <Icon name="chevron_right" size={20} className="shrink-0 text-on-surface-variant" />
                                                    </button>

                                                    {backupResult && (
                                                        <p
                                                            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                                                                backupResult.ok
                                                                    ? 'border-secondary/40 bg-secondary/10 text-secondary'
                                                                    : 'border-outline-variant bg-surface-container-highest text-on-surface-variant'
                                                            }`}
                                                        >
                                                            <Icon
                                                                name={backupResult.ok ? 'check_circle' : 'info'}
                                                                size={14}
                                                                filled={backupResult.ok}
                                                                className="mt-0.5 shrink-0"
                                                            />
                                                            {/* La ruta va ENTERA y se puede seleccionar: es
                                                                el dato por el que se hace un backup, y
                                                                truncada no sirve para ir a buscar el
                                                                archivo. */}
                                                            <span className="min-w-0 wrap-break-word select-text">{backupResult.text}</span>
                                                        </p>
                                                    )}

                                                    <button
                                                        onClick={onRestoreVault}
                                                        title={st.vault.restoreTitle}
                                                        className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3 text-left transition-colors hover:border-error/60 hover:bg-error-container/30"
                                                    >
                                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-error/15 text-error">
                                                            <Icon name="restore" size={18} />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium text-error">{st.restoreVault.title}</span>
                                                            <span className="block truncate text-xs text-on-surface-variant">
                                                                {st.vault.restoreHint}
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
                                                                <span className="block text-sm font-medium text-on-surface">{st.vault.autoBackup}</span>
                                                                <span className="block truncate text-xs text-on-surface-variant">
                                                                    {st.vault.autoBackupHint}
                                                                </span>
                                                            </div>
                                                            <Toggle
                                                                checked={autoBackupEnabled}
                                                                onChange={onToggleAutoBackup}
                                                                title={
                                                                    autoBackupEnabled
                                                                        ? st.vault.autoBackupOff
                                                                        : st.vault.autoBackupOn
                                                                }
                                                                ariaLabel={st.vault.autoBackup}
                                                            />
                                                        </div>

                                                        {autoBackupEnabled && (
                                                            <div className="flex flex-col gap-2 border-t border-outline-variant pt-3 pl-12">
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <span className="text-xs text-on-surface-variant">{st.every}</span>
                                                                    <Select
                                                                        value={String(autoBackupIntervalHours)}
                                                                        options={autoBackupHourOptions}
                                                                        onChange={(v) => onChangeAutoBackupInterval(Number(v))}
                                                                        ariaLabel={st.vault.autoBackupIntervalLabel}
                                                                        title={st.vault.autoBackupIntervalTitle}
                                                                        className="w-28"
                                                                        size="sm"
                                                                    />
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <button
                                                                        onClick={onPickAutoBackupFolder}
                                                                        title={st.vault.pickFolderTitle}
                                                                        className="flex items-center gap-1.5 rounded-md border border-outline-variant bg-surface px-2.5 py-1 text-xs font-medium text-on-surface-variant transition-colors hover:border-primary/60 hover:text-on-surface"
                                                                    >
                                                                        <Icon name="folder_open" size={14} />
                                                                        {st.vault.pickFolder}
                                                                    </button>
                                                                    <span
                                                                        className="min-w-0 flex-1 truncate text-xs text-on-surface-variant"
                                                                        title={autoBackupPath || st.vault.noFolderTitle}
                                                                    >
                                                                        {autoBackupPath || st.vault.noFolder}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                            </>
                        )}

                        {isSection('terminal') && (
                            <>
                                {/* Shell */}
                                                    <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                                        <div className="flex items-center gap-3">
                                                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                                                <Icon name="terminal" size={18} />
                                                            </span>
                                                            <div className="min-w-0 flex-1">
                                                                <span className="block text-sm font-medium text-on-surface">{st.shell.title}</span>
                                                                <span className="block truncate text-xs text-on-surface-variant">
                                                                    {st.shell.hint}
                                                                </span>
                                                            </div>
                                                            <Select
                                                                value={localShellId}
                                                                options={shellOptions}
                                                                onChange={onChangeLocalShellId}
                                                                ariaLabel={st.shell.label}
                                                                title={st.shell.selectTitle}
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
                                                                : st.shell.autoNote}
                                                        </p>
                                                    </div>

                                                    {/* Tamaño de fuente */}
                                                    <div className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                                            <Icon name="format_size" size={18} />
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium text-on-surface">{st.terminal.fontSize}</span>
                                                            <span className="block truncate text-xs text-on-surface-variant">
                                                                {st.terminal.fontSizeHint}
                                                            </span>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant bg-surface px-1 py-0.5">
                                                            <button
                                                                onClick={() => onChangeTerminalFontSize(terminalFontSize - 1)}
                                                                disabled={terminalFontSize <= TERMINAL_FONT_MIN}
                                                                title={
                                                                    terminalFontSize <= TERMINAL_FONT_MIN
                                                                        ? st.terminal.atMin({px: TERMINAL_FONT_MIN})
                                                                        : st.terminal.shrink({px: terminalFontSize - 1})
                                                                }
                                                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                                                            >
                                                                <Icon name="text_decrease" size={16} />
                                                            </button>
                                                            <span className="w-10 text-center font-mono text-xs text-on-surface" title={st.terminal.current}>
                                                                {st.pxCompact(terminalFontSize)}
                                                            </span>
                                                            <button
                                                                onClick={() => onChangeTerminalFontSize(terminalFontSize + 1)}
                                                                disabled={terminalFontSize >= TERMINAL_FONT_MAX}
                                                                title={
                                                                    terminalFontSize >= TERMINAL_FONT_MAX
                                                                        ? st.terminal.atMax({px: TERMINAL_FONT_MAX})
                                                                        : st.terminal.grow({px: terminalFontSize + 1})
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
                                                            <span className="block text-sm font-medium text-on-surface">{st.terminal.theme}</span>
                                                            <span className="block truncate text-xs text-on-surface-variant">
                                                                {st.terminal.themeHint}
                                                            </span>
                                                        </div>
                                                        <Select
                                                            value={terminalThemeId}
                                                            options={terminalThemeOptions}
                                                            onChange={(v) => onChangeTerminalThemeId(v as TerminalThemeId)}
                                                            ariaLabel={st.terminal.theme}
                                                            title={st.terminal.themeTitle}
                                                            className="w-52"
                                                        />
                                                    </div>
                            </>
                        )}

                        {isSection('ai') && (
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
                                    ? st.footer.updateDownload({latest: updateInfo.latest, current: version || '—', file: updateInfo.assetName})
                                    : st.footer.updatePage({latest: updateInfo.latest, current: version || '—'})
                            }
                            className="flex items-center gap-1.5 text-primary hover:underline"
                        >
                            <Icon name="new_releases" size={14} />
                            {st.footer.updateAvailable({current: version, latest: updateInfo.latest})}
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
                        onClick={() => BrowserOpenURL(docsUrl(lang))}
                        title={t.shell.sidebar.helpTitle}
                        className="flex items-center gap-1.5 hover:text-on-surface hover:underline"
                    >
                        <Icon name="help" size={14} />
                        {st.footer.docs}
                        <Icon name="open_in_new" size={12} />
                    </button>
                </div>
            </div>
        </div>
    )
}
