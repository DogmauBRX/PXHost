// Command devtoken is a stand-in for the panel's signing role during local
// development (a tiny slice of the "fake-panel harness" described in
// architecture doc 6): it can generate an Ed25519 keypair and mint
// capability tokens signed by it, so the WS console/stats protocol can be
// exercised end-to-end before a real panel exists.
//
// NEVER build this into the production agent image; it exists purely to
// unblock local testing of internal/auth.TokenVerifier.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/pxhost/agent/internal/auth"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = runKeygen(os.Args[2:])
	case "mint":
		err = runMint(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "devtoken: "+err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `devtoken - mint Ed25519 capability tokens for local agent testing

Usage:
  devtoken keygen --out-dir <dir>
      Writes panel-ed25519.pub and panel-ed25519.key (base64-encoded raw keys).

  devtoken mint --key <panel-ed25519.key> --node <node-uuid> --server <server-uuid>
                --user <user-uuid> --perms <comma,separated,perms> [--ttl 10m]
      Prints a signed capability token to stdout.`)
}

func runKeygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	outDir := fs.String("out-dir", ".", "directory to write the keypair into")
	if err := fs.Parse(args); err != nil {
		return err
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outDir+"/panel-ed25519.pub", []byte(base64.StdEncoding.EncodeToString(pub)), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(*outDir+"/panel-ed25519.key", []byte(base64.StdEncoding.EncodeToString(priv)), 0o600); err != nil {
		return err
	}
	fmt.Printf("wrote %s/panel-ed25519.pub and %s/panel-ed25519.key\n", *outDir, *outDir)
	return nil
}

func runMint(args []string) error {
	fs := flag.NewFlagSet("mint", flag.ExitOnError)
	keyPath := fs.String("key", "", "path to panel-ed25519.key")
	nodeUUID := fs.String("node", "", "node uuid (becomes aud=node:<uuid>)")
	serverUUID := fs.String("server", "", "server uuid (becomes sub)")
	userUUID := fs.String("user", "dev-user", "acting user uuid")
	permsCSV := fs.String("perms", "websocket.connect,control.console,control.start,control.stop,control.restart,control.kill", "comma-separated permission list")
	ttl := fs.Duration("ttl", 10*time.Minute, "token lifetime")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" || *nodeUUID == "" || *serverUUID == "" {
		return fmt.Errorf("--key, --node, and --server are required")
	}

	keyB64, err := os.ReadFile(*keyPath)
	if err != nil {
		return err
	}
	rawKey, err := base64.StdEncoding.DecodeString(string(keyB64))
	if err != nil {
		return fmt.Errorf("decoding key file: %w", err)
	}
	priv := ed25519.PrivateKey(rawKey)

	perms := splitCSV(*permsCSV)
	now := time.Now()
	claims := &auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "panel",
			Audience:  jwt.ClaimStrings{"node:" + *nodeUUID},
			Subject:   *serverUUID,
			ID:        randomID(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(*ttl)),
		},
		UID:         *userUUID,
		Cap:         auth.CapConsole,
		Permissions: perms,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signed, err := tok.SignedString(priv)
	if err != nil {
		return err
	}
	fmt.Println(signed)
	return nil
}

func splitCSV(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	return out
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
