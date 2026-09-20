# DNS autoritativa própria (PowerDNS Authoritative Server)

Runbook completo de como o GXhost passou a rodar sua própria DNS
autoritativa para hostnames de servidor de jogo (`*.mc.gxhost.com.br` e
hostnames personalizados), em vez de depender de um provedor terceiro
(Cloudflare) para isso. **O site principal (`gxhost.com.br`, painel,
API) continua na Cloudflare normalmente** — nada neste documento mexe
naquela zona; é uma DNS separada, só para o domínio de jogo.

Extende `docs/PUBLIC-EXPOSURE.md` (leia aquele documento primeiro) —
este aqui não duplica a arquitetura de gateway/allocation, só troca
**qual `DnsProvider` publica os registros** que o reconciler já calcula.
DNS aqui é estritamente uma **camada de apresentação**: quem decide para
onde o tráfego de um servidor vai é sempre `Allocation`/`PublicRoute`/
`GatewayReconcileProcessor`, nunca a DNS. Um registro DNS errado ou
desatualizado nunca redireciona um jogador para o servidor errado — na
pior hipótese, o hostname simplesmente não resolve, e o cliente ainda
pode conectar por IP:porta.

## 1. Por que isso já era 90% pronto

O pedido original assumia que seria preciso desenhar do zero: um
`DnsProvider` abstrato, um modelo de hostname por servidor, idempotência,
reconciliação, regras de ciclo de vida (suspensão preserva hostname,
só hard-delete remove, troca de porta/node nunca muda o hostname). Toda
essa camada **já existia**, construída durante a funcionalidade de
exposição pública (`docs/PUBLIC-EXPOSURE.md` §5.3/5.4):

- `apps/api/src/modules/gateway/dns/dns-provider.interface.ts` — a
  interface (`ensureSrv`, `removeSrv`, `ensureAddressRecord`,
  `removeAddressRecord`, `isHostnameAvailable`), já desenhada para caber
  qualquer provedor.
- `apps/api/src/modules/gateway/dns/none.dns-provider.ts` — o provider
  default, no-op (nunca toca em DNS).
- `PublicRoute.customHostname`/`dnsSyncedHostname`/`state` (schema já
  existente) — já cobre tudo que um "ServerHostname" precisaria: qual
  hostname o cliente escolheu, qual foi de fato publicado na DNS por
  último, e o estado da reconciliação. **Nenhuma migration nova foi
  necessária** — ver §3.
- `GatewayService`/`GatewayReconcileProcessor` — já chamam o
  `DnsProvider` ativo nos pontos certos (criação, exclusão, troca de
  hostname, troca de node/porta) com as regras de ciclo de vida corretas
  já implementadas.
- `hostname-policy.ts` — validação de formato/tamanho/palavra reservada
  já existente, independente de qual provider está por trás.

O único provider que existia de verdade era `CloudflareDnsProvider`
(agora removido — §2). Ou seja: o trabalho real desta funcionalidade não
foi "desenhar a camada de DNS", foi **trocar de provedor** — escrever um
`PowerDnsProvider` que implementa a mesma interface, sem tocar em nada
do que já funcionava (allocation, gateway, reconciliação, ciclo de
vida).

## 2. Resumo dos arquivos modificados

| Arquivo | Mudança |
|---|---|
| `apps/api/src/modules/gateway/gateway.module.ts` | Fábrica de `DnsProvider` trocada: `PUBLIC_GATEWAY_DNS_PROVIDER=powerdns` → `PowerDnsProvider` (era `=cloudflare` → `CloudflareDnsProvider`). |
| `apps/api/src/core/config/env.schema.ts` | Enum do provider agora `'none' \| 'powerdns'`. Removida `PUBLIC_GATEWAY_DNS_ZONE_ID` (específica da Cloudflare). Adicionadas `PUBLIC_GATEWAY_DNS_API_URL` e `PUBLIC_GATEWAY_DNS_SERVER_ID`. |
| `apps/api/src/modules/gateway/gateway.service.ts` | Só comentários genericizados (não citam mais "Cloudflare" especificamente, já que não é mais o único provider real possível). |
| `apps/api/src/modules/gateway/dns/none.dns-provider.ts` | Comentário atualizado (`'cloudflare'` → `'powerdns'`). |
| `apps/api/src/modules/gateway/dns/dns-provider.interface.ts` | Comentário genericizado. |
| `apps/api/src/modules/servers/client-servers.service.ts` | **Bug real corrigido**: `dnsAutomationActive` comparava `PUBLIC_GATEWAY_DNS_PROVIDER === 'cloudflare'`, um valor que o enum novo nunca mais produz — isso teria deixado a automação de SRV sempre "desligada" aos olhos do cliente mesmo com PowerDNS ativo. Corrigido para `=== 'powerdns'`. |
| `apps/api/test/gateway.e2e-spec.ts` | Só strings/comentários de teste genericizados (`'fake cloudflare outage'` → `'fake DNS provider outage'`, descrições de teste). Nenhuma asserção mudou. |
| `docker-compose.prod.yml` | Novo serviço `pdns` (ns1, co-localizado com o resto da stack). |
| `.env.production.example` | Bloco de DNS reescrito para as 3 variáveis novas, com comentários. |
| `apps/api/.env.example` | Mesmo bloco, versão para dev local. |

