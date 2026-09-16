# Handoff de hospedagem — Beta Cursos no Railway

Este documento descreve a infraestrutura proposta para homologar e publicar o Beta Cursos. Ele foi preparado para o Gilson e para a equipe responsável pela tecnologia da igreja, sem pressupor credenciais ou decisões ainda não fornecidas.

## 1. Arquitetura proposta

A produção definitiva é composta por três serviços no mesmo projeto Railway:

| Serviço | Responsabilidade | Exposição |
| --- | --- | --- |
| `Web` | Aplicação Node.js, frontend, API, autenticação e painel administrativo | Público, via HTTPS |
| `Postgres` | Usuários, sessões, cursos, matrículas, progresso, questões e metadados | Somente pela rede interna do projeto |
| `Media` | Bucket S3 compatível para apostilas, capas e vídeos enviados | Privado; acessado pela aplicação |

A aplicação Node é um monólito modular: entrega o frontend e a API no mesmo domínio. Essa topologia *same-origin* simplifica cookies de sessão, CORS, manutenção, logs e implantação. O Postgres não deve receber domínio público, e o bucket não precisa ser publicado diretamente.

O S3 usado anteriormente para uma página estática pode continuar servindo o site oficial da igreja, mas não substitui esta infraestrutura: o Beta Cursos precisa executar o backend, persistir sessões e consultar o banco.

### Primeira implantação sem assinatura

O ambiente pessoal pode usar o plano Free em uma topologia reduzida, sem
ativar recursos demonstrativos e sem alterar o destino arquitetural da produção:

| Recurso | Implementação inicial no plano Free |
| --- | --- |
| Aplicação | Um serviço `Web` Node.js, com uma réplica e modo serverless |
| Banco | SQLite dentro do volume persistente |
| Mídia | Filesystem dentro do mesmo volume |
| Vídeos maiores | Link do YouTube; upload local limitado a 25 MB |

Criar um volume de 0,5 GB no serviço `Web` e montá-lo em `/data`. O Railway
fornece `RAILWAY_VOLUME_MOUNT_PATH` automaticamente. A aplicação só aceita esse
arranjo quando `APP_ENV=production` e `RAILWAY_FREE_VOLUME_MODE=true`; se o volume
estiver ausente, ela falha antes de iniciar para não perder dados no disco
efêmero.

No painel do serviço, abrir **Settings > Deploy** e ativar **Serverless**.
Manter somente uma réplica. O Serverless não é configurado pelo `railway.json`:
é uma opção do serviço e precisa ser conferida manualmente. Depois de cerca de
dez minutos sem tráfego de rede, o serviço pode dormir; o primeiro acesso
seguinte terá uma inicialização mais lenta e deve ser repetido se o Railway
responder temporariamente com 502.

Variáveis do ambiente gratuito:

```dotenv
APP_ENV=production
NODE_ENV=production
HOST=0.0.0.0
APP_ORIGIN=https://DOMINIO-DE-STAGING
ALLOWED_ORIGINS=https://DOMINIO-DE-STAGING

RAILWAY_FREE_VOLUME_MODE=true
STORAGE_DRIVER=filesystem
STORAGE_MAX_MB=400

SESSION_SECRET=GERAR_UM_SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
SESSION_COOKIE_NAME=__Host-beta_session
SESSION_TTL_DAYS=7
COOKIE_SECURE=true

BOOTSTRAP_OWNER_EMAIL=EMAIL_DO_RESPONSAVEL
REGISTRATION_ENABLED=true
EMAIL_DRIVER=resend
EMAIL_VERIFICATION_REQUIRED=true
PASSWORD_RESET_ENABLED=true
EMAIL_FROM=Beta Cursos <cursos@DOMINIO-VERIFICADO>
EMAIL_TOKEN_SECRET=GERAR_OUTRO_SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
RESEND_API_KEY=re_SUBSTITUIR
ENABLE_DEMO_LOGIN=false
DEMO_ROLE=student
CHECKOUT_MODE=disabled
LOG_LEVEL=info
HEALTHCHECK_TIMEOUT_MS=3000
PDF_MAX_MB=15
IMAGE_MAX_MB=5
VIDEO_MAX_MB=25
```

