package api

import (
	"net/http"
	"testing"

	"github.com/gxhost/agent/internal/srv"
)

// O painel e a API ja chamavam POST /api/servers/{uuid}/reinstall muito
// antes desta rota existir, e o resultado era o "404 page not found" cru
// do mux do Go. Estes testes cobrem as guardas que decidem ANTES de
// qualquer chamada ao Docker — o resto (pull + recriacao do container) e
// validado ao vivo, como todo o restante deste pacote.
// O harness deste pacote nao tem cliente Docker, entao nenhum teste aqui
// pode passar das guardas (o pull da imagem viria logo depois). O 409
// abaixo e o que prova que a rota esta registrada: so o handler produz
// esse codigo — se o mux nao casasse, viria o 404 cru do Go.
const reinstallBody = `{"image":"example/java:17","startupTemplate":"java -jar s.jar","declaredVariables":[],"variables":{},"installImage":"x","installEntrypoint":"bash","installScript":"true"}`

func TestReinstall_ServidorDesconhecidoDa404(t *testing.T) {
	s, _ := newFilesTestServer(t)
	rec := doReq(t, s, http.MethodPost, "/api/servers/11111111-2222-3333-4444-555555555555/reinstall", []byte(reinstallBody), "test-node-token")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("uuid desconhecido deveria dar 404, veio %d: %s", rec.Code, rec.Body.String())
	}
}

func TestReinstall_RecusaServidorLigado(t *testing.T) {
	s, _ := newFilesTestServer(t)
	target, ok := s.manager.Get(filesTestServerUUID)
	if !ok {
		t.Fatal("servidor de teste nao registrado")
	}
	target.State = srv.StateRunning

	rec := doReq(t, s, http.MethodPost, "/api/servers/"+filesTestServerUUID+"/reinstall", []byte(reinstallBody), "test-node-token")
	if rec.Code != http.StatusConflict {
		t.Fatalf("servidor ligado deveria dar 409, veio %d: %s", rec.Code, rec.Body.String())
	}
}

func TestReinstall_CorpoInvalidoDa422(t *testing.T) {
	s, _ := newFilesTestServer(t)
	for _, corpo := range []string{`{}`, `{"image":"x"}`, `{"startupTemplate":"y"}`, `nao e json`} {
		rec := doReq(t, s, http.MethodPost, "/api/servers/"+filesTestServerUUID+"/reinstall", []byte(corpo), "test-node-token")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("corpo %q deveria dar 422, veio %d", corpo, rec.Code)
		}
	}
}

func TestReinstall_ExigeTokenDoNode(t *testing.T) {
	s, _ := newFilesTestServer(t)
	rec := doReq(t, s, http.MethodPost, "/api/servers/"+filesTestServerUUID+"/reinstall", []byte(reinstallBody), "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sem token deveria dar 401, veio %d", rec.Code)
	}
}
