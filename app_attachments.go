package main

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/appdata"
	"mini-tools/backend/llm"
)

// Adjuntos del chat con agentes: guardar, saber qué admite el destino y
// repartirlos al enviar. La lógica (clasificación, límites, formato) vive en
// backend/agentchat/attachments.go; acá solo se conecta con el vault, los
// proveedores y el directorio de datos de la app.
// El contrato para el frontend está en .claude/specs/go-react-contract.md
// («Adjuntos del chat»).

// attachCapsTimeout acota la consulta de capacidades al proveedor. Corre al
// elegir el modelo o al adjuntar, no en cada tecla, pero un servidor remoto
// lento no debe dejar el selector colgado.
const attachCapsTimeout = 10 * time.Second

// chatAttachmentsDir es la carpeta de adjuntos: bajo los datos de la app y
// NUNCA dentro del repositorio (ver agentchat/attach.go por qué).
func chatAttachmentsDir() (string, error) {
	dir, err := appdata.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "adjuntos"), nil
}

// SaveChatFile guarda un adjunto de cualquier tipo admitido (imagen, PDF,
// texto o código) y devuelve su ficha. Es el reemplazo general de
// SaveChatAttachment, que sigue existiendo solo para imágenes.
//
// El tipo se decide por el contenido, no por el nombre. Un archivo que no es
// imagen PNG/JPG/GIF/WebP, PDF ni texto UTF-8, o que supera el tope de su tipo
// (imagen 5 MB, PDF 32 MB, texto 512 KB), se rechaza con un error que dice por
// qué. Lo que devuelve `path` es lo que después se pasa en `images` de
// SendAgentChat.
func (a *App) SaveChatFile(name, dataBase64 string) (agentchat.Attachment, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentchat.Attachment{}, err
	}
	dir, err := chatAttachmentsDir()
	if err != nil {
		return agentchat.Attachment{}, err
	}
	return agentchat.SaveFile(dir, name, dataBase64)
}

// AgentAttachmentCapabilities dice qué adjuntos admite ese agente con ese
// modelo, para que la interfaz ofrezca solo lo que va a funcionar y explique el
// resto. model vacío = el modelo por defecto del proveedor.
//
//   - Servidor de modelos: lo que informe el proveedor (Ollama: «vision»;
//     Anthropic: la ficha del modelo; OpenRouter: las modalidades de entrada);
//     con otro servidor compatible con OpenAI no hay información y las imágenes
//     se suponen (known=false).
//   - CLI: lo que cada uno hace con los archivos, fijo por agente.
//
// Consultar al proveedor puede tardar (un HTTP), así que el resultado de un
// modelo se recuerda unos minutos del lado de Go.
func (a *App) AgentAttachmentCapabilities(agentID, model string) (agentchat.AttachmentCaps, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentchat.AttachmentCaps{}, err
	}
	caps, _, err := a.attachmentCaps(agentID, model)
	return caps, err
}

// attachmentCaps devuelve las capacidades y el nombre del destino para los
// mensajes de error («Ollama local · llava:7b»).
func (a *App) attachmentCaps(agentID, model string) (agentchat.AttachmentCaps, string, error) {
	agent, err := a.agentByID(agentID)
	if err != nil {
		return agentchat.AttachmentCaps{}, "", err
	}
	if !agentchat.IsLLM(agentID) {
		return agentchat.CLIAttachmentCaps(agentID), agent.Label, nil
	}
	server, client, err := a.llmServer(agentID)
	if err != nil {
		return agentchat.AttachmentCaps{}, "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), attachCapsTimeout)
	defer cancel()
	model = a.attachmentModel(ctx, server.DefaultModel, client, model)
	who := agent.Label
	if model != "" {
		who += " · " + model
	}
	return agentchat.CapsFromLLM(llm.AttachCapsOf(ctx, client, model)), who, nil
}

// attachmentModel resuelve el modelo del turno igual que el runner
// (resolveLLMModel): el elegido, el predeterminado del proveedor o el primero
// que liste el servidor. Si nada de eso se puede saber devuelve "" y la
// consulta de capacidades responde con suposiciones.
func (a *App) attachmentModel(ctx context.Context, providerDefault string, client llm.Client, model string) string {
	if model = strings.TrimSpace(model); model != "" {
		return model
	}
	if providerDefault != "" {
		return providerDefault
	}
	if d, ok := client.(interface{ DefaultModel() string }); ok && d.DefaultModel() != "" {
		return d.DefaultModel()
	}
	if names, err := client.Models(ctx); err == nil && len(names) > 0 {
		return names[0]
	}
	return ""
}

// prepareAttachments resuelve las rutas que llegaron en `images` de
// SendAgentChat, las valida contra lo que admite el destino y las reparte.
// Todo lo que sea un error de adjuntos se detecta ANTES de tocar el proveedor.
func (a *App) prepareAttachments(agentID, model string, paths []string) (agentchat.Prepared, []agentchat.Attachment, error) {
	if len(paths) == 0 {
		return agentchat.Prepared{}, nil, nil
	}
	dir, err := chatAttachmentsDir()
	if err != nil {
		return agentchat.Prepared{}, nil, err
	}
	atts, err := agentchat.ResolveAttachments(dir, paths)
	if err != nil {
		return agentchat.Prepared{}, nil, err
	}
	caps, who, err := a.attachmentCaps(agentID, model)
	if err != nil {
		return agentchat.Prepared{}, nil, err
	}
	p, err := agentchat.PrepareAttachments(atts, caps, who)
	if err != nil {
		return agentchat.Prepared{}, nil, err
	}
	return p, atts, nil
}