## 3. Novos arquivos

- `apps/api/src/modules/gateway/dns/powerdns.dns-provider.ts` — o
  `DnsProvider` novo. Fala com a REST API do PowerDNS
  (`PATCH /api/v1/servers/{server_id}/zones/{zone}` com `rrsets:
  [{name, type, changetype, ttl, records}]`) — uma única chamada faz
  upsert idempotente (`changetype: 'REPLACE'`) ou remoção
  (`changetype: 'DELETE'`), sem o "buscar primeiro, depois criar-ou-
  atualizar" que a API da Cloudflare exigia.
- `apps/api/src/modules/gateway/dns/powerdns.dns-provider.spec.ts` — 15
  testes unitários (mock de `fetch`), espelhando a cobertura que
  `cloudflare.dns-provider.spec.ts` tinha.
- `docker-compose.dns.yml` — compose standalone para um nameserver
  **genuinamente separado** (ex. ns2 num host diferente) — ver §7.
- `docs/DNS-POWERDNS.md` — este arquivo.

**Removidos**: `apps/api/src/modules/gateway/dns/cloudflare.dns-provider.ts`
e seu spec — confirmado via busca em todo o repositório que nenhum outro
código de produção dependia da classe (só comentários, já atualizados).

## 4. Migrations

**Nenhuma migration nova.** O modelo de dados que a exposição pública já
tinha (`PublicRoute.customHostname`, `PublicRoute.dnsSyncedHostname`,
`PublicRoute.state`) cobre integralmente o conceito de "hostname de
servidor" pedido — adicionar uma tabela `ServerHostname` separada seria
duplicar dado que já existe e uma fonte a mais para ficar dessincronizada.
O `shortId` do servidor (usado no esquema `<shortId>.mc.<zona>`) já é um
campo permanente existente em `Server`, sem necessidade de coluna nova.

## 5. Variáveis de ambiente novas

```bash
# 'none' (default) ou 'powerdns'.
PUBLIC_GATEWAY_DNS_PROVIDER=none

# URL base da REST API do PowerDNS. NUNCA pública — só alcançável pela
# rede WireGuard/loopback (ver §9 Segurança).
PUBLIC_GATEWAY_DNS_API_URL=http://127.0.0.1:8081

# API key do próprio PowerDNS (gerar com `openssl rand -hex 32`) — o
# MESMO nome de variável que a Cloudflare usava (`PUBLIC_GATEWAY_DNS_API_TOKEN`),
# reaproveitado de propósito para não precisar renomear nada em quem já
# lia essa env var.
PUBLIC_GATEWAY_DNS_API_TOKEN=

# Server id do PowerDNS na própria REST API dele — "localhost" é a
# convenção padrão do PowerDNS, praticamente nunca precisa mudar.
PUBLIC_GATEWAY_DNS_SERVER_ID=localhost

# A zona que o PowerDNS REALMENTE hospeda (a que aparece no path
# /api/v1/servers/{id}/zones/{zona} da REST API dele).
PUBLIC_GATEWAY_DNS_ZONE=mc.gxhost.com.br
```

Removida: `PUBLIC_GATEWAY_DNS_ZONE_ID` (conceito específico da Cloudflare
— zona no PowerDNS é identificada pelo próprio nome/domínio).

### 5.1. `PUBLIC_GATEWAY_DNS_ZONE` ≠ `PUBLIC_GATEWAY_HOSTNAME_ZONE`

Essas duas variáveis **não são a mesma coisa**, e tratá-las como se
fossem foi um bug real em produção: todo `PATCH` de registro respondia
`404 Not Found` e, como a sincronia de DNS é best-effort de propósito
(um cliente sempre pode cair de volta no `ip:porta`), nada falhava de
forma visível — os 7 servidores simplesmente continuaram mostrando
`ip:porta` e só o log da API dizia o porquê.

| Variável | O que é | Valor no setup recomendado |
| --- | --- | --- |
| `PUBLIC_GATEWAY_HOSTNAME_ZONE` | O domínio **raiz**, usado só para compor o hostname: `deriveHostname` monta `<shortId>.mc.<zona>`. | `gxhost.com.br` |
| `PUBLIC_GATEWAY_DNS_ZONE` | A zona **delegada aos ns da GXhost**, a que existe de fato no PowerDNS. | `mc.gxhost.com.br` |

