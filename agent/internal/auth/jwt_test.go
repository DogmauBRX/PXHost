package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testNodeUUID = "b0f7a1f0-6b1a-4a6f-9f2e-9d1c1a5f2b31"
const testServerUUID = "9c2e0000-0000-0000-0000-000000000001"

func genKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating test keypair: %v", err)
	}
	return pub, priv
}

func mintToken(t *testing.T, priv ed25519.PrivateKey, mutate func(*Claims)) string {
	t.Helper()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "panel",
			Audience:  jwt.ClaimStrings{"node:" + testNodeUUID},
			Subject:   testServerUUID,
			ID:        "test-jti-1",
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
		UID:         "user-1",
		Cap:         CapConsole,
		Permissions: []string{"websocket.connect", "control.console"},
	}
	if mutate != nil {
		mutate(claims)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("signing test token: %v", err)
	}
	return s
}

func TestVerify_AcceptsWellFormedToken(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)

	tok := mintToken(t, priv, nil)
	claims, err := v.Verify(tok, testServerUUID, CapConsole)
	if err != nil {
		t.Fatalf("expected a valid token to verify, got: %v", err)
	}
	if !claims.HasPermission("control.console") {
		t.Fatal("expected the console permission to survive verification")
	}
}

func TestVerify_RejectsWrongServerSubject(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, nil)

	if _, err := v.Verify(tok, "some-other-server-uuid", CapConsole); err == nil {
		t.Fatal("expected rejection when the token's subject doesn't match the requested server")
	}
}

func TestVerify_RejectsWrongAudience(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, func(c *Claims) {
		c.Audience = jwt.ClaimStrings{"node:some-other-node-uuid"}
	})

	if _, err := v.Verify(tok, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected rejection of a token minted for a different node")
	}
}

func TestVerify_RejectsWrongCapability(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, func(c *Claims) { c.Cap = "file.download" })

	if _, err := v.Verify(tok, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected rejection when the token's capability doesn't match what's required")
	}
}

func TestVerify_RejectsExpiredToken(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 1*time.Second) // small leeway
	tok := mintToken(t, priv, func(c *Claims) {
		c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-5 * time.Minute))
	})

	if _, err := v.Verify(tok, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected rejection of an expired token")
	}
}

func TestVerify_RejectsMissingJTI(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, func(c *Claims) { c.ID = "" })

	if _, err := v.Verify(tok, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected rejection of a token with no jti")
	}
}

// The canonical alg-confusion attack: take a token whose header claims
// HS256 and whose "signature" is an HMAC computed using the Ed25519
// PUBLIC key bytes as the HMAC secret (which an attacker can always obtain,
// since it's public). If the verifier ever honored the token's own alg
// field, this would validate. WithValidMethods must make this impossible.
func TestVerify_RejectsAlgorithmConfusion_HMACWithPublicKeyAsSecret(t *testing.T) {
	pub, _ := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)

	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{"node:" + testNodeUUID},
			Subject:   testServerUUID,
			ID:        "forged-jti",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
		Cap:         CapConsole,
		Permissions: []string{"websocket.connect", "control.console", "control.start", "control.stop"},
	}
	forged := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := forged.SignedString([]byte(pub)) // attacker signs with the public key bytes
	if err != nil {
		t.Fatalf("crafting forged token: %v", err)
	}

	if _, err := v.Verify(s, testServerUUID, CapConsole); err == nil {
		t.Fatal("SECURITY: algorithm-confusion forged token was accepted")
	}
}

func TestVerify_RejectsAlgNone(t *testing.T) {
	pub, _ := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)

	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{"node:" + testNodeUUID},
			Subject:   testServerUUID,
			ID:        "none-jti",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
		Cap: CapConsole,
	}
	unsigned := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	s, err := unsigned.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("crafting alg=none token: %v", err)
	}

	if _, err := v.Verify(s, testServerUUID, CapConsole); err == nil {
		t.Fatal("SECURITY: alg=none token was accepted")
	}
}

func TestVerify_RejectsSignatureTampering(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, nil)

	tampered := tok[:len(tok)-4] + "AAAA"
	if _, err := v.Verify(tampered, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected rejection of a tampered signature")
	}
}

// mintTokenWithKid is mintToken plus a real kid header — every token the
// panel actually mints carries one (roadmap M13); a bare mintToken (no
// kid) exercises the fallback path instead, used by every OTHER test in
// this file that predates multi-key support.
func mintTokenWithKid(t *testing.T, priv ed25519.PrivateKey, kid string) string {
	t.Helper()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "panel",
			Audience:  jwt.ClaimStrings{"node:" + testNodeUUID},
			Subject:   testServerUUID,
			ID:        "test-jti-" + kid,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
		UID:         "user-1",
		Cap:         CapConsole,
		Permissions: []string{"websocket.connect", "control.console"},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = kid
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("signing token: %v", err)
	}
	return s
}

