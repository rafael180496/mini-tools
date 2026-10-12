package main

import (
	"sort"
	"strings"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/agentusage"
	"mini-tools/backend/i18n"
	"mini-tools/backend/vault"
)

// Consumo de los proveedores de modelos (Ollama, compatibles con OpenAI,
// Anthropic).
//
// Los CLIs dejan sus tokens en transcripts que lee backend/agentusage; un
// servidor de modelos no deja nada en disco, pero cada turno guardado en el
// historial (agent_chat_messages.usage) trae sus tokens, y desde que se
// guarda también el modelo y cuánto tardó el servidor en generar. De ahí sale
// este informe, sin descifrar un solo mensaje.
//
// **Lo que NO hay es costo.** Un servidor propio no cobra por token y ni uno
// compatible con OpenAI ni la API de Anthropic informan precio en su respuesta:
// inventar un monto sería falso, así que el informe habla solo de tokens, turnos
// y velocidad. Con Anthropic además se ve cuánto salió de la caché del prompt.
//
// Lo que se sabe depende de qué reporte el servidor: uno que no devuelve
// conteo de tokens aparece con turnos pero sin tokens. Y los turnos guardados
// antes de que se registrara el modelo o la duración (filas anteriores) se
// cuentan en los totales con modelo "" y sin velocidad.

// ModelUsageTotals son los contadores de un servidor o de un modelo.
type ModelUsageTotals struct {
	// Input incluye CacheRead y CacheWrite: es todo lo que el modelo recibió.
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
	Total  int64 `json:"total"`
	// CacheRead y CacheWrite son la parte de Input que salió de la caché del
	// prompt o se escribió en ella (Anthropic; 0 en el resto de los proveedores).
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	// Turns son los turnos que dejaron uso guardado.
	Turns int `json:"turns"`
	// Conversations son los chats distintos con al menos un turno.
	Conversations int `json:"conversations"`
}

// ModelUsageModel es lo consumido con un modelo concreto.
type ModelUsageModel struct {
	// Model es "" para los turnos anteriores a que se guardara el modelo.
	Model  string           `json:"model"`
	Totals ModelUsageTotals `json:"totals"`
	// Percent es la parte de los tokens del servidor, 0..100.
	Percent float64 `json:"percent"`
	// TokensPerSec es la velocidad media de salida (tokens generados por
	// segundo de generación); 0 = no se sabe (ningún turno con duración).
	TokensPerSec float64 `json:"tokensPerSec"`
}

// ModelUsageDay es un día de la serie. Siempre vienen todos los días de la
// ventana, con ceros: una serie con huecos se dibuja torcida.
type ModelUsageDay struct {
	Day   string `json:"day"` // YYYY-MM-DD, hora local
	Total int64  `json:"total"`
	Turns int    `json:"turns"`
}

// ModelServerUsage es el consumo de un servidor.
type ModelServerUsage struct {
	// AgentID es `llm:<id>`, el mismo que usa el catálogo de agentes.
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // "ollama" | "openai" | "anthropic"; "" si el servidor se eliminó
	IsLocal bool   `json:"isLocal"`
	// Deleted: el servidor ya no existe pero quedan chats suyos. Name trae un
	// rótulo genérico; la interfaz puede ponerle el suyo.
	Deleted bool              `json:"deleted"`
	Totals  ModelUsageTotals  `json:"totals"`
	ByModel []ModelUsageModel `json:"byModel"`
	ByDay   []ModelUsageDay   `json:"byDay"`
	// TokensPerSec: velocidad media de salida de todo el servidor; 0 = no se
	// sabe.
	TokensPerSec float64 `json:"tokensPerSec"`
	// LastUsedAt son segundos Unix del último turno; 0 = ninguno en la ventana.
	LastUsedAt int64 `json:"lastUsedAt"`
}

// ModelServerUsageReport es lo que ve la interfaz.
type ModelServerUsageReport struct {
	// Days es la ventana leída; FirstDay y LastDay la acotan (YYYY-MM-DD).
	Days     int    `json:"days"`
	FirstDay string `json:"firstDay"`
	LastDay  string `json:"lastDay"`
	// Servers: primero los que más consumieron; los que no tienen turnos en
	// la ventana van al final, y un servidor eliminado solo aparece si dejó
	// turnos en la ventana.
	Servers []ModelServerUsage `json:"servers"`
}

var msgDeletedServer = i18n.Msg{ES: "Servidor eliminado", EN: "Deleted server"}

// ModelServerUsage devuelve el consumo de cada servidor de modelos en los
// últimos `days` días (0 o menos = la misma ventana por defecto que
// AgentUsageAll).
func (a *App) ModelServerUsage(days int) (ModelServerUsageReport, error) {
	if err := a.requireUnlocked(); err != nil {
		return ModelServerUsageReport{}, err
	}
	if days <= 0 {
		days = agentusage.DefaultDays
	}
	now := time.Now()
	first := firstWindowDay(now, days)
	servers, err := a.vault.ListModelServers()
	if err != nil {
		return ModelServerUsageReport{}, err
	}
	rows, err := a.vault.ModelServerUsageRows(first.Unix())
	if err != nil {
		return ModelServerUsageReport{}, err
	}
	return buildModelServerUsage(servers, rows, now, days), nil
}

// firstWindowDay es la medianoche local del primer día de la ventana: `days`
// días contando hoy.
func firstWindowDay(now time.Time, days int) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d-(days-1), 0, 0, 0, 0, now.Location())
}

