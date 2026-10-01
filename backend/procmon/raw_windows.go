//go:build windows

package procmon

import (
	"context"
	"os/exec"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	psapi            = windows.NewLazySystemDLL("psapi.dll")
	procGlobalMemory = kernel32.NewProc("GlobalMemoryStatusEx")
	procProcessMem   = psapi.NewProc("GetProcessMemoryInfo")
)

// memoryStatusEx es MEMORYSTATUSEX de la API de Windows.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys, availPhys uint64
	totalPage, availPage uint64
	totalVirt, availVirt uint64
	availExtendedVirtual uint64
}

// processMemoryCounters es PROCESS_MEMORY_COUNTERS: los campos de tamaño son
// SIZE_T, o sea uintptr.
type processMemoryCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

// filetimeDuration convierte un FILETIME (intervalos de 100 ns) en Duration.
func filetimeDuration(f windows.Filetime) time.Duration {
	return time.Duration(uint64(f.HighDateTime)<<32|uint64(f.LowDateTime)) * 100
}

// readRaw en Windows: la lista sale de un snapshot de Toolhelp32 y, por cada
// proceso que se deja abrir con el permiso mínimo, el tiempo de CPU y el working
// set. Los que no se dejan (del sistema) figuran igual, con 0.
func readRaw(ctx context.Context) (*rawSample, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)

	s := &rawSample{at: time.Now()}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		p := rawProc{pid: int(e.ProcessID), ppid: int(e.ParentProcessID), name: windows.UTF16ToString(e.ExeFile[:])}
		if p.pid > 0 {
			readWinProcess(&p)
		}
		s.procs = append(s.procs, p)
	}

	var ms memoryStatusEx
	ms.length = uint32(unsafe.Sizeof(ms))
	if r, _, _ := procGlobalMemory.Call(uintptr(unsafe.Pointer(&ms))); r != 0 {
		s.memTotal = ms.totalPhys
		s.memUsed = ms.totalPhys - ms.availPhys
	}

	cmd := exec.CommandContext(ctx, "netstat", "-e")
	hideWindow(cmd)
	if b, err := cmd.Output(); err == nil {
		s.netRx, s.netTx = parseNetstatE(string(b))
	}
	return s, nil
}

func readWinProcess(p *rawProc) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(p.pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)

	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
		p.cpu = filetimeDuration(kernel) + filetimeDuration(user)
	}
	var pmc processMemoryCounters
	pmc.cb = uint32(unsafe.Sizeof(pmc))
	if r, _, _ := procProcessMem.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.cb)); r != 0 {
		p.mem = uint64(pmc.workingSetSize)
	}
}
