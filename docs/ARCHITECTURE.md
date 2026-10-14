# Arquitetura

Visão geral de como as peças conversam. Para subir o projeto, veja o [README](../README.md).

## Peças

```
navegador (cliente, src)
   │  WebSocket  ws://<host>:8090/tcp?target=auth|game1|game2|game3   (bytes do protocolo PB)
   │  WebSocket  ws://<host>:8090/signal?...                          (sinalização WebRTC)
   │  HTTP       /api/register, /api/login                            (conta, sem protocolo PB)
   ▼
servidor (server)  ──── Postgres 16 (db/)
   ├─ Auth   (TCP 39290; também via /tcp?target=auth)
   ├─ Game   (TCP 39291-39293, um por canal; também via /tcp?target=game1..3)
   └─ web front (8090): /tcp, /signal, /api, /health

partida P2P (um dos jogadores é o host)
   host: Web Worker na aba do líder da sala (src/host) + um RTCPeerConnection por convidado
   convidado: um RTCPeerConnection até o host
```

O navegador não abre TCP. Todo o tráfego PB passa por WebSocket no front web. O servidor TCP continua disponível para clientes nativos.

## Cliente (`src`)

| Pasta | Conteúdo |
|---|---|
| `boot.ts`, `main.ts`, `game/game.ts` | inicialização, loop do jogo, tela de lobby e de batalha |
| `game/`, `weapons/`, `gameplay/` | personagem, armas, granadas, dano, movimento (controlador de personagem) |
| `game/pbHud/` | HUD da partida (placar, munição, radar, avisos) |
| `lobby/` | lobby: telas (`screens`, `screensCross`), estado (`state`), regras de sala (`core`) |
| `net/` | conexão WebSocket, enquadramento e cifra do protocolo (`cmess.ts`, `packet.ts`), um cliente por assunto (login, sala, clã, amigos, loja, missões) |
| `p2p/`, `host/` | partida P2P: sinalização, canais de dados, host (`matchCore.ts`, `worker.ts`) |
| `render/` | three.js: materiais, texturas comprimidas, iluminação |
| `ui/` | telas de conta e de sala no modo web |

Os assets (modelos, texturas, sons, mapas) não estão no repositório. O export do `pbx` gera-os em `public/assets/`.

## Servidor (`server/src`)

| Arquivo ou pasta | Conteúdo |
|---|---|
| `main.ts` | sobe Auth, Game e o front web num processo só |
| `config.ts` | lê `server/runtime/Config/Settings.ini`, `server/runtime/Data/ServerConfig.json` e `server/.env.local` / variáveis de ambiente |
| `auth/` | Auth: login, lista de servidores e canais, token de entrada |
| `game/` | Game: canais, lobby, salas (`roomModel.ts`, `roomHandlers.ts`), inventário, loja, clã, missões, votações, chat e relatórios |
| `web/` | front web: `/tcp` (WebSocket para TCP), `/signal`, `/api` (conta, com bcrypt), `/health` |
| `net/tcpSession.ts` | enquadramento e cifra de uma sessão PB, igual para Auth e Game |
| `shared/` | acesso ao Postgres (`db.ts`, `dao.ts`), dados estáticos (`data.ts`, `shop.ts`, `items.ts`) |

Os dados de jogo que o servidor lê na subida ficam em `server/runtime/`. O banco guarda contas, personagens, inventário e progresso. A tabela `system_*` guarda configuração (loja, missões, títulos, canais) e vem de `db/init/001_init.sql`.

## Protocolo

O protocolo é o binário original do Point Blank. Cada pacote tem cabeçalho de opcode e número de sequência. A cifra e o enquadramento estão em `src/net/cmess.ts` (cliente) e `server/src/net/tcpSession.ts` (servidor). Os dois usam o mesmo código de cifra, e os testes de vetores em `src/net/test/` conferem a compatibilidade. Os opcodes estão em `src/net/opcodes.ts`.

Fluxo de entrada: conexão, `CONNECT_ACK` (chave de sessão), login no Auth, troca para o Game, escolha de canal, lobby. Depois disso, sala, partida e resultado.

## Banco

- Postgres 16 em Docker (`db/docker-compose.yml`), porta 5433 em `127.0.0.1`.
- `db/init/001_init.sql` é carregado quando o volume está vazio (primeira subida). Ele traz o esquema e os dados de jogo (loja, mapas, missões, títulos, canais), sem contas nem progresso. Para mudar o esquema ou os dados, gere um novo init a partir do banco e teste numa subida limpa; para resetar, `docker compose down -v`.
- Não há usuário de teste no banco. Contas são criadas pelo registro.

## P2P

A sala e o resultado continuam no servidor (Game). Só os datagramas da partida trafegam entre os jogadores:

1. Ao iniciar a batalha, o Game emite um ticket de sinalização para cada jogador (`server/src/web/signalTicket.ts`).
2. O líder da sala roda o núcleo da partida (`src/host/matchCore.ts`) num Web Worker da própria aba.
3. Cada convidado abre um `RTCPeerConnection` até o líder. A troca de SDP e ICE passa pela rota `/signal` do servidor, que só repassa mensagens. Sem ticket válido, nada é entregue.
4. Se o líder sai, o host passa para outro jogador (handoff). `src/p2p/handoff.ts`.

Sem TURN configurado, só STUN público é usado. Jogadores atrás de NAT restrito podem não conectar. Veja `TURN_URLS` em `server/.env.example`.