// usageAcc acumula un servidor o un modelo.
type usageAcc struct {
	t     ModelUsageTotals
	chats map[string]struct{}
	// Para la velocidad: solo cuentan los turnos con duración Y con tokens de
	// salida. Mezclar turnos sin duración inflaría el cociente.
	timedOut int64
	timedMs  int64
}

func (u *usageAcc) add(r vault.ChatUsageRow) {
	total := r.Total
	if total == 0 {
		total = r.Input + r.Output
	}
	u.t.Input += r.Input
	u.t.Output += r.Output
	u.t.CacheRead += r.CacheRead
	u.t.CacheWrite += r.CacheWrite
	u.t.Total += total
	u.t.Turns++
	if u.chats == nil {
		u.chats = map[string]struct{}{}
	}
	u.chats[r.ChatID] = struct{}{}
	if r.DurationMs > 0 && r.Output > 0 {
		u.timedOut += r.Output
		u.timedMs += r.DurationMs
	}
}

func (u *usageAcc) totals() ModelUsageTotals {
	t := u.t
	t.Conversations = len(u.chats)
	return t
}

func (u *usageAcc) speed() float64 {
	if u.timedMs <= 0 {
		return 0
	}
	v := float64(u.timedOut) / (float64(u.timedMs) / 1000)
	return float64(int64(v*10+0.5)) / 10
}

// buildModelServerUsage arma el informe. Es pura —recibe los servidores, los
// turnos y el "ahora"— para probarla sin base ni reloj.
func buildModelServerUsage(servers []vault.ModelServer, rows []vault.ChatUsageRow, now time.Time, days int) ModelServerUsageReport {
	loc := now.Location()
	first := firstWindowDay(now, days)
	dayKeys := make([]string, days)
	dayIdx := make(map[string]int, days)
	for i := 0; i < days; i++ {
		k := first.AddDate(0, 0, i).Format("2006-01-02")
		dayKeys[i] = k
		dayIdx[k] = i
	}

	type serverAcc struct {
		meta    ModelServerUsage
		all     usageAcc
		models  map[string]*usageAcc
		byDay   []ModelUsageDay
		lastUse int64
	}
	accs := map[string]*serverAcc{}
	newAcc := func(agentID string, meta ModelServerUsage) *serverAcc {
		s := &serverAcc{meta: meta, models: map[string]*usageAcc{}, byDay: make([]ModelUsageDay, days)}
		for i, k := range dayKeys {
			s.byDay[i].Day = k
		}
		accs[agentID] = s
		return s
	}
	for _, sv := range servers {
		id := agentchat.LLMPrefix + sv.ID
		newAcc(id, ModelServerUsage{AgentID: id, Name: sv.Name, Kind: sv.Kind, IsLocal: isLoopbackURL(sv.BaseURL)})
	}

	for _, r := range rows {
		idx, ok := dayIdx[time.Unix(r.CreatedAt, 0).In(loc).Format("2006-01-02")]
		if !ok {
			continue // fuera de la ventana (o del futuro)
		}
		s := accs[r.AgentID]
		if s == nil {
			// Chat de un servidor que ya no existe: se agrupa por su id.
			s = newAcc(r.AgentID, ModelServerUsage{AgentID: r.AgentID, Name: i18n.T(msgDeletedServer) + " (" + strings.TrimPrefix(r.AgentID, agentchat.LLMPrefix) + ")", Deleted: true})
		}
		s.all.add(r)
		m := s.models[r.Model]
		if m == nil {
			m = &usageAcc{}
			s.models[r.Model] = m
		}
		m.add(r)
		total := r.Total
		if total == 0 {
			total = r.Input + r.Output
		}
		s.byDay[idx].Total += total
		s.byDay[idx].Turns++
		if r.CreatedAt > s.lastUse {
			s.lastUse = r.CreatedAt
		}
	}

	out := make([]ModelServerUsage, 0, len(accs))
	for _, s := range accs {
		if s.meta.Deleted && s.all.t.Turns == 0 {
			continue
		}
		u := s.meta
		u.Totals = s.all.totals()
		u.TokensPerSec = s.all.speed()
		u.LastUsedAt = s.lastUse
		u.ByDay = s.byDay
		u.ByModel = make([]ModelUsageModel, 0, len(s.models))
		for name, m := range s.models {
			mm := ModelUsageModel{Model: name, Totals: m.totals(), TokensPerSec: m.speed()}
			if s.all.t.Total > 0 {
				mm.Percent = float64(int64(float64(mm.Totals.Total)/float64(s.all.t.Total)*1000+0.5)) / 10
			}
			u.ByModel = append(u.ByModel, mm)
		}
		sort.Slice(u.ByModel, func(i, j int) bool {
			a, b := u.ByModel[i], u.ByModel[j]
			if a.Totals.Total != b.Totals.Total {
				return a.Totals.Total > b.Totals.Total
			}
			if a.Totals.Turns != b.Totals.Turns {
				return a.Totals.Turns > b.Totals.Turns
			}
			return a.Model < b.Model
		})
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Totals.Turns > 0) != (b.Totals.Turns > 0) {
			return a.Totals.Turns > 0
		}
		if a.Totals.Total != b.Totals.Total {
			return a.Totals.Total > b.Totals.Total
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return ModelServerUsageReport{Days: days, FirstDay: dayKeys[0], LastDay: dayKeys[days-1], Servers: out}
}