O motivo de serem diferentes é justamente o que torna essa migração
segura: delegando **só** `mc.gxhost.com.br`, o domínio raiz continua
servindo site, painel e API de onde já está — a migração não toca em
nada que já funciona. Delegar o raiz inteiro ao PowerDNS também é
válido; nesse caso as duas têm o mesmo valor e
`PUBLIC_GATEWAY_DNS_ZONE` pode ficar vazia (cai em
`PUBLIC_GATEWAY_HOSTNAME_ZONE`).

**Consequência para hostname personalizado**: `deriveCustomHostname`
compõe o label direto sob o raiz (`survival.gxhost.com.br`), que está
**fora** da zona delegada. Com só o subdomínio de jogo delegado, o
PowerDNS não tem como publicar esse nome — `PowerDnsProvider.assertInZone`
recusa com uma mensagem explícita em vez de deixar o PowerDNS devolver
um `422` sem contexto. Para habilitar hostname personalizado é preciso
delegar o raiz inteiro, ou mudar `deriveCustomHostname` para compor sob
`.mc.` também.

## 6. Alterações no Docker/Compose

### 6.1. `docker-compose.prod.yml` (ns1, junto com o resto da stack)

Novo serviço `pdns`, reaproveitando o Postgres já existente (banco `pdns`
separado, mesmo container/credencial de infraestrutura):

```yaml
pdns:
  image: powerdns/pdns-auth-49:latest
  environment:
    PDNS_AUTH_API_KEY: ${PUBLIC_GATEWAY_DNS_API_TOKEN}
  command:
    - --launch=gpgsql
    - --gpgsql-host=postgres
    - --gpgsql-dbname=pdns
    - --gpgsql-user=gxhost
    - --gpgsql-password=${POSTGRES_PASSWORD}
    - --ignore-unknown-settings=gsqlite3-dnssec,gsqlite3-database
    - --webserver-allow-from=127.0.0.1,10.10.0.0/24
    - --default-soa-content=@ hostmaster.gxhost.com.br 0 10800 3600 604800 3600
  ports:
    - "53:53/tcp"
    - "53:53/udp"
    - "127.0.0.1:8081:8081"   # API — NUNCA publicado em 0.0.0.0
```

**Correção importante, achada testando ao vivo (não em produção — num
container local descartável) antes de considerar isto pronto**: a
primeira versão deste serviço configurava tudo (`PDNS_launch`,
`PDNS_gpgsql_*`, `PDNS_api`, `PDNS_webserver*`) via `environment:`,
assumindo (incorretamente) que essa imagem tem um mecanismo genérico
`PDNS_<setting>` → config, do jeito que outras imagens Docker de
PowerDNS têm. **Ela não tem.** O único wrapper de start dela
(`/usr/local/sbin/pdns_server-startup`) só lê UMA variável de ambiente —
`PDNS_AUTH_API_KEY`, que gera automaticamente o bloco
`webserver`+`api`+`api-key` — e ignora silenciosamente qualquer outra
`PDNS_*`. Isso teria feito o serviço subir com o backend `gsqlite3`
padrão da própria imagem (efêmero, dentro do container, nunca no
Postgres) mesmo com `PDNS_launch: gpgsql` configurado — perdendo todo
dado a cada `docker compose up`/recriação do container, e invalidando o
backup/restore via `pg_dump` documentado nas seções 16-17. A configuração
real passa por `command:` (argumentos de linha de comando reais do
`pdns_server`, que o entrypoint da imagem repassa direto) — confirmado
lendo `pdns.conf`/logs dentro de um container descartável e provando que
os registros criados via API realmente aparecem nas tabelas do Postgres
(`SELECT * FROM domains/records`), não só ficam "achando que sim" pela
resposta HTTP.

O `--ignore-unknown-settings=gsqlite3-dnssec,gsqlite3-database` é
necessário porque o `pdns.conf` que já vem dentro da imagem (pré-
configurado para o backend `gsqlite3` que ela mesma inclui) continua
sendo lido primeiro — `--launch=gpgsql` troca o backend ativo, mas as
duas configurações específicas do `gsqlite3` que sobram nesse arquivo
viram "setting desconhecido" assim que o `gsqlite3` deixa de estar
carregado, e o `pdns_server` recusa subir com uma config desconhecida a
menos que seja instruído a ignorá-la.

Só a porta 53 é de fato pública (é a porta que qualquer resolver DNS do
mundo precisa alcançar). A porta 8081 (API) fica em loopback + liberada
só para a sub-rede do WireGuard, nunca exposta na internet.

### 6.2. `docker-compose.dns.yml` (ns2, host genuinamente separado)

O pedido original é explícito: **não assumir que ns1 e ns2 estão na
mesma máquina física**. Por isso este é um compose file separado, para
rodar num segundo VPS/localização, com seu **próprio** Postgres
dedicado (não depende de rede alguma até o Postgres do ns1):