func TestVerify_MultiKeyRotationViaSetKeys(t *testing.T) {
	pubOld, privOld := genKeypair(t)
	pubNew, privNew := genKeypair(t)
	v := NewTokenVerifier(nil, testNodeUUID, 10*time.Second)

	v.SetKeys(map[string]ed25519.PublicKey{"kid-old": pubOld})
	tokOld := mintTokenWithKid(t, privOld, "kid-old")
	if _, err := v.Verify(tokOld, testServerUUID, CapConsole); err != nil {
		t.Fatalf("expected the old-key token to verify while kid-old is trusted: %v", err)
	}

	// A real rotation's JWKS still lists BOTH keys for a while (current +
	// retiring) — a token minted under the old key right before rotation
	// must keep verifying, not break the instant a new key appears.
	v.SetKeys(map[string]ed25519.PublicKey{"kid-old": pubOld, "kid-new": pubNew})
	if _, err := v.Verify(tokOld, testServerUUID, CapConsole); err != nil {
		t.Fatalf("expected the old-key token to still verify while retiring, not yet retired: %v", err)
	}
	tokNew := mintTokenWithKid(t, privNew, "kid-new")
	if _, err := v.Verify(tokNew, testServerUUID, CapConsole); err != nil {
		t.Fatalf("expected the new-key token to verify once its kid is trusted: %v", err)
	}

	// Only once the JWKS actually stops listing kid-old (fully retired)
	// does a token under it get rejected.
	v.SetKeys(map[string]ed25519.PublicKey{"kid-new": pubNew})
	if _, err := v.Verify(tokOld, testServerUUID, CapConsole); err == nil {
		t.Fatal("expected the old-key token to be rejected once kid-old is retired out of the JWKS")
	}
}

func TestVerify_FallbackKeyUsedWhenKidUnknown(t *testing.T) {
	// Standalone mode / before the first JWKS fetch: a token with no kid
	// (or a kid this verifier has never seen) still verifies against the
	// static panel_public_key_path fallback — bootstrap compatibility,
	// see NewTokenVerifier's doc comment.
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	tok := mintToken(t, priv, nil) // no kid header at all
	if _, err := v.Verify(tok, testServerUUID, CapConsole); err != nil {
		t.Fatalf("expected a kid-less token to verify against the fallback key: %v", err)
	}
}

func mintFileToken(t *testing.T, priv ed25519.PrivateKey, jti, filePath string, cap Capability) string {
	t.Helper()
	return mintToken(t, priv, func(c *Claims) {
		c.ID = jti
		c.Cap = cap
		c.Permissions = nil
		c.Ctx = &TokenContext{Path: filePath, MaxBytes: 1 << 20}
	})
}

func TestVerifyFileToken_AcceptsMatchingPathOnce(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	replay := NewReplayCache()
	tok := mintFileToken(t, priv, "file-jti-1", "server.properties", CapFileDownload)

	if _, err := v.VerifyFileToken(tok, testServerUUID, CapFileDownload, "server.properties", replay); err != nil {
		t.Fatalf("expected the first presentation to verify: %v", err)
	}
	if _, err := v.VerifyFileToken(tok, testServerUUID, CapFileDownload, "server.properties", replay); err == nil {
		t.Fatal("expected the SECOND presentation of a single-use file token to be rejected")
	}
}

func TestVerifyFileToken_RejectsPathMismatch(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	replay := NewReplayCache()
	// Minted for server.properties, presented against a DIFFERENT path —
	// this is exactly the "don't let a download token for one file also
	// open another" guarantee architecture doc 3.4 requires.
	tok := mintFileToken(t, priv, "file-jti-2", "server.properties", CapFileDownload)

	if _, err := v.VerifyFileToken(tok, testServerUUID, CapFileDownload, "backup.tar.gz", replay); err == nil {
		t.Fatal("expected a path mismatch to be rejected")
	}
}

func TestVerifyFileToken_RejectsMissingCtx(t *testing.T) {
	pub, priv := genKeypair(t)
	v := NewTokenVerifier(pub, testNodeUUID, 10*time.Second)
	replay := NewReplayCache()
	// A console token (no ctx at all) must never be usable as a file
	// token even if somehow presented with a matching capability check
	// bypassed elsewhere — Ctx == nil must fail closed.
	tok := mintToken(t, priv, func(c *Claims) { c.ID = "no-ctx-jti"; c.Cap = CapFileDownload })

	if _, err := v.VerifyFileToken(tok, testServerUUID, CapFileDownload, "server.properties", replay); err == nil {
		t.Fatal("expected a token with no ctx to be rejected")
	}
}

func TestVerifyNodeToken_ConstantTimeComparison(t *testing.T) {
	if !VerifyNodeToken("secret-abc", "secret-abc") {
		t.Fatal("expected matching tokens to verify")
	}
	if VerifyNodeToken("wrong", "secret-abc") {
		t.Fatal("expected mismatched tokens to fail")
	}
	if VerifyNodeToken("", "secret-abc") || VerifyNodeToken("secret-abc", "") {
		t.Fatal("expected empty tokens to always fail")
	}
}
