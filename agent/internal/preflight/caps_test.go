package preflight

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// O node02 subiu com um unit escrito à mão, sem AmbientCapabilities. Este
// é exatamente o conjunto vazio que ele tinha em CapEff.
func TestMissingCapabilities_semNenhuma(t *testing.T) {
	missing := MissingCapabilities(1000, 0x0, RequiredCapabilities)
	if len(missing) != len(RequiredCapabilities) {
		t.Fatalf("esperava as %d faltando, veio %d", len(RequiredCapabilities), len(missing))
	}
}

// E este é o CapEff do node01, que funciona: bits 0, 1 e 3.
func TestMissingCapabilities_comAsTres(t *testing.T) {
	if missing := MissingCapabilities(1000, 0xb, RequiredCapabilities); missing != nil {
		t.Fatalf("0xb tem as três, mas acusou %v", missing)
	}
}

// Faltar UMA é o caso traiçoeiro: o agente funciona para quase tudo e
// falha só onde aquela capability é usada.
func TestMissingCapabilities_umaSo(t *testing.T) {
	// 0xb sem o bit 3 (CAP_FOWNER) = 0x3.
	missing := MissingCapabilities(1000, 0x3, RequiredCapabilities)
	if len(missing) != 1 || missing[0].Name != "CAP_FOWNER" {
		t.Fatalf("esperava só CAP_FOWNER, veio %v", missing)
	}
}

// Root já pode tudo que estas capabilities recortam, e um agente rodando
// como root legitimamente tem o conjunto ambiente vazio — acusar aqui
// seria recusar subir uma instalação perfeitamente válida.
func TestMissingCapabilities_rootEIsento(t *testing.T) {
	if missing := MissingCapabilities(0, 0x0, RequiredCapabilities); missing != nil {
		t.Fatalf("root não deveria acusar nada, veio %v", missing)
	}
}

func TestReadEffectiveCaps(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status")
	// Formato real do /proc/<pid>/status, com as linhas vizinhas que o
	// parser precisa ignorar.
	conteudo := "Name:\tpxagent\nUid:\t1000\t1000\t1000\t1000\n" +
		"CapInh:\t0000000000000000\nCapPrm:\t000000000000000b\n" +
		"CapEff:\t000000000000000b\nCapBnd:\t000001ffffffffff\n"
	if err := os.WriteFile(status, []byte(conteudo), 0o644); err != nil {
		t.Fatal(err)
	}
	caps, ok := readEffectiveCaps(status)
	if !ok || caps != 0xb {
		t.Fatalf("esperava 0xb ok, veio %#x ok=%v", caps, ok)
	}
}

// "Não consegui descobrir" nunca pode virar "está faltando": recusar
// subir num sistema que este check não entende seria uma falha pior que
// a que ele existe para evitar.
func TestReadEffectiveCaps_arquivoAusenteNaoEhFalha(t *testing.T) {
	if _, ok := readEffectiveCaps(filepath.Join(t.TempDir(), "nao-existe")); ok {
		t.Fatal("arquivo ausente deveria responder ok=false, não um valor")
	}
}

func TestReadEffectiveCaps_semALinha(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status")
	if err := os.WriteFile(status, []byte("Name:\tpxagent\nUid:\t1000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := readEffectiveCaps(status); ok {
		t.Fatal("sem a linha CapEff deveria responder ok=false")
	}
}

// A mensagem É o produto deste check — se ela não disser o que fazer, o
// próximo operador repete a mesma caçada de horas.
func TestCheckCapabilities_mensagemDizComoConsertar(t *testing.T) {
	var b strings.Builder
	for _, c := range RequiredCapabilities {
		b.WriteString(c.Name)
		b.WriteString(" ")
	}
	nomes := strings.TrimSpace(b.String())
	if nomes != "CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER" {
		t.Fatalf("a lista precisa bater com deploy/node/pxagent.service, veio %q", nomes)
	}
}
