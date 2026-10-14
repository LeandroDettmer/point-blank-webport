# Point Blank web port

Read this in English: [README.md](README.md).

Port web do Point Blank (cliente Point Blank Cross) para o navegador. O cliente é TypeScript + Vite + three.js + Rapier. O servidor (`server`) fala o protocolo binário original e usa Postgres. As partidas rodam peer-to-peer (WebRTC). O servidor cuida de login, lobby, salas, itens e progressão.

> **Aviso legal.** Este repositório tem só código nosso: cliente, servidor, esquema do banco e scripts. Não tem assets, executável nem dados de jogo extraídos. O código deste projeto é licenciado sob a [MIT](LICENSE).
>
> **Point Blank, seus assets, seu protocolo de rede e seus dados de jogo pertencem à Zepetto e não são cobertos pela licença MIT.** Isso vale também para `server/runtime/Config/` e `server/runtime/Data/`, que trazem dados do jogo mantidos como estão.
>
> Use o projeto com um cliente que você tem direito de usar. Não publique assets extraídos. Este projeto não é afiliado nem endossado pela Zepetto.

## Requisitos

| Item | Observação |
|---|---|
| Node.js 22.18 ou mais novo | O servidor roda arquivos `.ts` direto (type stripping). Testado com Node 24. |
| npm | Vem com o Node. |
| Git | Para clonar os dois repositórios. |
| Docker | Docker Desktop (Windows/macOS) ou Docker Engine. Sobe o Postgres 16 em `127.0.0.1:5433`. Precisa estar rodando antes do `dev:all`. |
| Cliente Point Blank Cross | Uma pasta chamada `PBCross`, com `PointBlank.exe` e `Pack/`. Você precisa ter o cliente. |
| Python 3 + `capstone` | Só para as ferramentas de engenharia reversa do `pb-extract-tools`. Não é necessário para jogar. |

O ffmpeg vem com `npm install` (pacote `ffmpeg-static`). Não instale à parte.

## Estrutura de pastas

Você precisa de duas pastas lado a lado:

```
pasta-de-projetos/
├── point-blank-webport/     este repositório
│   └── Clients/PBCross/     seu cliente (criado por você, git-ignored)
└── pb-extract-tools/        exportador de assets (outro repositório)
```

## Passo a passo, do zero

Os passos 1 e 2 rodam na pasta `pasta-de-projetos/`. Dos passos 3 em diante, o diretório atual é `point-blank-webport/`.

**1. Clone os dois repositórios**

```sh
git clone <url deste repositório> point-blank-webport
git clone https://github.com/LeandroDettmer/pb-extract-tools-public pb-extract-tools
```

**2. Instale as dependências**

```sh
cd point-blank-webport
npm install
npm --prefix server install
npm --prefix ../pb-extract-tools install
```

**3. Coloque o cliente**

Copie sua instalação do Point Blank Cross para `point-blank-webport/Clients/PBCross/`. Tem que existir o arquivo `Clients/PBCross/PointBlank.exe`. O nome da pasta precisa ser exatamente `PBCross`. Se o cliente estiver em outro lugar, aponte com a variável `PB_CLIENTS` (pasta que contém `PBCross`).

**4. Confira o ambiente**

```sh
npm run pbx -- doctor
```

Mostra Node, dependências, ffmpeg, o cliente encontrado e quais grupos de comando podem rodar. Confira que o Point Blank Cross aparece como encontrado.

**5. Gere os assets**

```sh
npm run pbx -- export all --client cross --dry-run   # lista os passos e não grava nada
npm run pbx -- export all --client cross             # roda os passos em ordem
npm run assets:ogg                  # versões OGG dos sons WAV
```

- Tempo e tamanho: o export leva horas e ocupa vários GB. Não medimos o tempo exato. Depende da máquina e do cliente.
- Onde grava: `public/assets/` e `extracted/`. Ambos são git-ignored. O cliente é só lido, nunca alterado.
- Passos sem o cliente necessário são pulados e listados no resumo.
- Se um passo falhar, o `pbx` diz o nome dele. Corrija a causa e retome com `npm run pbx -- export all --client cross --from <passo>`.
- Ajuda completa: `npm run pbx -- help`. Documentação do exportador: README de `pb-extract-tools`.

