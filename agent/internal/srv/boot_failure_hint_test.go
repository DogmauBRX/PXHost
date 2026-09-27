package srv

import "testing"

func TestBootFailureHintKeepsEveryDependencyLineEvenUnderTheGeneralCap(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.Hub.Publish("stdout", "Exception message: MISSING EXCEPTION MESSAGE")
	s.Hub.Publish("stdout", "[main/ERROR] [minecraft/Main]: Failed to start the minecraft server")
	s.Hub.Publish("stdout", "net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [")
	s.Hub.Publish("stdout", "Mod §ecolorwheel§r requires §6oculus§r §o1.7.0 or above§r")
	s.Hub.Publish("stdout", "Mod §esecondmod§r requires §6oculus§r §o1.0.0 or above§r")
	s.Hub.Publish("stdout", "Mod §ethirdmod§r requires §6somethingelse§r §o2.0.0 or above§r")

	hint := s.BootFailureHint(4)

	for _, want := range []string{"colorwheel", "secondmod", "thirdmod"} {
		if !contains(hint, want) {
			t.Fatalf("BootFailureHint dropped a dependency line for %q, got:\n%s", want, hint)
		}
	}
}

func TestBootFailureHintFillsRemainingBudgetWithGenericLines(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.Hub.Publish("stdout", "[main/FATAL] older unrelated fatal")
	s.Hub.Publish("stdout", "[main/FATAL] most recent fatal")
	s.Hub.Publish("stdout", "Mod §efoo§r requires §6bar§r §o1.0.0 or above§r")

	hint := s.BootFailureHint(2)

	if !contains(hint, "most recent fatal") {
		t.Fatalf("expected the most recent generic line to survive, got:\n%s", hint)
	}
	if contains(hint, "older unrelated fatal") {
		t.Fatalf("generic budget should have dropped the older line once the dependency line took a slot, got:\n%s", hint)
	}
	if !contains(hint, "foo") {
		t.Fatalf("dependency line must always survive, got:\n%s", hint)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
