# AgentProxy

Gateway local OpenAI-compatible otimizado para agentes de IA. O primeiro alvo e o Hermes Agent e o primeiro provedor implementado e o Qwen.

> Estado: alpha inicial. A arquitetura multi-provider esta pronta, mas somente o adaptador Qwen foi implementado ate agora.

## O que ja funciona

- `proxy setup`, `proxy on`, `proxy off`, `proxy status` e `proxy doctor`.
- Login persistente do Qwen pelo navegador.
- Endpoint `/v1/chat/completions` com streaming e formato OpenAI.
- Endpoint `/v1/models` com descoberta dos modelos do Qwen.
- Rotacao automatica quando a porta preferida estiver ocupada.
- Perfil Hermes stateless: o proxy nao reaproveita o `parent_id` do Qwen.
- Isolamento de `chat_id` por requisicao e limite global de concorrencia para evitar disputa entre subagentes.
- Circuit breaker para rate limit do Qwen, evitando retries longos quando o upstream ja bloqueou a conta/sessao.
- Remocao de reasoning antigo, janela de historico e limite para resultados de ferramentas.
- Parser incremental de `<tool_call>` e retorno de `tool_calls` estruturado.
- Timeout de conexao, duracao total, inatividade e cancelamento do cliente.
- Chave local aleatoria e servidor restrito a `127.0.0.1` por padrao.

## Instalacao rapida no WSL

Este e o caminho recomendado para usar com o Hermes Agent. Para usuarios novos, prefira rodar AgentProxy e Hermes no mesmo ambiente WSL.

Requisitos:

- WSL Ubuntu ou outra distribuicao Linux compativel.
- Node.js 20 ou superior instalado dentro do WSL.
- Hermes Agent instalado e funcionando.
- Conta Qwen ativa.

Instalacao do zero:

```bash
git clone https://github.com/CodigoCrafter/agentproxy.git
cd agentproxy
bash scripts/install-wsl.sh --start
```

Esse comando instala dependencias, baixa o Chromium do Playwright, compila o projeto, registra o comando `proxy` no WSL e roda `proxy hermes`.

No primeiro uso, faca o login manual no Qwen:

```bash
proxy login qwen
proxy hermes
```

Para usar o pool com ate 5 sessoes Qwen, faca login em cada slot desejado. Cada slot usa um perfil de navegador separado:

```bash
proxy login qwen main
proxy login qwen qwen2
proxy login qwen qwen3
proxy login qwen qwen4
proxy login qwen qwen5
proxy qwen accounts
```

Depois disso, o uso diario fica:

```bash
proxy hermes
proxy status
proxy off
```

Se quiser instalar sem iniciar:

```bash
bash scripts/install-wsl.sh
```

Tambem existe o atalho npm:

```bash
npm run install:wsl
```

### Windows + WSL

O uso com AgentProxy no Windows e Hermes dentro do WSL e suportado, mas e mais sensivel a IP, porta, PATH e ponte entre ambientes. Para instalacao inicial e para usuarios iniciantes, use tudo dentro do WSL.

Quando o Hermes estiver no WSL e o AgentProxy no Windows, o daemon abre uma segunda escuta somente na interface privada do WSL. O endpoint Windows continua em `127.0.0.1`; nenhuma escuta generica em `0.0.0.0` e criada.

## Instalacao rapida no Windows / PowerShell

Use este caminho quando o Hermes tambem estiver rodando no PowerShell/Windows. Evite misturar um AgentProxy no Windows com um Hermes no WSL sem necessidade.

Requisitos:

- Node.js 20 ou superior instalado no Windows.
- PowerShell.
- Hermes Agent instalado e disponivel no `PATH` do PowerShell.
- Conta Qwen ativa.

Instalacao do zero:

```powershell
git clone https://github.com/CodigoCrafter/agentproxy.git
cd agentproxy
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -Start
```

Esse comando instala dependencias, baixa o Chromium do Playwright, compila o projeto, registra os comandos `proxy` e `agentproxy` no npm global do Windows e roda `proxy hermes`.

No uso diario:

```powershell
proxy hermes
proxy status
proxy off
```

Para logar o pool com ate 5 sessoes Qwen no Windows:

```powershell
proxy login qwen main
proxy login qwen qwen2
proxy login qwen qwen3
proxy login qwen qwen4
proxy login qwen qwen5
proxy qwen accounts
```

No Windows, configuracao, logs, cookies e perfis de navegador ficam em:

```text
C:\Users\<seu-usuario>\.agentproxy
```

No WSL, ficam em:

```text
/home/<seu-usuario>/.agentproxy
```

Esses dois ambientes nao compartilham login automaticamente. Para usar em qualquer lugar com previsibilidade, escolha um ambiente principal por vez: tudo no PowerShell ou tudo no WSL.

Se quiser forcar outro diretorio de dados, defina `AGENTPROXY_HOME` antes de iniciar:

```powershell
$env:AGENTPROXY_HOME = "C:\Users\andre\.agentproxy-windows"
proxy hermes
```

```bash
export AGENTPROXY_HOME="$HOME/.agentproxy-wsl"
proxy hermes
```

## Instalacao manual

```bash
npm ci
npx playwright install chromium
npm run build
npm link
proxy setup
proxy login qwen
proxy on
proxy status
proxy connect hermes
```

O comando `npm link` instala os dois nomes locais: `agentproxy` e o atalho `proxy`.

## Uso diario