**6. Configure o servidor (opcional)**

Os padrões já funcionam com o Docker do próximo passo. Para mudar algo, copie o modelo e edite:

```sh
cp server/.env.example server/.env.local
```

A seção [Variáveis de ambiente](#variáveis-de-ambiente) explica cada uma.

**7. Suba a pilha**

```sh
npm run dev:all
```

O comando:

- sobe o Postgres pelo Docker (`db/docker-compose.yml`). Se o volume ainda não existe (primeira subida), o banco é criado a partir de `db/init/001_init.sql`: esquema e dados de jogo, sem contas;
- inicia o servidor (portas 39290, 39291-39293 e 8090);
- inicia o Vite (porta 8000).

O servidor reinicia sozinho quando muda `server/src` ou `server/runtime/Config`. `Ctrl+C` encerra tudo. `npm run dev:all:nowatch` desliga essa observação. `npm run status` mostra quais portas estão em uso.

**8. Entre no jogo**

1. Abra http://localhost:8000.
2. Crie uma conta na tela de registro do jogo. Ou pela API:

   ```sh
   curl -X POST http://localhost:8090/api/register -H "content-type: application/json" -d '{"username":"player1","password":"secret1"}'
   curl -X POST http://localhost:8090/api/login    -H "content-type: application/json" -d '{"username":"player1","password":"secret1"}'
   ```

3. Usuário: de 4 a 16 caracteres (letras, números e `_`). Senha: de 6 a 64 caracteres.
4. Crie uma sala no modo bots (sala com IA) e jogue contra os bots.

O banco começa sem contas. Não há usuário de teste pronto: a primeira conta é a que você criar.

**Resetar o banco.** O `db/init/001_init.sql` só roda quando o volume `pbwebport_pb-postgres-data` (ou o volume do projeto que você usar) está vazio. Para começar do zero, pare o servidor e remova o volume:

```sh
cd db
docker compose -p pbwebport down -v   # apaga o volume: contas, personagens e progresso
cd ..
npm run dev:all                    # recria o banco a partir de db/init/001_init.sql
```

Se você subiu o compose com outro nome de projeto (`-p`), use o mesmo nome no `down -v`. `docker volume ls` lista os volumes.

## Variáveis de ambiente

O servidor lê `server/.env.local` (se existir) e depois as variáveis do ambiente. Variável do ambiente vence o arquivo. Todas são opcionais. A lista completa com comentários está em `server/.env.example`.

| Variável | Padrão | Para que serve |
|---|---|---|
| `PB_DB_HOST` | `127.0.0.1` | Host do Postgres. |
| `PB_DB_PORT` | `5433` | Porta do Postgres. Tem que bater com a porta publicada pelo Docker. |
| `PB_DB_NAME` | `pb` | Nome do banco. |
| `PB_DB_USER` / `PB_DB_PASS` | `postgres` / `postgres` | Usuário e senha. Só para uso local. |
| `PB_DB_URL` | vazio | URL completa (`postgres://usuario:senha@host:porta/banco`). Substitui host, porta, nome, usuário e senha. |
| `PB_DB_SSL` / `PB_DB_SSL_STRICT` | `0` / `0` | `1` liga TLS no Postgres (bancos hospedados). `PB_DB_SSL_STRICT=1` também confere o certificado. |
| `PB_WEB_PORT` | `8090` | Porta do front web (`/tcp`, `/signal`, `/api`, `/health`). |
| `PB_ADVERTISE_HOST` | vazio | Host que a lista de servidores envia ao cliente. Vazio usa o host do banco (`127.0.0.1`). Ponha seu IP da rede se outra máquina vai jogar. |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | vazio | Servidor TURN para partidas P2P atrás de NAT restrito. Sem ele, o projeto usa só STUN público. |

Para trocar a porta do Postgres, mude nos dois lugares: `PB_DB_PORT` no ambiente do Docker (o `dev:all` roda o compose a partir de `db/`, então use um arquivo `db/.env` ou a variável do shell) e `PB_DB_PORT` em `server/.env.local`.

Variáveis de desenvolvimento usadas pelos scripts (você não precisa definir):

- `PB_TOOLS`: caminho do `pb-extract-tools`. Padrão: pasta irmã `../pb-extract-tools`.
- `PB_CLIENTS`: pasta que contém `PBCross`. Padrão: `Clients/` na raiz do repositório.

## Problemas comuns

- **Porta em uso** (8000, 8090, 39290-39293 ou 5433). Rode `npm run status` para ver quem usa. O `dev:all` encerra processos antigos deste repositório. Se a porta for de outro programa, ele para e avisa: feche o programa ou troque a porta.
- **`docker compose failed`**. O Docker não está rodando. Abra o Docker Desktop, espere ele iniciar e rode `npm run dev:all` de novo.
- **Postgres não sobe na 5433** porque outro banco usa a porta. Troque `PB_DB_PORT` (ver acima).
- **`pbx doctor` não encontra o Point Blank Cross**. A pasta tem outro nome ou está fora de `Clients/`. Renomeie para `PBCross` ou defina `PB_CLIENTS`.
- **Jogo abre com telas vazias ou arquivos 404**. Um passo do export falhou ou foi pulado. Veja o resumo do `pbx` e rode de novo com `--from`.
- **`ffmpeg` ausente ou `ffmpeg-static` sem binário**. O pacote baixa o binário no `npm install`. Se o download falhou (rede ou proxy), rode `npm install` de novo.
- **`ERR_UNKNOWN_FILE_EXTENSION` com `.ts`**. Seu Node é mais antigo que 22.18. Atualize.
- **`node-datachannel` falha ao instalar**. Ele é um módulo nativo, usado nos testes P2P. Confira a versão do Node e as ferramentas de build do sistema.

## Testes

```sh
npm run typecheck            # tipos do cliente
npm --prefix server run typecheck  # tipos do servidor
npm --prefix server test           # testes do servidor (alguns precisam do Postgres rodando)
npm run test:net             # testes do protocolo do cliente
npm run test:p2p             # partida P2P com servidor real (sobe servidores de teste)
```

Os smokes em `scripts/dev/` e `src/**/dev/` importam o código do cliente. Alguns precisam dos assets gerados.

## Estrutura do repositório

| Caminho | O que é |
|---|---|
| `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json` | cliente: dependências, scripts (`dev:all`, `pbx`, `status`, `test:net`) e build |
| `src/` | cliente: jogo, armas, lobby, HUD, rede, host P2P |
| `public/` | arquivos estáticos do cliente. `public/assets/` é gerado pelo `pbx` (git-ignored) |
| `scripts/` | `dev-all.mjs` (supervisor), `pbx.mjs` (lança o exportador), smokes |
| `server/` | servidor (projeto próprio): `src/` (Auth e Game TCP, front web WebSocket e `/api`, Postgres), `test/`, `tools/`, `package.json` |
| `server/runtime/` | configuração e dados que o servidor lê (`Config/`, `Data/`). Dados do jogo, ver aviso legal |
| `server/.env.example` | modelo de variáveis de ambiente do servidor |
| `db/` | `docker-compose.yml` (só o Postgres) e `init/001_init.sql` (esquema e dados de jogo, criados na primeira subida do volume) |
| `docs/ARCHITECTURE.md` | visão geral: cliente, servidor, banco e P2P |

## Portas

| Porta | O que é |
|---|---|
| 8000 | jogo (Vite, em desenvolvimento) |
| 8090 | front web: `/tcp` e `/signal` (WebSocket), `/api/register`, `/api/login`, `/health` (HTTP) |
| 39290 | Auth (protocolo TCP do cliente) |
| 39291-39293 | Game, um por canal (TCP) |
| 5433 | Postgres (Docker, só `127.0.0.1`) |

## Licença

Código deste projeto: MIT, veja [LICENSE](LICENSE). Point Blank, seus assets, protocolo e dados de jogo: Zepetto, fora da MIT (ver aviso no topo).