```bash
docker compose -f docker-compose.dns.yml up -d postgres
# espere ficar healthy, depois inicialize o schema do PowerDNS (§7.2)
docker compose -f docker-compose.dns.yml up -d pdns
```

Esse `pdns` sobe **sem `environment:` nenhum** — a imagem só lê uma única
variável de ambiente (`PDNS_AUTH_API_KEY`), e deixá-la fora é justamente
o que mantém a REST API desligada: um secundário nunca precisa dela (o
backend do GXhost só fala com o ns1). Todo o resto vai pelo `command:`.
Ele só recebe a zona por transferência (`AXFR`) do ns1, restrita ao IP
público do ns1 em `--allow-axfr-ips`/`--allow-notify-from`.

## 7. Configuração do PowerDNS

> **Sempre passe `--config-dir=/etc/pdnsutil` ao `pdnsutil`.** Ele não lê
> o `command:` do compose — é outro binário, e só lê arquivo de
> configuração. O que vem na imagem diz `launch=gsqlite3` e aponta para
> um SQLite descartável dentro do container. Sem essa flag, todo comando
> opera no banco errado **e mesmo assim reporta sucesso**: o
> `create-zone` imprime a linha de sempre e sai com 0, tendo criado uma
> zona que o servidor jamais vai servir, e o `list-zone` lê esse mesmo
> fantasma de volta, parecendo confirmar. Descoberto ao subir o ns2: dois
> SOAs diferentes para o mesmo nome de zona, um no Postgres (real, sendo
> servido) e outro no SQLite (o que o pdnsutil mostrava). Passar
> `--launch=gpgsql` na linha de comando não resolve — o pdnsutil rejeita
> a opção. O `pdns_control` não tem esse problema: ele fala com o
> processo em execução, não com o banco.

### 7.1. Por que backend `gpgsql` (PostgreSQL) e não SQLite/BIND

O GXhost já roda Postgres em produção — reaproveitar a mesma engine
evita introduzir uma peça de infraestrutura nova, e o backend `gpgsql`
é o mais maduro dos backends SQL do PowerDNS. **Importante**: o PowerDNS
gerencia seu próprio schema SQL (tabelas `domains`, `records`, etc.) —
isso é **completamente independente do Prisma/das migrations do
GXhost**. O `pdns`/`gxhost` (ns1) ou `pdns` (ns2, arquivo standalone) só
compartilham o motor Postgres, nunca o schema ou as migrations.

### 7.2. Inicializar o schema do PowerDNS (uma vez, por instância)

**ns1 primeiro: crie o banco `pdns`.** O Postgres de `docker-compose.prod.yml`
só cria automaticamente o banco `gxhost` (`POSTGRES_DB: gxhost` no
compose) — `--gpgsql-dbname=pdns` aponta para um banco que ainda não
existe nesse container. Achado revisando este runbook antes de
considerá-lo pronto (nunca testado ao vivo): sem este passo, `pdns`
falha ao subir com `database "pdns" does not exist`, direto no `psql`
do passo seguinte. Crie o banco uma vez, usando o mesmo usuário/senha
que a stack já usa:

```bash
docker exec -i <container_postgres> psql -U gxhost -d gxhost -c 'CREATE DATABASE pdns OWNER gxhost;'
```

**ns2 não precisa desse passo** — `docker-compose.dns.yml` já declara
`POSTGRES_DB: pdns` no seu próprio Postgres dedicado, criado
automaticamente no primeiro boot desse container.

Com o banco criado, carregue o schema do PowerDNS para `gpgsql`. Não
baixe do site: a própria imagem carrega o schema da sua versão, em
`/usr/local/share/doc/pdns/schema.pgsql.sql`. Usar o da imagem elimina
a chance de pegar um schema de versão diferente da do binário que vai
lê-lo — um erro que não aparece na hora, só quando alguma coluna que a
versão nova espera não existe.

```bash
# ns1 (banco compartilhado com o resto da stack, já criado acima):
docker run --rm --entrypoint cat powerdns/pdns-auth-49:latest \
  /usr/local/share/doc/pdns/schema.pgsql.sql \
  | docker compose -f docker-compose.prod.yml exec -T postgres psql -q -U gxhost -d pdns

# ns2 (banco dedicado do docker-compose.dns.yml, já existe por padrão):
docker run --rm --entrypoint cat powerdns/pdns-auth-49:latest \
  /usr/local/share/doc/pdns/schema.pgsql.sql \
  | docker compose -f docker-compose.dns.yml exec -T postgres psql -q -U pdns -d pdns
```

Confere com `\dt`: sete tabelas (`domains`, `records`, `comments`,
`domainmetadata`, `cryptokeys`, `supermasters`, `tsigkeys`).

Depois disso, `docker compose up -d pdns` sobe normalmente — sem esse
passo, o container inicia mas toda zona/registro falha com erro de
tabela inexistente.

### 7.3. Criar a zona `mc.gxhost.com.br` no PowerDNS (uma vez)

