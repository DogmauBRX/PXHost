# Exposição pública de servidores (VPS gateway + WireGuard)

Runbook completo da camada de exposição pública: como um servidor
Minecraft hospedado num node residencial/CGNAT (IP privado, sem port
forwarding possível) fica acessível por um cliente Minecraft comum, na
internet, sem que ele instale VPN nenhuma.

Extende a topologia já existente em `docs/DEPLOY.md` (VPS + Cloudflare +
WireGuard) — leia aquele documento primeiro se ainda não estiver
familiarizado com ela. **Nada aqui substitui o sistema de allocation do
GXhost** (`Allocation.ip`/`Allocation.port`, `AllocationsService`,
`CapacityService.pickFreeAllocation`) — essa camada continua sendo a
única fonte de verdade sobre qual porta interna cada servidor usa. Esta
funcionalidade só adiciona um mapeamento público por cima dela.

## 1. Arquitetura

```
Cliente Minecraft
   │  (mc-abc123.gxhost.com.br:25566, ou IP_PUBLICO_DA_VPS:25566)
   ▼
VPS pública ── nginx stream (apps/gateway) ── escuta 25566
   │  conecta OUTBOUND para 10.10.0.2:25566 (o próprio IP do node no túnel)
   ▼
WireGuard (wg0, rede já existente — deploy/vps/wg0.conf.example)
   │
   ▼
Node residencial (10.10.0.2 no túnel, 192.168.1.100 na LAN)
   │  nftables PREROUTING DNAT: 10.10.0.2:25566 → 192.168.1.100:25566
   ▼
Docker (o container já publica exatamente 192.168.1.100:25566 — isso já
        funciona hoje, via Allocation.ip/port, sem nenhuma mudança)
   ▼
Servidor Minecraft
```

O node **nunca** precisa de IP público nem de port forwarding no
roteador residencial — a conexão WireGuard é sempre iniciada pelo node
em direção à VPS (`Endpoint = <vps-public-ip>` no `wg0.conf` do node),
o que já funciona atrás de CGNAT hoje para o control plane e continua
funcionando idêntico para o tráfego de jogo.

**Limitação conhecida desta primeira versão:** como o nginx faz uma
conexão nova para o node, o servidor Minecraft vê todo jogador conectado
como vindo do IP do node no túnel (ex. `10.10.0.2`) — bans por IP,
logs de conexão e proteções anti-DDoS por jogador não funcionam
corretamente. Veja a seção 9 para o caminho de upgrade (nftables DNAT
de ponta a ponta, preservando o IP real).

## 2. Modelo de dados

Duas tabelas novas (migration `0036_public_gateway`), reaproveitando
tudo que já existia:

- **`Node.tunnelIp`** — o IP do node no túnel WireGuard (ex.
  `10.10.0.2`), como dado estruturado. Editável em **Admin > Nodes >
  Editar**. Sem isso preenchido, nenhum servidor daquele node é exposto.
- **`Gateway`** — uma VPS gateway (`publicHost`, `tunnelIp`,
  `controlUrl`, `isActive`). Cadastrado em **Admin > Gateways**. Sem
  nenhum gateway ativo cadastrado, a funcionalidade inteira fica
  desligada — todo servidor continua mostrando só `ip:porta` interno,
  exatamente como antes desta funcionalidade existir.
- **`PublicRoute`** — uma linha por servidor exposto, ligando-o a um
  `Gateway` e a uma porta pública (`gatewayId`, `serverId` único,
  `publicPort`, `state`: `pending|active|failed|removing`). O alvo real
  (IP do node no túnel + porta da allocation primária do servidor) é
  **derivado a cada reconciliação**, nunca guardado aqui — assim uma
  transferência de node nunca deixa esse dado desatualizado.

## 3. Como um servidor recebe/perde exposição pública

Totalmente automático, disparado pelos mesmos pontos onde o GXhost já
mexe em allocation hoje — nenhum deles pode falhar por causa do
gateway:

- **Criar servidor** (`ServersService.createOnNode`) → depois do commit,
  `GatewayService.ensureRouteForServer` cria a `PublicRoute` (idempotente
  — não faz nada se já existir uma, ou se nenhum gateway estiver
  cadastrado).
- **Excluir servidor** (`ServersService.remove`) → a linha é
  marcada `removing` e depois apagada via `ON DELETE CASCADE` junto com
  o servidor; a próxima reconciliação (a cada 30s) simplesmente para de
  incluir aquela porta na config do nginx.