```bash
proxy hermes
proxy on
proxy status
proxy models
proxy use qwen/qwen3.7-max-no-thinking
proxy connect hermes
proxy off
```

Se a porta `3091` estiver ocupada, o servidor tenta `3092`, `3093` e assim por diante. A porta escolhida fica em `~/.agentproxy/runtime.json`, e todos os comandos consultam esse arquivo automaticamente.

Depois de `proxy connect hermes`, o AgentProxy configura o Hermes como provedor customizado. A integracao fica registrada e atualiza a `model.base_url` automaticamente em cada inicializacao, inclusive quando houver rotacao de porta. No Windows, o comando procura o Hermes local e depois tenta a distribuicao WSL padrao.

## Configuracao do cliente

Depois de `proxy on`, use o endpoint mostrado por `proxy status`:

```text
Base URL: http://127.0.0.1:<porta>/v1
API key: valor de apiKey em ~/.agentproxy/config.json
Model: qwen/qwen3.7-max-no-thinking
```

O comando `proxy config` esconde a chave de proposito. Ela deve ser lida diretamente do arquivo apenas durante a configuracao do agente e nunca deve ser publicada.

Para separar sessoes paralelas, clientes podem enviar um destes identificadores:

```text
X-AgentProxy-Session
X-Session-Id
session_id no JSON
metadata.session_id no JSON
user no JSON
```

## Configuracao

O arquivo `~/.agentproxy/config.json` controla:

- Host, porta preferida e quantidade de portas alternativas.
- Modelo padrao.
- Quantidade de mensagens e caracteres de contexto.
- Tamanho maximo de resultados de ferramentas.
- Exposicao ou ocultacao de reasoning.
- Navegador, timeouts, concorrencia, cooldown de rate limit e ativacao do Qwen.

Credenciais, cookies e perfis de navegador ficam fora do repositorio em `~/.agentproxy/`.

## Solucao de problemas

Rode sempre o diagnostico antes de investigar manualmente:

```bash
proxy doctor
proxy status
```

Se o Qwen responder `Your account is currently pending activation`, a sessao do navegador existe, mas a conta ainda nao foi ativada. Abra o e-mail enviado pelo Qwen, confirme a conta e depois execute:

```bash
proxy off
proxy login qwen
proxy hermes
```

Se `proxy` apontar para um `proxy.cmd` do Windows ou nao for encontrado, abra um novo terminal WSL e rode novamente `bash scripts/install-wsl.sh --skip-browser`. O instalador remove aliases antigos e registra o comando nativo do WSL.

Se o Hermes mostrar `Model not found`, confira os modelos disponiveis e selecione um deles:

```bash
proxy models
proxy use qwen/qwen3.7-max-no-thinking
proxy hermes
```

Se aparecer `browserContext.newPage: Target page, context or browser has been closed`, o navegador usado pelo Playwright fechou ou ficou invalido. Reinicie o daemon:

```bash
proxy off
proxy hermes
```

Se aparecer `Provider enabled but not implemented`, algum provider experimental esta habilitado na configuracao, mas ainda nao tem adaptador estavel no codigo publicado. No estado atual do projeto, mantenha somente o Qwen habilitado em `~/.agentproxy/config.json`.

Se aparecer uma mensagem de throttle/rate limit do Qwen web, o bloqueio veio do endpoint interno usado pela sessao autenticada. Isso pode acontecer por excesso de paralelismo, modelo preview saturado, contexto grande ou heuristica anti-abuso da propria interface web; nao significa necessariamente que o chat manual do Qwen deixou de ser gratuito. O AgentProxy nao consegue remover esse bloqueio no upstream, mas evita continuar martelando a sessao: a conta afetada sai da rotacao durante o cooldown configurado em `providers.qwen.rateLimitCooldownMs`. Se houver outras contas logadas no pool, elas continuam sendo usadas automaticamente.

Por padrao, cada conta Qwen usa no maximo 2 requisicoes upstream simultaneas (`providers.qwen.maxConcurrentRequests`), a fila de espera e curta (`providers.qwen.queueTimeoutMs`, 10s) e o cooldown de throttle e de 6 horas. Isso nao volta a compartilhar o mesmo chat entre subagentes; cada requisicao continua usando um `chat_id` isolado. O limite serve apenas para proteger a sessao web contra bloqueio por excesso de uso e evitar que um chat novo fique mudo enquanto outro teste pesado esta rodando.

Se houver conflito entre dependencias do Windows e do WSL, reinstale dentro do WSL. Dependencias nativas, como `esbuild` em outros projetos ou binarios do Playwright, devem ser instaladas no mesmo ambiente onde o proxy sera executado:

```bash
rm -rf node_modules
npm ci
npx playwright install chromium
npm run build
```

## Arquitetura

```text
Hermes / cliente OpenAI
          |
    API normalizada
          |
 contexto + ferramentas + sessoes
          |
    registro de provedores
          |
      Qwen adapter
```

Os proximos adaptadores planejados sao Kimi, ChatGPT e Gemini. O objetivo e adicionar um provider por vez, mantendo isolamento entre adaptadores e sem quebrar o Qwen ja estavel. Adaptadores baseados em sessao de site serao explicitamente marcados como experimentais.

## Desenvolvimento

```bash
npm run build
npm test
npm run check
```

## Licenca e atribuicao

Licenca ISC. O adaptador Qwen contem partes adaptadas do projeto qwenproxy, de Pedro Farias. Consulte `LICENSE` e `NOTICE`.
