// Package agentplan informa con qué plan está cada CLI agéntico en esta
// máquina.
//
// # Para qué sirve saberlo
//
// El panel de consumo dice cuántos tokens se gastaron, pero un total no
// significa lo mismo en un plan gratuito que en uno de pago: sin el plan al
// lado, "3,6 mil millones de tokens" es un número sin escala. Además explica
// de entrada por qué un agente responde distinto —o directamente no responde—
// sin tener que abrir cada CLI a preguntarle.
//
// # De dónde sale, verificado en instalaciones reales
//
//   - **Claude Code**: `~/.claude.json`, bloque `oauthAccount`, que trae
//     `organizationType` (`claude_max`, …) y `organizationRateLimitTier`
//     (`default_claude_max_5x`, …). Es el dato más completo de los tres.
//   - **Codex**: el `id_token` de `~/.codex/auth.json` es un JWT y su claim
//     `https://api.openai.com/auth` lleva `chatgpt_plan_type`.
//   - **Antigravity**: **no publica su plan en el disco.** Lo único local es
//     si completó el onboarding de consumidor o el de empresa, que distingue
//     el tipo de cuenta pero NO el nivel. Su cuota real la contesta el
//     servidor y se ve con `/usage` dentro de la sesión.
//
// # Lo que este paquete NO hace
//
// **No devuelve ni loguea el token.** El JWT de Codex se decodifica solo para
// sacarle el claim del plan; ni el token ni el resto de sus claims salen de
// acá. Tampoco se valida la firma: no se está autenticando a nadie, se está
// leyendo un dato que el propio CLI ya guardó — comprobar la firma daría una
// falsa sensación de que esto es un control de acceso, que no lo es.
package agentplan

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Plan es lo que se sabe del plan de un agente.
type Plan struct {
	Agent string `json:"agent"`
	// Known es false cuando el CLI no publica el dato. Se distingue de "plan
	// gratuito" a propósito: no saber y saber que no paga son cosas
	// distintas, y mostrarlas igual sería inventar.
	Known bool `json:"known"`
	// Label es el plan en una línea, ya legible ("Max 5x", "Free").
	Label string `json:"label"`
	// Detail agrega lo que haga falta para entenderlo (el tipo de cuenta, si
	// tiene uso extra habilitado).
	Detail string `json:"detail"`
	// Note explica por qué no se sabe, cuando Known es false.
	Note string `json:"note"`
}

// All devuelve el plan de los tres agentes. Siempre los tres: uno ausente del
// listado y uno sin dato se verían igual, y solo el segundo es información.
func All() []Plan {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []Plan{claudePlan(home), codexPlan(home), antigravityPlan(home)}
}