- **Transferir de node** (`TransfersService.handleResult`) → a porta
  pública **não muda** (fica presa ao servidor, não ao node); só o alvo
  interno muda, e a próxima reconciliação já pega o node/allocation
  novos sozinha.

## 4. Reconciliação (por que nunca fica preso)

`GatewayReconcileProcessor` roda a cada 30s (BullMQ, fila
`gateway-reconcile`) e recalcula, para cada `Gateway` ativo, a lista
completa de rotas desejadas — servidor existe? tem allocation
primária? o node tem `tunnelIp`? Se sim, entra na lista; senão, fica de
fora (e a rota é marcada `failed` com o motivo). Essa lista completa é
enviada de uma vez (`PUT /api/routes`) para o sidecar, que **substitui**
o arquivo de config do nginx inteiro — nunca faz diff, nunca acumula.
Isso é o que torna tudo idempotente: rodar duas vezes com o mesmo estado
não cria regra duplicada, e se a VPS cair e voltar sem nenhuma config, a
próxima reconciliação recria tudo do zero a partir do banco.

Forçar uma reconciliação manual: botão "Reconciliar agora" em
**Admin > Gateways**, ou `POST /api/admin/gateways/reconcile`.

## 5. Passo a passo — configurando pela primeira vez

### 5.1. Na VPS

1. WireGuard já deve estar rodando (`docs/DEPLOY.md` §1-2) — nada muda
   aqui, é a mesma rede `10.10.0.0/24`.
2. Suba o sidecar do gateway:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build gateway
   ```
   (requer `PUBLIC_GATEWAY_TOKEN` definido no `.env` da VPS — veja
   `.env.production.example`.)
3. Firewall da VPS (fora do compose — regras do provedor/iptables da
   própria VPS, não do node): libere entrada TCP na faixa de portas
   públicas (`PUBLIC_GATEWAY_PORT_RANGE`, padrão `25565-25664`) de
   **qualquer origem** (é tráfego de jogador real) — mas **não** abra a
   porta de controle do sidecar (`9443`) publicamente, só o suficiente
   para o próprio WireGuard alcançá-la:
   ```bash
   # Exemplo com nftables na própria VPS (ajuste à sua distro/provedor):
   nft add rule inet filter input tcp dport 25565-25664 accept
   nft add rule inet filter input ip saddr 10.10.0.0/24 tcp dport 9443 accept
   ```
4. No admin do GXhost, **Admin > Gateways > Criar gateway**:
   - Nome: qualquer coisa (ex. "VPS Principal").
   - Host público: o IP público real da VPS (ou o hostname, se já tiver
     DNS — ex. `gxhost.com.br` ou um subdomínio dedicado).
   - IP no túnel: `10.10.0.1` (o endereço da própria VPS no WireGuard).
   - URL de controle: `http://10.10.0.1:9443` (o sidecar, pela VPN).

### 5.2. No node

1. WireGuard já deve estar rodando (`docs/DEPLOY.md` §3) — nada muda.
2. Aplique o firewall atualizado (preenchendo as 4 variáveis no topo do
   script antes):
   ```bash
   sudo nano deploy/node/firewall.sh   # GATEWAY_TUNNEL_IP, NODE_LAN_IP, GAME_PORT_RANGE
   sudo ./deploy/node/firewall.sh
   sudo sysctl -w net.ipv4.ip_forward=1
   echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
   ```
   Instale também a regra DNAT como serviço persistente. Ela usa uma
   tabela nftables própria e não apaga nem substitui as regras criadas
   pelo Docker:
   ```bash
   sudo install -m 0755 deploy/node/gxhost-game-dnat.sh /usr/local/sbin/
   sudo install -m 0644 deploy/node/gxhost-game-dnat.service /etc/systemd/system/
   sudo install -m 0644 deploy/node/game-dnat.env.example /etc/gxhost-agent/game-dnat.env
   sudo nano /etc/gxhost-agent/game-dnat.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now gxhost-game-dnat.service
   ```
   Sem esse serviço, a regra aplicada manualmente desaparece no próximo
   reboot e o gateway continua aceitando a porta pública, mas recebe
   `connection refused` ao tentar chegar ao servidor no node.
3. No admin do GXhost, **Admin > Nodes > (o node) > Editar**, preencha
   "IP no túnel WireGuard" com o `Address` desse node no `wg0.conf`
   (ex. `10.10.0.2`, sem a máscara `/24`).

