#!/usr/bin/env bash
# Regenera las capturas de la ayuda (index.html / es/index.html) en los dos
# idiomas: inglés en docs/screenshots/, español en docs/screenshots/es/.
#
#   ./scripts/help-shots.sh              todas las de la tabla
#   ./scripts/help-shots.sh ui-http      solo esa
#
# La tabla dice qué vista del banco (scripts/uishot.sh) produce cada archivo y
# con qué tamaño. Las capturas que NO están acá (recortes o tomas viejas de la
# app: editor.png, redis-browser.png, new-connection.png…) no se pueden
# reproducir con el banco; si cambian, hay que sumarlas a esta tabla con su
# vista.
set -euo pipefail
cd "$(dirname "$0")/.."

# archivo  vista[:sección]  ancho  alto
SHOTS='
notes-preview notespreview 1280 700
ui-files files 1100 560
notes-editor notes 1280 760
ui-history history 1200 1200
chat-usage usage 440 400
ui-redis redis 1200 640
notes-folder notesfolder 1000 620
mcp-setup mcp 460 900
ui-agentmode agentmode 1200 860
git-reflog reflog 1000 520
ui-newmenu newmenu 1200 860
ui-panelagents panelagents 1200 860
ui-chatmode chatmode 1200 860
ui-repo repo 1200 860
notes-graph notesgraph 1280 620
git-commit-graph commitgraph 1440 860
ui-http http 1440 900
ui-agents agents 1400 880
ui-workspace workspace 1440 900
sftp-dual sftp 1280 500
grid-edit gridedit 1280 400
unlock-vault unlock 1232 770
sidebar-modules sidebarsearch 1200 760
settings-editor settings 1100 820
settings-ai settings:IA 1100 800
model-servers modelservertest 1100 760
model-servers-form modelserverheaders 1100 980
model-servers-presets modelserverpresets 1100 860
model-servers-remote-guide modelserverremote 1100 1400
model-servers-context modelservercontext 1100 900
ai-model-offline healthred 1440 860
ssh-terminal sshterm 1280 420
ui-chat chat 900 700
ui-thinking thinking 900 560
chat-db chatdb 820 700
settings-full settings:Vault 1100 720
utilities-port-killer portkiller 1200 440
utilities-activity-monitor activitymonitor 1200 640
utilities-docker docker 1300 560
utilities-docker-logs dockersearch 1500 600
utilities-docker-builds dockerbuilds 1300 400
utilities-ai-chat aichat 1440 860
utilities-ai-chat-conversation aichatchat 1440 860
utilities-ai-chat-search aichatsearch 1440 860
utilities-ai-chat-wide aichatwide 1600 860
utilities-ai-chat-narrow aichatnarrow 700 860
utilities-ai-chat-resize aichatresize 1400 800
utilities-ai-chat-no-server aichatnoserver 1300 800
utilities-ai-chat-usage aichatusage 1300 860
utilities-models models 1300 560
utilities-models-pull modelspull 1300 660
utilities-models-detail modelsdetail 1300 700
utilities-models-readonly modelsopenai 1100 420
utilities-models-servers modelsservers 1300 640
utilities-models-server-edit modelsserveredit 1300 800
utilities-models-server-delete modelsserverdelete 1300 640
utilities-models-servers-empty modelsserversempty 1300 640
utilities-models-servers-narrow modelsserversnarrow 640 600
utilities-providers modelsproviders 1300 760
utilities-providers-off modelsprovidersoff 1300 700
utilities-providers-usage modelsprovidersusage 1300 560
utilities-providers-config modelsprovidersconfig 1300 700
utilities-providers-form modelsprovidersform 1100 1150
ai-chat-lost aichatlost 1440 800
ai-chat-switched aichatlostcontinue 1440 800
model-servers-add-dialog aichataddfail 1300 800
ai-code-agent-tools toolevents 1440 860
ai-code-agent-approval approvalrisky 1100 700
ai-code-agent-remote remotewarn 1440 860
ai-code-agent-norepo norepo 1440 860
ai-project-picker projectpicker 1300 760
ai-project-hint projecthint 1300 760
ai-project-auto projectauto 1300 760
ai-project-context projectcontext 1300 760
ai-project-skills projectchat 1300 760
ai-project-folders projectmanage 1300 760
ai-brain-chat brainon 1440 860
ai-brain-disabled braindisabled 1440 860
ai-brain-settings brainsettings 1100 900
ai-attach-chips attachchips 620 700
ai-attach-warn attachwarnpdf 620 700
ai-attach-drop attachdrop 620 700
ai-attach-sent attachresumed 620 700
git-sidebar gitsidebar 700 1100
git-sidebar-filter gitsidebarfilter 700 520
git-sidebar-menu gitsidebarmenu 700 1100
git-work-history gitworkhistory 1280 560
git-work-changes gitworkdiff 1280 540
git-work-stash gitworkstash 1280 470
git-work-switcher gitworkswitcher 1100 520
git-work-narrow gitworknarrow 760 560
ia-sessions-sidebar aisesssidebar 1400 1040
ia-sessions-reattach aisessreattach 1400 860
ia-sessions-split aisesssplit 1400 860
ia-sessions-approval aisessapproval 1400 860
ia-sessions-toast aisesstoast 1400 860
ia-sessions-new-menu aisessnewmenu 1400 800
ia-sessions-utilities aisessutiltabs 1400 800
ia-sessions-tab-menu aisessbgtabmenu 1400 560
ia-sessions-background-toast aisessbgclosetoast 1400 560
ia-sessions-background-list aisessbgmenu 1400 1040
ia-sessions-rename-tab aisessrenametab 1400 560
ia-sessions-open aisessopen 1400 1240
ia-sessions-open-menu aisessopenmenu 1400 1240
utilities-ai-chat-filters aichatfiltersopen 1100 740
utilities-ai-chat-filters-chips aichatfilters 1100 360
'

mkdir -p docs/screenshots/es
# Puerto propio: si hay otra captura o un `wails dev` en el 5199, no se pisan.
export UISHOT_PORT="${UISHOT_PORT:-5241}"
echo "$SHOTS" | while read -r name view w h; do
    [ -z "$name" ] && continue
    [ -n "${1:-}" ] && [ "$1" != "$name" ] && continue
    section=''
    case "$view" in *:*) section="${view#*:}"; view="${view%%:*}" ;; esac
    # Las vistas aisess* encadenan pasos (abrir una conversación, dividir, tocar
    # «Revisar») y necesitan más tiempo virtual antes de la foto.
    budget=''
    case "$view" in aisess*) budget=9000 ;; esac
    export UISHOT_BUDGET="$budget"
    UISHOT_LANG=en UISHOT_SECTION="$section" UISHOT_OUT="$PWD/docs/screenshots/$name.png" ./scripts/uishot.sh "$view" "$w" "$h" </dev/null >/dev/null
    UISHOT_LANG=es UISHOT_SECTION="$section" UISHOT_OUT="$PWD/docs/screenshots/es/$name.png" ./scripts/uishot.sh "$view" "$w" "$h" </dev/null >/dev/null
    echo "$name"
done
