package srv

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/gxhost/agent/internal/fsx"
)

// rewriteServerPort sets server.properties' server-port line to port,
// appending it when absent. Line-based on purpose: every other line (seed,
// difficulty, comments) must survive byte for byte.
func rewriteServerPort(content []byte, port int) ([]byte, bool) {
	want := fmt.Sprintf("server-port=%d", port)
	var lines []string
	if len(content) > 0 {
		lines = strings.Split(strings.TrimRight(string(content), "\n"), "\n")
	}
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSuffix(l, "\r"), "server-port=") {
			if strings.TrimSuffix(l, "\r") == want {
				return content, false
			}
			lines[i] = want
			return []byte(strings.Join(lines, "\n") + "\n"), true
		}
	}
	lines = append(lines, want)
	return []byte(strings.Join(lines, "\n") + "\n"), true
}

// ensureServerPort pins server-port to this server's primary allocation
// right before every start. Docker publishes only that port, with the same
// number inside the container, so a JVM listening anywhere else accepts
// nothing: docker-proxy completes the TCP handshake and then resets every
// connection. Seen live after a node transfer carried the old node's port
// in server.properties; doing it here covers every path that brings files
// in (transfer, backup restore, modpack, a customer upload), not just one.
//
// Goes through the jail: server.properties lives in customer-controlled
// space, and a symlink planted there must never redirect this write.
// Software without a server.properties (proxies) is left alone.
func (s *Server) ensureServerPort() {
	port := s.PrimaryPort()
	if port <= 0 || s.Jail == nil {
		return
	}
	content, err := s.Jail.ReadFile("server.properties")
	if err != nil {
		return
	}
	updated, changed := rewriteServerPort(content, port)
	if !changed {
		return
	}
	if _, err := s.Jail.WriteFile("server.properties", bytes.NewReader(updated), s.spec.UID, fsx.MaxEditableFileBytes); err != nil {
		s.Hub.Publish("stderr", fmt.Sprintf("[GXhost] não foi possível ajustar server-port para %d: %v", port, err))
		return
	}
	s.Hub.Publish("stdout", fmt.Sprintf("[GXhost] server-port ajustado para %d (a porta reservada para este servidor)", port))
}
