import type {Messages} from '../../types'
import type es from '../../es/gitparts/graph'

const en: Messages<typeof es> = {
    loading: 'Loading history…',
    empty: "This repository doesn't have any commits yet.",
    rowTitle: (p) =>
        `View this commit's files and diff — ${p.hash} by ${p.author}. Right-click to revert, cherry-pick, create a branch/tag or reset`,
    tag: (p) => `Tag: ${p.name}`,
    remoteBranch: (p) => `Remote branch: ${p.name}`,
    localBranch: (p) => `Local branch: ${p.name}`,
}
export default en