Não definir `DATABASE_URL`, `LOCAL_STORAGE_PATH` nem
`RAILWAY_VOLUME_MOUNT_PATH` manualmente nesse modo. O último valor vem do
volume, e os dois primeiros são derivados pela aplicação dentro dele.

O crédito gratuito de US$ 1 pode interromper o serviço quando for consumido.
Por isso este ambiente é destinado a testes esporádicos e deve permanecer sem
monitor externo fazendo requisições contínuas. A migração final para a conta da
igreja troca SQLite/filesystem por PostgreSQL/Bucket, mantendo as URLs internas
de mídia e as regras da aplicação.

## 2. Staging espelhável em produção

O primeiro ambiente deve ser `staging`, usado para testes completos com dados não sensíveis. Depois da homologação, a mesma configuração pode ser duplicada para `production`, trocando apenas domínio, dados e segredos.

Estrutura recomendada:

- Um projeto Railway chamado `Beta Cursos`.
- Dois ambientes persistentes e isolados: `staging` e `production`.
- Em cada ambiente: uma instância própria de `Web`, `Postgres` e `Media`.
- Branch de homologação ligada a `staging` e branch principal ligada a `production`, conforme o fluxo de Git adotado pela equipe.
- Segredos diferentes por ambiente. Ao duplicar um ambiente, revisar manualmente variáveis seladas, credenciais do bucket e referências entre serviços.

Não é recomendado compartilhar o mesmo banco ou bucket entre staging e produção.

## 3. Criação da infraestrutura definitiva

Os passos desta seção são para a produção com PostgreSQL e Bucket. A
homologação Free usa apenas o serviço `Web` e o volume descritos na seção 1.

1. Criar o projeto `Beta Cursos`.
2. No ambiente `staging`, adicionar um serviço PostgreSQL e nomeá-lo exatamente `Postgres`.
3. Adicionar um Storage Bucket e nomeá-lo exatamente `Media`.
4. Criar o serviço `Web` a partir do repositório GitHub do projeto.
5. Manter a raiz do repositório como diretório de build.
6. Autorizar o Railway a construir pelo `Dockerfile` versionado.
7. Configurar as variáveis do serviço `Web` conforme a seção seguinte.
8. Gerar primeiro um domínio `*.up.railway.app` para a homologação.
9. Confirmar que o deploy conclui com `GET /health/ready` retornando HTTP 200.

O arquivo `railway.json` já define:

- builder por `Dockerfile`;
- healthcheck em `/health/ready`;
- timeout de deploy de 120 segundos;
- reinício em caso de falha.

O `Dockerfile` define o `ENTRYPOINT` e o `CMD`, usa Node.js 22, instala versões
diretas fixadas no `package.json` e executa o build. Não configurar outro Start
Command no painel ou no `railway.json`, pois ele substituiria o entrypoint do
container. No início, o entrypoint ajusta somente a permissão do volume anexado
e reduz imediatamente o processo para o usuário `node`, sem manter a aplicação
como `root`. O build hospedado gera um `data.js` público sanitizado: gabaritos,
alunos demonstrativos, apostila de exemplo e URLs de materiais restritos não
entram nesse artefato.

## 4. Variáveis do serviço Web

As referências abaixo pressupõem os nomes de serviço `Postgres` e `Media`. Se esses serviços receberem outros nomes no Railway, o namespace da referência também deverá mudar.

### Valores recomendados para staging