Pela própria REST API (a mesma que o `PowerDnsProvider` usa em runtime),
depois do `pdns` estar de pé:

```bash
curl -X POST http://127.0.0.1:8081/api/v1/servers/localhost/zones \
  -H "X-API-Key: $PUBLIC_GATEWAY_DNS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mc.gxhost.com.br.",
    "kind": "Master",
    "nameservers": ["ns1.gxhost.com.br.", "ns2.gxhost.com.br."]
  }'
```

`kind: "Master"`, não `"Native"`. A diferença é só uma: uma zona
`Native` **nunca envia `NOTIFY`**. Com ela, o ns2 continua servindo a
versão antiga até o refresh do SOA vencer — uma hora, na configuração
atual — e como o que se escreve aqui são registros de servidor de jogo
criados no momento em que o cliente aperta o botão, uma hora de atraso é
o mesmo que não funcionar. `Master` + `--primary=yes` no ns1 fazem o ns2
ser avisado em segundos.

Cuidado com o vocabulário, porque o PowerDNS 4.9 usa dois para a mesma
coisa: na REST API o kind é `"Master"`/`"Slave"`, no `pdnsutil` e nos
settings de linha de comando é `primary`/`secondary` — e os nomes
antigos `--master`/`--slave` **não existem mais** como settings. Passar
um setting inexistente não degrada nada: o `pdns_server` se recusa a
subir, e aí cai o DNS de todos os servidores de jogo junto.

## 8. Configuração NS1/NS2

- **ns1** = a instância `pdns` de `docker-compose.prod.yml`, no mesmo
  VPS do resto da stack. Roda API+webserver (é quem o GXhost escreve).
- **ns2** = uma instância **separada** de `docker-compose.dns.yml`, em
  outro host (segundo VPS, ou até em outra região/provedor, para
  redundância geográfica de verdade). Roda só a porta 53, sem API — só
  responde consultas e recebe `AXFR` do ns1.
- Cada uma precisa de um **IP público próprio** (são nameservers
  distintos aos olhos da internet — dois `A`/`AAAA` diferentes).
- No ns1, o IP público do ns2 entra em **duas** listas do `command:` do
  serviço `pdns` em `docker-compose.prod.yml`: `--allow-axfr-ips` (quem
  pode puxar a zona) e `--also-notify` (quem é avisado quando ela muda).
  São coisas separadas — permitir o AXFR sem notificar significa que o
  ns2 só descobre uma mudança quando o refresh do SOA vence.
- Ainda no ns1, `--primary=yes`. É ele que liga o envio de `NOTIFY`;
  sem isso uma zona `MASTER` nunca notifica ninguém.
- No ns2, `--secondary=yes` no `docker-compose.dns.yml` (é o que faz o
  `NOTIFY` recebido virar uma transferência de verdade) e o IP do ns1 em
  `--allow-notify-from`.
- Crie a zona no ns2 como secundária, apontando pro ns1 — sem isso não
  há o que transferir:
  ```bash
  # no host do ns2:
  docker compose -f docker-compose.dns.yml exec pdns \
    pdnsutil --config-dir=/etc/pdnsutil \n      create-secondary-zone mc.gxhost.com.br <IP_PUBLICO_DO_NS1>
  # força a primeira cópia em vez de esperar o refresh:
  docker compose -f docker-compose.dns.yml exec pdns \
    pdns_control retrieve mc.gxhost.com.br
  ```

### 8.1. O que está montado hoje (2026-09-20)

O resto desta seção descreve o procedimento; isto aqui registra onde ele
foi parar, que é o que falta quando alguém precisa mexer meses depois.

| | ns1 | ns2 |
|---|---|---|
| Host | `143.95.164.255` (`ssh vps`) | `143.95.213.60` (`ssh vps2`) |
| Diretório | `/opt/gxhost` (checkout git) | `/opt/gxhost-ns2` (**não** é git) |
| Compose | `docker-compose.prod.yml` | `docker-compose.dns.yml` |
| Postgres | compartilhado com a stack, banco `pdns` | dedicado, só do nameserver |
| REST API | sim, é quem o painel escreve | não, deliberadamente |
| Kind da zona | `MASTER` | `SLAVE`, primário `143.95.164.255` |

O ns2 não é um checkout git de propósito: ele precisa de exatamente um
arquivo de compose e um `.env` com a senha do Postgres dele, e clonar o
repositório inteiro num nameserver público significaria manter o código
da plataforma numa máquina que não tem motivo para conhecê-lo. Para
atualizar, copie o compose:

```bash
scp docker-compose.dns.yml vps2:/opt/gxhost-ns2/
ssh vps2 "cd /opt/gxhost-ns2 && docker compose -f docker-compose.dns.yml up -d"
```

