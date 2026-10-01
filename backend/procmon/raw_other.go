//go:build !darwin && !linux && !windows

package procmon

import (
	"context"

	"mini-tools/backend/i18n"
)

var ErrUnsupported = i18n.NewCoded("unsupported", i18n.Msg{
	ES: "el monitor de procesos no está disponible en este sistema operativo",
	EN: "the process monitor isn't available on this operating system",
})

func readRaw(context.Context) (*rawSample, error) { return nil, ErrUnsupported }