```dotenv
APP_ENV=staging
NODE_ENV=production
HOST=0.0.0.0
APP_ORIGIN=https://DOMINIO-DE-STAGING
ALLOWED_ORIGINS=https://DOMINIO-DE-STAGING

DATABASE_URL=${{Postgres.DATABASE_URL}}

SESSION_SECRET=GERAR_UM_SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
SESSION_COOKIE_NAME=__Host-beta_session
SESSION_TTL_DAYS=7
COOKIE_SECURE=true

STORAGE_DRIVER=s3
BUCKET=${{Media.BUCKET}}
ENDPOINT=${{Media.ENDPOINT}}
REGION=${{Media.REGION}}
ACCESS_KEY_ID=${{Media.ACCESS_KEY_ID}}
SECRET_ACCESS_KEY=${{Media.SECRET_ACCESS_KEY}}
STORAGE_PREFIX=

BOOTSTRAP_OWNER_EMAIL=ehenriquesilva021@gmail.com
REGISTRATION_ENABLED=true
EMAIL_DRIVER=resend
EMAIL_VERIFICATION_REQUIRED=true
PASSWORD_RESET_ENABLED=true
EMAIL_FROM=Beta Cursos <cursos@DOMINIO-VERIFICADO>
EMAIL_TOKEN_SECRET=GERAR_OUTRO_SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
RESEND_API_KEY=re_SUBSTITUIR
ENABLE_DEMO_LOGIN=true
DEMO_ROLE=student
CHECKOUT_MODE=test
LOG_LEVEL=info
HEALTHCHECK_TIMEOUT_MS=3000
PDF_MAX_MB=30
IMAGE_MAX_MB=10
VIDEO_MAX_MB=100
```

Observações:

- `PORT` é fornecida pelo Railway em tempo de execução. Não é necessário fixá-la no painel. Para execução fora do Railway, o padrão é `3000`.
- `APP_ORIGIN` e `ALLOWED_ORIGINS` devem conter apenas a origem HTTPS, sem barra final, caminho, consulta ou curinga.
- `SESSION_SECRET` deve ser gerado separadamente para staging e produção e nunca deve entrar no Git, em PDF ou em conversa comum.
- `BOOTSTRAP_OWNER_EMAIL` deve ser definido antes do primeiro cadastro do proprietário.
- `EMAIL_TOKEN_SECRET` deve ser diferente de `SESSION_SECRET`. O driver `preview` é exclusivo para desenvolvimento local e é recusado em ambientes hospedados.
- Com cadastro aberto no Railway, a aplicação exige confirmação de e-mail e um remetente real. O domínio usado em `EMAIL_FROM` precisa estar validado no provedor.
- `ENABLE_DEMO_LOGIN=true` e `CHECKOUT_MODE=test` são próprios de staging. A conta demo hospedada deve manter `DEMO_ROLE=student`; em produção, usar `false` e `disabled` até as integrações oficiais estarem prontas.
- Se houver mais de uma origem permitida no futuro, `ALLOWED_ORIGINS` aceita valores separados por vírgula.
- `STORAGE_PREFIX` pode permanecer vazio porque cada ambiente terá um bucket separado.

### Variáveis presentes no `.env.example`

Além das variáveis acima, o projeto reconhece as seguintes opções para desenvolvimento local:

```dotenv
PORT=3000
DATABASE_URL=sqlite:.data/beta-cursos.sqlite
SESSION_COOKIE_NAME=beta_session
COOKIE_SECURE=false
STORAGE_DRIVER=filesystem
LOCAL_STORAGE_PATH=.data/media
```

Para provedores S3 compatíveis que não sejam o Bucket Railway, também são aceitos os aliases:

```dotenv
S3_BUCKET=
S3_ENDPOINT=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_SESSION_TOKEN=
S3_FORCE_PATH_STYLE=false
S3_PREFIX=

AWS_S3_BUCKET=
AWS_S3_ENDPOINT=
AWS_ENDPOINT_URL_S3=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
AWS_S3_FORCE_PATH_STYLE=false
```

Usar um único padrão por ambiente. No Railway, o padrão `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID` e `SECRET_ACCESS_KEY` com referências `${{Media.*}}` é o mais direto.