O `.env` do ns2 tem três variáveis: `PDNS_POSTGRES_PASSWORD` (gerada na
instalação, só existe lá), `PDNS_NS1_PUBLIC_IP` e `PDNS_BIND_ADDRESS`
— esta última é o IP público **do próprio ns2**, por causa do
systemd-resolved (§7).

## 9. Delegação: tudo na Cloudflare, nada no Registro.br

`mc.gxhost.com.br` é um **subdomínio** de `gxhost.com.br` — não precisa
ser registrado como domínio próprio, só delegado. E como
`gxhost.com.br` inteiro é servido pela Cloudflare (isso continua — §0),
**a configuração toda acontece lá**. No Registro.br não há nada a fazer.

Na zona `gxhost.com.br` da Cloudflare, dois tipos de registro:

1. **O endereço de cada nameserver**, como registro `A` comum:
   ```
   ns1.gxhost.com.br.   A   <IP público do ns1>
   ns2.gxhost.com.br.   A   <IP público do ns2>
   ```
   Estes precisam ficar **cinza (DNS only)**, nunca laranja. Um
   nameserver atrás do proxy da Cloudflare responderia com um IP da
   Cloudflare, que não fala DNS na porta 53 — a delegação inteira
   pararia de funcionar.
2. **A delegação do subdomínio**, como registros `NS`:
   ```
   mc.gxhost.com.br.   NS   ns1.gxhost.com.br.
   mc.gxhost.com.br.   NS   ns2.gxhost.com.br.
   ```
   Registro `NS` não tem proxy; é só delegação.

### Por que NÃO há glue record aqui

Uma versão anterior deste runbook mandava cadastrar glue records no
Registro.br, com o argumento de que `ns1`/`ns2` estão "dentro do próprio
domínio que delegam" e sem glue o resolver cairia num loop. Esse loop
não existe nesta topologia, e a instrução era errada.

Glue é necessário quando o nameserver tem nome **dentro da zona que ele
mesmo serve** — aí, para descobrir o IP dele, seria preciso perguntar a
ele. Aqui a zona delegada é `mc.gxhost.com.br` e os nameservers se
chamam `ns1/ns2.gxhost.com.br`: nomes na zona **pai**, que quem responde
é a Cloudflare. O resolver pergunta o IP do ns1 à Cloudflare, recebe, e
só então vai falar com o ns1 sobre `mc`. Nenhuma circularidade.

Glue só entraria em cena se um dia `gxhost.com.br` inteiro fosse
delegado para nameservers próprios — aí sim o registrador precisaria
carregar os endereços deles.

## 10. Como testar DNS

```bash
# A delegação e o endereço dos nameservers resolvem?
dig NS mc.gxhost.com.br
dig A ns1.gxhost.com.br
dig A ns2.gxhost.com.br

# Consulta direta no PowerDNS (bypassa cache de resolver, prova que a
# zona está correta na origem):
dig @<ip-publico-ns1> A abc123.mc.gxhost.com.br
dig @<ip-publico-ns2> A abc123.mc.gxhost.com.br   # confirma AXFR ok

# Resolução "pelo mundo" (depois da delegação propagar, minutos a horas):
dig A abc123.mc.gxhost.com.br
```

## 11. Como testar o SRV do Minecraft

```bash
dig SRV _minecraft._tcp.abc123.mc.gxhost.com.br

# formato esperado (RFC 2782): priority weight port target
# _minecraft._tcp.abc123.mc.gxhost.com.br. 60 IN SRV 0 0 25566 abc123.mc.gxhost.com.br.
```

No cliente Minecraft: **Multiplayer > Add Server >
`abc123.mc.gxhost.com.br`** (sem porta) — o próprio launcher resolve o
SRV e conecta na porta certa.

## 12. Como testar criação de servidor (ponta a ponta)

1. `PUBLIC_GATEWAY_DNS_PROVIDER=powerdns` no `.env` da API + as 3
   variáveis do §5 preenchidas, API reiniciada.
2. Crie um servidor normalmente pelo painel (fluxo já existente, nada
   muda aqui).
3. Dentro de 30s (próxima reconciliação — ou force via **Admin >
   Gateways > Reconciliar agora**), confirme:
   ```bash
   dig @<ip-ns1> SRV _minecraft._tcp.<shortId>.mc.gxhost.com.br
   ```
   deve responder com a porta pública real da `PublicRoute` desse
   servidor.
4. Confirme na tabela que o reconciler realmente enxergou sucesso:
   ```sql
   SELECT server_id, public_port, state, dns_synced_hostname, last_error
     FROM public_routes WHERE server_id = '<id>';
   -- state deve ser 'active', last_error NULL
   ```

## 13. Como testar remoção

```bash
# Apague o servidor pelo painel/API normalmente, depois confirme que o
# SRV (e A/AAAA, se era hostname personalizado) sumiu IMEDIATAMENTE —
# GatewayService.markRemoving limpa a DNS de forma síncrona, antes do
# hard-delete, sem esperar a próxima reconciliação:
dig @<ip-ns1> SRV _minecraft._tcp.<shortId>.mc.gxhost.com.br
# esperado: NXDOMAIN / sem resposta
```

