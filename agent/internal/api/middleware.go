package api

import (
	"net/http"
	"strings"

	"github.com/pxhost/agent/internal/auth"
)

// requireNodeToken gates the REST control endpoints the panel calls
// machine-to-machine (architecture doc 3.4 layer 2). Checks the presented
// bearer against s.tokenStore with a constant-time comparison — reading
// through the store, not a plain field, is what lets rotation (roadmap
// M13, cmd/pxagent's self-rotation loop) swap the accepted value with no
// window where an in-flight panel call and this check disagree about
// which token is current.
func (s *Server) requireNodeToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := bearerToken(r)
		if !auth.VerifyNodeToken(got, s.tokenStore.Get()) {
			writeJSONResp(w, http.StatusUnauthorized, map[string]any{
				"error": map[string]any{"code": "UNAUTHORIZED", "message": "missing or invalid node token"},
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimPrefix(h, prefix)
}

// corsForBrowser allows the panel's own origin (reusing the SAME
// wsOriginPatterns config the console WS already trusts — one allowlist,
// not two) to read the response of a direct fetch() call, needed for
// file upload's {bytesWritten} response (download works without this:
// see the route registration comment). A request with no Origin header
// at all — curl, a same-origin request, a plain browser navigation for
// download — is left untouched; CORS headers only matter to a
// cross-origin fetch()/XHR in the first place.
func (s *Server) corsForBrowser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && originAllowed(s.wsOriginPatterns, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originAllowed(patterns []string, origin string) bool {
	for _, p := range patterns {
		if p == "*" || p == origin {
			return true
		}
	}
	return false
}
