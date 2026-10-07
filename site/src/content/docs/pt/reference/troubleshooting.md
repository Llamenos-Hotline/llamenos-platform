---
title: Solucao de problemas
description: Solucoes para problemas comuns com implantacao, o aplicativo desktop, aplicativo movel, telefonia e operacoes criptograficas.
---

Este guia cobre problemas comuns e suas solucoes em todos os modos de implantacao e plataformas do Llamenos.

## Problemas de implantacao Docker

### Containers nao iniciam

**Variaveis de ambiente ausentes:**

O Docker Compose valida todos os servicos na inicializacao, mesmo os com perfil. Se voce ver erros sobre variaveis ausentes, certifique-se de que o seu arquivo `.env` inclua todos os valores obrigatorios:

```bash
# Obrigatorio no .env para Docker Compose
PG_PASSWORD=sua_senha_postgres
STORAGE_ACCESS_KEY=sua_chave_de_acesso_rustfs
STORAGE_SECRET_KEY=sua_chave_secreta_rustfs
HMAC_SECRET=seu_segredo_hmac
ARI_PASSWORD=sua_senha_ari       # Obrigatorio mesmo sem usar Asterisk
BRIDGE_SECRET=seu_segredo_bridge # Obrigatorio mesmo sem usar Asterisk
ADMIN_PUBKEY=sua_chave_publica_hex_admin
```

Mesmo que voce nao esteja usando o bridge Asterisk, o Docker Compose valida a definicao do servico e requer que `ARI_PASSWORD` e `BRIDGE_SECRET` estejam definidos.

**Conflitos de porta:**

Se uma porta ja estiver em uso, verifique qual processo a esta usando:

```bash
# Verificar o que esta usando a porta 8787 (Worker)
sudo lsof -i :8787

# Verificar o que esta usando a porta 5432 (PostgreSQL)
sudo lsof -i :5432

# Verificar o que esta usando a porta 9000 (RustFS)
sudo lsof -i :9000
```

Pare o processo conflitante ou altere o mapeamento de porta no `docker-compose.yml`.

### Erros de conexao com o banco de dados

Se o aplicativo nao consegue se conectar ao PostgreSQL:

- Verifique se o `PG_PASSWORD` no `.env` corresponde ao que foi usado quando o container foi criado pela primeira vez
- Verifique se o container PostgreSQL esta saudavel: `docker compose ps`
- Se a senha foi alterada, pode ser necessario remover o volume e recriar: `docker compose down -v && docker compose up -d`

### Relay WebSocket relay nao conecta

O relay WebSocket e um servico essencial, nao opcional. Se o relay nao estiver rodando:

```bash
# Verificar status do relay
docker compose logs WebSocket relay

# Reiniciar o relay
docker compose restart WebSocket relay
```

Se o relay nao iniciar, verifique conflitos na porta 7777 ou permissoes insuficientes no diretorio de dados.

### Erros de armazenamento RustFS / S3

- Verifique se `STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` estao corretos
- Verifique se o container RustFS esta rodando: `docker compose ps rustfs`
- Acesse o console RustFS em `http://localhost:9001` para verificar a criacao do bucket

## Problemas de implantacao Cloudflare

### Erros de Durable Object

**"Durable Object not found" ou erros de binding:**

- Execute `bun run deploy` (nunca `wrangler deploy` diretamente) para garantir que os bindings de DO estejam corretos
- Verifique `wrangler.jsonc` para nomes de classe e bindings de DO corretos
- Apos adicionar um novo DO, voce deve fazer deploy antes que ele fique disponivel

**Limites de armazenamento de DO:**

Cloudflare Durable Objects tem um limite de 128 KB por par chave-valor. Se voce ver erros de armazenamento:

- Certifique-se de que o conteudo das notas nao esta excedendo o limite (notas muito grandes com muitos anexos)
- Verifique se envelopes ECIES nao estao sendo duplicados

### Erros do Worker (respostas 500)

Verifique os logs do Worker:

```bash
bunx wrangler tail
```

Causas comuns:
- Secrets ausentes (use `bunx wrangler secret list` para verificar)
- Formato incorreto de `ADMIN_PUBKEY` (deve ser 64 caracteres hexadecimais, sem prefixo `npub`)
- Limite de taxa no plano gratuito (1.000 requisicoes/minuto no Workers Free)

### Deploy falha com erros "Pages deploy"