## 5. Deploy pelo GitHub e Dockerfile

O serviço `Web` deve ficar conectado ao repositório GitHub autorizado pela igreja. Cada push na branch vinculada cria uma imagem nova usando o `Dockerfile`.

Fluxo recomendado:

1. abrir PR e executar os testes;
2. fazer merge na branch de staging;
3. aguardar build, migrations e healthcheck;
4. executar o checklist de homologação;
5. promover o mesmo commit para a branch de produção;
6. registrar o commit ou a tag que foi publicado.

O repositório precisa incluir `package.json`, `pnpm-lock.yaml`, `Dockerfile`,
`railway.json`, a pasta `railway/` e os arquivos do frontend. As dependências
diretas estão fixadas em versões exatas no `package.json`; o lockfile também deve
ser versionado antes da promoção para a produção, para congelar toda a árvore
transitiva. O primeiro deploy de homologação pode gerar esse lock no ambiente
com acesso ao registry; o deploy seguinte deve usar `--frozen-lockfile`.

## 6. Banco e migrations

As migrations SQL são versionadas separadamente para PostgreSQL e SQLite. Elas são idempotentes e registradas na tabela `railway_migrations`; uma migration já aplicada não é repetida, e uma migration aplicada não deve ser editada posteriormente.

No fluxo hospedado, o servidor aplica migrations pendentes durante a inicialização antes de declarar o ambiente pronto. O caminho manual equivalente, útil em diagnóstico ou janela controlada, é:

```bash
pnpm migrate
```

Para executar manualmente pelo contexto do Railway, usar um shell ou job com as mesmas variáveis do serviço `Web`. Antes de uma migration de produção:

1. criar ou confirmar um backup recente do Postgres;
2. revisar o SQL e compatibilidade com a versão anterior da aplicação;
3. executar primeiro em staging;
4. publicar mudanças de schema de forma retrocompatível sempre que possível;
5. não editar migrations antigas; criar uma nova migration corretiva.

## 7. Domínio, HTTPS e DNS

Durante a homologação, usar o domínio fornecido pelo Railway. Quando o domínio oficial for decidido:

1. adicionar o domínio customizado ao serviço `Web`;
2. copiar exatamente os registros DNS exibidos pelo Railway;
3. criar no provedor DNS o `CNAME` de roteamento e o `TXT` de verificação solicitados;
4. aguardar a validação e emissão do certificado;
5. atualizar `APP_ORIGIN` e `ALLOWED_ORIGINS` para o endereço HTTPS final;
6. efetuar novo deploy e repetir os testes de login, upload e painel;
7. somente depois direcionar usuários para o novo endereço.

O subdomínio `cursos.dominio-da-igreja` tende a ser mais simples que publicar em uma subpasta do site oficial. Não manter dois domínios ativos gravando cookies de sessão sem uma regra explícita de redirecionamento.

## 8. Healthchecks e observabilidade

Endpoints previstos:

- `/health/live`: confirma que o processo Node está ativo.
- `/health/ready`: confirma que a aplicação está pronta para atender, incluindo banco, armazenamento e configuração do e-mail.

A seção `email` do readiness mostra apenas driver, obrigatoriedade, estado e se a
configuração mínima está presente. `providerProbe=not_performed` é intencional:
o healthcheck não envia mensagem e não faz chamada à Resend, evitando custo,
spam e falso tráfego operacional. A disponibilidade externa do provedor é
observada durante envios reais. Se o e-mail for obrigatório, uma falha real
marca a dependência como `degraded` e `ok=false`; um envio posterior bem-sucedido
zera as falhas consecutivas e restaura `ok=true`, sem probe artificial.

O Railway usa `/health/ready` para aceitar ou rejeitar um novo deploy. Esse healthcheck de implantação não substitui monitoramento contínuo. Para operação:

