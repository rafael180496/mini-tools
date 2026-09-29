import type {Messages} from '../types'
import type es from '../es/common'

const en: Messages<typeof es> = {
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    delete: 'Delete',
    loading: 'Loading…',
    closeWithoutChanges: 'Closes without doing anything',
    closeWithoutApplying: 'Close without applying any change',
    fillRequiredFirst: 'Fill in the required field first',
    moreOptions: 'More options',
    nothingToPick: 'Nothing to pick',
    expand: 'Expand',
    collapse: 'Collapse',
    rootNoFolder: 'Root (no folder)',
    middleClickClose: ' · middle-click to close',
}
export default en