Nunca execute `wrangler pages deploy` ou `wrangler deploy` diretamente. Sempre use os scripts do `package.json` raiz:

```bash
bun run deploy          # Deploy de tudo (app + site de marketing)
bun run deploy:site     # Deploy apenas do site de marketing
```

Executar `wrangler pages deploy dist` do diretorio errado implanta o build do app Vite no Pages em vez do site Astro, quebrando o site de marketing com erros 404.

## Problemas do aplicativo desktop

### Atualizacao automatica nao funciona

O aplicativo desktop usa o Tauri updater para verificar novas versoes. Se as atualizacoes nao estao sendo detectadas:

- Verifique sua conexao com a internet
- Verifique se o endpoint de atualizacao esta acessivel: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- No Linux, AppImage requer permissoes de escrita no diretorio onde esta o arquivo para atualizacao automatica
- No macOS, o aplicativo deve estar em `/Applications` (nao rodando diretamente do DMG)

Para atualizar manualmente, baixe a versao mais recente na pagina de [Download](/download).

### Desbloqueio por PIN falha

Se seu PIN e rejeitado no aplicativo desktop:

- Certifique-se de que esta inserindo o PIN correto (nao ha recuperacao de "esqueci meu PIN")
- PINs sao sensiveis a maiusculas/minusculas se contiverem letras
- Se voce esqueceu seu PIN, devera reinserir seu nsec para definir um novo. Suas notas criptografadas permanecem acessiveis porque estao vinculadas a sua identidade, nao ao seu PIN
- O Tauri Stronghold criptografa seu nsec com a chave derivada do PIN (PBKDF2). Um PIN errado produz uma decifracao invalida, nao uma mensagem de erro -- o aplicativo detecta isso verificando a chave publica derivada

### Recuperacao de chave

Se voce perdeu acesso ao seu dispositivo:

1. Use seu nsec (que voce deveria ter armazenado em um gerenciador de senhas) para fazer login em um novo dispositivo
2. Se voce registrou uma passkey WebAuthn, pode usa-la no novo dispositivo
3. Suas notas criptografadas estao armazenadas no servidor -- assim que voce fizer login com a mesma identidade, podera decifra-las
4. Se voce perdeu tanto seu nsec quanto sua passkey, contate seu administrador. Eles nao podem recuperar seu nsec, mas podem criar uma nova identidade para voce. Notas criptografadas para sua identidade antiga nao serao mais legiveis por voce

### Aplicativo nao inicia (janela em branco)

- Verifique se seu sistema atende aos requisitos minimos (veja [Download](/download))
- No Linux, certifique-se de que o WebKitGTK esta instalado: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) ou equivalente
- Tente iniciar pelo terminal para ver a saida de erro: `./llamenos` (AppImage) ou verifique os logs do sistema
- Se estiver usando Wayland, tente com `GDK_BACKEND=x11` como alternativa

### Conflito de instancia unica

O Llamenos impoe o modo de instancia unica. Se o aplicativo diz que ja esta rodando mas voce nao encontra a janela:

- Verifique processos em segundo plano: `ps aux | grep llamenos`
- Encerre processos orfaos: `pkill llamenos`
- No Linux, verifique se ha um arquivo de bloqueio obsoleto e remova-o se o aplicativo travou

## Problemas do aplicativo movel

### Falhas de provisionamento