func claudePlan(home string) Plan {
	p := Plan{Agent: "claude"}

	raw, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		p.Note = "No hay una sesión de Claude Code iniciada en esta máquina."
		return p
	}
	var doc struct {
		OAuth struct {
			OrganizationType      string `json:"organizationType"`
			OrgRateLimitTier      string `json:"organizationRateLimitTier"`
			UserRateLimitTier     string `json:"userRateLimitTier"`
			BillingType           string `json:"billingType"`
			HasExtraUsageEnabled  bool   `json:"hasExtraUsageEnabled"`
			ClaudeCodeTrialEndsAt string `json:"claudeCodeTrialEndsAt"`
		} `json:"oauthAccount"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		p.Note = "No se pudo leer la configuración de Claude Code."
		return p
	}

	// El tier de límite es más específico que el tipo de organización
	// (`default_claude_max_5x` contra `claude_max`), así que se prefiere ese
	// cuando está: es el que dice cuánto, no solo cuál.
	tier := firstNonEmpty(doc.OAuth.OrgRateLimitTier, doc.OAuth.UserRateLimitTier)
	if tier == "" && doc.OAuth.OrganizationType == "" {
		p.Note = "La sesión de Claude Code no informa un plan."
		return p
	}

	p.Known = true
	p.Label = prettifyTier(firstNonEmpty(tier, doc.OAuth.OrganizationType))

	var detail []string
	if doc.OAuth.OrganizationType != "" {
		detail = append(detail, doc.OAuth.OrganizationType)
	}
	if doc.OAuth.HasExtraUsageEnabled {
		detail = append(detail, "uso extra habilitado")
	}
	if doc.OAuth.ClaudeCodeTrialEndsAt != "" {
		detail = append(detail, "en prueba")
	}
	p.Detail = strings.Join(detail, " · ")
	return p
}

func codexPlan(home string) Plan {
	p := Plan{Agent: "codex"}

	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		p.Note = "No hay una sesión de Codex iniciada en esta máquina."
		return p
	}
	var doc struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		p.Note = "No se pudo leer la sesión de Codex."
		return p
	}
	if doc.Tokens.IDToken == "" {
		// Con API key no hay plan de suscripción que informar: se paga por uso.
		p.Note = "Codex está autenticado por API key, que no tiene plan asociado."
		return p
	}

	claims := jwtClaims(doc.Tokens.IDToken)
	if claims == nil {
		p.Note = "La sesión de Codex no informa un plan."
		return p
	}
	var auth struct {
		PlanType string `json:"chatgpt_plan_type"`
	}
	if err := json.Unmarshal(claims["https://api.openai.com/auth"], &auth); err != nil || auth.PlanType == "" {
		p.Note = "La sesión de Codex no informa un plan."
		return p
	}

	p.Known = true
	p.Label = prettifyTier(auth.PlanType)
	p.Detail = doc.AuthMode
	return p
}

func antigravityPlan(home string) Plan {
	p := Plan{Agent: "antigravity"}

	dir := filepath.Join(home, ".gemini", "antigravity-cli")
	if _, err := os.Stat(dir); err != nil {
		p.Note = "No se encontró Antigravity CLI en esta máquina."
		return p
	}

	// Lo único que publica en el disco es qué onboarding completó. Distingue
	// el TIPO de cuenta, no el nivel — y decirlo así es más útil que llamar
	// "plan" a algo que no lo es.
	var onboarding struct {
		Consumer   bool `json:"consumerOnboardingComplete"`
		Enterprise bool `json:"enterpriseOnboardingComplete"`
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "cache", "onboarding.json")); err == nil {
		_ = json.Unmarshal(raw, &onboarding)
	}

	switch {
	case onboarding.Enterprise:
		p.Detail = "cuenta de empresa"
	case onboarding.Consumer:
		p.Detail = "cuenta personal"
	}
	p.Note = "Antigravity no publica su plan en el disco: el límite semanal y el de cinco horas los contesta el servidor, y se ven con /usage dentro de la sesión."
	return p
}

// prettifyTier convierte el identificador interno en algo legible
// (`default_claude_max_5x` → "Claude Max 5x", `free` → "Free").
//
// Es cosmética y deliberadamente tonta: no traduce nombres de plan a otro
// idioma ni intenta ordenarlos por nivel, porque esos nombres los define cada
// proveedor y cualquier tabla de equivalencias quedaría vieja. Si aparece un
// tier que no se conoce, se muestra tal cual — que es exactamente lo que hay
// que ver para poder buscarlo.
func prettifyTier(tier string) string {
	t := strings.TrimPrefix(tier, "default_")
	t = strings.ReplaceAll(t, "_", " ")
	words := strings.Fields(t)
	for i, w := range words {
		// "5x" y similares se dejan en minúscula: "5X" se lee peor.
		if w == "" || (w[0] >= '0' && w[0] <= '9') {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

// jwtClaims decodifica el payload de un JWT.
//
// **No valida la firma, y eso es correcto acá**: no se está autenticando a
// nadie, se está leyendo un dato que el propio CLI ya guardó y usa. Validar
// daría la falsa impresión de que esto es un control de acceso.
func jwtClaims(token string) map[string]json.RawMessage {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload := parts[1]
	// base64url sin relleno, que es como viaja en un JWT.
	if pad := len(payload) % 4; pad != 0 {
		payload += strings.Repeat("=", 4-pad)
	}
	raw, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return nil
	}
	var claims map[string]json.RawMessage
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil
	}
	return claims
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
