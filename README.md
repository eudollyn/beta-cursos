# Beta Cursos

Plataforma de cursos da Igreja Beta com catálogo público, área do aluno e painel administrativo. Esta versão roda como uma aplicação Node única: o mesmo domínio entrega o site e a API, o que simplifica autenticação, cookies, implantação e manutenção.

## O que está funcional

- cadastro em duas etapas com confirmação de e-mail, login, logout e restauração de sessão;
- recuperação de senha por link de uso único, com encerramento das sessões antigas;
- senhas protegidas com `scrypt` e sessões opacas em cookie `HttpOnly`;
- catálogo persistente e painel para criar, editar, publicar, duplicar, arquivar e excluir cursos;
- criação de módulos, lições, cinco questões por lição, alternativas, gabarito e regras de tentativa;
- envio de PDF, capa e vídeo, além de YouTube, Vimeo e URL HTTPS;
- biblioteca de mídia, exportação e restauração de cursos;
- matrícula e progresso persistentes, sem simular pagamento em produção;
- correção de avaliações no servidor, tentativas idempotentes e gabarito removido do catálogo público;
- apostilas e vídeos enviados protegidos por sessão e matrícula ativa;
- painel de alunos com progresso real da base;
- SQLite e arquivos locais para desenvolvimento;
- PostgreSQL e Bucket S3 compatível para Railway;
- migrations idempotentes, healthchecks e logs estruturados.

Novos bancos hospedados iniciam sem cursos. O primeiro conteúdo é criado pelo painel administrativo e pode usar a contribuição aprovada de **R$ 19,90**, sem desconto automático.

## Executar localmente

Requisitos: Node.js 22 ou superior e pnpm.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev
```

Abra `http://127.0.0.1:3000`. O servidor aplica as migrations ao iniciar. Localmente, os dados ficam em `.data/beta-cursos.sqlite` e os arquivos em `.data/media`.

O `.env.example` ativa `EMAIL_DRIVER=preview`: os links de confirmação e recuperação aparecem somente na interface local, permitindo testar todo o fluxo sem contratar ou configurar um provedor. Esse driver é recusado em ambientes hospedados.

O curso-base existe apenas como apoio interno ao desenvolvimento local. Ambientes hospedados nunca importam conteúdo automaticamente.

Para executar apenas a antiga prévia estática, sem backend:

```powershell
pnpm dev:static
```

## Painel administrativo

O procedimento seguro para restaurar um backup ou migrar SQLite/filesystem para PostgreSQL/S3 está em [docs/RESTAURACAO-E-MIGRACAO.md](docs/RESTAURACAO-E-MIGRACAO.md). O comando `pnpm restore --file <backup>` executa somente uma simulação; a gravação exige `--apply` explícito.

Depois de entrar com uma conta autorizada, abra **Administração**. Em ambiente hospedado, o proprietário inicial é exclusivamente o e-mail definido em `BOOTSTRAP_OWNER_EMAIL`, mas a função `owner` só é concedida depois que a pessoa abre o link recebido nesse endereço e define a própria senha. Um visitante não consegue tomar a conta cadastrando primeiro uma senha nem enviando cabeçalhos pelo navegador.

Para publicar, cada lição precisa ter:

- uma apostila PDF interna;
- um vídeo enviado ou um link permitido;
- exatamente cinco questões;
- quatro alternativas completas em cada questão;
- uma resposta correta.

O passo a passo para a equipe de conteúdo está em [GUIA-ADMINISTRACAO.md](GUIA-ADMINISTRACAO.md).

## Railway

A homologação inicial pode rodar sem assinatura no plano Free como um único
serviço Node, usando SQLite e filesystem no mesmo volume persistente. Esse modo
é ativado explicitamente com `RAILWAY_FREE_VOLUME_MODE=true`, falha se o volume
não estiver anexado e limita os uploads para proteger os 0,5 GB disponíveis.
No painel do serviço, ative também **Settings > Deploy > Serverless**, mantenha
uma réplica e não use monitor externo contínuo. Ele é adequado para testes
esporádicos, não para manter a operação final da igreja disponível
continuamente.

A arquitetura recomendada para produção possui três serviços no mesmo projeto:

- `Web`: frontend, API e painel em Node.js;
- `Postgres`: cursos, usuários, sessões, matrículas e progresso;
- `Media`: Bucket privado compatível com S3.

O `Dockerfile` e o `railway.json` já estão na raiz. O servidor usa `PORT`, escuta em `0.0.0.0`, executa migrations antes de aceitar tráfego e expõe:

- `GET /health/live`;
- `GET /health/ready`.

O readiness inclui banco, armazenamento e a configuração não sensível do envio de
e-mail. A checagem de e-mail é local (`providerProbe=not_performed`): ela nunca
envia mensagem nem chama a Resend. Falhas reais de entrega ficam nos logs
estruturados e no contador em memória, sem destinatário, link, token ou chave de
API. Quando o e-mail é obrigatório, uma falha real deixa essa dependência
`degraded` e `ok=false`; o próximo envio bem-sucedido restaura o estado.

O handoff completo para o Gilson/equipe de infraestrutura está em [docs/HOSPEDAGEM-RAILWAY.md](docs/HOSPEDAGEM-RAILWAY.md).

## Variáveis essenciais no Railway