Veja o [Guia do aplicativo movel](/docs/mobile-guide#solucao-de-problemas-do-aplicativo-movel) para solucao detalhada de problemas de provisionamento.

Causas comuns:
- Codigo QR expirado (tokens expiram apos 5 minutos)
- Sem conexao a internet em qualquer um dos dispositivos
- Aplicativo desktop e aplicativo movel rodando versoes diferentes do protocolo

### Notificacoes push nao chegam

- Verifique se as permissoes de notificacao foram concedidas nas configuracoes do SO
- No Android, verifique se a otimizacao de bateria nao esta encerrando o aplicativo em segundo plano
- No iOS, verifique se a Atualizacao de Apps em Segundo Plano esta ativada para o Llamenos
- Verifique se voce tem um turno ativo e nao esta em pausa

## Problemas de telefonia

### Configuracao de webhook do Twilio

Se as chamadas nao estao sendo roteadas para voluntarios:

1. Verifique se as URLs de webhook estao corretas no console Twilio:
   - Webhook de voz: `https://seu-worker.seu-dorustfs.com/telephony/incoming` (POST)
   - Status callback: `https://seu-worker.seu-dorustfs.com/telephony/status` (POST)
2. Verifique se as credenciais Twilio nas suas configuracoes correspondem ao console:
   - Account SID
   - Auth Token
   - Numero de telefone (deve incluir codigo do pais, ex.: `+1234567890`)
3. Verifique o debugger do Twilio para erros: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Configuracao de numero

- O numero de telefone deve ser um numero de propriedade do Twilio ou um caller ID verificado
- Para desenvolvimento local, use um Cloudflare Tunnel ou ngrok para expor seu Worker local ao Twilio
- Verifique se a configuracao de voz do numero aponta para a URL do seu webhook, nao para o TwiML Bin padrao

### Chamadas conectam mas sem audio

- Certifique-se de que os servidores de midia do provedor de telefonia podem alcancam o telefone do voluntario
- Verifique problemas de NAT/firewall bloqueando trafego RTP
- Se estiver usando WebRTC, verifique se os servidores STUN/TURN estao configurados corretamente
- Algumas VPNs bloqueiam trafego VoIP -- tente sem a VPN

### Mensagens SMS/WhatsApp nao chegam

- Verifique se as URLs de webhook de mensagens estao configuradas corretamente no console do seu provedor
- Para WhatsApp, certifique-se de que o token de verificacao do webhook da Meta corresponde as suas configuracoes
- Verifique se o canal de mensagens esta ativado em **Configuracoes de Admin > Canais**
- Para Signal, verifique se o bridge signal-cli esta rodando e configurado para encaminhar ao seu webhook

## Erros de criptografia

### Erros de incompatibilidade de chave

**"Falha ao decifrar" ou "Chave invalida" ao abrir notas:**

- Isso geralmente significa que a nota foi criptografada para uma identidade diferente da que voce esta logado
- Verifique se esta usando o nsec correto (verifique se seu npub nas Configuracoes corresponde ao que o administrador ve)
- Se voce recriou recentemente sua identidade, notas antigas criptografadas para sua chave publica anterior nao serao decifraveis com a nova chave

**"Assinatura invalida" no login:**

- O nsec pode estar corrompido -- tente reinseri-lo do seu gerenciador de senhas
- Certifique-se de que o nsec completo foi colado (comeca com `nsec1`, 63 caracteres no total)
- Verifique se ha espacos em branco ou caracteres de nova linha extras

### Falhas na verificacao de assinatura

Se os eventos do hub falham na verificacao de assinatura:

- Verifique se o relogio do sistema esta sincronizado (NTP). Grande desvio de relogio pode causar problemas com timestamps de eventos
- Verifique se o relay WebSocket nao esta retransmitindo eventos de pubkeys desconhecidas
- Reinicie o aplicativo para buscar novamente a lista atual de membros do hub

### Erros de envelope ECIES

**"Falha ao desembrulhar chave" na decifracao de notas:**

- O envelope ECIES pode ter sido criado com uma chave publica incorreta
- Isso pode acontecer se o administrador adicionou um voluntario com erro de digitacao na pubkey
- O administrador deve verificar a chave publica do voluntario e reconvidar se necessario

**"Comprimento de texto cifrado invalido":**

- Isso indica corrupcao de dados, possivelmente de uma resposta de rede truncada
- Tente novamente a operacao. Se persistir, os dados criptografados podem estar permanentemente corrompidos
- Verifique problemas de proxy ou CDN que possam truncar corpos de resposta

### Erros de chave do hub

**"Falha ao decifrar evento do hub":**

- A chave do hub pode ter sido rotacionada desde sua ultima conexao
- Feche e reabra o aplicativo para buscar a chave do hub mais recente
- Se voce foi recentemente removido e readicionado ao hub, a chave pode ter sido rotacionada durante sua ausencia

## Obtendo ajuda

Se o seu problema nao esta coberto aqui:

- Verifique as [Issues do GitHub](https://github.com/rhonda-rodododo/llamenos-platform/issues) para bugs conhecidos e solucoes alternativas
- Pesquise issues existentes antes de criar uma nova
- Ao reportar um bug, inclua: seu modo de implantacao (Cloudflare/Docker/Kubernetes), plataforma (Desktop/Mobile) e quaisquer mensagens de erro do console do navegador ou terminal
