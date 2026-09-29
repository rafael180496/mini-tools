import type {Messages} from '../types'
import type es from '../es/lock'

const en: Messages<typeof es> = {
    switchLanguage: 'Change the interface language — it is remembered',
    toggleTheme: 'Change theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    passwordsDontMatch: 'Passwords do not match',
    wrongPassword: 'Wrong master password',
    unlockTitle: 'Unlock vault',
    createTitle: 'Create master password',
    unlockHint: 'Enter your master password to access your connections.',
    createHint: 'This password encrypts your saved connections. If you lose it, you lose the vault — there is no recovery.',
    passwordPlaceholder: 'Master password',
    confirmPlaceholder: 'Confirm password',
    unlockSubmit: 'Unlock',
    unlockSubmitTitle: 'Decrypts your saved connections with this master password',
    createSubmit: 'Create vault',
    createSubmitTitle: 'Creates the encrypted vault where your connections are stored — this password is not saved anywhere, only you know it',
    restore: {
        start: 'Restore from backup…',
        startTitle: 'Pick the .mtbackup file; then we ask for the password that backup was created with',
        title: 'Restore from backup',
        changeFile: 'Change',
        changeFileTitle: 'Pick a different backup file',
        hint: 'Enter the master password this backup was created with — most likely different from any other.',
        passwordPlaceholder: 'Backup password',
        submit: 'Restore',
        submitting: 'Restoring…',
        submitTitle: 'Checks the password against the backup and restores the vault',
    },
}
export default en
