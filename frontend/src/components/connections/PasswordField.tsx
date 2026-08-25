import {useState} from 'react'
import {RevealConnectionPassword} from '../../../wailsjs/go/main/App'
import PasswordConfirmDialog from '../PasswordConfirmDialog'
import Icon from '../Icon'

interface PasswordFieldProps {
    value: string
    onChange: (value: string) => void
    // La conexión que se está editando, o null en un alta. Con null no hay nada
    // guardado que recuperar y el botón "Ver la actual" no se dibuja.
    editingId: string | null
    label?: string
    inputClass: string
    labelClass: string
}

// Campo de contraseña de una conexión, con los tres gestos que hacen falta y
// que son tres cosas distintas:
//
//   - el ojo destapa lo que estás TIPEANDO;
//   - "Ver la actual" recupera del vault la contraseña YA GUARDADA (pide la
//     clave maestra);
//   - copiar manda al portapapeles lo que haya en el campo.
//
// Vale la aclaración porque el ojo sobre un campo vacío que dice "dejar en
// blanco para mantener la actual" no muestra nada, y eso se lee como que está
// roto. Son botones separados justamente para que cada uno signifique una sola
// cosa.
//
// Sirve para cualquier motor: el binding devuelve el parámetro `password` de la
// conexión, sea SSH, Postgres, Oracle, SQL Server, Mongo o Redis. La
// passphrase de una llave privada y la clave de un SQLite cifrado NO pasan por
// acá — son credenciales distintas, con su propio campo, y el binding no las
// devuelve.
export default function PasswordField({value, onChange, editingId, label = 'Password', inputClass, labelClass}: PasswordFieldProps) {
    const [visible, setVisible] = useState(false)
    const [asking, setAsking] = useState(false)
    const [notice, setNotice] = useState('')
    const [copied, setCopied] = useState(false)

    async function reveal(masterPassword: string) {
        setNotice('')
        const password = await RevealConnectionPassword(editingId ?? '', masterPassword)
        if (!password) {
            // Sin error pero sin nada que mostrar: la conexión se guardó sin
            // contraseña. Decirlo evita que un campo que sigue vacío se lea
            // como una falla.
            setNotice('Esta conexión no tiene una contraseña guardada.')
            return
        }
        onChange(password)
        // Mostrarla y dejarla tapada con puntitos sería no haberla mostrado.
        setVisible(true)
    }

    async function copy() {
        if (!value) return
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className={labelClass}>
            <div className="flex items-center gap-2">
                <span className="flex-1">{label}</span>
                {editingId && (
                    <button
                        type="button"
                        onClick={() => setAsking(true)}
                        title="Trae del vault la contraseña que ya está guardada y la deja en el campo, lista para copiar o editar. Pide tu clave maestra: verla en pantalla es una decisión aparte de tener la app abierta."
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 text-primary hover:bg-surface-variant"
                    >
                        <Icon name="key" size={13} />
                        Ver la actual
                    </button>
                )}
            </div>

            <div className="flex items-center gap-1">
                <input
                    type={visible ? 'text' : 'password'}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={editingId ? 'Dejar en blanco para mantener la actual' : undefined}
                    className={inputClass}
                />
                <button
                    type="button"
                    onClick={() => setVisible((v) => !v)}
                    disabled={!value}
                    title={
                        !value
                            ? 'No hay nada escrito para mostrar. Para ver la contraseña ya guardada usá "Ver la actual".'
                            : visible
                              ? 'Ocultar lo escrito'
                              : 'Mostrar lo escrito en el campo'
                    }
                    className="shrink-0 rounded p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                >
                    <Icon name={visible ? 'visibility_off' : 'visibility'} size={16} />
                </button>
                <button
                    type="button"
                    onClick={copy}
                    disabled={!value}
                    title={!value ? 'No hay nada en el campo para copiar' : 'Copiar al portapapeles lo que hay en el campo'}
                    className={`shrink-0 rounded p-1.5 hover:bg-surface-variant disabled:opacity-30 disabled:hover:bg-transparent ${
                        copied ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                >
                    <Icon name={copied ? 'check' : 'content_copy'} size={16} />
                </button>
            </div>

            {notice && <span className="text-ui-11 text-error">{notice}</span>}

            {asking && (
                <PasswordConfirmDialog
                    title="Ver la contraseña guardada"
                    description="Reingresá tu clave maestra para traer al campo la contraseña de esta conexión."
                    confirmLabel="Mostrar"
                    onConfirm={reveal}
                    onClose={() => setAsking(false)}
                />
            )}
        </div>
    )
}