- acompanhar logs estruturados do serviço `Web`;
- manter `LOG_LEVEL=info` em staging e produção;
- somente na produção paga, criar um monitor externo para `/health/live`;
- alertar para indisponibilidade, aumento de respostas 5xx, falhas de autenticação anormais, erros de Postgres e falhas de acesso ao bucket;
- acompanhar CPU, memória, volume e conexões do Postgres;
- acompanhar eventos `email_delivery_failed` e o estado `degraded` do e-mail; os
  eventos contêm somente driver, finalidade, código técnico e, quando existir,
  status HTTP do provedor;
- não registrar senha, cookie, token, segredo, conteúdo integral de formulários ou dados pessoais desnecessários.

Não usar monitor externo na homologação Free: requisições contínuas impedem o
Serverless de dormir e consomem o crédito mensal.

## 9. Segurança, sessões e proprietário inicial

- A autenticação hospedada usa sessão no servidor e cookie `HttpOnly`, `Secure` e `SameSite`; a senha ou o token de sessão não deve ficar em `localStorage`.
- Toda entrada de cabeçalhos de identidade deve ser ignorada; a identidade válida vem exclusivamente da sessão resolvida pelo servidor.
- `SESSION_SECRET` deve ter pelo menos 32 caracteres, ser exclusivo por ambiente e ser rotacionado de forma planejada. A rotação encerra sessões ativas.
- O bucket deve permanecer privado. Downloads e uploads passam pelas autorizações da aplicação.
- Postgres deve ser acessado pela referência interna do Railway, não por credenciais copiadas para o navegador.
- Contas administrativas devem ser individuais; não compartilhar uma senha de “admin da igreja”.
- Aplicar menor privilégio entre `owner`, `admin`, `facilitador` e `aluno`.

### Bootstrap do owner

1. Definir `BOOTSTRAP_OWNER_EMAIL` com o e-mail individual aprovado pela igreja.
2. Publicar o ambiente.
3. Solicitar o cadastro usando exatamente esse e-mail.
4. Abrir o link recebido na caixa postal e somente então definir nome e senha.
5. Confirmar no painel que a função recebida é `owner`.
6. Testar uma segunda conta comum e confirmar que ela não recebe acesso administrativo.

O valor não deve ser um e-mail genérico acessível por várias pessoas. Alterar ou remover a variável não deve ser tratado como forma de rebaixar uma conta existente; mudanças de função devem passar pelo fluxo administrativo e por auditoria.

## 10. Backups e restauração

### Volume da homologação Free

O SQLite e as mídias compartilham `/data`; portanto, o backup precisa preservar
o volume inteiro, não apenas o arquivo do banco. Antes de importar conteúdo em
massa ou testar uma mudança relevante:

1. interromper temporariamente alterações no painel;
2. gerar o export pelo painel para portabilidade;
3. criar um backup/snapshot do volume quando o recurso estiver disponível no
   plano ou copiar `/data/db` e `/data/media` juntos para armazenamento externo;
4. testar a restauração em um ambiente separado.

Um serviço com volume não oferece troca de versão totalmente sem interrupção.
Programar redeploys fora do período de teste e aguardar `/health/ready` antes de
continuar.

### PostgreSQL

- Habilitar backups nativos no serviço `Postgres`.
- Em produção, combinar uma agenda frequente com uma retenção aprovada pela igreja.
- Criar backup manual antes de migration relevante, importação em massa ou alteração estrutural.
- Registrar responsável e periodicidade de um teste de restauração.
- Se a criticidade justificar, avaliar também recuperação para um ponto no tempo oferecida pelo Railway.

### Mídia

O banco guarda referências aos objetos; portanto, restaurar apenas o Postgres não recupera arquivos ausentes. Para o bucket `Media`:

- manter inventário periódico de objetos;
- definir cópia periódica para outro bucket ou conta de armazenamento;
- preservar as chaves dos objetos durante a restauração;
- testar em staging a associação entre curso, metadado e arquivo restaurado.

O backup/exportação disponível no painel é útil para portabilidade dos dados da aplicação, mas não substitui o backup completo do Postgres nem a cópia dos objetos de mídia.