Pronto — dentro de 30s (a próxima reconciliação), todo servidor
existente e todo servidor novo nesse node passa a ter um endereço
público. Nada precisa ser reiniciado.

### 5.3. Hostname (opcional)

Sem configurar nada, o cliente vê `<host público do gateway>:<porta>`.
Para usar `<shortId>.mc.<seu-domínio>:<porta>` em vez do IP cru:

1. Crie um registro DNS curinga `*.mc.gxhost.com.br` → IP público da VPS
   (uma vez só, cobre todo servidor atual e futuro).
2. Defina `PUBLIC_GATEWAY_HOSTNAME_ZONE=gxhost.com.br` no `.env` da API.

SRV (pra esconder a porta também, `mc-abc123.gxhost.com.br` sem `:porta`)
é opt-in e **nunca mexe em DNS sozinho** por padrão — só ligue
`PUBLIC_GATEWAY_DNS_PROVIDER=powerdns` (+ `PUBLIC_GATEWAY_DNS_API_URL`
+ `PUBLIC_GATEWAY_DNS_API_TOKEN`) se realmente quiser essa automação —
ver `docs/DNS-POWERDNS.md` para o runbook completo (PowerDNS é a DNS
autoritativa própria do GXhost, não depende mais da Cloudflare para
isso).

### 5.4. Hostname personalizado pelo cliente

Com `PUBLIC_GATEWAY_HOSTNAME_ZONE` configurada, cada cliente pode escolher
um subdomínio próprio, sob o mesmo `.mc.` do esquema acima, em
**Configurações** na página do servidor: `survival` vira
`survival.mc.gxhost.com.br`.

Ele já compôs direto sob o apex (`survival.gxhost.com.br`), o que parecia
mais bonito e não funcionava: a plataforma é autoritativa por
`mc.<zona>` apenas — o apex fica com quem serve o site — então um nome
no apex é um nome que ela não consegue publicar. Ver
`docs/DNS-POWERDNS.md` §5.1 para o que isso causou em produção e as três
guardas que nasceram dali. Diferente do esquema por
`shortId` (que usa um único wildcard estático, seguro porque o `shortId`
é permanente), um hostname escolhido pelo cliente pode ser trocado ou
liberado e reaproveitado por outro cliente depois — por isso cada um
ganha registros DNS próprios (A/AAAA + SRV), criados e removidos
individualmente pelo reconciler, nunca um wildcard.

- **Validação**: formato (minúsculas, números e hífen, sem começar/
  terminar com hífen, 3–32 caracteres), lista de palavras reservadas
  (`www`, `api`, `admin`, `mc`, `node01`, `node02`, mais qualquer label
  com a **forma** de um `shortId` — 8 caracteres do alfabeto dele —
  porque os dois esquemas dividem o namespace `.mc.` e sem isso um
  cliente reivindicaria o endereço do servidor de outro; ver
  `apps/api/src/modules/gateway/hostname-policy.ts`), unicidade global
  (constraint no banco — nenhum cliente pode usar o hostname de outro),
  e, quando `PUBLIC_GATEWAY_DNS_PROVIDER=powerdns` está ligado, uma
  checagem ao vivo contra a zona real no PowerDNS (falha aberta: uma
  instabilidade da API do PowerDNS nunca bloqueia o cliente salvar).
- **Sem porta de verdade**: só quando `PUBLIC_GATEWAY_DNS_PROVIDER=powerdns`
  está ligado — é o registro SRV que faz isso funcionar. Com a automação
  desligada, o hostname ainda é reservado e mostrado, mas com a porta
  (`survival.mc.gxhost.com.br:25566`), porque o SRV nunca foi publicado de
  verdade.
- **Trocar de node/porta**: o hostname do cliente nunca muda — só o alvo
  (`target`/porta) do registro SRV é recalculado a cada reconciliação, o
  mesmo mecanismo que já existe para o esquema por `shortId`.
- **Segurança**: o gateway (`nginx stream`) continua roteando só por
  PORTA, nunca por hostname — o cliente Minecraft resolve o SRV do lado
  dele e conecta direto em `ip:porta`; o hostname nunca chega a ser
  interpretado pelo proxy TCP. Isso já satisfaz "mapping hostname →
  servidor explícito, sem roteamento por padrão previsível" sem nenhum
  código novo no caminho do proxy.