## 14. Como testar reconciliation

```bash
# 1. Simule uma falha: pare o container pdns.
docker compose -f docker-compose.prod.yml stop pdns

# 2. Crie ou edite um hostname personalizado pelo painel — deve
#    continuar funcionando (fail-open: PublicRoute fica 'failed' com
#    last_error preenchido, mas o servidor em si não é afetado nem
#    bloqueado).
# 3. Suba o pdns de novo:
docker compose -f docker-compose.prod.yml start pdns

# 4. Force uma reconciliação (Admin > Gateways > Reconciliar agora, ou
#    espere os 30s) e confirme que os registros aparecem sozinhos, sem
#    nenhuma ação manual — é o mesmo mecanismo "recalcula tudo do zero
#    a cada tick" que docs/PUBLIC-EXPOSURE.md §4 já documenta.
```

## 15. Rollback

Reversível a qualquer momento, sem tocar em servidor/allocation/
gateway/pagamento algum:

```bash
# 1. Volte a variável de ambiente (API cai para NoneDnsProvider):
#    PUBLIC_GATEWAY_DNS_PROVIDER=none
# 2. Reinicie api/worker.
docker compose -f docker-compose.prod.yml up -d --no-deps api worker
# 3. Opcional: pare o serviço pdns (não é mais chamado de qualquer forma).
docker compose -f docker-compose.prod.yml stop pdns
```

Nenhuma migration para reverter (§4 — nenhuma foi criada). Os
registros já publicados no PowerDNS ficam órfãos (respondendo, mas
nunca mais atualizados) até você removê-los manualmente ou apagar a
zona — o site/painel/checkout não são afetados em nenhum cenário, já
que essa DNS é exclusiva do domínio de jogo `mc.gxhost.com.br`.

Se em vez de voltar para `none` você quiser voltar para a Cloudflare
como provider de novo, isso exigiria reintroduzir `CloudflareDnsProvider`
(removido nesta mudança) — recuperável via `git log`/`git revert` do
commit que o removeu, caso necessário.

## 16. Backup

O que precisa de backup é **só o banco Postgres do PowerDNS** (as zonas/
registros — tudo mais é stateless):

```bash
# ns1 (banco compartilhado — banco 'pdns' dentro do mesmo Postgres):
docker exec <container_postgres> pg_dump -U gxhost -d pdns > pdns-ns1-backup.sql

# ns2 (banco dedicado do docker-compose.dns.yml):
docker exec <container_postgres_dns> pg_dump -U pdns -d pdns > pdns-ns2-backup.sql
```

Inclua isso na mesma rotina/cron que já faz backup do Postgres principal
do GXhost (`docs/DEPLOY.md`) — é só mais um `pg_dump`, mesma cadência.
Se/quando DNSSEC for ativado (§18), as chaves privadas também vivem
nesse mesmo banco (`cryptokeys`) — o backup acima já as cobre.

## 17. Como restaurar

```bash
# Suba um Postgres/pdns limpo, schema já inicializado (§7.2), depois:
docker exec -i <container_postgres> psql -U gxhost -d pdns < pdns-ns1-backup.sql

# Reinicie o pdns para ele reler o estado:
docker compose -f docker-compose.prod.yml restart pdns
```

Nenhuma coordenação com o GXhost/Prisma é necessária — o PowerDNS é
restaurado de forma totalmente independente do resto do banco.

## 18. Como adicionar um NS adicional no futuro (ex. ns3)

1. Suba uma nova instância com `docker-compose.dns.yml` (copie o
   arquivo, ajuste nomes se quiser rodar mais de uma no mesmo compose
   project) em outro host.
2. Acrescente o IP público do host novo ao `--allow-axfr-ips` e ao
   `--also-notify` do `pdns` em `docker-compose.prod.yml` (ns1) e
   recarregue: `docker compose -f docker-compose.prod.yml up -d pdns`.
3. No host novo, `pdnsutil --config-dir=/etc/pdnsutil create-secondary-zone
   mc.gxhost.com.br <IP_ns1>`.
   A partir daí o ns1 avisa sozinho a cada mudança; para forçar a
   primeira cópia sem esperar, `pdns_control retrieve mc.gxhost.com.br`.
4. Na zona `gxhost.com.br` da Cloudflare, adicione o `A` de
   `ns3.gxhost.com.br` → IP público, **cinza (DNS only)**. Não há nada a
   fazer no Registro.br (§9).
5. Adicione o registro `NS mc.gxhost.com.br. ns3.gxhost.com.br.` na
   zona `gxhost.com.br` na Cloudflare (mesmo passo do §9.2).