### Procedimento de restore

1. suspender alterações administrativas se houver incidente de dados;
2. identificar o horário e o escopo da perda;
3. restaurar primeiro em uma instância separada;
4. validar contagens, usuários, cursos, matrículas, progresso e referências de mídia;
5. restaurar objetos do bucket mantendo as mesmas chaves, se necessário;
6. apontar a aplicação para a instância validada em uma mudança controlada;
7. executar `/health/ready` e o checklist crítico antes de reabrir o acesso;
8. documentar o incidente e as decisões tomadas.

## 11. Teste local sem serviços externos

O desenvolvimento local usa SQLite e filesystem, mas executa a mesma aplicação Node e as mesmas regras de sessão.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm migrate
pnpm dev
```

Abrir `http://127.0.0.1:3000`. Os dados ficam em `.data/beta-cursos.sqlite` e os uploads em `.data/media`. Esses caminhos são apenas para desenvolvimento e não devem ser versionados nem usados no Railway.

Antes de enviar uma alteração:

```powershell
pnpm test
```

Também é recomendável validar pelo menos uma vez contra PostgreSQL e um S3 compatível antes de promover para produção, pois SQLite e filesystem não reproduzem todas as características operacionais dos serviços hospedados.

## 12. Checklist de homologação

### Infraestrutura

- [ ] Na homologação Free, existem apenas `Web` e um volume montado em `/data`.
- [ ] Na homologação Free, Serverless está ativado, há uma réplica e não existe monitor externo.
- [ ] Na produção, `Web`, `Postgres` e `Media` existem no ambiente correto.
- [ ] Na produção, referências `${{Postgres.DATABASE_URL}}` e `${{Media.*}}` resolvem no serviço `Web`.
- [ ] `/health/live` e `/health/ready` retornam HTTP 200.
- [ ] Reiniciar o serviço não perde conta, sessão persistida, curso, progresso ou mídia.
- [ ] Produção e qualquer staging definitivo usam bancos, buckets e segredos distintos.

### Conta e segurança

- [ ] Cadastro, login, logout e restauração de sessão funcionam.
- [ ] O owner aprovado recebe a função correta.
- [ ] Aluno comum não acessa rotas nem telas administrativas.
- [ ] Sessão inválida, expirada ou manipulada é rejeitada.
- [ ] Cookies são `HttpOnly`, `Secure` e não são expostos no frontend.
- [ ] Limites e validações de upload são aplicados.
- [ ] Catálogo público não contém gabaritos.
- [ ] PDF e vídeo enviados rejeitam acesso sem matrícula.

### Cursos e administração

- [ ] Criar, editar, publicar, despublicar e excluir curso.
- [ ] Criar módulos, aulas, questões e alternativas.
- [ ] Definir e validar a resposta correta.
- [ ] Enviar capa e apostila PDF.
- [ ] Enviar vídeo dentro do limite configurado.
- [ ] Adicionar e reproduzir vídeo por link do YouTube.
- [ ] Ver cursos e alunos no painel sem dados de demonstração indevidos.
- [ ] Exportar dados e validar o arquivo gerado.

### Jornada do aluno

- [ ] Visualizar catálogo e detalhe do curso.
- [ ] Matricular uma conta no modo de homologação autorizado.
- [ ] Iniciar aula, salvar progresso e continuar após novo login.
- [ ] Confirmar progresso em outro navegador ou dispositivo.
- [ ] Responder questões e concluir uma aula/curso conforme a regra aprovada.
- [ ] Confirmar no log/banco que a nota foi calculada pelo servidor e um replay não duplicou a tentativa.
- [ ] Conferir preço de R$ 19,90 onde o curso assim estiver cadastrado.
- [ ] Validar responsividade em celular e desktop.

### Operação

