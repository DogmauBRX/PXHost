// Command gen-seccomp derives configs/seccomp-pxhost.json from Docker's
// upstream default profile (hack/gen-seccomp/seccomp-default.json) by unconditionally
// stripping a fixed denylist of syscalls that PXHost containers must never
// reach, regardless of capabilities.
//
// Most of these are already unreachable once CapDrop:ALL is applied (Docker's
// default profile gates them behind includes.caps), but PXHost strips them
// explicitly for defense in depth: a future template accidentally granted a
// capability must not silently regain them. clone/clone3/unshare are left
// untouched — the base profile already masks CLONE_NEW* flags for them
// (required for normal thread creation, e.g. JVM/pthread_create).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// denylist: syscalls removed unconditionally from every allow entry.
var denylist = map[string]bool{
	"ptrace":            true,
	"process_vm_readv":  true,
	"process_vm_writev": true,
	"userfaultfd":       true,
	"io_uring_setup":    true,
	"io_uring_enter":    true,
	"io_uring_register": true,
	"move_mount":        true,
	"open_tree":         true,
	"fsopen":            true,
	"fsconfig":          true,
	"fsmount":           true,
	"fspick":            true,
	"mount_setattr":     true,
	"pidfd_getfd":       true,
	"kcmp":              true,
	"bpf":               true,
	"perf_event_open":   true,
	"mount":             true,
	"umount":            true,
	"umount2":           true,
	"name_to_handle_at": true,
	"open_by_handle_at": true,
	"acct":              true,
	"add_key":           true,
	"request_key":       true,
	"keyctl":            true,
	"swapon":            true,
	"swapoff":           true,
	"quotactl":          true,
	"quotactl_fd":       true,
	"lookup_dcookie":    true,
	"process_madvise":   true,
}

type syscallEntry struct {
	Names    []string        `json:"names"`
	Action   string          `json:"action"`
	Args     json.RawMessage `json:"args,omitempty"`
	Comment  string          `json:"comment,omitempty"`
	Includes json.RawMessage `json:"includes,omitempty"`
	Excludes json.RawMessage `json:"excludes,omitempty"`
}

type profile struct {
	DefaultAction   string          `json:"defaultAction"`
	DefaultErrnoRet json.RawMessage `json:"defaultErrnoRet,omitempty"`
	Architectures   json.RawMessage `json:"architectures,omitempty"`
	ArchMap         json.RawMessage `json:"archMap,omitempty"`
	Syscalls        []syscallEntry  `json:"syscalls"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gen-seccomp <in.json> <out.json>")
		os.Exit(2)
	}
	in, err := os.ReadFile(os.Args[1])
	must(err)

	var p profile
	must(json.Unmarshal(in, &p))

	removedNames := map[string]bool{}
	var kept []syscallEntry
	for _, sc := range p.Syscalls {
		var names []string
		for _, n := range sc.Names {
			if denylist[n] {
				removedNames[n] = true
				continue
			}
			names = append(names, n)
		}
		if len(names) == 0 {
			continue // entry fully denylisted, drop it
		}
		sc.Names = names
		kept = append(kept, sc)
	}
	p.Syscalls = kept

	out, err := json.MarshalIndent(p, "", "  ")
	must(err)
	out = append(out, '\n')
	must(os.WriteFile(os.Args[2], out, 0o644))

	var missing []string
	for n := range denylist {
		if !removedNames[n] {
			missing = append(missing, n) // wasn't present anyway (already denied by default action)
		}
	}
	sort.Strings(missing)
	fmt.Printf("pxhost seccomp profile written: %s\n", os.Args[2])
	fmt.Printf("explicitly stripped %d/%d denylisted syscalls (rest were already absent, i.e. already denied): %v\n",
		len(removedNames), len(denylist), missing)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
