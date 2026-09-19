package srv

import "testing"

func TestAllowedModrinthURL(t *testing.T) {
	for _, raw := range []string{
		"http://cdn.modrinth.com/data/a/file.jar",
		"https://cdn.modrinth.com.evil.test/file.jar",
		"https://user@cdn.modrinth.com/file.jar",
		"https://example.com/file.jar",
	} {
		if err := allowedModrinthURL(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
	if err := allowedModrinthURL("https://cdn.modrinth.com/data/a/versions/b/file.jar"); err != nil {
		t.Fatal(err)
	}
}

func TestSafeRelative(t *testing.T) {
	for _, value := range []string{"../secret", "/etc/passwd", "mods/../../secret", ""} {
		if err := safeRelative(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
	for _, value := range []string{"mods/example.jar", "config/example.toml"} {
		if err := safeRelative(value); err != nil {
			t.Fatalf("expected %q to be accepted: %v", value, err)
		}
	}
}