6. Opcional: atualize o array `nameservers` retornado pela zona no
   PowerDNS (`PATCH .../zones/mc.gxhost.com.br.` com o novo NS no
   próprio `rrsets` do apex) para que respostas autoritativas já
   incluam o ns3 também.

Nenhum código do GXhost muda — o `PowerDnsProvider` só fala com o ns1
(o único com API), nunca com os secundários diretamente.

## 19. Como ativar DNSSEC futuramente

Desligado por padrão nesta entrega (o pedido original só pediu
"DNSSEC-ready", não ativado). Para ativar quando fizer sentido:

```bash
# 1. Assine a zona (o PowerDNS gera e guarda as chaves no próprio banco
#    gpgsql — nenhuma mudança de código necessária, é config do PowerDNS):
curl -X POST http://127.0.0.1:8081/api/v1/servers/localhost/zones/mc.gxhost.com.br./cryptokeys \
  -H "X-API-Key: $PUBLIC_GATEWAY_DNS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keytype": "ksk", "active": true}'

# repita com "keytype": "zsk" para a chave de assinatura de zona.

# 2. Pegue o registro DS a publicar no pai (Cloudflare, já que é lá que
#    'mc.gxhost.com.br' é delegado — §9.2):
curl http://127.0.0.1:8081/api/v1/servers/localhost/zones/mc.gxhost.com.br./cryptokeys \
  -H "X-API-Key: $PUBLIC_GATEWAY_DNS_API_TOKEN"
# a resposta inclui "ds": [...] — cada string já no formato pronto pra
# colar como registro DS.
```

3. Na Cloudflare, na zona `gxhost.com.br`, adicione o(s) registro(s) DS
   retornado(s) acima para o subdomínio `mc` (painel da Cloudflare tem
   um campo dedicado para DS records em domínios/subdomínios delegados).
4. Propague para o ns2 (o `AXFR` já leva o `RRSIG`/`DNSKEY` junto — nada
   adicional necessário nele).
5. **Rotação de chaves**: PowerDNS suporta rotação automática
   (`pdnsutil` tem comandos para isso), mas para uma zona pequena como
   essa, rotação manual periódica (gerar chave nova, publicar DS novo,
   esperar o TTL do DS antigo expirar, aí sim desativar a antiga) é mais
   simples de operar com segurança do que automatizar de início.

## 20. Segurança

- A API do PowerDNS (`8081`) **nunca** é publicada em `0.0.0.0` — só
  `127.0.0.1` (mesmo host) e a sub-rede do WireGuard
  (`--webserver-allow-from`, no `command:` do serviço). Um cliente do
  GXhost nunca cria registro DNS arbitrário — só os 5 métodos do
  `DnsProvider`, cada um restrito ao formato exato de SRV/A/AAAA que o
  próprio GXhost monta, nunca aceitando conteúdo livre vindo do cliente.
- A API key (`PUBLIC_GATEWAY_DNS_API_TOKEN`) só existe como variável de
  ambiente — nunca hardcoded, nunca versionada (`.env.production.example`
  só documenta o nome da variável, com o valor em branco).
- ns2 não roda API/webserver nenhum — só porta 53, reduzindo a
  superfície de ataque do secundário ao mínimo possível (ele só
  responde consulta e aceita `AXFR` de um IP específico).
- Fail-open em `isHostnameAvailable`: uma instabilidade do PowerDNS
  nunca impede um cliente de salvar um hostname personalizado — na
  pior hipótese, a checagem de conflito ao vivo é pulada dessa vez (a
  constraint `@unique` no banco continua sendo a garantia de verdade
  contra duplicidade, independente da DNS estar no ar ou não).

## 0. O que NÃO muda

- A zona `gxhost.com.br` (site, painel, `api.gxhost.com.br`) continua
  inteiramente na Cloudflare, exatamente como `docs/DEPLOY.md` já
  documenta — nada aqui foi tocado ou migrado.
- Nenhuma credencial de produção existente foi alterada.
- Nenhum deploy foi feito para a VPS de produção como parte desta
  mudança — o código está pronto e testado localmente (§21), mas
  `PUBLIC_GATEWAY_DNS_PROVIDER` continua `none` até você decidir ativar,
  seguindo os passos de configuração de nameserver/registrador acima
  primeiro (ativar antes disso deixaria o hostname reservado no banco
  mas sem nenhum registro DNS de fato publicável, já que a zona nem
  existiria ainda).

## 21. Resultado dos testes

- `pnpm run test` (suite unitária completa, `apps/api`): **178/178
  passaram**, incluindo os 15 testes novos de `powerdns.dns-provider.spec.ts`.
- `pnpm run test:e2e -- gateway.e2e-spec.ts`: **16/16 passaram**.
- `tsc --noEmit` (`apps/api`): sem erros.
- `apps/panel`: nenhum arquivo alterado nesta mudança (é puramente
  backend) — build/typecheck do painel não re-executado por não haver
  nada para regredir ali.