**Bug encontrado e corrigido ao construir isso** (afeta os dois esquemas,
`shortId` e personalizado): excluir um servidor nunca removia o registro
SRV dele — o reconciler só via a linha `removing` DEPOIS que o
`ON DELETE CASCADE` já tinha apagado a `PublicRoute`. A limpeza de DNS
agora acontece de forma síncrona em `GatewayService.markRemoving`, antes
do hard-delete, não mais esperando o reconcile.

## 6. Ambiente de desenvolvimento / teste local

Sem precisar mexer no roteador de casa nem ter uma VPS de verdade — só
uma segunda máquina/VM na mesma rede fazendo o papel da VPS:

1. Suba o sidecar direto (sem Docker):
   ```bash
   cd apps/gateway
   pnpm install
   GATEWAY_TOKEN=dev-token GATEWAY_NGINX_CONF_PATH=/tmp/gxhost-routes.conf pnpm run start:dev
   ```
   (isso ainda chama o `nginx` real via `execFile` — instale-o na
   máquina de teste, ou rode o sidecar dentro do container
   `apps/gateway` mesmo para já ter o nginx incluso: `docker build -t
   gxhost-gateway apps/gateway && docker run --rm -p 9443:9443 -p
   25565-25664:25565-25664 -e GATEWAY_TOKEN=dev-token gxhost-gateway`.)
2. `PUBLIC_GATEWAY_TOKEN=dev-token` no `.env` da API.
3. Crie o Gateway pelo admin com `controlUrl=http://<ip-da-maquina-de-teste>:9443`
   e `publicHost`/`tunnelIp` = o IP dessa máquina na sua rede (não
   precisa ser um túnel de verdade para este teste local — o objetivo é
   só provar o caminho VPS→node→Minecraft).
4. Preencha `tunnelIp` do node com o IP real dele na sua rede (já que
   não há WireGuard de verdade neste teste local, o "IP do túnel" é
   apenas o IP da LAN mesmo — a reconciliação não sabe nem se importa
   se o transporte é WireGuard ou LAN direta).
5. Crie um servidor de teste e confirme com os comandos da seção 7.

## 7. Comandos de teste e diagnóstico

```bash
# 1. Túnel: handshake recente?
wg show

# 2. Rota: a VPS enxerga o node pelo túnel?
ip route get 10.10.0.2

# 3. Control plane: o agent responde pela VPN?
curl http://10.10.0.2:8443/healthz

# 4. Sidecar do gateway está de pé e autenticando certo?
curl http://10.10.0.1:9443/healthz
curl -H "Authorization: Bearer $PUBLIC_GATEWAY_TOKEN" http://10.10.0.1:9443/api/routes

# 5. Estado desejado (banco) bate com o estado real (sidecar)?
#    Compare a saída do comando acima com:
docker exec -it <postgres> psql -U pxhost -d pxhost_dev -c \
  "SELECT server_id, public_port, state, last_error FROM public_routes;"

# 6. nginx está de fato escutando a porta pública?
ss -lntp | grep 25566          # na VPS
nft list ruleset                # no node — confirma a regra DNAT

# 7. TCP puro alcança de fora da rede?
nc -vz IP_PUBLICO_DA_VPS 25566

# 8. Minecraft de verdade
#    No cliente: Multiplayer > Add Server > IP_PUBLICO_DA_VPS:25566
#    (ou mc-<shortId>.mc.<zona>:25566, se configurado)
```

Se o passo 7 falhar mas o 6 funcionar: é o firewall da VPS (§5.1.3). Se
o passo 3 falhar mas o `wg show` (passo 1) mostrar handshake: é o
firewall do node não estar liberando `GATEWAY_TUNNEL_IP` (§5.2.2). Se o
passo 4 falhar: confira `PUBLIC_GATEWAY_TOKEN` nos dois lados.

## 8. Segurança

- **Isolamento entre servidores**: cada porta pública do nginx aponta
  para exatamente um alvo fixo — descobrir uma porta não dá acesso a
  outro servidor, e uma porta sem `PublicRoute` ativa simplesmente não
  está escutando nada.
- **Isolamento node↔node**: o firewall do node aceita tráfego de jogo
  (e de controle) **somente** do IP exato do gateway no túnel
  (`GATEWAY_TUNNEL_IP`), nunca da faixa `10.10.0.0/24` inteira — outro
  node que eventualmente entre nesse mesmo túnel não ganha acesso a
  nada por isso.