- [ ] Logs não expõem segredos ou dados pessoais desnecessários.
- [ ] Na homologação Free, SQLite e mídias do volume foram copiados juntos.
- [ ] Na produção, backup do Postgres foi criado.
- [ ] Na produção, cópia/inventário de mídia foi definido.
- [ ] Um restore de teste foi concluído e documentado.
- [ ] Procedimento de rollback foi ensaiado em staging.

## 13. Dependências externas ainda necessárias

O backend, o banco, as sessões e o armazenamento podem ser homologados no Railway sem chamar essa camada de “simulada”. Entretanto, os itens abaixo dependem de decisões ou credenciais externas e não devem ser apresentados como integração real concluída:

| Item | Necessário para concluir |
| --- | --- |
| Mercado Pago | Conta da igreja, credenciais separadas de teste/produção, definição do recebedor, meios de pagamento, URLs de retorno, webhook assinado, política de aprovação/estorno e testes de reconciliação |
| CRM ou cadastro de membros | Provedor, documentação da API, credenciais, campos de identificação e regra para membro inexistente ou divergente |
| E-mail transacional | O código, os templates, a confirmação e a recuperação estão prontos. Faltam conta/credencial Resend, domínio remetente e configuração SPF/DKIM/DMARC no DNS |
| Domínio | Nome final, acesso ao DNS e responsável por aprovar a virada |
| Conteúdo | Apostilas e vídeos finais, banco de questões revisado, fases, pré-requisitos, bloqueios e responsáveis por liberar exceções |

Na homologação, qualquer fluxo de checkout deve permanecer claramente marcado como teste. Uma matrícula criada para validar a jornada não equivale a pagamento confirmado. Ativar cobrança real exige implementar, configurar e testar o ciclo completo do provedor.

## 14. Rollback

### Aplicação

1. identificar o último deploy saudável e seu commit;
2. usar o rollback/redeploy do Railway para essa versão;
3. aguardar `/health/ready`;
4. executar os testes críticos de login, catálogo, painel e mídia;
5. manter o deploy defeituoso disponível para análise de logs, sem recolocá-lo em tráfego.

### Banco

Rollback de código e rollback de dados são decisões diferentes. Não executar automaticamente uma migration “ao contrário”. Se a versão anterior não for compatível com o schema novo:

1. manter a aplicação em manutenção;
2. restaurar o backup em uma instância separada;
3. validar os dados;
4. atualizar `DATABASE_URL` em mudança controlada;
5. reabrir o serviço somente após o healthcheck e a homologação mínima.

Antes de cada release, registrar commit, migrations incluídas, backup de referência e responsável pela decisão. Alterações destrutivas devem usar uma estratégia em etapas: adicionar, migrar dados, trocar a aplicação e somente depois remover o legado em outro release.

## 15. Informações que a equipe da igreja precisa fornecer

- conta ou projeto Railway em que o ambiente será criado;
- acesso do repositório GitHub ao serviço `Web`;
- branches destinadas a staging e produção;
- domínio final e acesso ao provedor DNS;
- e-mail individual do primeiro owner;
- política de backup e retenção;
- responsáveis por homologação técnica e funcional;
- credenciais externas quando Mercado Pago, CRM e e-mail forem autorizados.

Credenciais devem ser inseridas diretamente como variáveis seladas no Railway ou por um gerenciador de segredos aprovado, nunca commitadas no repositório.

## Referências oficiais

- [Railway — PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway — Storage Buckets](https://docs.railway.com/storage-buckets)
- [Railway — Environments](https://docs.railway.com/environments)
- [Railway — Variables e referências entre serviços](https://docs.railway.com/variables)
- [Railway — Healthchecks](https://docs.railway.com/deployments/healthchecks)
- [Resend — envio de e-mail](https://resend.com/docs/api-reference/emails/send-email)
- [Resend — verificação de domínio](https://resend.com/docs/dashboard/domains/introduction)
- [Railway — Domínios](https://docs.railway.com/cli/domain)
- [Railway — Backups](https://docs.railway.com/volumes/backups)
