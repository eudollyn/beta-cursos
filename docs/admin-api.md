# Beta Cursos — contrato da administração

Esta API é o contrato estável entre o painel e o servidor. O adaptador original
usa os bindings `DB` e `MEDIA`; no Railway, eles são fornecidos pelos adaptadores
PostgreSQL e S3 compatível. O JSON dos cursos não contém objetos ou
identificadores internos desses provedores.

## Identidade e autorização

Internamente, as rotas `/api/admin/*` recebem os cabeçalhos confiáveis
`oai-authenticated-user-email` e, opcionalmente,
`oai-authenticated-user-full-name`. No Railway, todo valor enviado pelo cliente
com esses nomes é removido; o servidor volta a inseri-los somente depois de
resolver a sessão. O primeiro `owner` deve usar exatamente o e-mail configurado
em `BOOTSTRAP_OWNER_EMAIL`. Depois disso, somente usuários da tabela `admins`
acessam a administração.

`GET /api/media/:id` serve arquivos para o player com suporte a `Range`. No
servidor Railway, capas (`image`) permanecem públicas; PDFs e vídeos enviados
exigem uma sessão administrativa ou matrícula ativa em um curso publicado que
referencie o arquivo.

## Conta, jornada e avaliação

- `POST /api/auth/register` — cria uma conta de aluno.
- `POST /api/auth/login` — inicia uma sessão opaca em cookie `HttpOnly`.
- `POST /api/auth/logout` — revoga a sessão atual.
- `GET /api/auth/session` — restaura a identidade da sessão.
- `POST /api/auth/demo` — disponível somente quando habilitado pelo ambiente.
- `GET /api/me/state` — retorna matrículas e progresso da conta autenticada.
- `PUT /api/me/progress/:courseId` — registra leitura, vídeo e revisão em ordem.
- `POST /api/me/quiz/:courseId/:lessonId/attempt` — recebe somente os IDs das
  alternativas, exige `Idempotency-Key`, corrige no servidor e atualiza o
  progresso de forma transacional.
- `POST /api/checkouts` — cria checkout/matrícula apenas no modo configurado.
- `GET /api/admin/students` — lista alunos reais para funções administrativas.
- `GET /api/admin/team` — lista contas e funções; exclusivo do proprietário.
- `PATCH /api/admin/team/:id/role` — atribui aluno, facilitador ou administrador; exclusivo do proprietário.

O catálogo público remove todos os campos de gabarito. Uma tentativa reprovada
com novas chances informa a pontuação, mas não revela a resposta correta.

## Cursos

- `GET /api/courses` — retorna `{ courses, initialized }`; somente publicados.
  Visitantes recebem estrutura e apresentação sem materiais, questões ou
  gabaritos. Alunos matriculados recebem o conteúdo das aulas, ainda sem
  gabaritos; funções administrativas recebem os materiais de todos os cursos.
- `GET /api/admin/courses` — lista rascunhos, publicados e arquivados.
- `POST /api/admin/courses` — cria um curso.
- `GET /api/admin/courses/:id` — abre um curso.
- `PUT /api/admin/courses/:id` — salva e incrementa `version`.
- `DELETE /api/admin/courses/:id` — exclui um curso.

Campos reservados e mantidos pelo servidor: `id`, `version`, `createdAt`,
`revision`, `updatedAt`, `publishedAt`, `createdBy` e `updatedBy`. O restante do documento,
incluindo módulos, aulas, questões, regras, preço e apresentação, permanece em
JSON comum. Os estados aceitos são `draft`, `published` e `archived`.

Ao atualizar, é obrigatório enviar a `version` ou o alias `revision` recebido anteriormente
evita sobrescrever uma edição feita em outra sessão. Conflitos retornam HTTP
`409`; a ausência da revisão retorna `428`. IDs de módulos, lições, questões e alternativas são obrigatórios,
imutáveis e formados por letras, números, hífen ou sublinhado. IDs legados como
`modulo-1`, `licao-1`, `licao-1-q1` e alternativas `a` a `d` são aceitos. IDs
duplicados são rejeitados; alternativas podem reutilizar `a` a `d` em questões
diferentes.

Para publicar, cada lição precisa ter título e identificador. Apostila, vídeo e teste são opcionais e validados somente quando informados. Um teste pode ter uma ou mais questões; cada questão possui exatamente quatro alternativas completas e uma resposta correta.

Rascunhos podem permanecer incompletos, mas ainda precisam manter IDs válidos.
O seed demonstrativo `jornada-lidere`, identificado também por
`contentStatus: "demo"`, mantém a compatibilidade histórica de vídeo pendente;
essa exceção não se aplica a nenhum curso novo.

`DELETE /api/admin/courses/:id` exclui somente cursos em `draft`. Cursos
`published` ou `archived` retornam `409` para preservar histórico. Para retirar
um curso do catálogo público, altere seu status para `archived`.

## Apostilas e vídeos

- `GET /api/admin/media` — lista a biblioteca.
- `POST /api/admin/media` — `multipart/form-data`, campo `file` e campo opcional
  `kind` (`pdf`, `image` ou `video`).
- `GET /api/media/:id` — endereço estável; PDF e vídeo exigem matrícula no Railway.
- `GET /api/admin/media/:id` — alias administrativo autenticado.
- `DELETE /api/admin/media/:id` — exclui; retorna `409` se ainda estiver em uso.
  `?force=true` força a exclusão e deve ser usado somente após confirmação.

PDF: até 30 MB, MIME `application/pdf`. Imagem: até 10 MB em PNG, JPEG ou WebP.
Vídeo: até 100 MB nos formatos MP4, WebM, MOV ou M4V. Links externos de vídeo devem ser HTTPS; YouTube e Vimeo têm
seus identificadores validados, enquanto `direct` aceita uma URL HTTPS para um
arquivo compatível com o player. O upload retorna `media.url`, que deve ser salvo em `pdfUrl` ou
`videoUrl`; o documento do curso guarda somente essa URL/ID estável.

## Cópia de segurança e restauração

- `GET /api/admin/system-backup` — exclusivo do proprietário; baixa um arquivo
  gzip com todas as tabelas permanentes e os bytes da biblioteca de mídia.
  Sessões ativas e tokens temporários são excluídos por segurança.
- `GET /api/admin/export` — baixa JSON com cursos e metadados da biblioteca;
  os bytes dos arquivos não fazem parte dessa exportação de catálogo.
- `POST /api/admin/import` — recebe `{ courses, mode }`. `mode` pode ser `merge`
  ou `replace`. O modo `replace` exige owner e `confirm: "SUBSTITUIR"`.

A resposta da importação de catálogo inclui `missingMediaIds`, permitindo avisar
quando um curso aponta para um arquivo que ainda precisa ser reenviado. A
restauração de um backup integral é uma operação técnica de contingência e deve
ser feita primeiro em um ambiente separado.

## Portabilidade

As funções `dataRepository()` e `mediaStore()` em `worker.mjs` são as portas de
persistência. Para trocar de infraestrutura, implemente nelas as mesmas
operações (`prepare`/`batch` para dados e `put`/`get`/`head`/`delete` para
arquivos), preserve este contrato HTTP e migre as tabelas da pasta `drizzle/`.
O painel e os documentos JSON dos cursos não precisam mudar.