- **Painel/SSH/banco nunca ficam públicos por causa disso**: a VPS só
  abre 22, 80/443 (Caddy), 51820/udp (WireGuard) e a faixa de portas de
  jogo — a porta de controle do sidecar (9443) só é alcançável pela VPN.
  `docker-compose.prod.yml` já não publica porta nenhuma de
  Postgres/Redis/MariaDB.
- **DELETE nunca acontece "de fora"**: o sidecar só aceita `PUT`/`GET`
  em `/api/routes` com o bearer token certo; ele nunca inicia conexão
  nenhuma, só reage ao que a API manda.

## 9. Caminho futuro: preservar o IP real do jogador (nftables DNAT)

Esta versão usa nginx `stream` (proxy TCP em userspace) de propósito —
mais simples de operar, sem precisar de policy routing nos nodes. O
custo é o IP do jogador virar o IP do gateway no túnel (§1).

Para preservar o IP real ponta a ponta:

```
Cliente → VPS → nftables DNAT (kernel) → WireGuard → Node → Minecraft
```

O que muda:
1. **Na VPS**: em vez do sidecar nginx, uma regra `nft ... dnat to
   <node-tunnel-ip>` no PREROUTING da própria VPS — o pacote chega com o
   IP do jogador intacto (DNAT não reescreve a origem) e sai pelo `wg0`
   assim mesmo.
2. **No node**: o pacote chega com `saddr` = IP real do jogador, algo
   que a regra de firewall atual (`ip saddr "$GATEWAY_TUNNEL_IP"`) vai
   **rejeitar**, porque ela hoje assume que todo tráfego vem do gateway.
   Precisa mudar para aceitar por interface (`iif wg0`) em vez de por
   IP de origem, já que a origem passa a ser o jogador, não mais o
   gateway.
3. **Rota de volta (o ponto que realmente exige trabalho)**: a resposta
   do container Minecraft, hoje, sai pela rota padrão do node (a LAN),
   não pelo `wg0` — o jogador nunca veria a resposta. Isso exige
   **policy routing** no node: uma tabela de rotas separada que marca
   pacotes vindos de `wg0` (via `fwmark`/`ip rule`) e força a resposta a
   sair de volta pelo mesmo `wg0`, em vez de seguir a tabela de rotas
   principal.
4. **Implementação da interface `GatewayDriver`/`ProxyBackend`**: exatamente
   por causa disso, o core do GXhost (`GatewayService`, `DesiredRoute`)
   já não sabe nada sobre nginx — só chama
   `driver.apply(gateway, routes)`. Um novo `NftablesDnatDriver`
   (API) + `NftablesDnatBackend` (sidecar, ou até sem sidecar nenhum,
   se as regras forem aplicadas via SSH/Ansible) plugam nesse mesmo
   contrato sem tocar em `ServersService`, `TransfersService` ou no
   banco.
5. **Como validar que o IP real está sendo preservado**: no
   `server.properties`/logs do Minecraft, o IP de conexão registrado
   deve ser o do jogador, não `10.10.0.1`. Um teste direto: `tcpdump -i
   <interface-do-container> tcp port 25566` durante uma conexão real e
   conferir o IP de origem no pacote SYN.

Nada disso precisa existir para a v1 funcionar — é o desenho para não
travar essa evolução depois.

## 10. Rollback

A camada inteira é aditiva. Para desligar completamente, sem tocar em
nenhum servidor/allocation/plano/pagamento:

```bash
# 1. Pare o sidecar (a VPS para de aceitar conexão nova nas portas de jogo).
docker compose -f docker-compose.prod.yml stop gateway

# 2. Opcional: desative os gateways no admin (Admin > Gateways > Excluir)
#    — a reconciliação simplesmente para de processá-los.

# 3. Opcional: reverta o firewall do node para a versão anterior
#    (git checkout <commit-anterior> -- deploy/node/firewall.sh) se
#    quiser voltar exatamente ao estado de antes.
```

Nenhuma migration precisa ser revertida — `Node.tunnelIp` é nullable e
`gateways`/`public_routes` ficam simplesmente vazias/órfãs, sem efeito
em nenhuma consulta existente (a query em `server-view.ts` já trata
`publicRoute` ausente como "sem endereço público", exatamente o
comportamento de antes desta funcionalidade existir).
