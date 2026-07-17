interface ToggleProps {
    checked: boolean
    onChange: (checked: boolean) => void
    disabled?: boolean
    // 'md' (default) for dialogs/forms, 'sm' for compact toolbar controls.
    size?: 'sm' | 'md'
    title?: string
    ariaLabel?: string
}

// Themed on/off switch — replaces native checkboxes where a boolean setting
// reads better as a switch (MD3 style). Colors via the app's semantic tokens
// so it follows dark/light automatically.
export default function Toggle({checked, onChange, disabled, size = 'md', title, ariaLabel}: ToggleProps) {
    const track = size === 'sm' ? 'h-4.5 w-8' : 'h-6 w-11'
    const knob = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5'
    const knobOn = size === 'sm' ? 'translate-x-4' : 'translate-x-5'
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            title={title}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                checked ? 'bg-primary' : 'border border-outline bg-surface-container-lowest'
            }`}
        >
            <span
                className={`inline-block ${knob} transform rounded-full transition-transform ${
                    checked ? `${knobOn} bg-on-primary` : 'translate-x-0.5 bg-outline'
                }`}
            />
        </button>
    )
}
