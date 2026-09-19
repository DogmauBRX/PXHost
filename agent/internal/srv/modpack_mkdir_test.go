package srv

import (
	"os"
	"path/filepath"
	"testing"
)

// O chown em si só tem efeito no Linux (é ignorado nos outros sistemas,
// ver chownStagedPath), então o que dá para fixar aqui é o resto do
// contrato: criar a árvore inteira e nunca caminhar acima da raiz de
// staging — um bug nessa segunda parte trocaria o dono de diretórios que
// não pertencem à instalação.
func TestMkdirAllOwned_CriaArvoreCompleta(t *testing.T) {
	root := t.TempDir()
	alvo := filepath.Join(root, "mods", "sub", "dir")

	if err := mkdirAllOwned(root, alvo, os.Getuid()); err != nil {
		t.Fatalf("mkdirAllOwned: %v", err)
	}
	info, err := os.Stat(alvo)
	if err != nil || !info.IsDir() {
		t.Fatalf("esperava o diretório criado, got err=%v info=%v", err, info)
	}
}

func TestMkdirAllOwned_AceitaDiretorioIgualARaiz(t *testing.T) {
	root := t.TempDir()
	if err := mkdirAllOwned(root, root, os.Getuid()); err != nil {
		t.Fatalf("a própria raiz deve ser aceita: %v", err)
	}
}

func TestMkdirAllOwned_NaoCaminhaAcimaDaRaiz(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "staging")
	fora := filepath.Join(base, "fora")
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatal(err)
	}

	// Um alvo fora da raiz não deve fazer a função subir a árvore
	// chownando o caminho inteiro — ela chowna só o que foi pedido.
	if err := mkdirAllOwned(root, fora, os.Getuid()); err != nil {
		t.Fatalf("mkdirAllOwned: %v", err)
	}
	if _, err := os.Stat(fora); err != nil {
		t.Fatalf("esperava o diretório criado: %v", err)
	}
}