Para a primeira implantação Free com um volume anexado em `/data`, use:

```dotenv
APP_ENV=production
NODE_ENV=production
HOST=0.0.0.0
APP_ORIGIN=https://DOMINIO-GERADO
ALLOWED_ORIGINS=https://DOMINIO-GERADO
RAILWAY_FREE_VOLUME_MODE=true
SESSION_SECRET=SEGREDO_ALEATORIO_COM_32_OU_MAIS_CARACTERES
SESSION_COOKIE_NAME=__Host-beta_session
SESSION_TTL_DAYS=7
COOKIE_SECURE=true
BOOTSTRAP_OWNER_EMAIL=ehenriquesilva021@gmail.com
REGISTRATION_ENABLED=true
EMAIL_DRIVER=resend
EMAIL_VERIFICATION_REQUIRED=true
PASSWORD_RESET_ENABLED=true
EMAIL_FROM=Beta Cursos <cursos@DOMINIO-DA-IGREJA>
EMAIL_TOKEN_SECRET=OUTRO_SEGREDO_ALEATORIO_COM_32_OU_MAIS_CARACTERES
RESEND_API_KEY=re_SUBSTITUIR
ENABLE_DEMO_LOGIN=false
DEMO_ROLE=student
CHECKOUT_MODE=disabled
LOG_LEVEL=info
STORAGE_MAX_MB=400
PDF_MAX_MB=15
IMAGE_MAX_MB=5
VIDEO_MAX_MB=25
```

`RAILWAY_VOLUME_MOUNT_PATH` é fornecida automaticamente pelo Railway. Nesse
modo, não defina `DATABASE_URL` nem `LOCAL_STORAGE_PATH`: a aplicação os resolve
dentro do volume e recusa iniciar se houver risco de gravar no disco efêmero.

Na arquitetura definitiva com PostgreSQL e Bucket, use como base
`.env.example`. Em staging/produção são obrigatórios:

- `APP_ORIGIN` e `ALLOWED_ORIGINS` em HTTPS;
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`;
- `SESSION_SECRET` com pelo menos 32 caracteres;
- `BOOTSTRAP_OWNER_EMAIL`;
- `EMAIL_DRIVER=resend`, `EMAIL_FROM`, `EMAIL_TOKEN_SECRET` e `RESEND_API_KEY`;
- `STORAGE_DRIVER=s3`;
- `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID` e `SECRET_ACCESS_KEY` referenciando o serviço `Media`.

O Checkout Pro usa a Orders API do Mercado Pago. Para homologar, configure `CHECKOUT_MODE=test`, `MERCADO_PAGO_ACCESS_TOKEN_TEST`, `MERCADO_PAGO_WEBHOOK_SECRET_TEST` e, quando necessário, `MERCADO_PAGO_TEST_PAYER_EMAIL` com um endereço `@testuser.com`; use um comprador de teste no checkout. Antes da abertura, repita o fluxo com as credenciais definitivas e então use `CHECKOUT_MODE=production`.

## Verificação

```powershell
pnpm test
```

O comando gera `dist/`, valida a sintaxe e executa a suíte completa. Há testes de integração para cadastro, sessão, bloqueio de identidade forjada, administração, criação de curso, preço de R$ 19,90, matrícula, proteção de mídia, progresso, correção segura dos testes e listagem de alunos.

Outros comandos:

```powershell
pnpm migrate
pnpm build
pnpm package:s3
```

O pacote S3 continua disponível apenas como alternativa estática/legada. Sozinho, um bucket S3 não executa autenticação, banco, progresso ou painel persistente.

## E-mail transacional

O código de confirmação e recuperação já está concluído. Em produção, o adaptador usa a API HTTPS do Resend sem pacote adicional. Os tokens possuem finalidade específica, expiração, uso único e ficam armazenados somente como HMAC; o valor bruto nunca é salvo no banco. Cadastro, reenvio e recuperação usam respostas genéricas e tempo mínimo de resposta no ambiente hospedado para reduzir a enumeração de contas. Limites independentes por endereço e por IP dificultam spam mesmo quando o atacante alterna e-mails.

Para ativar o envio real, ainda é necessário criar ou utilizar uma conta Resend, validar um domínio remetente e configurar no Railway as variáveis listadas acima. Até isso acontecer, não publique o cadastro aberto com um remetente improvisado. `EMAIL_DRIVER=preview` é exclusivamente local e a aplicação recusa essa opção no Railway.

## Dependências externas antes da abertura pública

O backend pode ser homologado integralmente no Railway. Ainda dependem de decisões ou credenciais da igreja:

- credenciais definitivas do Mercado Pago, segredo do webhook de pedidos e validação operacional de estorno/reconciliação;
- CRM ou cadastro oficial para validar o código de membro; os campos compatíveis permanecem reservados no backend, mas o recurso não aparece nas telas nem concede benefícios enquanto essa integração não existir;
- credencial do provedor de e-mail e domínio remetente validado; a confirmação e a recuperação já estão implementadas;
- domínio e acesso ao DNS;
- apostilas, vídeos e questões finais;
- decisão pastoral sobre fases, pré-requisitos e exceções;

Enquanto `CHECKOUT_MODE=disabled`, o checkout permanece indisponível e nenhuma cobrança é iniciada.
